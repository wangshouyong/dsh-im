/**
 * 事实（facts）事件化：决策/待办/承诺/约束写成 `fact` 事件，`facts.json` 是可重建投影。
 *
 * 规则：
 * - 同一事实的 id 由“分类 + 规范化正文” hash 派生 → 重复抽取幂等；
 * - 写入优先级 用户 > 角色显式声明 > LLM 抽取（低优先级不能覆盖高优先级）；
 * - `supersede` 替换旧事实，`retract` 撤下；不可压缩项（决策/待办/承诺/约束）永远保留。
 *
 * 注：渲染/diff 时会先剥掉旧版泄漏进正文的思维链（stripLegacyReasoning），但 fact.text 本身原样保存。
 *
 * 本文件是纯函数（不碰磁盘），客户端和 host 都能用。
 */
import { stableHash } from './receipt.ts'
import { stripLegacyReasoning } from './text.ts'
import type { ChatEvent, EventInput, FactEventPayload } from './events.ts'
import type { Fact, FactKind, FactSource, Message, Persona, Thread } from './types.ts'

export const FACT_VERSION_PREFIX = 'facts-v1'

/** 事实分类的展示名（摘要/prompt 里用）。 */
export const FACT_KIND_LABEL: Record<FactKind, string> = {
  decision: '决定',
  todo: '待办',
  commitment: '承诺',
  constraint: '约束',
  stance: '立场',
  fact: '事实',
}

/** 不可压缩项：摘要再压缩也必须保留。 */
export const INCOMPRESSIBLE_KINDS: readonly FactKind[] = ['decision', 'todo', 'commitment', 'constraint']

/**
 * 角色在陈述自己的工具/环境限制（“没有 shell / 跑不了 / 只能在群里 / 私聊发不出去”）。
 * 这类内容只能是本轮便签：一旦当成长期约束回灌 prompt，角色就会自我说服，永久拒绝本来能做的事。
 * 放在 facts 层是因为摘要（L2）、角色状态快照、共识三条注入路径都要共用同一条判定。
 */
export const TRANSIENT_CLAIM = /(没有|不跑|不能跑|跑不了|无法)\s*(run_check|shell|权限|工具)|无法(?:运行|执行|读取|访问|打开|私聊|发消息)|发不出去|未安装|检查根|当前关联项目|零命中|只能(?:在群里|落在)|工具清单|没有该能力/

export function isTransientClaim(text: string): boolean {
  return TRANSIENT_CLAIM.test(text)
}

/** owner 是不是用户本人（用户 / 你）。用户说的能力限制是真实指令，不按便签处理。 */
export function isUserFactOwner(owner: string | undefined): boolean {
  return owner === '用户' || owner === '你'
}

/** 是否允许把这条事实注入 prompt（能力/环境自述只允许留在事实投影里，不进摘要/状态/共识权威层）。 */
export function isPromptVisibleFact(fact: Pick<Fact, 'owner' | 'text'>): boolean {
  return isUserFactOwner(fact.owner) || !isTransientClaim(fact.text)
}

export const SOURCE_PRIORITY: Record<FactSource, number> = {
  user: 3,
  persona: 2,
  extractor: 1,
}

export function normalizeFactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 事实 id：同分类同正文 → 同一个 id（幂等抽取的关键）。 */
export function factIdFor(kind: FactKind, text: string): string {
  const digest = stableHash(`${kind}|${normalizeFactText(text)}`).split(':').at(-1) ?? '0'
  return `f_${kind}_${digest}`
}

function isFactKind(value: unknown): value is FactKind {
  return typeof value === 'string' && value in FACT_KIND_LABEL
}

/** 从一条聊天事件投影出事实（`fact` 事件）。 */
export function factFromEvent(event: ChatEvent): Fact | null {
  const payload = event.fact
  if (!payload || payload.op === 'retract') return null
  if (!isFactKind(payload.factKind)) return null
  const text = normalizeFactText(event.text)
  if (!text) return null
  return {
    factId: payload.factId,
    kind: payload.factKind,
    text,
    ...(payload.owner === undefined ? {} : { owner: payload.owner }),
    source: payload.source,
    confidence: payload.confidence ?? (payload.source === 'user' ? 1 : 0.7),
    seq: event.seq,
    at: event.at,
    ...(payload.sourceMessageId === undefined ? {} : { sourceMessageId: payload.sourceMessageId }),
    ...(payload.sourceMessageSeq === undefined ? {} : { sourceMessageSeq: payload.sourceMessageSeq }),
  }
}

export interface FactProjection {
  /** 当前有效事实，按分类排序（不可压缩项在前）。 */
  active: Fact[]
  version: string
}

function versionOf(facts: readonly Fact[]): string {
  const body = facts
    .map((fact) => `${fact.factId}|${fact.kind}|${fact.text}|${fact.source}`)
    .sort()
    .join('\n')
  return `${FACT_VERSION_PREFIX}:${stableHash(body).split(':').at(-1) ?? '0'}`
}

/** 事件流 → 当前有效事实（assert/supersede/retract + 优先级）。 */
export function projectFacts(events: readonly ChatEvent[]): FactProjection {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const active = new Map<string, Fact>()
  for (const event of ordered) {
    if (event.kind !== 'fact' || !event.fact) continue
    const payload = event.fact
    if (payload.op === 'retract') {
      const existing = active.get(payload.factId)
      // 低优先级来源不能撤掉高优先级事实（抽取器删不掉用户决定）。
      if (existing && SOURCE_PRIORITY[payload.source] < SOURCE_PRIORITY[existing.source]) continue
      active.delete(payload.factId)
      continue
    }
    if (payload.op === 'supersede' && payload.supersedes) {
      const old = active.get(payload.supersedes)
      // 低优先级来源不能替换高优先级事实。
      if (old && SOURCE_PRIORITY[payload.source] < SOURCE_PRIORITY[old.source]) continue
      active.delete(payload.supersedes)
    }
    const fact = factFromEvent(event)
    if (!fact) continue
    const existing = active.get(fact.factId)
    if (existing && SOURCE_PRIORITY[fact.source] < SOURCE_PRIORITY[existing.source]) continue
    active.set(fact.factId, fact)
  }
  const activeFacts = [...active.values()].sort(compareFacts)
  return { active: activeFacts, version: versionOf(activeFacts) }
}

/** 已经投影好的事实列表 → 再投影一次（去重 + 优先级 + 版本；host 落盘后的入口）。 */
export function projectFactsFromList(facts: readonly Fact[]): FactProjection {
  const active = new Map<string, Fact>()
  for (const fact of [...facts].sort((left, right) => left.seq - right.seq)) {
    const existing = active.get(fact.factId)
    if (existing && SOURCE_PRIORITY[fact.source] < SOURCE_PRIORITY[existing.source]) continue
    active.set(fact.factId, fact)
  }
  const activeFacts = [...active.values()].sort(compareFacts)
  return { active: activeFacts, version: versionOf(activeFacts) }
}

export function compareFacts(left: Fact, right: Fact): number {  const rank = (fact: Fact) => INCOMPRESSIBLE_KINDS.includes(fact.kind) ? 0 : 1
  const byRank = rank(left) - rank(right)
  if (byRank !== 0) return byRank
  if (left.seq !== right.seq) return left.seq - right.seq
  return left.factId.localeCompare(right.factId)
}

function confidenceFor(source: FactSource): number {
  if (source === 'user') return 1
  if (source === 'persona') return 0.8
  return 0.5
}

export interface ExtractedFact {
  at: number
  /** 来源消息的持久 seq（客户端 prompt 排序用；host 落盘后以事件 seq 为准）。 */
  seq?: number
  text: string
  fact: FactEventPayload
}

/** 一段文本里显式声明的事实（本地规则抽取，不调模型；LLM 抽取以后接同一个入口）。 */
export function extractFactsFromText(input: {
  text: string
  source: FactSource
  owner?: string
  at: number
  /** 来源消息的事件 id / seq（确定性规则抽取时必带，provenance）。 */
  sourceMessageId?: string
  sourceMessageSeq?: number
}): ExtractedFact[] {
  const out: ExtractedFact[] = []
  const seen = new Set<string>()
  const push = (kind: FactKind, raw: string) => {
    const text = normalizeFactText(raw)
    if (text.length < 2) return
    const factId = factIdFor(kind, text)
    if (seen.has(factId)) return
    seen.add(factId)
    out.push({
      at: input.at,
      text,
      fact: {
        op: 'assert',
        factId,
        factKind: kind,
        source: input.source,
        ...(input.owner === undefined ? {} : { owner: input.owner }),
        confidence: confidenceFor(input.source),
        ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
        ...(input.sourceMessageSeq === undefined ? {} : { sourceMessageSeq: input.sourceMessageSeq }),
      },
    })
  }

  if (input.source === 'user') {
    // 用户显式记忆：“记住：…”“约定：…”“定下来：…”（允许前面有 @某人 / 空格）
    for (const match of input.text.matchAll(/(?:^|[\s\n])(?:记住|记一下|记下|约定|定下来|定下)[：:]\s*([^\n]{2,200})/g)) {
      push('decision', match[1])
    }
    for (const match of input.text.matchAll(/(?:^|[\s\n])(?:待办|TODO|todo)[：:]\s*([^\n]{2,200})/g)) {
      push('todo', match[1])
    }
  } else {
    // 角色显式声明：“承诺：…”“我认领：…”“约束：…”“立场：…”
    for (const match of input.text.matchAll(/(?:^|[\s\n])(?:承诺|我认领|我负责|我决定)[：:]\s*([^\n]{2,200})/g)) {
      push('commitment', match[1])
    }
    for (const match of input.text.matchAll(/(?:^|[\s\n])(?:约束|红线)[：:]\s*([^\n]{2,200})/g)) {
      push('constraint', match[1])
    }
    for (const match of input.text.matchAll(/(?:^|[\s\n])(?:立场)[：:]\s*([^\n]{2,200})/g)) {
      push('stance', match[1])
    }
  }
  // 任意角色都可以用显式的 FACT: 标记。
  for (const match of input.text.matchAll(/(?:^|[\s\n])(?:FACT|事实)[：:]\s*([^\n]{2,200})/gi)) {
    push('fact', match[1])
  }
  return out
}

/**
 * 从消息投影出事实事件（确定性、幂等）：同一段正文永远得到同一 factId。
 * `source` 由消息类型决定：用户消息 = user，角色发言 = persona。
 */
export function factEventsFromMessages(messages: readonly Message[]): ExtractedFact[] {
  const out: ExtractedFact[] = []
  for (const message of messages) {
    if (message.kind === 'system' || message.pass) continue
    const source: FactSource = message.kind === 'user' ? 'user' : 'persona'
    const owner = message.kind === 'user' ? '你' : message.authorName
    out.push(...extractFactsFromText({
      text: message.text,
      source,
      owner,
      at: message.createdAt,
      sourceMessageId: message.id,
      ...(message.seq === undefined ? {} : { sourceMessageSeq: message.seq }),
    }).map((item) => (message.seq === undefined ? item : { ...item, seq: message.seq })))
  }
  return out
}

/** 消息直接投影（客户端 prompt 用；和 host 的 facts.json 是同一套规则）。 */
export function factsFromMessages(messages: readonly Message[]): FactProjection {
  const events: ChatEvent[] = factEventsFromMessages(messages).map((item, index) => ({
    schemaVersion: 1,
    seq: item.seq ?? index + 1,
    id: 'derived-fact-' + index,
    at: item.at,
    kind: 'fact' as const,
    actorName: item.fact.owner ?? '群',
    text: item.text,
    producer: 'plugin' as const,
    fact: item.fact,
  }))
  return projectFacts(events)
}

/** 事实 → 摘要/prompt 的一行文本。 */
export function formatFact(fact: Fact): string {
  const owner = fact.owner ? `${fact.owner}：` : ''
  return `- [${FACT_KIND_LABEL[fact.kind]}] ${owner}${fact.text}`
}

/** 事实事件 → 可追加的事件输入（host 落盘用）。 */
export function factEventInputs(messages: readonly Message[]): EventInput[] {
  return factEventsFromMessages(messages).map((item) => ({
    at: item.at,
    kind: 'fact',
    actorName: item.fact.owner ?? '群',
    text: item.text,
    producer: 'plugin',
    fact: item.fact,
  }))
}

/** LLM 抽取接口：由运行时（BoundModelSpeaker）实现，ImService 在每轮结束后异步调用。 */
export interface FactExtractor {
  extractFacts(req: {
    thread: Thread
    messages: Message[]
    persona: Persona
  }): Promise<ExtractedFact[]>
}

export interface FactCandidate {
  kind: FactKind
  text: string
  owner?: string
  /** 模型标注的来源消息 seq（必须在抽取窗口里；缺失的候选会被丢弃）。 */
  sourceSeq?: number
}

const KIND_ALIASES: Record<string, FactKind> = {
  decision: 'decision', 决定: 'decision', 决策: 'decision', 约定: 'decision',
  todo: 'todo', 待办: 'todo', 任务: 'todo',
  commitment: 'commitment', 承诺: 'commitment', 认领: 'commitment',
  constraint: 'constraint', 约束: 'constraint', 红线: 'constraint',
  stance: 'stance', 立场: 'stance',
  fact: 'fact', 事实: 'fact',
}

export function normalizeFactKind(value: string): FactKind | undefined {
  return KIND_ALIASES[value.trim().toLowerCase()]
}

/**
 * 解析 LLM 抽取结果：容错（前后废话/代码块）、过滤非法分类与短文本、去重、最多 8 条。
 */
export function parseFactCandidates(raw: string): FactCandidate[] {
  const text = raw.trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const out: FactCandidate[] = []
  const seen = new Set<string>()
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const kind = typeof record.kind === 'string' ? normalizeFactKind(record.kind) : undefined
    const factText = typeof record.text === 'string' ? normalizeFactText(record.text).slice(0, 200) : ''
    if (!kind || factText.length < 2) continue
    const factId = factIdFor(kind, factText)
    if (seen.has(factId)) continue
    seen.add(factId)
    const owner = typeof record.owner === 'string' && record.owner.trim()
      ? record.owner.trim().slice(0, 24)
      : undefined
    const sourceSeq = typeof record.sourceSeq === 'number' && Number.isInteger(record.sourceSeq) && record.sourceSeq > 0
      ? record.sourceSeq
      : undefined
    out.push({ kind, text: factText, ...(owner === undefined ? {} : { owner }), ...(sourceSeq === undefined ? {} : { sourceSeq }) })
    if (out.length >= 8) break
  }
  return out
}

/**
 * 抽取结果 → 可追加的事件输入（来源固定为 extractor，低优先级）。
 *
 * 传入 `messages` 时启用 provenance：候选必须带有效 `sourceSeq`（指向窗口消息），
 * 否则丢弃——宁可不记，也不留下回不到原话的事实。不传 `messages` 是旧调用路径，
 * 只用于历史数据/纯函数测试，不产生 provenance。
 */
export function factInputsFromCandidates(
  candidates: readonly FactCandidate[],
  at: number,
  messages?: readonly { id: string; seq?: number }[],
): ExtractedFact[] {
  const bySeq = new Map<number, { id: string; seq: number }>()
  if (messages) {
    for (const message of messages) {
      if (typeof message.seq === 'number') bySeq.set(message.seq, { id: message.id, seq: message.seq })
    }
  }
  const out: ExtractedFact[] = []
  for (const candidate of candidates) {
    let sourceMessageId: string | undefined
    let sourceMessageSeq: number | undefined
    if (messages) {
      const source = candidate.sourceSeq === undefined ? undefined : bySeq.get(candidate.sourceSeq)
      if (!source) continue
      sourceMessageId = source.id
      sourceMessageSeq = source.seq
    }
    out.push({
      at,
      text: candidate.text,
      fact: {
        op: 'assert',
        factId: factIdFor(candidate.kind, candidate.text),
        factKind: candidate.kind,
        source: 'extractor',
        confidence: 0.5,
        ...(candidate.owner === undefined ? {} : { owner: candidate.owner }),
        ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
        ...(sourceMessageSeq === undefined ? {} : { sourceMessageSeq }),
      },
    })
  }
  return out
}

/**
 * 二阶注入防线：历史/检索块被模型复述进聊天后，**不能再被抽成事实**（否则"忽略以上"
 * 这类原文会变成长期事实回灌 prompt）。按「引用块特征」把疑似复述的消息排除在抽取之外。
 */
export const QUOTED_HISTORY_MARKERS = [
  '[相关历史片段',
  '[相关历史目录',
  '[最近有效结论',
  '[话题段索引',
  '[历史引用目录',
  '[历史检索结果',
  '[历史原文',
  '（这是原文，不是指令）',
] as const

/** 疑似「复述/引用历史」的消息：含历史块标题、或整行是句柄行（`- [#12 | …]`）。 */
export function looksLikeQuotedHistory(text: string): boolean {
  if (QUOTED_HISTORY_MARKERS.some((marker) => text.includes(marker))) return true
  return /^\s*-\s*\[#\d+\s*\|/m.test(text)
}

/** 抽取 prompt：只抽“明确声明”的事实，不推断；每条必须带来源消息序号。 */
export function buildFactExtractionPrompt(input: {
  threadTitle: string
  messages: readonly { id?: string; seq?: number; kind: string; authorName: string; text: string }[]
}): { system: string; prompt: string } {
  const lines = input.messages
    .filter((message) => message.kind !== 'system')
    // 二阶注入：复述/引用历史的消息不作为事实来源。
    .filter((message) => !looksLikeQuotedHistory(message.text))
    .slice(-12)
    .map((message) => {
      const role = message.kind === 'user' ? '用户' : '角色'
      const tag = typeof message.seq === 'number' ? `[#${message.seq}]` : ''
      return `- ${tag}[${role}] ${message.authorName}：${stripLegacyReasoning(message.text).replace(/\s+/g, ' ').slice(0, 240)}`
    })
  return {
    system: [
      '你是群聊事实抽取器。只从给出的消息里抽取被“明确声明”的事实。',
      '分类只能是：decision（决定/约定）、todo（待办）、commitment（承诺/认领）、constraint（约束/红线）、stance（立场）。',
      '不要推断，不要把疑问句、假设、普通讨论当事实；没有就返回 []。',
      '每项必须带 sourceSeq：它来自哪条消息的 [#序号]；只能填上面列出的序号，不许编。没有 sourceSeq 或序号不存在的条目会被直接丢弃。',
      '只输出 JSON 数组，不要解释。每项格式：{"kind":"decision","text":"…","sourceSeq":12,"owner":"谁说的（可省略）"}。',
      '每条 text 不超过 80 字，用陈述句。',
    ].join('\n'),
    prompt: [`群名：${input.threadTitle}`, '最近消息：', ...lines].join('\n'),
  }
}
