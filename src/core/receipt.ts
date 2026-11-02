/**
 * 两阶段回执（receipt）：发送前记 intent，结束后补 outcome。
 *
 * 目的：任何一轮都能回答“模型当时看到了什么、用的是哪版规则”，
 * 出问题时可离线复现，不靠猜。
 */
export const HASH_ALGO_VERSION = 'fnv1a32-v1'
export const PROMPT_TEMPLATE_VERSION = 'im-prompt-v1'
export const VISIBILITY_POLICY_VERSION = 'visibility-v1'
export const EVENT_LOG_SCHEMA_VERSION = 1

/** 规范化 JSON：键排序、去 undefined、NFC 归一，保证同样的内容 hash 相同。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? JSON.stringify(value.normalize('NFC')) : JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']'
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts: string[] = []
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) continue
    parts.push(JSON.stringify(key.normalize('NFC')) + ':' + canonicalJson(item))
  }
  return '{' + parts.join(',') + '}'
}

/** 确定性哈希（FNV-1a 32 位，纯 JS，客户端也能用）。 */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5
  const normalized = text.normalize('NFC')
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return HASH_ALGO_VERSION + ':' + hash.toString(16).padStart(8, '0')
}

export function fingerprint(parts: Record<string, unknown>): string {
  return stableHash(canonicalJson(parts))
}

export interface ReceiptVersions {
  eventLogSchema: number
  promptTemplate: string
  visibilityPolicy: string
  hashAlgo: string
  factsVersion?: string
}

export interface ReceiptSampling {
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
}

export interface ReceiptIntent {
  turnId: string
  personaId: string
  provider: string
  model: string
  /** 本轮窗口里的事件序号（回放时用来比对“看到的是不是这一批”）。 */
  windowSeqs: number[]
  summaryUntil: number
  versions: ReceiptVersions
  sampling?: ReceiptSampling
  systemPromptHash: string
  promptHash: string
  /** 角色状态快照的内容 hash（回执变厚：状态版本可回放）。 */
  stateSnapshotHash?: string
  /** 按需检索的审计字段：结构化 query + 完整命中 + 最终选中 + 索引版本。 */
  retrieval?: {
    query: ReceiptRetrievalQuery
    hitIds: number[]
    selectedIds: number[]
    indexVersion: string
  }
  /** 窗口里是否含不可信内容（群消息/工具结果）。 */
  untrusted: boolean
  /** Phase 1 引用句柄协议审计：选中/目录 seq、话题段、字数与背压原因（不含正文）。 */
  memoryContext?: import('./memory-context.ts').MemoryContextReceipt
  /** A-1 群级预算快照（粘滞；同输入同预算，可离线对照）。 */
  budget?: import('./context-budget.ts').ContextBudgetReceipt
  /** A-1 预算变更事件：只在成员/模型/档位/ratio 显式变化时出现（不是每轮都写）。 */
  budgetChanged?: import('./context-budget.ts').BudgetChangedEvent
  at: number
}

/** 回执里的结构化检索 query（能 diff，不用自然语言字符串）。 */
export interface ReceiptRetrievalQuery {
  topicId: number
  entities: { type: string; value: string }[]
  replyChainRoots: number[]
  params: {
    retrievalVersion: string
    topicSegVersion: string
    weights: Record<string, number>
  }
}

export interface ReceiptOutcome {
  tokensIn?: number
  tokensOut?: number
  ms: number
  finish: 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted'
}

export interface TurnReceipt {
  intent: ReceiptIntent
  outcome?: ReceiptOutcome
}

export function defaultVersions(extra: Partial<ReceiptVersions> = {}): ReceiptVersions {
  return {
    eventLogSchema: EVENT_LOG_SCHEMA_VERSION,
    promptTemplate: PROMPT_TEMPLATE_VERSION,
    visibilityPolicy: VISIBILITY_POLICY_VERSION,
    hashAlgo: HASH_ALGO_VERSION,
    ...extra,
  }
}

export function createIntent(input: {
  turnId: string
  personaId: string
  provider: string
  model: string
  windowSeqs: number[]
  summaryUntil?: number
  systemPrompt: string
  prompt: string
  sampling?: ReceiptSampling
  untrusted?: boolean
  versions?: Partial<ReceiptVersions>
  stateSnapshotHash?: string
  retrieval?: ReceiptIntent['retrieval']
  memoryContext?: ReceiptIntent['memoryContext']
  budget?: ReceiptIntent['budget']
  budgetChanged?: ReceiptIntent['budgetChanged']
  at: number
}): ReceiptIntent {
  return {
    turnId: input.turnId,
    personaId: input.personaId,
    provider: input.provider,
    model: input.model,
    windowSeqs: [...input.windowSeqs],
    summaryUntil: input.summaryUntil ?? 0,
    versions: defaultVersions(input.versions),
    ...(input.sampling === undefined ? {} : { sampling: input.sampling }),
    systemPromptHash: stableHash(input.systemPrompt),
    promptHash: stableHash(input.prompt),
    ...(input.stateSnapshotHash ? { stateSnapshotHash: input.stateSnapshotHash } : {}),
    ...(input.retrieval ? { retrieval: input.retrieval } : {}),
    ...(input.memoryContext ? { memoryContext: input.memoryContext } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.budgetChanged ? { budgetChanged: input.budgetChanged } : {}),
    untrusted: Boolean(input.untrusted),
    at: input.at,
  }
}

/** 回执自检：窗口序号是否与“现在按同一规则重算的窗口”一致。 */
export function verifyReceipt(intent: ReceiptIntent, currentWindowSeqs: readonly number[]): {
  ok: boolean
  reason?: string
} {
  if (intent.versions.hashAlgo !== HASH_ALGO_VERSION) {
    return { ok: false, reason: 'hash 算法版本不一致，无法比对' }
  }
  if (intent.windowSeqs.length !== currentWindowSeqs.length) {
    return { ok: false, reason: `窗口长度变化：${intent.windowSeqs.length} → ${currentWindowSeqs.length}` }
  }
  for (let index = 0; index < intent.windowSeqs.length; index++) {
    if (intent.windowSeqs[index] !== currentWindowSeqs[index]) {
      return { ok: false, reason: `第 ${index + 1} 条窗口事件不同：#${intent.windowSeqs[index]} → #${currentWindowSeqs[index]}` }
    }
  }
  return { ok: true }
}
