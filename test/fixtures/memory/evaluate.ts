/**
 * 冷区多跳评测（B-2 的唯一判定实现）。
 *
 * 判定口径（纯确定性，不调用模型）：
 * 1. `expectedSeqChain` 里每个 seq 都真的被工具展开（输出里出现 `#seq` 句柄行）；
 * 2. `expectedFacts` 每个片段都是工具输出子串；
 * 3. **防自证**：期望 seq 不得落在热区窗口内（否则测的是热区）；
 * 4. 每题记录真实执行出来的 `hops / expandChars / hopBudgetUsed / gaps`。
 *
 * runner（scripts/memory-eval.mjs）与单测共用本文件：数字来自真实执行，不是写死断言。
 */
import { buildChapterTree } from '../../../src/core/chapter-tree.ts'
import {
  multiHopDirectoryChars,
  runMultiHop,
  type MultiHopExpanded,
  type MultiHopReceipt,
} from '../../../src/core/multi-hop.ts'
import { HOT_WINDOW_KEEP, type ColdQuestion } from './cold-questions.ts'
import { LONG_SESSION_TARGETS, claimsOf, type LongSessionFixture } from './long-session.ts'

export interface ColdQuestionResult {
  id: string
  kind: ColdQuestion['kind']
  question: string
  ok: boolean
  expectedSeqChain: number[]
  expandedSeqs: number[]
  missingSeqs: number[]
  missingFacts: string[]
  hops: number
  expandChars: number
  hopBudgetUsed: number
  budgetSource: MultiHopReceipt['budgetSource']
  gaps: string[]
}

export interface ColdEvalReport {
  fixture: {
    id: string
    messages: number
    budgetTier: string
    groupTokens: number
    groupMinModel: string
    windowChars: number
    chapterChars: number
    chapters: number
    directoryChars: number
  }
  hotSeqs: number[]
  coldZoneMaxSeq: number
  total: number
  passed: number
  /** 0–1，保留 4 位（报告里同时写成百分比）。 */
  passRate: number
  byKind: Record<ColdQuestion['kind'], { total: number; passed: number }>
  questions: ColdQuestionResult[]
}

/** 冷区章节目录：热区窗口（最近 N 条）之外的历史；预算算法与 host 工具完全一致。 */
export function coldDirectoryOf(fixture: LongSessionFixture, keep = HOT_WINDOW_KEEP) {
  const hotStart = Math.max(1, fixture.thread.messages.length - keep + 1)
  const hotSeqs = fixture.thread.messages.slice(-keep).map((message) => message.seq)
  const directoryChars = multiHopDirectoryChars(fixture.budget.allocation.windowChars)
  const directory = buildChapterTree({
    messages: fixture.thread.messages.filter((message) => message.seq < hotStart),
    summaryChars: Math.round(directoryChars / 0.4),
    claims: claimsOf(fixture),
    excludeSeqs: new Set(hotSeqs),
  })
  return { hotSeqs, hotStart, directory, directoryChars }
}

function judgeQuestion(
  question: ColdQuestion,
  hotSeqs: readonly number[],
  expanded: readonly MultiHopExpanded[],
  text: string,
  receipt: MultiHopReceipt,
  gaps: readonly string[],
): ColdQuestionResult {
  const hot = new Set(hotSeqs)
  const expandedSeqs = expanded.map((item) => item.seq)
  const missingSeqs = question.expectedSeqChain.filter((seq) => !expandedSeqs.includes(seq) || hot.has(seq))
  const missingFacts = question.expectedFacts.filter((fact) => !text.includes(fact))
  return {
    id: question.id,
    kind: question.kind,
    question: question.question,
    ok: missingSeqs.length === 0 && missingFacts.length === 0,
    expectedSeqChain: [...question.expectedSeqChain],
    expandedSeqs,
    missingSeqs,
    missingFacts,
    hops: receipt.hops,
    expandChars: receipt.expandChars,
    hopBudgetUsed: receipt.hopBudgetUsed,
    budgetSource: receipt.budgetSource,
    gaps: [...gaps],
  }
}

/** 真实执行一遍冷区题库；返回逐题判定与总体通过率。 */
export async function evaluateColdQuestions(
  fixture: LongSessionFixture,
  questions: readonly ColdQuestion[],
): Promise<ColdEvalReport> {
  const { hotSeqs, hotStart, directory, directoryChars } = coldDirectoryOf(fixture)
  const textBySeq = new Map(fixture.thread.messages.map((message) => [message.seq, message.text]))
  // 冷区 = 热区窗口之前；这里再确保目录覆盖答案区（答案必须早于 hotStart）。
  const coldZoneMaxSeq = hotStart
  const claims = claimsOf(fixture)
  const results: ColdQuestionResult[] = []
  for (const question of questions) {
    const outsideCold = question.expectedSeqChain.filter((seq) => seq >= coldZoneMaxSeq)
    const run = await runMultiHop({
      question: question.question,
      directory,
      claims,
      budgetChars: fixture.budget.allocation.windowChars,
      excludeSeqs: new Set(hotSeqs),
      resolve: async (seq) => textBySeq.get(seq),
    })
    const result = judgeQuestion(question, hotSeqs, run.expanded, run.text, run.receipt, run.gaps)
    if (outsideCold.length) {
      result.ok = false
      result.missingSeqs = [...new Set([...result.missingSeqs, ...outsideCold])]
      result.gaps = [...result.gaps, `期望 seq 不在冷区（>= ${coldZoneMaxSeq}）`]
    }
    results.push(result)
  }
  const byKind = {
    single: { total: 0, passed: 0 },
    'multi-hop': { total: 0, passed: 0 },
  }
  for (const result of results) {
    byKind[result.kind].total += 1
    if (result.ok) byKind[result.kind].passed += 1
  }
  const passed = results.filter((result) => result.ok).length
  return {
    fixture: {
      id: fixture.id,
      messages: fixture.thread.messages.length,
      budgetTier: fixture.budget.tier,
      groupTokens: fixture.budget.groupTokens,
      groupMinModel: `${fixture.budget.groupMinModel.personaId}(${fixture.budget.groupMinModel.model} · ${fixture.budget.groupMinModel.contextWindow})`,
      windowChars: fixture.budget.allocation.windowChars,
      chapterChars: directory.meta.chapterChars,
      chapters: directory.meta.chapterCount,
      directoryChars: directoryChars,
    },
    hotSeqs,
    coldZoneMaxSeq,
    total: results.length,
    passed,
    passRate: results.length ? Math.round((passed / results.length) * 10_000) / 10_000 : 0,
    byKind,
    questions: results,
  }
}

/** 期望 seq 的文本（调试/报告用，避免手抄）。 */
export function expectedTextsOf(fixture: LongSessionFixture, question: ColdQuestion): string[] {
  const bySeq = new Map(fixture.thread.messages.map((message) => [message.seq, message.text]))
  return question.expectedSeqChain.map((seq) => bySeq.get(seq) ?? `<missing #${seq}>`)
}

/** 通过率口径（runner 与单测共用的唯一实现）。 */
export function evalPassRate(report: ColdEvalReport): number {
  return report.total > 0 ? Math.round((report.passed / report.total) * 10_000) / 10_000 : 0
}

export { LONG_SESSION_TARGETS }
