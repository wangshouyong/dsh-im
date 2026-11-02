import type {
  CatalogCard,
  ChairSelector,
  Message,
  ModelContentPart,
  Persona,
  RetrievalMode,
  RetrievalQuery,
  SpeakRequest,
  SpeakResult,
  Speaker,
  Thread,
  TurnStepTrace,
  NativeFrame,
  NativeFrameLine,
} from './types.ts'
import { DutyChair } from './floor.ts'
import { groupWindow } from './window.ts'
import { assemblePrompt, assignSeqs, selectWindow } from './prompt.ts'
import { digestSummaryText } from './summary.ts'
import { renderRoleState } from './role-state.ts'
import { renderRetrieval, retrieveRelevant } from './retrieval.ts'
import { buildMemoryContext, memoryBlockOf, memoryReceiptOf, type MemoryContextMode, type MemoryContextReceipt } from './memory-context.ts'
import { claimsFromThread } from './memory-claims.ts'
import { BUDGET_SAFETY, DEFAULT_BUDGET_TIER, DEFAULT_RATIO, resolveTier } from './budget-plan.ts'
import {
  budgetChangeOf,
  budgetViewOf,
  groupBudgetSignature,
  groupContextBudget,
  groupEntriesForThread,
  type BudgetChangedEvent,
  type ContextBudgetReceipt,
} from './context-budget.ts'
import { chapterHandleSeqs, splitSummaryBudget } from './chapter-tree.ts'
import { buildDualWindow } from './dual-window.ts'
import { classifyComposition, priorRatio } from './calibration-samples.ts'
import { stableHash } from './receipt.ts'
import { logWarn } from './log.ts'
import { renderConsensusPrompt, type ConsensusDraft, type ConsensusFact } from './consensus.ts'
import { buildCuratorPrompt, parseCuratorOutput } from './curator.ts'
import {
  buildFactExtractionPrompt,
  factInputsFromCandidates,
  factsFromMessages,
  formatFact,
  INCOMPRESSIBLE_KINDS,
  isPromptVisibleFact,
  parseFactCandidates,
  type ExtractedFact,
} from './facts.ts'

export class ModelCallError extends Error {
  readonly model: string
  constructor(model: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ModelCallError'
    this.model = model
  }
}

export interface ModelTransport {
  complete(input: {
    model: string
    provider?: string
    system: string
    messages: { role: 'user' | 'assistant'; content: string | ModelContentPart[] }[]
    toolAllow?: string[]
    projectRoot?: string
    threadId?: string
    /** 回执用：这一轮是谁在说、看到的是哪批事件、摘要覆盖到哪。 */
    personaId?: string
    windowSeqs?: number[]
    summaryUntil?: number
    /** 事实投影版本（回执里用于判断“当时看到的事实是不是这一版”）。 */
    factsVersion?: string
    /** 角色状态快照 hash（回执里用于判断“当时的状态版本”）。 */
    stateSnapshotHash?: string
    /** 按需检索的结构化查询 + 完整命中 / 最终选中事件 seq（回执审计/回放用）。 */
    retrievalQuery?: RetrievalQuery
    retrievalHitIds?: number[]
    retrievalSelectedIds?: number[]
    indexVersion?: string
    /** Phase 1 引用句柄协议回执（目录/片段的 seq 与字数，不含正文）。 */
    memoryContext?: import('./memory-context.ts').MemoryContextReceipt
    /** A-1 群级预算快照（粘滞：同输入同预算；receipt 落盘后可回放）。 */
    budget?: ContextBudgetReceipt
    /** A-1 预算变更事件：只有成员/模型/档位/ratio 显式变化才出现。 */
    budgetChanged?: BudgetChangedEvent
    /** 模型组装时看到的最后一条消息 seq（因果一致性）。 */
    basedOnSeq?: number
    /** 调用用途：reply（角色发言）/ extract（异步事实抽取）/ curate（共识整理），指标里区分。 */
    purpose?: 'reply' | 'extract' | 'curate'
    /** 原生会话增量帧；没有时 host 仍整段投喂 system + prompt。 */
    nativeFrame?: NativeFrame
    /** 当前发言角色名，host 用来排除「自己的话」避免和会话历史重复。 */
    personaName?: string
    /** host 返回这一轮的工具执行轨迹（客户端保存到 thread.traces）。 */
    onTrace?: (steps: TurnStepTrace[]) => void
  }): Promise<string>
}

/** curator（共识整理）的一次调用：同一份 facts → A/B/C/D 聚类草稿。 */
export interface ConsensusCurateRequest {
  threadId: string
  threadTitle: string
  projectRoot?: string
  facts: ConsensusFact[]
  persona: Persona
}

/** 共识整理能力：由 BoundModelSpeaker 实现；ImService 只在开关打开时调用。 */
export interface ConsensusCurator {
  curate(req: ConsensusCurateRequest): Promise<ConsensusDraft>
}

/**
 * prompt 预算：按模型上下文窗口分配 60%（最近窗口）/ 20%（摘要）/ 20%（系统 + 当前消息 + 输出余量）。
 *
 * 传了 `charsPerToken`（usage 校准结果）时按真实比例换算并留安全余量；
 * 没传时保持旧的「字符≈token」保守估算（老行为不变，测试可对照）。
 */
export const WINDOW_BUDGET_SHARE = 0.6
export const SUMMARY_BUDGET_SHARE = 0.2
export const MIN_WINDOW_CHARS = 6000
export const MAX_WINDOW_CHARS = 24_000
export const MAX_SUMMARY_CHARS = 32_000

export function promptBudgetFor(contextWindow?: number, charsPerToken?: number): { windowChars: number; summaryChars: number } {
  const fallback = { windowChars: MIN_WINDOW_CHARS, summaryChars: Math.round(MIN_WINDOW_CHARS * SUMMARY_BUDGET_SHARE / WINDOW_BUDGET_SHARE) }
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return fallback
  const ratio = charsPerToken !== undefined && Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : undefined
  if (ratio === undefined) {
    // 没有校准：保持旧的「字符≈token」保守估算。
    const windowChars = Math.min(MAX_WINDOW_CHARS, Math.max(MIN_WINDOW_CHARS, Math.floor(contextWindow * WINDOW_BUDGET_SHARE)))
    const summaryChars = Math.min(MAX_SUMMARY_CHARS, Math.max(1200, Math.floor(contextWindow * SUMMARY_BUDGET_SHARE)), Math.floor(windowChars / 3))
    return { windowChars, summaryChars }
  }
  // 有校准：按真实 chars/token 换算。**不再套 MIN 地板**——实测中文 1 字≈2.1 tokens，
  // 6000 字地板在 8k 窗口上会直接超窗；这里只保留保护性下限 400 与 MAX 上限。
  const windowByRatio = Math.floor(contextWindow * WINDOW_BUDGET_SHARE * ratio * BUDGET_SAFETY)
  const summaryByRatio = Math.floor(contextWindow * SUMMARY_BUDGET_SHARE * ratio * BUDGET_SAFETY)
  const windowChars = Math.min(MAX_WINDOW_CHARS, Math.max(400, windowByRatio))
  const summaryChars = Math.min(MAX_SUMMARY_CHARS, Math.max(200, summaryByRatio), Math.floor(windowChars / 3))
  return { windowChars, summaryChars }
}

function truncateSummary(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)) + '…'
}

/** 检索开关三档：off 完全不跑；shadow 跑检索+回执但不进 prompt（线上观察）；on 进 prompt。 */
export interface SpeakerOptions {
  /** 按角色绑定的模型查上下文窗口（token）；查不到就用默认预算。 */
  contextWindowFor?: (model: string) => number | undefined
  /** 按角色查其模型的上下文窗口（群级预算用：取在场成员里最小的那个）。 */
  contextWindowForPersona?: (personaId: string) => number | undefined
  /** 按角色查模型 id（只写进 groupMinModel 回执，不参与判定）。 */
  modelForPersona?: (personaId: string) => string | undefined
  /** 预算档位（economy/standard/deep）；按 localStorage 或默认 standard。 */
  budgetTier?: string
  /**
   * 显式 chars/token（校准/成本观测用）。**不传时**用内容先验且按群冻结（粘滞），
   * 保证同一群同档位下热区预算恒定（A-1）；传了则值变化会触发 budgetChanged(reason=ratio)。
   */
  ratio?: number
  /** 章节目录占 summary 预算的比例（默认 40%，可配置）。 */
  summaryChapterShare?: number
  /** 按需检索开关（默认 shadow：不改变模型看到的 prompt，只在回执里积累检索质量数据）。 */
  retrievalMode?: RetrievalMode
  /** 引用句柄协议开关（默认 shadow：只写回执，不改 prompt；on 才注入）。 */
  memoryContextMode?: MemoryContextMode
}

export function interpretSpeech(
  text: string,
  catalog: Pick<CatalogCard, 'threadId' | 'title' | 'shortSummary'>[],
  threadId: string,
): SpeakResult {
  const trimmed = text.trim()
  const pass = /^\s*PASS\b/i.test(trimmed)
  const named = catalog.find((c) => {
    const summary = c.shortSummary?.trim() ?? ''
    return c.threadId !== threadId
      && Boolean(c.title)
      && summary.length >= 6
      && summary !== c.title
      && trimmed.includes(c.title)
      && /要不要调|调出来/.test(trimmed)
  })
  return { text: trimmed, pass, proposeRecallThreadId: named?.threadId }
}

export function toChatMessages(req: SpeakRequest): { role: 'user' | 'assistant'; content: string }[] {
  const windowed = req.visibleMessages.filter((m) => !(
    m.kind === 'system' && /本轮开始|本轮弃权|全员暂停|跨场召回|先当参考|汇总已写入/.test(m.text)
  ))
  // 群聊只给最近 N 条（摘要走 threadMemory 注入），避免整段历史灌给每个角色。
  const visible = groupWindow(windowed, undefined).recent
  let lastUser = -1
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].kind === 'user') {
      lastUser = i
      break
    }
  }
  const question = lastUser >= 0 ? visible[lastUser].text : ''
  const background = visible.filter((_, i) => i !== lastUser)
  const turns: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of background) {
    if (m.kind === 'user') turns.push({ role: 'user', content: m.text })
    else turns.push({ role: 'assistant', content: `${m.authorName}：${m.text}` })
  }
  const merged: { role: 'user' | 'assistant'; content: string }[] = []
  for (const turn of turns) {
    const prev = merged.at(-1)
    if (prev && prev.role === turn.role) prev.content += `\n${turn.content}`
    else merged.push({ ...turn })
  }
  if (question) merged.push({ role: 'user', content: question })
  return merged.length ? merged : [{ role: 'user', content: question }]
}

/** 模型偶尔会给自己的发言加“名字：”前缀（甚至连续套娃、加粗、加书名号），这里循环剥干净。 */
export function stripSpeakerPrefix(text: string, selfName: string, knownNames: readonly string[]): string {
  const names = [...new Set([selfName, ...knownNames])]
    .filter((name) => Boolean(name) && name.length <= 12)
  if (names.length === 0) return text
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  // 例：淇淇： / **淇淇**： / 【淇淇】 / “淇淇：” / 淇淇: 
  const lead = '[\\s*_【\\[「“"\'（(]*'
  const tail = '[\\s*_】\\]」”"\'）)]*'
  const withColon = new RegExp('^' + lead + '(?:' + escaped + ')' + tail + '\\s*[：:]\\s*' + tail + '\\s*')
  const wrappedOnly = new RegExp('^\\s*(?:\\*\\*|__|【|\\[|「|“|"|\')(?:' + escaped + ')(?:\\*\\*|__|】|\\]|」|”|"|\')\\s*[：:]?\\s*')
  let out = text
  for (let layer = 0; layer < 5; layer++) {
    const before = out
    out = out.replace(withColon, '')
    if (out === before) out = out.replace(wrappedOnly, '')
    if (out === before) break
  }
  return out.trimStart()
}

/** 把当前用户消息的附件拼成模型内容块：图片走 DSH ImageBlock，文本文件内联，二进制只留占位。 */
export function modelContentForAttachments(prompt: string, current: Message | undefined): string | ModelContentPart[] {
  const attachments = current?.attachments ?? []
  if (attachments.length === 0) return prompt
  const parts: ModelContentPart[] = [{ type: 'text', text: prompt }]
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.attachmentId) {
      parts.push({
        type: 'image',
        attachment: {
          attachmentId: attachment.attachmentId,
          ...(attachment.name ? { name: attachment.name } : {}),
          ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
          ...(attachment.width ? { width: attachment.width } : {}),
          ...(attachment.height ? { height: attachment.height } : {}),
        },
      })
      continue
    }
    if (attachment.kind === 'image') {
      parts.push({ type: 'text', text: `\n\n[图片：${attachment.name}（未关联到 DSH 附件存储，当前模型看不到内容）]` })
      continue
    }
    if (attachment.text) {
      parts.push({ type: 'text', text: `\n\n[附件：${attachment.name}]\n${attachment.text}` })
      continue
    }
    parts.push({ type: 'text', text: `\n\n[附件：${attachment.name}（${attachment.bytes} 字节，二进制文件，当前只能看到文件名）]` })
  }
  return parts
}

function frameLine(message: { seq?: number; kind: NativeFrameLine['kind']; authorName: string; text: string }): NativeFrameLine {
  return {
    seq: message.seq ?? 0,
    kind: message.kind,
    authorName: message.authorName,
    text: message.text,
  }
}

/** 给原生会话的增量帧：窗口行 + 当前消息 + L2 事实。事实变了会改已有段，不重建会话。 */
function nativeFrameFor(
  window: readonly { seq?: number; kind: NativeFrameLine['kind']; authorName: string; text: string }[],
  current: { seq?: number; kind: NativeFrameLine['kind']; authorName: string; text: string } | undefined,
  facts: { factsL2: string[]; factsUntilSeq: number },
  memoryBlock?: string,
  contextBlock?: string,
): NativeFrame {
  return {
    windowLines: window.map(frameLine),
    ...(current ? { currentLine: frameLine(current) } : {}),
    ...(facts.factsL2.length ? { factsL2: facts.factsL2 } : {}),
    factsUntilSeq: facts.factsUntilSeq,
    ...(memoryBlock ? { memoryBlock } : {}),
    ...(contextBlock ? { contextBlock } : {}),
  }
}

interface BudgetState {
  signature: string
  /** 未拆分的预算快照（digest/chapter 在 prompt 组装时按记忆模式填）。 */
  receipt: ContextBudgetReceipt
  entries: import('./context-budget.ts').GroupContextEntry[]
  tier: unknown
  ratio: number
}

/** 兜底预算（没有任何成员窗口信息时，保持旧的「字符≈token 保守估算」）。 */
function fallbackBudgetView(
  contextWindow: number | undefined,
  tier: unknown,
  signature: string,
): ContextBudgetReceipt {
  const budget = promptBudgetFor(contextWindow)
  return {
    version: 'context-budget-v1',
    source: 'fallback',
    tier: resolveTier(tier),
    tokens: null,
    ratio: DEFAULT_RATIO,
    windowChars: budget.windowChars,
    summaryChars: budget.summaryChars,
    digestChars: 0,
    chapterChars: 0,
    memoryChars: 0,
    factsCount: 0,
    signature,
  }
}

/** 按角色 model id 调用 transport。失败抛 ModelCallError，不改写成本地假回复。 */
export class BoundModelSpeaker implements Speaker {
  /** A-1 粘滞预算：同群同 signature 复用同一份预算（windowChars 恒定）。 */
  private readonly budgetStates = new Map<string, BudgetState>()
  constructor(
    private readonly transport: ModelTransport,
    private readonly options: SpeakerOptions = {},
  ) {}

  async complete(req: SpeakRequest): Promise<SpeakResult> {
    // 固定前缀 → 分层摘要（L2 事实 + L1 旧消息压缩）→ 最近窗口 → 当前消息
    const digest = req.thread.summaryState
    // 坏摘要（老数据/字段缺失）回退到“窗口 + 事实”模式，不让 prompt 组装备拖垮。
    const rawUntil = digest?.untilSeq ?? req.thread.summaryUntilSeq ?? 0
    const summaryUntil = Number.isFinite(rawUntil) && rawUntil > 0 ? rawUntil : 0
    const fallbackFacts = digest ? undefined : factsFromMessages(req.visibleMessages)
    const factsVersion = digest?.factsVersion ?? req.thread.factsVersion ?? fallbackFacts?.version ?? ''
    // 还没有摘要投影（老数据/第一轮）时，至少把事实（决定/待办/承诺）带上。
    const fallbackFactLines = fallbackFacts
      ? fallbackFacts.active
        .filter((fact) => INCOMPRESSIBLE_KINDS.includes(fact.kind))
        .filter((fact) => isPromptVisibleFact(fact))
        .slice(0, 12)
        .map(formatFact)
      : []
    const summary = [
      digestSummaryText(digest),
      fallbackFactLines.length ? ['[群事实/决定]', ...fallbackFactLines].join('\n') : '',
      req.threadMemory.join('\n'),
    ].filter(Boolean).join('\n\n')
    const contextWindow = this.options.contextWindowFor?.(req.persona.model)
    // 禁言角色的窗口语义要保留：只给它窗口，不做跨窗口检索/记忆注入。
    const muted = req.thread.members.find((member) => member.personaId === req.persona.id)?.activity === 'muted'
    const memoryMode: MemoryContextMode = req.memoryContextMode ?? this.options.memoryContextMode ?? 'shadow'
    const memoryModeOn = memoryMode === 'on' && !muted
    // ── A-1 群级粘滞预算 ────────────────────────────────────────────────
    // 预算只由**显式输入**决定：在场成员（排除禁言）/ 成员模型窗口 / 档位 / ratio。
    // 同 signature 直接复用上一轮结果：消息条数、时间、轮次变化都不会让 windowChars 抖动
    // （同群同档位同 ratio 下完全相等）。预算真的变了才产生 budgetChanged 事件并写进回执。
    const recentMessages = req.thread.messages ?? []
    const recentText = recentMessages.slice(-20).map((message) => message.text).join('\n')
    const groupEntries = groupEntriesForThread(req.thread, {
      ...(this.options.contextWindowForPersona ? { contextWindowForPersona: this.options.contextWindowForPersona } : {}),
      ...(this.options.modelForPersona ? { modelForPersona: this.options.modelForPersona } : {}),
      fallback: { personaId: req.persona.id, ...(contextWindow === undefined ? {} : { contextWindow }) },
    })
    const tier = resolveTier(this.options.budgetTier ?? DEFAULT_BUDGET_TIER)
    const explicitRatio = typeof this.options.ratio === 'number' && Number.isFinite(this.options.ratio) ? this.options.ratio : undefined
    const signature = groupBudgetSignature(groupEntries, tier) + (explicitRatio === undefined ? '' : `#ratio:${explicitRatio}`)
    const priorBudget = this.budgetStates.get(req.thread.id)
    let baseBudget: ContextBudgetReceipt
    let budgetChanged: BudgetChangedEvent | undefined
    if (priorBudget && priorBudget.signature === signature) {
      baseBudget = priorBudget.receipt
    } else {
      // ratio 只在预算重建时确定：显式传入优先；否则用当前内容先验，之后随预算一起冻结（粘滞）。
      const ratio = explicitRatio ?? priorRatio(classifyComposition(recentText))
      const groupBudget = groupContextBudget(groupEntries, { tier, ratio })
      baseBudget = groupBudget
        ? budgetViewOf(groupBudget, { tier, signature })
        : fallbackBudgetView(contextWindow, tier, signature)
      if (priorBudget) {
        budgetChanged = budgetChangeOf({
          previous: priorBudget.receipt,
          next: baseBudget,
          previousInputs: { entries: priorBudget.entries, tier: priorBudget.tier, ratio: priorBudget.ratio },
          nextInputs: { entries: groupEntries, tier, ratio },
        })
      }
      this.budgetStates.set(req.thread.id, { signature, receipt: baseBudget, entries: groupEntries, tier, ratio })
    }
    // 摘要预算拆分：目录 : 摘要 = 40 : 60。只有记忆层真的注入（on 且未禁言）时才给目录留预算；
    // shadow/off 不注入目录，摘要用全额预算（旧行为/旧断言不变）。
    const summarySplit = memoryModeOn
      ? splitSummaryBudget(baseBudget.summaryChars, {
        ...(this.options.summaryChapterShare === undefined ? {} : { chapterShare: this.options.summaryChapterShare }),
      })
      : {
        totalChars: baseBudget.summaryChars,
        digestChars: baseBudget.summaryChars,
        chapterChars: 0,
        chapterShare: 0,
        digestShare: 1,
        notes: [] as string[],
      }
    const budget: ContextBudgetReceipt = {
      ...baseBudget,
      digestChars: summarySplit.digestChars,
      chapterChars: summarySplit.chapterChars,
    }
    const assigned = assignSeqs(req.visibleMessages)
    const basedOnSeq = assigned.reduce((max, message) => Math.max(max, message.seq), 0)
    const currentMessage = [...assigned].reverse().find((message) => message.kind === 'user')
    const summaryUntilInput = summaryUntil > 0 ? { summaryUntilSeq: summaryUntil } : {}
    const memoryClaims = claimsFromThread({
      ...(req.thread.facts ? { facts: req.thread.facts } : {}),
      ...(req.thread.consensusState ? { consensus: req.thread.consensusState } : {}),
    })
    // 1) 热区窗口（与 assemblePrompt 用的是同一份；不在这里再 selectWindow 一次）。
    const hot = selectWindow({
      messages: assigned,
      personaId: req.persona.id,
      personaName: req.persona.name,
      ...(currentMessage ? { currentId: currentMessage.id } : {}),
      ...summaryUntilInput,
      charBudget: budget.windowChars,
    })
    const hotSeqs = new Set(hot.map((message) => message.seq ?? 0))
    if (currentMessage) hotSeqs.add(currentMessage.seq ?? 0)
    // 2) L1 摘要行已经引用的 seq：目录/句柄块不能再重复引用（任何 seq 在 prompt 里最多出现一次）。
    const l1Seqs = digest
      ? [...digest.l1.matchAll(/#(\d+)/g)].map((match) => Number(match[1])).filter((seq) => Number.isFinite(seq) && seq > 0)
      : []
    const baseExclude = new Set<number>([...hotSeqs, ...l1Seqs])
    // 3) 引用句柄块：排除热区 + L1 已引用的 seq，避免同一段历史在 prompt 里出现两遍。
    const activeConclusions = (req.thread.facts ?? [])
      .filter((fact) => typeof fact.sourceMessageSeq === 'number' && isPromptVisibleFact(fact))
      .slice(0, 4)
      .map((fact) => ({ seq: fact.sourceMessageSeq as number, label: fact.text }))
    const memoryContext = memoryMode === 'off' || muted
      ? undefined
      : buildMemoryContext({
        messages: assigned,
        personaName: req.persona.name,
        currentText: currentMessage?.text ?? '',
        excludeSeqs: baseExclude,
        claims: memoryClaims,
        activeConclusions,
        mode: memoryMode,
      })
    const memoryBlock = memoryContext ? memoryBlockOf(memoryContext, memoryMode) : ''
    // 4) 冷区章节目录：排除热区 + L1 + 句柄块已经引用过的 seq（跨层去重）。
    const memorySeqs = new Set<number>()
    if (memoryContext) {
      for (const snippet of memoryContext.snippets) memorySeqs.add(snippet.seq)
      for (const handle of memoryContext.handles) memorySeqs.add(handle.seq)
      for (const handle of memoryContext.conclusions) memorySeqs.add(handle.seq)
      for (const segment of memoryContext.segments) {
        memorySeqs.add(segment.seqFrom)
        memorySeqs.add(segment.seqTo)
      }
    }
    const dual = buildDualWindow({
      messages: assigned,
      hot,
      personaId: req.persona.id,
      personaName: req.persona.name,
      ...(currentMessage ? { currentId: currentMessage.id } : {}),
      ...summaryUntilInput,
      windowChars: budget.windowChars,
      summaryChars: baseBudget.summaryChars,
      chapterShare: memoryModeOn ? summarySplit.chapterShare : 0,
      ...(memoryModeOn ? { targetChapterChars: Math.max(200, Math.floor(baseBudget.summaryChars / 3)) } : {}),
      ...(memoryClaims.size ? { claims: memoryClaims } : {}),
      excludeSeqs: new Set<number>([...baseExclude, ...memorySeqs]),
    })
    const excludeSeqs = new Set(dual.hot.map((message) => message.seq ?? 0))
    if (currentMessage) excludeSeqs.add(currentMessage.seq ?? 0)
    const chapterDirectory = memoryModeOn ? dual.directory : ''
    const mode: RetrievalMode = req.retrievalMode ?? this.options.retrievalMode ?? 'shadow'
    const retrieval = mode === 'off' || muted
      ? undefined
      : retrieveRelevant({
        messages: assigned,
        personaName: req.persona.name,
        ...(req.memberNames ? { memberNames: req.memberNames } : {}),
        currentText: currentMessage?.text ?? '',
        excludeSeqs,
        maxTotalChars: Math.max(400, Math.floor(budget.windowChars * 0.2)),
      })
    const stateBlock = muted ? '' : renderRoleState(req.roleState)
    const retrievalBlock = mode === 'on' ? renderRetrieval(retrieval) : ''
    const memoryReceipt: MemoryContextReceipt | undefined = memoryContext
      ? {
        ...memoryReceiptOf(memoryContext),
        ...(chapterDirectory
          ? {
            coldZone: {
              chapterIds: dual.cold.chapters.map((chapter) => chapter.chapterId),
              handleSeqs: chapterHandleSeqs(dual.cold),
              chars: chapterDirectory.length,
            },
          }
          : {}),
      }
      : undefined
    const consensusBlock = req.thread.consensusState ? renderConsensusPrompt(req.thread.consensusState).block : ''
    const stateSnapshotHash = req.roleState && !muted ? stableHash(JSON.stringify(req.roleState)) : undefined
    const assembled = assemblePrompt({
      messages: assigned,
      window: dual.hot,
      excludeSeqRefs: baseExclude,
      persona: req.persona,
      personaId: req.persona.id,
      personaName: req.persona.name,
      threadTitle: req.thread.title,
      threadKind: req.thread.kind,
      summary: truncateSummary(summary, summarySplit.digestChars),
      charBudget: budget.windowChars,
      ...(stateBlock ? { stateBlock } : {}),
      ...(consensusBlock ? { consensusBlock } : {}),
      ...(memoryBlock ? { memoryBlock } : {}),
      ...(chapterDirectory ? { contextBlock: chapterDirectory } : {}),
      ...(retrievalBlock ? { retrievalBlock } : {}),
      ...(currentMessage ? { currentId: currentMessage.id } : {}),
      ...summaryUntilInput,
    })
    // native 增量帧只吃 windowLines+currentLine+factsL2，所以摘要/目录要按"本轮用户文本"追加：
    // contextBlock = L1 摘要 + 冷区章节目录（仅在记忆层 on 时注入，system 前缀一律不动）。
    const nativeContextBlock = memoryModeOn
      ? [truncateSummary(digestSummaryText(digest), summarySplit.digestChars), chapterDirectory].filter(Boolean).join('\n\n')
      : ''
    const system = req.proactive
      ? assembled.system + '\n[主动私聊模式] 这是你主动发起的私聊，用户没有先提问：用 1-2 句（20-60 字）简短跟进或问候，可以结合你承诺过的事或最近群里的待办；不要提隐私、不要重复你上次说过的话、不要长篇大论。'
      : assembled.system
    const messages: { role: 'user' | 'assistant'; content: string | ModelContentPart[] }[] = [
      { role: 'user', content: modelContentForAttachments(assembled.prompt, currentMessage) },
    ]
    let raw: string
    let trace: TurnStepTrace[] | undefined
    try {
      raw = await this.transport.complete({
        model: req.persona.model,
        provider: req.persona.provider,
        system,
        messages,
        onTrace: (steps) => { if (steps.length) trace = steps },
        toolAllow: req.persona.toolAllow,
        projectRoot: req.thread.projectRoot,
        threadId: req.thread.id,
        personaId: req.persona.id,
        windowSeqs: assembled.window.map((message) => message.seq ?? 0),
        summaryUntil,
        factsVersion,
        ...(stateSnapshotHash ? { stateSnapshotHash } : {}),
        ...(retrieval
          ? {
            retrievalQuery: retrieval.query,
            retrievalHitIds: retrieval.hitIds,
            retrievalSelectedIds: retrieval.hits.map((hit) => hit.seq),
            indexVersion: retrieval.indexVersion,
          }
          : {}),
        ...(memoryReceipt ? { memoryContext: memoryReceipt } : {}),
        budget,
        ...(budgetChanged ? { budgetChanged } : {}),
        basedOnSeq,
        purpose: 'reply',
        personaName: req.persona.name,
        nativeFrame: nativeFrameFor(assembled.window, currentMessage, {
          factsL2: digest?.l2?.length ? digest.l2 : fallbackFactLines,
          factsUntilSeq: digest?.untilSeq ?? summaryUntil,
        }, memoryBlock, nativeContextBlock),
      })
    } catch (err) {
      throw new ModelCallError(req.persona.model, err)
    }
    raw = stripSpeakerPrefix(raw, req.persona.name, [
      ...(req.memberNames ?? []),
      ...req.visibleMessages.map((message) => message.authorName),
    ])
    if (!raw.trim()) throw new ModelCallError(req.persona.model, new Error('模型返回空内容'))
    return { ...interpretSpeech(raw, req.catalog, req.thread.id), basedOnSeq, ...(trace ? { trace } : {}) }
  }

  /**
   * 异步事实抽取（LLM 通道，低优先级）：只从最近消息里抽明确声明的事实。
   * 失败/解析不出来都返回空数组，绝不影响主回复。
   */
  async extractFacts(req: { thread: Thread; messages: Message[]; persona: Persona }): Promise<ExtractedFact[]> {
    const { system, prompt } = buildFactExtractionPrompt({
      threadTitle: req.thread.title,
      messages: req.messages,
    })
    let raw: string
    try {
      raw = await this.transport.complete({
        model: req.persona.model,
        provider: req.persona.provider,
        system,
        messages: [{ role: 'user', content: prompt }],
        projectRoot: req.thread.projectRoot,
        threadId: req.thread.id,
        personaId: req.persona.id,
        purpose: 'extract',
      })
    } catch {
      return []
    }
    const candidates = parseFactCandidates(raw)
    if (candidates.length === 0) return []
    const inputs = factInputsFromCandidates(candidates, Date.now(), req.messages)
    if (inputs.length < candidates.length) {
      logWarn(`[dsh-im] 事实抽取丢弃 ${candidates.length - inputs.length} 条缺少有效 sourceSeq 的候选`)
    }
    if (inputs.length === 0) {
      throw new ModelCallError(req.persona.model, new Error('抽取候选全部缺少有效 sourceSeq，已拒绝写入（provenance 是硬要求）'))
    }
    return inputs
  }

  /**
   * Curator：同一份 facts 整理成 A/B/C/D 聚类草稿（每轮一次的调用，purpose=curate）。
   * 输出形状由 parseCuratorOutput 校验；语义（覆盖/错栏/自述归档）由 consensus builder 强校验。
   */
  async curate(req: ConsensusCurateRequest): Promise<ConsensusDraft> {
    const { system, prompt } = buildCuratorPrompt({
      threadTitle: req.threadTitle,
      facts: req.facts.map((fact) => ({
        factId: fact.factId,
        owner: fact.owner,
        kind: fact.kind,
        text: fact.text,
      })),
    })
    let raw: string
    try {
      raw = await this.transport.complete({
        model: req.persona.model,
        provider: req.persona.provider,
        system,
        messages: [{ role: 'user', content: prompt }],
        ...(req.projectRoot ? { projectRoot: req.projectRoot } : {}),
        threadId: req.threadId,
        purpose: 'curate',
      })
    } catch (err) {
      throw new ModelCallError(req.persona.model, err)
    }
    const parsed = parseCuratorOutput(raw)
    if (!parsed.ok || !parsed.draft) {
      throw new ModelCallError(req.persona.model, new Error('curator 输出不合法：' + parsed.errors.slice(0, 3).join('；')))
    }
    return parsed.draft
  }
}

export class MockSpeaker implements Speaker {
  async complete(req: SpeakRequest): Promise<SpeakResult> {
    const last = req.visibleMessages.at(-1)?.text ?? ''
    const catalogHit = req.catalog.find((c) =>
      last.includes(c.title) || last.includes('缓存') && c.shortSummary.includes('缓存'),
    )
    if (catalogHit && catalogHit.threadId !== req.thread.id && /另一场|之前|群/.test(last)) {
      return {
        text: `我想起「${catalogHit.title}」里好像谈过类似内容，要不要调出来？`,
        proposeRecallThreadId: catalogHit.threadId,
      }
    }
    if (/没增量|没什么|同意前面/.test(last) || req.focus === 'PASS') {
      return { text: 'PASS：本焦点没有增量。', pass: true }
    }
    const seen = req.visibleMessages
      .filter((m) => m.kind === 'persona')
      .map((m) => m.text)
      .join(' ')
    if (seen.length > 80 && !req.focus) {
      return { text: 'PASS：前面已经覆盖，没有增量。', pass: true }
    }
    return {
      text: `【${req.persona.name} · ${req.focus}】针对「${last.slice(0, 40)}」：从${req.persona.duties[0] || '职责'}看，建议写进本场汇总，不改已有源码。`,
    }
  }
}

export function defaultChair(): ChairSelector {
  return new DutyChair()
}
