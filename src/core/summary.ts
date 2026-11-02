/**
 * 群级分层摘要投影（L0 详细 → L1 粗 → L2 事实/决策/待办）。
 *
 * - L1：旧消息压缩成一行一条（增量合并：只把上次覆盖之后的新旧消息追加进来）；
 * - L2：事实投影里的不可压缩项（决定/待办/承诺/约束）永远保留；
 * - `untilSeq`：摘要覆盖到的消息 seq，prompt 窗口只取它之后的消息。
 *
 * 本文件是纯函数、不调模型：它替代“同步 LLM 摘要”这条慢路径，
 * 以后接 LLM 摘要时把 L1 来源换掉即可（接口不变、失败仍能回退到窗口）。
 */
import { factsFromMessages, formatFact, INCOMPRESSIBLE_KINDS, isPromptVisibleFact, projectFactsFromList } from './facts.ts'
import { stableHash } from './receipt.ts'
import type { Fact, Message, SummaryDigest, Thread } from './types.ts'

/** 与 prompt 默认窗口一致：最近 20 条留原文，更早的进 L1。 */
export const SUMMARY_KEEP_RECENT = 20
/** L1 的字符预算：超了就从最旧的行开始丢（L2 不可压缩项不受影响）。 */
export const L1_CHAR_BUDGET = 8000
/** L2 最多保留多少条事实（按不可压缩项优先）。 */
export const L2_MAX_FACTS = 40
const L1_ITEM_MAX = 60

const NOISE = /本轮开始|本轮弃权|全员暂停|跨场召回|先当参考|汇总已写入/

function seqOf(message: Message, index: number): number {
  return message.seq ?? index + 1
}

function l1Line(message: Message, seq: number): string {
  const text = message.text.replace(/\s+/g, ' ').trim()
  return `[#${seq}] ${message.authorName}：${text.slice(0, L1_ITEM_MAX)}`
}

function digestVersion(input: { untilSeq: number; l1: string; l2: string[]; factsVersion: string }): string {
  return `digest-v1:${stableHash([
    `until=${input.untilSeq}`,
    input.l1,
    ...input.l2,
    input.factsVersion,
  ].join('\n')).split(':').at(-1) ?? '0'}`
}

export interface DigestOptions {
  keep?: number
  charBudget?: number
  /** 已有的事实投影（host 落盘后以它为准；不传就从消息现算）。 */
  facts?: Fact[]
}

/**
 * 生成/增量更新摘要投影。`previous` 传上一次的摘要，只追加新增的旧消息。
 */
export function buildThreadDigest(
  thread: Thread,
  previous?: SummaryDigest,
  options: DigestOptions = {},
): SummaryDigest {
  const messages = thread.messages
  const keep = Math.max(1, options.keep ?? SUMMARY_KEEP_RECENT)
  const budget = Math.max(200, options.charBudget ?? L1_CHAR_BUDGET)
  const boundaryIndex = Math.max(0, messages.length - keep)
  const oldMessages = messages.slice(0, boundaryIndex)
  // 消息回退（state 回滚）时旧摘要可能覆盖到已不存在的消息，直接重算。
  const lastSeq = messages.length ? seqOf(messages[messages.length - 1], messages.length - 1) : 0
  const base = previous && previous.untilSeq <= lastSeq ? previous : undefined
  const coveredSeq = base?.untilSeq ?? 0

  // 旧摘要只有在仍存在“旧消息区”时才延续；否则（回退/变短）从头算。
  const carried = boundaryIndex > 0 && base ? base.l1 : ''
  const lines = carried ? carried.split('\n').filter(Boolean) : []
  for (let index = 0; index < oldMessages.length; index++) {
    const message = oldMessages[index]
    if (NOISE.test(message.text)) continue
    const seq = seqOf(message, index)
    if (seq <= coveredSeq) continue
    lines.push(l1Line(message, seq))
  }
  while (lines.length > 1 && lines.join('\n').length > budget) lines.shift()
  const l1 = lines.join('\n')
  const untilSeq = oldMessages.length ? seqOf(oldMessages[oldMessages.length - 1], boundaryIndex - 1) : 0

  // L2：不可压缩项永远保留（用户的决定/待办优先）。
  // 能力/环境自述（“我没有 shell / 只能在群里 / 私聊发不出去”）不进 L2：
  // 它们只是那一轮的便签，回灌进 prompt 会让角色把自己的临时说法当成长期约束。
  const factProjection = options.facts
    ? projectFactsFromList(options.facts)
    : factsFromMessages(messages)
  const incompressible = factProjection.active
    .filter((fact) => INCOMPRESSIBLE_KINDS.includes(fact.kind))
    .filter((fact) => isPromptVisibleFact(fact))
    .slice(0, L2_MAX_FACTS)
  const l2 = incompressible.map(formatFact)

  const factsVersion = factProjection.version
  return {
    version: digestVersion({ untilSeq, l1, l2, factsVersion }),
    untilSeq,
    l1,
    l2,
    factsVersion,
    at: Date.now(),
  }
}

/** prompt 里怎么放摘要：L2（事实）在前、L1（旧消息压缩）在后。 */
export function digestSummaryText(digest: SummaryDigest | undefined): string {
  if (!digest) return ''
  const parts: string[] = []
  if (digest.l2.length) parts.push('[群事实/决定]', ...digest.l2)
  if (digest.l1) parts.push('[更早消息摘要]', digest.l1)
  return parts.join('\n')
}
