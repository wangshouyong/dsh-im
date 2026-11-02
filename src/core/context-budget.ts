/**
 * 群级上下文预算（按群里**最小上下文**统一压）。
 *
 * 为什么按最小而不是按发言者各自：同一轮里不同成员如果看到不同长度的上下文，
 * 会各说各话（1M 角色看到 150k tokens，256k 角色只看到 64k）。统一预算后，
 * 同一轮所有人共享同一份"压缩后的上下文"，一致性优先；1M 角色想看得更多，
 * 用 memory_search / memory_expand 按需拉原文（推压缩 + 拉原文）。
 *
 * 预算 = min(
 *   每个在场成员模型: min(上下文 × 档位份额, 档位绝对上限)
 * )
 * 再按固定份额分给四块：窗口 60% / 摘要 18% / 事实 10% / 记忆 12%。
 * 全确定性：同一组输入永远算出同一预算，可回放、可 golden 对照。
 */
import {
  BUDGET_SAFETY,
  DEFAULT_BUDGET_TIER,
  DEFAULT_RATIO,
  resolveTier,
  type BudgetTier,
} from './budget-plan.ts'
import { RATIO_MAX, RATIO_MIN } from './calibration-samples.ts'
import { BUDGET_TIERS } from './budget-plan.ts'

/** 四块份额；窗口用不完时记忆块上限内的余量回流窗口。 */
export const CONTEXT_BLOCK_SHARES = { window: 0.6, summary: 0.18, facts: 0.1, memory: 0.12 } as const

/** 摘要/记忆块的字符硬上限（防单块吃穿预算；数值来自实测成本与可读性）。 */
export const MAX_SUMMARY_BLOCK_CHARS = 32_000
export const MAX_MEMORY_BLOCK_CHARS = 8_000
export const MIN_MEMORY_BLOCK_CHARS = 1_400
export const MIN_SUMMARY_BLOCK_CHARS = 2_000
export const MAX_WINDOW_BLOCK_CHARS = 400_000
export const MIN_WINDOW_BLOCK_CHARS = 4_000

export interface GroupContextEntry {
  personaId: string
  model?: string
  contextWindow?: number
}

export interface GroupTokensDecision {
  /** 群级 token 预算（= 最小成员窗口 × 份额，再夹档位上限）。 */
  tokens: number
  tier: BudgetTier
  /** 决定预算的那个成员（最小窗口）；没有任何窗口信息时 undefined。 */
  smallest?: { personaId: string; model?: string; contextWindow: number }
  /** 有窗口信息的成员数（0 = 调用方应退回旧估算）。 */
  knownWindows: number
  clampedBy: 'member-window' | 'tier-cap'
}

/** 群级 token 预算：取在场成员里最小上下文。 */
export function groupContextTokens(entries: readonly GroupContextEntry[], tier: unknown = DEFAULT_BUDGET_TIER): GroupTokensDecision {
  const resolvedTier = resolveTier(tier)
  const spec = BUDGET_TIERS[resolvedTier]
  const known = entries
    .filter((entry) => typeof entry.contextWindow === 'number' && (entry.contextWindow ?? 0) > 0)
    .map((entry) => ({ ...entry, contextWindow: entry.contextWindow as number }))
  if (known.length === 0) {
    return { tokens: spec.tokens, tier: resolvedTier, knownWindows: 0, clampedBy: 'tier-cap' }
  }
  const smallest = known.reduce((left, right) => (right.contextWindow < left.contextWindow ? right : left))
  const shareCap = Math.floor(smallest.contextWindow * spec.maxShare)
  if (shareCap >= spec.tokens) {
    return { tokens: spec.tokens, tier: resolvedTier, smallest, knownWindows: known.length, clampedBy: 'tier-cap' }
  }
  return { tokens: shareCap, tier: resolvedTier, smallest, knownWindows: known.length, clampedBy: 'member-window' }
}

export interface ContextAllocation {
  tokens: number
  ratio: number
  windowChars: number
  summaryChars: number
  factsCount: number
  memoryChars: number
  notes: string[]
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 把群级 token 预算按份额换成各块的字符/条数预算（确定性）。 */
export function allocateContextBudget(tokens: number, options: { ratio?: number; factsMax?: number } = {}): ContextAllocation {
  const raw = typeof options.ratio === 'number' && Number.isFinite(options.ratio) ? options.ratio : DEFAULT_RATIO
  const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, raw))
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0
  const charsFor = (share: number) => safeTokens * share * ratio * BUDGET_SAFETY
  const memoryRaw = clampNumber(charsFor(CONTEXT_BLOCK_SHARES.memory), MIN_MEMORY_BLOCK_CHARS, MAX_MEMORY_BLOCK_CHARS)
  const memoryChars = memoryRaw
  // 记忆块吃不满预算时，余量回流窗口（摘要/事实按各自上限，不回流）。
  const memoryBudgetChars = charsFor(CONTEXT_BLOCK_SHARES.memory)
  const rollover = Math.max(0, memoryBudgetChars - memoryChars)
  const windowChars = clampNumber(
    charsFor(CONTEXT_BLOCK_SHARES.window) + rollover,
    MIN_WINDOW_BLOCK_CHARS,
    MAX_WINDOW_BLOCK_CHARS,
  )
  const summaryChars = clampNumber(charsFor(CONTEXT_BLOCK_SHARES.summary), MIN_SUMMARY_BLOCK_CHARS, MAX_SUMMARY_BLOCK_CHARS)
  const factsChars = charsFor(CONTEXT_BLOCK_SHARES.facts)
  const factsMax = clampNumber(options.factsMax ?? 60, 12, 120)
  const factsCount = clampNumber(factsChars / 50, 12, factsMax)
  return {
    tokens: safeTokens,
    ratio: Math.round(ratio * 1000) / 1000,
    windowChars,
    summaryChars,
    factsCount,
    memoryChars,
    notes: rollover > 0 ? ['memory-rollover-to-window'] : [],
  }
}

export interface GroupContextBudget extends GroupTokensDecision, ContextAllocation {}

/** 一次性算出群级预算 + 四块分配；没有任何窗口信息时返回 undefined（调用方回退）。 */
export function groupContextBudget(
  entries: readonly GroupContextEntry[],
  options: { tier?: unknown; ratio?: number } = {},
): GroupContextBudget | undefined {
  const decision = groupContextTokens(entries, options.tier)
  if (decision.knownWindows === 0) return undefined
  return { ...decision, ...allocateContextBudget(decision.tokens, { ratio: options.ratio }) }
}

/* ------------------------------------------------------------------ *
 * A-1：**粘滞群预算**的输入/回执/变更事件（纯函数，运行时与 ImService 共用）
 * ------------------------------------------------------------------ */

/** 群级预算的输入来源（客户端注入；prompt 组装与摘要生成必须用同一份输入）。 */
export interface GroupBudgetPolicy {
  /** economy / standard / deep。 */
  tier?: unknown
  /** chars/token（内容先验或校准；不传则 allocate 用 DEFAULT_RATIO）。 */
  ratio?: number
  /** 按角色查模型上下文窗口（群里取在场成员最小值）。 */
  contextWindowForPersona?: (personaId: string) => number | undefined
  /** 按角色查模型 id（写进 groupMinModel，便于回执定位）。 */
  modelForPersona?: (personaId: string) => string | undefined
  /** 当前发言角色自己的窗口：没有按角色查表时用它兜底（与旧 runtime 行为一致）。 */
  fallback?: { personaId: string; contextWindow?: number }
}

/** 在场成员（排除禁言）→ 群级预算条目；按 personaId 排序保证同一群签名稳定。 */
export function groupEntriesForThread(
  thread: Pick<import('./types.ts').Thread, 'members'> | { members?: readonly { personaId: string; activity: string }[] },
  policy: GroupBudgetPolicy = {},
): GroupContextEntry[] {
  const members = [...(thread.members ?? [])]
    .filter((member) => member.activity !== 'muted')
    .sort((left, right) => left.personaId.localeCompare(right.personaId))
  return members.map((member) => {
    const window = policy.contextWindowForPersona?.(member.personaId)
      ?? (policy.fallback && policy.fallback.personaId === member.personaId ? policy.fallback.contextWindow : undefined)
    const model = policy.modelForPersona?.(member.personaId)
    return {
      personaId: member.personaId,
      ...(model ? { model } : {}),
      ...(window === undefined ? {} : { contextWindow: window }),
    }
  })
}

/** 群级预算（thread 版本）；没有成员的窗口信息时返回 undefined（调用方回退旧估算）。 */
export function groupBudgetForThread(
  thread: Pick<import('./types.ts').Thread, 'members'> | { members?: readonly { personaId: string; activity: string }[] },
  policy: GroupBudgetPolicy = {},
): GroupContextBudget | undefined {
  return groupContextBudget(groupEntriesForThread(thread, policy), {
    ...(policy.tier === undefined ? {} : { tier: policy.tier }),
    ...(policy.ratio === undefined ? {} : { ratio: policy.ratio }),
  })
}

/** 预算输入签名：只有成员集合 / 模型窗口 / 档位变化才会变（消息条数、时间不参与）。 */
export function groupBudgetSignature(entries: readonly GroupContextEntry[], tier: unknown): string {
  const resolved = resolveTier(tier)
  const members = [...entries]
    .map((entry) => `${entry.personaId}:${entry.model ?? ''}:${entry.contextWindow ?? ''}`)
    .sort()
    .join('|')
  return `${resolved}#${members}`
}

/** 回执里的预算快照（结构化、可 diff；不含正文/时间）。 */
export const CONTEXT_BUDGET_VERSION = 'context-budget-v1'

export interface ContextBudgetReceipt {
  version: string
  source: 'group' | 'fallback'
  tier: BudgetTier
  tokens: number | null
  ratio: number
  windowChars: number
  summaryChars: number
  digestChars: number
  chapterChars: number
  memoryChars: number
  factsCount: number
  groupMinModel?: { personaId: string; model?: string; contextWindow: number }
  /** 预算输入签名（同签名 = 同一预算；粘滞保证同签名不重算）。 */
  signature: string
}

export interface BudgetChangedEvent {
  from: Pick<ContextBudgetReceipt, 'tokens' | 'tier' | 'windowChars' | 'summaryChars' | 'groupMinModel'>
  to: Pick<ContextBudgetReceipt, 'tokens' | 'tier' | 'windowChars' | 'summaryChars' | 'groupMinModel'>
  reason: 'members' | 'model' | 'tier' | 'ratio'
}

export function budgetViewOf(
  budget: ContextAllocation | GroupContextBudget,
  input: { tier?: unknown; source?: 'group' | 'fallback'; signature?: string },
): ContextBudgetReceipt {
  const group = 'clampedBy' in budget ? budget as GroupContextBudget : undefined
  const tier = resolveTier(input.tier)
  return {
    version: CONTEXT_BUDGET_VERSION,
    source: input.source ?? (group ? 'group' : 'fallback'),
    tier: group?.tier ?? tier,
    tokens: group ? group.tokens : null,
    ratio: budget.ratio,
    windowChars: budget.windowChars,
    summaryChars: budget.summaryChars,
    digestChars: 0,
    chapterChars: 0,
    memoryChars: budget.memoryChars,
    factsCount: budget.factsCount,
    ...(group?.smallest
      ? {
        groupMinModel: {
          personaId: group.smallest.personaId,
          ...(group.smallest.model ? { model: group.smallest.model } : {}),
          contextWindow: group.smallest.contextWindow,
        },
      }
      : {}),
    signature: input.signature ?? groupBudgetSignature([], input.tier),
  }
}

function comparableBudget(receipt: ContextBudgetReceipt): BudgetChangedEvent['from'] {
  return {
    tokens: receipt.tokens,
    tier: receipt.tier,
    windowChars: receipt.windowChars,
    summaryChars: receipt.summaryChars,
    ...(receipt.groupMinModel ? { groupMinModel: receipt.groupMinModel } : {}),
  }
}

/**
 * 预算变更事件：**只有显式输入变化**（成员集合 / 模型窗口 / 档位 / ratio）才会返回。
 * 消息条数、时间、轮次都不在判据里；同输入必然返回 undefined（单测锁死）。
 */
export function budgetChangeOf(input: {
  previous: ContextBudgetReceipt | undefined
  next: ContextBudgetReceipt
  previousInputs?: { entries: readonly GroupContextEntry[]; tier: unknown; ratio: number }
  nextInputs: { entries: readonly GroupContextEntry[]; tier: unknown; ratio: number }
}): BudgetChangedEvent | undefined {
  const { previous, next } = input
  if (!previous) return undefined
  const same = previous.tokens === next.tokens
    && previous.tier === next.tier
    && previous.windowChars === next.windowChars
    && previous.summaryChars === next.summaryChars
    && JSON.stringify(previous.groupMinModel ?? null) === JSON.stringify(next.groupMinModel ?? null)
  if (same) return undefined
  let reason: BudgetChangedEvent['reason'] = 'ratio'
  const before = input.previousInputs
  if (before) {
    const tierChanged = resolveTier(before.tier) !== resolveTier(input.nextInputs.tier)
    const memberIdsBefore = before.entries.map((entry) => entry.personaId).sort().join('|')
    const memberIdsAfter = input.nextInputs.entries.map((entry) => entry.personaId).sort().join('|')
    const windowsBefore = before.entries.map((entry) => `${entry.personaId}:${entry.model ?? ''}:${entry.contextWindow ?? ''}`).sort().join('|')
    const windowsAfter = input.nextInputs.entries.map((entry) => `${entry.personaId}:${entry.model ?? ''}:${entry.contextWindow ?? ''}`).sort().join('|')
    if (tierChanged) reason = 'tier'
    else if (memberIdsBefore !== memberIdsAfter) reason = 'members'
    else if (windowsBefore !== windowsAfter) reason = 'model'
    else reason = 'ratio'
  }
  return { from: comparableBudget(previous), to: comparableBudget(next), reason }
}
