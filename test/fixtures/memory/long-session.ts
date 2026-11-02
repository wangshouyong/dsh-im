/**
 * 长会话 fixture（A 的 A-1/A-2/A-3 与 B 的冷区多跳题共用）。
 *
 * 为什么需要：pilot 只有 200 条、每 10 条一个话题，冷区太短，测不出
 * 「600 条历史 + 冷区章节目录 + 多跳展开」的真实行为。这里用**确定性生成器**
 * （无随机、无时钟）造 600 条消息，并固化预算输入（`{tier, groupTokens, allocation, groupMinModel}`），
 * 让黄金回放可以只比对语义字段。
 *
 * 分布（显式构造，不靠随机）：
 * - 前 6 个话题（seq ≤ 72）放目标事实：决定 / 约束 / 数字 / 文件 / 补充引用（多跳跳板）；
 * - 每 5 个话题一条后段决定（保持长会话仍有决定分布）；
 * - 每 7 个话题一条数字/文件（保持细节分布）；
 * - 每 3 个话题一条开放问题；
 * - seq 37 与 61 的决定各被后段一条修订取代（superseded 分布；
 *   注意它们同时也是冷区题库的目标，用来验证"过期也只能降级引用、不能当现状"）。
 */
import type { FixtureClaim, FixtureMessage } from './schema.ts'
import type { ThreadMember } from '../../../src/core/types.ts'
import { classifyComposition, priorRatio } from '../../../src/core/calibration-samples.ts'
import { allocateContextBudget, groupContextTokens, type ContextAllocation } from '../../../src/core/context-budget.ts'
import { splitSummaryBudget, type SummaryBudgetSplit } from '../../../src/core/chapter-tree.ts'
import { DEFAULT_BUDGET_TIER, type BudgetTier } from '../../../src/core/budget-plan.ts'

export const LONG_SESSION_SCHEMA = 1
export const LONG_SESSION_TOTAL_MESSAGES = 600
export const LONG_SESSION_SEGMENT_SIZE = 12
export const LONG_SESSION_BASE_AT = 1_700_000_000_000

const TOPICS = [
  '支付灰度',
  '风控策略',
  '消息投递',
  '计费对账',
  '权限模型',
  '搜索排序',
  '附件上传',
  '模型路由',
  '任务调度',
  '数据导出',
]

export interface LongSessionBudget {
  tier: BudgetTier
  /** 内容先验 ratio（由最近 20 条消息的构成算出；回放时必须与运行时一致）。 */
  ratio: number
  groupTokens: number
  /** 决定预算的成员（最小上下文窗口）。 */
  groupMinModel: { personaId: string; model: string; contextWindow: number }
  allocation: ContextAllocation
  summarySplit: SummaryBudgetSplit
}

export interface LongSessionFixture {
  schema: number
  id: string
  kind: 'synthetic'
  thread: {
    id: string
    title: string
    messages: FixtureMessage[]
    topicBoundaries: number[]
    planted: { seq: number; category: string; text: string }[]
    claims: FixtureClaim[]
    members: ThreadMember[]
  }
  /** 固化预算输入：黄金回放直接比对它（不许只靠"同一段代码再算一遍"）。 */
  budget: LongSessionBudget
}

export const LONG_SESSION_PERSONAS = [
  { personaId: 'p-pm', name: '产品经理', model: 'mock-256k', contextWindow: 256_000 },
  { personaId: 'p-arch', name: '架构师', model: 'mock-1m', contextWindow: 1_000_000 },
] as const

export const LONG_SESSION_MEMBERS: ThreadMember[] = LONG_SESSION_PERSONAS.map((persona) => ({
  personaId: persona.personaId,
  activity: 'review',
  completedRound: false,
  passedRound: false,
}))

/** fixture 固化的 claim 状态 → 章节目录/展开用的 Map（未列出的 seq 视为 raw）。 */
export function claimsOf(fixture: LongSessionFixture): Map<number, { state: 'raw' | 'active' | 'superseded'; successorSeq?: number }> {
  return new Map(fixture.thread.claims.map((claim) => [
    claim.seq,
    {
      state: claim.state,
      ...(claim.successorSeq === undefined ? {} : { successorSeq: claim.successorSeq }),
    },
  ]))
}

function segmentStart(segment: number): number {
  return (segment - 1) * LONG_SESSION_SEGMENT_SIZE + 1
}

/** 目标事实 seq（提前算好，题目和 fixture 共用，避免手抄错）。 */
export const LONG_SESSION_TARGETS = {
  decision: (segment: number) => segmentStart(segment) + 3,
  constraint: (segment: number) => segmentStart(segment) + 5,
  numberOrFile: (segment: number) => segmentStart(segment) + 7,
  supplement: (segment: number) => segmentStart(segment) + 11,
}

function message(
  seq: number,
  kind: FixtureMessage['kind'],
  authorName: string,
  text: string,
): FixtureMessage {
  return { seq, kind, authorName, text, at: LONG_SESSION_BASE_AT + seq * 60_000 }
}

function buildMessages(): FixtureMessage[] {
  const messages: FixtureMessage[] = []
  for (let segment = 1; segment <= LONG_SESSION_TOTAL_MESSAGES / LONG_SESSION_SEGMENT_SIZE; segment++) {
    const start = segmentStart(segment)
    const topic = TOPICS[(segment - 1) % TOPICS.length]
    const seqs = Array.from({ length: LONG_SESSION_SEGMENT_SIZE }, (_, index) => start + index)
    for (const seq of seqs) {
      const offset = seq - start
      const odd = segment % 2 === 1
      // 目标事实区：前 6 个话题，seq ≤ 72（答案全部落在 150 条以前）。
      const isTargetZone = segment <= 6
      if (isTargetZone && offset === 3) {
        messages.push(message(seq, 'user', '你', `决定 D-${segment}：${topic} 的灰度先放 3% 流量，回滚窗口 10 分钟。`))
        continue
      }
      if (isTargetZone && offset === 5) {
        messages.push(message(seq, 'user', '你', `约束 C-${segment}：跨批次必须人工复核，禁止自动回滚。`))
        continue
      }
      if (isTargetZone && offset === 7) {
        messages.push(message(seq, 'user', '你', odd
          ? `数字 N-${segment}：压测口径 ${1000 + segment} 次采样，失败率阈值 0.${(segment % 9) + 1}7%。`
          : `文件 F-${segment}：边界条件以 src/core/policy-${segment}.ts 为准。`))
        continue
      }
      if (isTargetZone && offset === 11) {
        const ref = LONG_SESSION_TARGETS.numberOrFile(segment)
        messages.push(message(seq, 'user', '你', `补充 S-${segment}：D-${segment} 的口径详见 #${ref}，按那边执行。`))
        continue
      }
      // 后段决定 / 数字 / 开放问题：保持长会话的分布，同时不抢目标区的话柄额度。
      if (!isTargetZone && offset === 3 && segment % 5 === 0) {
        messages.push(message(seq, 'user', '你', `决定 D-${segment}：${topic} 的方案按当前版本推进，本周内评审。`))
        continue
      }
      if (!isTargetZone && offset === 5 && segment % 7 === 0) {
        messages.push(message(seq, 'persona', '架构师', `文件 G-${segment}：细节在 src/host/gate-${segment}.ts。`))
        continue
      }
      if (!isTargetZone && offset === 8 && segment % 3 === 0) {
        messages.push(message(seq, 'user', '你', `待确认 Q-${segment}：${topic} 的负责人是谁？还没定。`))
        continue
      }
      // 修订（superseded）：D-3 / D-5 被后段修订取代——既覆盖 superseded 分布，
      // 又让"过期目标事实"只能以目录降级引用出现。
      if (segment === 8 && offset === 3) {
        messages.push(message(seq, 'user', '你', `修订 R-3：D-3 的灰度改到 5%（取代上一条决定）。`))
        continue
      }
      if (segment === 9 && offset === 3) {
        messages.push(message(seq, 'user', '你', `修订 R-5：D-5 的灰度改到 8%（取代上一条决定）。`))
        continue
      }
      // 普通讨论：交替用户/角色，内容确定。
      if (offset === 0) {
        messages.push(message(seq, 'user', '你', `第 ${segment} 个话题：继续对齐 ${topic} 的口径和负责人。`))
        continue
      }
      if (offset === 2) {
        messages.push(message(seq, 'user', '你', `背景 ${segment}-B：${topic} 先按上一版接口和排期推进。`))
        continue
      }
      messages.push(message(seq, 'persona', seq % 2 === 0 ? '产品经理' : '架构师', `第 ${seq} 条：${topic} 这个点先记下来，后面再对。`))
    }
  }
  return messages
}

function buildPlanted(messages: readonly FixtureMessage[]): LongSessionFixture['thread']['planted'] {
  const planted: LongSessionFixture['thread']['planted'] = []
  for (const target of messages) {
    if (/^(决定 D-|约束 C-|数字 N-|文件 F-|补充 S-|修订 R-)/.test(target.text)) {
      planted.push({
        seq: target.seq,
        category: target.text.startsWith('决定') ? 'decision'
          : target.text.startsWith('约束') ? 'constraint'
            : target.text.startsWith('补充') || target.text.startsWith('修订') ? 'stale'
              : target.text.startsWith('数字') ? 'number' : 'file',
        text: target.text,
      })
    }
  }
  return planted
}

function buildClaims(): FixtureClaim[] {
  return [
    { seq: LONG_SESSION_TARGETS.decision(3), state: 'superseded', successorSeq: LONG_SESSION_TARGETS.decision(8) },
    { seq: LONG_SESSION_TARGETS.decision(8), state: 'active' },
    { seq: LONG_SESSION_TARGETS.decision(5), state: 'superseded', successorSeq: LONG_SESSION_TARGETS.decision(9) },
    { seq: LONG_SESSION_TARGETS.decision(9), state: 'active' },
    // 目标句柄里有 active 状态，验证"status 贯穿"在目录/展开里都不丢。
    ...LONG_SESSION_PERSONAS.length ? [{ seq: LONG_SESSION_TARGETS.constraint(1), state: 'raw' as const }] : [],
  ]
}

/**
 * 预算（**固化值**，不在这里重算）。
 *
 * 生成方式（一次性）：用与运行时同一套纯函数算出后写死；
 * 单测 `long-session-fixture.test.ts` 会断言「现在重算 == 固化值」，公式/输入变了就必须显式改 fixture。
 * 这组数字的输入：tier=standard、成员 256k(p-pm)+1M(p-arch)、ratio=2.189（最近 20 条的内容先验）。
 */
export const LONG_SESSION_BUDGET: LongSessionBudget = {
  tier: 'standard',
  ratio: 2.189,
  groupTokens: 64_000,
  groupMinModel: { personaId: 'p-pm', model: 'mock-256k', contextWindow: 256_000 },
  allocation: {
    tokens: 64_000,
    ratio: 2.189,
    windowChars: 72_695,
    summaryChars: 20_174,
    factsCount: 60,
    memoryChars: 8_000,
    notes: ['memory-rollover-to-window'],
  },
  summarySplit: {
    totalChars: 20_174,
    digestChars: 12_105,
    chapterChars: 8_069,
    chapterShare: 0.4,
    digestShare: 0.6,
    notes: [],
  },
}

/** 用当前公式 + 当前消息重算预算（单测用它证明固化值没被悄悄改掉）。 */
export function recomputeLongSessionBudget(): LongSessionBudget {
  const messages = buildMessages()
  const recentText = messages.slice(-20).map((item) => item.text).join('\n')
  const ratio = priorRatio(classifyComposition(recentText))
  const entries = LONG_SESSION_PERSONAS.map((persona) => ({
    personaId: persona.personaId,
    model: persona.model,
    contextWindow: persona.contextWindow,
  }))
  const decision = groupContextTokens(entries, DEFAULT_BUDGET_TIER)
  const allocation = allocateContextBudget(decision.tokens, { ratio })
  const summarySplit = splitSummaryBudget(allocation.summaryChars)
  return {
    tier: DEFAULT_BUDGET_TIER,
    ratio,
    groupTokens: decision.tokens,
    ...(decision.smallest
      ? { groupMinModel: { personaId: decision.smallest.personaId, model: decision.smallest.model ?? '', contextWindow: decision.smallest.contextWindow } }
      : { groupMinModel: { personaId: 'p-pm', model: 'mock-256k', contextWindow: 256_000 } }),
    allocation,
    summarySplit,
  }
}

export function buildLongSessionFixture(): LongSessionFixture {
  return {
    schema: LONG_SESSION_SCHEMA,
    id: 'long-600',
    kind: 'synthetic',
    thread: {
      id: 'fixture-long-600',
      title: '600 条长会话（支付灰度 / 长周期评审）',
      messages: buildMessages(),
      topicBoundaries: Array.from(
        { length: LONG_SESSION_TOTAL_MESSAGES / LONG_SESSION_SEGMENT_SIZE },
        (_, index) => segmentStart(index + 1),
      ),
      planted: buildPlanted(buildMessages()),
      claims: buildClaims(),
      members: LONG_SESSION_MEMBERS,
    },
    budget: LONG_SESSION_BUDGET,
  }
}
