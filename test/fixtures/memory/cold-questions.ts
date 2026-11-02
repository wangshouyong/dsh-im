/**
 * 冷区题库（B-2）：答案全部位于 `seq < 150`（远早于热区窗口 581–600），
 * 所以判定的是「冷区章节目录 → 代表句柄 → 多跳展开」，不是热区侥幸命中。
 *
 * 每题标注：
 * - `expectedSeqChain`：期望被展开的 seq 链（1 跳 = 1 条；2 跳 = 跳板 + 被引用目标）；
 * - `expectedFacts`：工具输出里必须出现的原文片段（判定用；**不会**进 prompt/系统文本）；
 * - `kind`：single（hop1 直接命中） / multi-hop（hop1 命中跳板，hop2 从原文里的 #seq 再展开）。
 *
 * 判定口径（runner 与单测共用）：`expectedSeqChain` 全部出现在输出句柄里
 * **且** `expectedFacts` 全部是输出子串；任一不满足即该题失败。
 */
import { LONG_SESSION_TARGETS } from './long-session.ts'

/** 冷区上界：答案必须早于这个 seq（600 条会话里 150 以前）。 */
export const COLD_ZONE_MAX_SEQ = 150
/** 600 条会话的热区窗口大小（最近 20 条 → seq 581–600）。 */
export const HOT_WINDOW_KEEP = 20

export type ColdQuestionKind = 'single' | 'multi-hop'

export interface ColdQuestion {
  id: string
  question: string
  kind: ColdQuestionKind
  /** 期望展开链（1–2 跳）。 */
  expectedSeqChain: number[]
  /** 判定用原文片段（必须出现在工具输出里；不得出现在 prompt 里）。 */
  expectedFacts: string[]
}

/** 目标事实（前 6 个话题）→ 高价值冷区问题。 */
export function buildColdQuestions(): ColdQuestion[] {
  const questions: ColdQuestion[] = []
  for (let segment = 1; segment <= 6; segment++) {
    const odd = segment % 2 === 1
    const decisionSeq = LONG_SESSION_TARGETS.decision(segment)
    const constraintSeq = LONG_SESSION_TARGETS.constraint(segment)
    const detailSeq = LONG_SESSION_TARGETS.numberOrFile(segment)
    const supplementSeq = LONG_SESSION_TARGETS.supplement(segment)
    questions.push({
      id: `cold-decision-${segment}`,
      question: `D-${segment} 这个决定里灰度先放多少流量？`,
      kind: 'single',
      expectedSeqChain: [decisionSeq],
      expectedFacts: [`D-${segment}`, '3% 流量'],
    })
    questions.push({
      id: `cold-constraint-${segment}`,
      question: `C-${segment} 这条约束划的红线是什么？`,
      kind: 'single',
      expectedSeqChain: [constraintSeq],
      expectedFacts: [`C-${segment}`, '人工复核'],
    })
    questions.push({
      id: `cold-detail-${segment}`,
      question: odd
        ? `N-${segment} 的压测数字口径是多少？`
        : `F-${segment} 这份文件说边界条件以哪里为准？`,
      kind: 'single',
      expectedSeqChain: [detailSeq],
      expectedFacts: odd ? [`N-${segment}`, '阈值'] : [`F-${segment}`, `policy-${segment}.ts`],
    })
    // 多跳：跳板 S-s 的原文里带 #detailSeq → hop2 继续展开目标。
    questions.push({
      id: `cold-hop2-${segment}-a`,
      question: `「补充 S-${segment} 的口径详见哪条」按哪条执行？`,
      kind: 'multi-hop',
      expectedSeqChain: [supplementSeq, detailSeq],
      expectedFacts: [`S-${segment}`, `D-${segment} 的口径详见`, odd ? `N-${segment}` : `policy-${segment}.ts`],
    })
    questions.push({
      id: `cold-hop2-${segment}-b`,
      question: `S-${segment} 这条补充让我们按哪条执行？`,
      kind: 'multi-hop',
      expectedSeqChain: [supplementSeq, detailSeq],
      expectedFacts: [`S-${segment}`, `#${detailSeq}`, odd ? `N-${segment}` : `policy-${segment}.ts`],
    })
  }
  return questions
}

export const COLD_QUESTIONS: ColdQuestion[] = buildColdQuestions()

/** 负向校验：所有期望 seq 都必须早于冷区上界（否则测的是热区）。 */
export function assertColdZoneGroundTruth(questions: readonly ColdQuestion[], maxSeq = COLD_ZONE_MAX_SEQ): string[] {
  const errors: string[] = []
  for (const question of questions) {
    if (question.expectedSeqChain.length < 1 || question.expectedSeqChain.length > 2) {
      errors.push(`${question.id}: expectedSeqChain 必须是 1–2 跳（当前 ${question.expectedSeqChain.length}）`)
    }
    for (const seq of question.expectedSeqChain) {
      if (!Number.isFinite(seq) || seq <= 0) errors.push(`${question.id}: expectedSeq 非法 ${seq}`)
      else if (seq >= maxSeq) errors.push(`${question.id}: expectedSeq ${seq} 不在冷区（应 < ${maxSeq}）`)
    }
    if (question.expectedFacts.length === 0) errors.push(`${question.id}: expectedFacts 不能为空`)
    if (question.kind === 'multi-hop' && question.expectedSeqChain.length !== 2) {
      errors.push(`${question.id}: multi-hop 题必须有 2 段期望 seq 链`)
    }
    if (question.kind === 'single' && question.expectedSeqChain.length !== 1) {
      errors.push(`${question.id}: single 题只能有 1 段期望 seq`)
    }
  }
  return errors
}
