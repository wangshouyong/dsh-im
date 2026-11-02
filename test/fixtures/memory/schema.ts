/**
 * 记忆层 fixture 的 ground truth schema（Phase 0）。
 *
 * 为什么先定 schema：`目录兜底率 ≥50%`、`双传输一致率 ≥90%` 这类验收指标没有 ground truth 就是口号。
 * 这里把「一个问题和哪些 seq / 哪些段相关」写成数据，测试和后续 Phase 的验收都读同一份。
 *
 * 口径约定（写进 docs/DESIGN.md）：
 * - **seq 级命中**：正确原文 seq 是否被检索/展开拿到（严格指标）；
 * - **段级兜底**：正确内容所在的「话题段」是否出现在目录里（宽松指标，兜底率用它）；
 * - `anchorType` 决定该题走哪条验收线，不要把 paraphrase 混进 anchored 的 90% 门；
 * - `expectation=downgrade` 表示「必须命中但只能降级为目录引用」——过期口径的验收形态。
 */
export const MEMORY_FIXTURE_SCHEMA = 1

export type AnchorType = 'anchored' | 'paraphrase' | 'multi-hop' | 'negative' | 'injection' | 'stale-conflict'

export type MemoryExpectation = 'hit' | 'no-hit' | 'downgrade'

export type PlantedCategory = 'decision' | 'detail' | 'file' | 'number' | 'injection' | 'stale'

export interface FixtureMessage {
  seq: number
  kind: 'user' | 'persona' | 'system'
  authorName: string
  text: string
  at: number
}

export interface FixtureClaim {
  seq: number
  state: 'active' | 'superseded' | 'raw'
  successorSeq?: number
}

export interface MemoryFixtureQuestion {
  id: string
  question: string
  anchorType: AnchorType
  /** seq 级命中目标（ground truth）。negative 必须为空。 */
  relatedSeqs: number[]
  /** 段级兜底目标：段号 = 段首用户消息的 seq。 */
  relatedSegments: number[]
  expectation: MemoryExpectation
  /** 这道题是否应该触发记忆工具（双向门里的"应触发"侧；negative 为 false）。 */
  needsHistoryTool: boolean
  notes?: string
}

export interface MemoryFixture {
  schema: number
  id: string
  kind: 'synthetic' | 'real'
  thread: {
    id: string
    title: string
    messages: FixtureMessage[]
    /** 显式话题边界（段首用户消息 seq）。合成数据必须显式标注，不能让拼接边界污染分段测试。 */
    topicBoundaries: number[]
    planted: { seq: number; category: PlantedCategory; text: string }[]
    /** 期望的 claim 状态（Phase 1 给索引/状态过滤做 ground truth）。 */
    claims: FixtureClaim[]
  }
  questions: MemoryFixtureQuestion[]
}

/** 样本量与统计口径（Phase 0 定义；Phase 1 才按它设硬门）。 */
export const FIXTURE_SAMPLE = {
  /** Phase 0 pilot：每类 6 题（跑通流程 + 测基线，不设硬门）。 */
  pilotPerCategory: 6,
  /** Phase 1 设硬门前的最低样本量。 */
  gatePerCategory: 30,
  /** 小样本下 ≥90% 的差异容忍：小于这个样本量时只看差异不超过 10 个百分点。 */
  parityTolerancePp: 10,
  parityMinSample: 30,
} as const

const ANCHOR_TYPES: readonly AnchorType[] = ['anchored', 'paraphrase', 'multi-hop', 'negative', 'injection', 'stale-conflict']

/** 校验 fixture 自洽性；返回错误列表（空 = 合法）。 */
export function validateMemoryFixture(fixture: MemoryFixture): string[] {
  const errors: string[] = []
  if (fixture.schema !== MEMORY_FIXTURE_SCHEMA) errors.push(`schema 必须是 ${MEMORY_FIXTURE_SCHEMA}`)
  if (!fixture.thread?.messages?.length) errors.push('thread.messages 不能为空')

  const seqs = new Set(fixture.thread.messages.map((message) => message.seq))
  const userSeqs = new Set(fixture.thread.messages.filter((message) => message.kind === 'user').map((message) => message.seq))
  for (const boundary of fixture.thread.topicBoundaries) {
    if (!userSeqs.has(boundary)) errors.push(`话题边界 ${boundary} 不是用户消息 seq`)
  }
  for (const planted of fixture.thread.planted) {
    if (!seqs.has(planted.seq)) errors.push(`planted seq ${planted.seq} 不存在`)
  }

  const ids = new Set<string>()
  for (const question of fixture.questions) {
    if (ids.has(question.id)) errors.push(`问题 id 重复：${question.id}`)
    ids.add(question.id)
    if (!ANCHOR_TYPES.includes(question.anchorType)) errors.push(`${question.id}: anchorType 非法`)
    for (const seq of question.relatedSeqs) {
      if (!seqs.has(seq)) errors.push(`${question.id}: relatedSeq ${seq} 不存在`)
    }
    for (const segment of question.relatedSegments) {
      if (!fixture.thread.topicBoundaries.includes(segment)) errors.push(`${question.id}: relatedSegment ${segment} 不是话题边界`)
    }
    if (question.anchorType === 'negative') {
      if (question.relatedSeqs.length > 0) errors.push(`${question.id}: negative 不应有 relatedSeqs`)
      if (question.expectation !== 'no-hit') errors.push(`${question.id}: negative 的 expectation 必须是 no-hit`)
      if (question.needsHistoryTool) errors.push(`${question.id}: negative 不应要求触发记忆工具`)
    } else if (question.relatedSeqs.length === 0) {
      errors.push(`${question.id}: 非 negative 必须有 relatedSeqs（ground truth 不能空）`)
    }
    if (question.anchorType === 'stale-conflict' && question.expectation !== 'downgrade') {
      errors.push(`${question.id}: stale-conflict 的 expectation 必须是 downgrade`)
    }
    if (question.anchorType === 'injection' && !question.notes?.includes('包裹')) {
      errors.push(`${question.id}: injection 题必须在 notes 里写明"包裹/指令隔离"要求`)
    }
  }
  return errors
}

/** 按 anchorType 统计题量（验收用）。 */
export function countByAnchorType(fixture: MemoryFixture): Record<AnchorType, number> {
  const counts = Object.fromEntries(ANCHOR_TYPES.map((type) => [type, 0])) as Record<AnchorType, number>
  for (const question of fixture.questions) counts[question.anchorType] += 1
  return counts
}
