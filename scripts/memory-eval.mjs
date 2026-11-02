#!/usr/bin/env node
/**
 * 冷区多跳评测 runner（B-2）。
 *
 * 真实执行（确定性、不调用模型）：600 条长会话 fixture → 冷区章节目录 →
 * 每题 hop1/hop2 展开 → 按 expectedSeqChain + expectedFacts 判定。
 *
 * 用法：`npm run eval:memory`
 * 输出：每题判定 + 总体通过率 + 预算/hops/expandChars 真实数字；通过率 < 90% 时 exit 1。
 *
 * 说明：Node 24 原生支持运行本仓库的 TS 源码（type stripping），所以 runner 直接 import
 * `src/core/*.ts` 与 `test/fixtures/memory/*.ts`，与单测共用同一实现，不存在"评测脚本另写一套"。
 */
import { COLD_QUESTIONS } from '../test/fixtures/memory/cold-questions.ts'
import { buildLongSessionFixture } from '../test/fixtures/memory/long-session.ts'
import { evalPassRate, evaluateColdQuestions } from '../test/fixtures/memory/evaluate.ts'

const GATE = 0.9

const fixture = buildLongSessionFixture()
const report = await evaluateColdQuestions(fixture, COLD_QUESTIONS)

console.log('冷区多跳评测（真实执行，无 mock）')
console.log(`fixture: ${report.fixture.id} · ${report.fixture.messages} 条消息 · tier=${report.fixture.budgetTier} · groupTokens=${report.fixture.groupTokens} · 最小窗口成员=${report.fixture.groupMinModel}`)
console.log(`预算: windowChars=${report.fixture.windowChars} summaryChars=${fixture.budget.allocation.summaryChars}（目录 ${report.fixture.chapterChars} / 摘要 ${fixture.budget.summarySplit.digestChars}）· 目录 ${report.fixture.chapters} 章 / ${report.fixture.directoryChars} 字`)
console.log(`热区窗口: seq ${Math.min(...report.hotSeqs)}–${Math.max(...report.hotSeqs)}（${report.hotSeqs.length} 条）· 冷区上界 seq < ${report.coldZoneMaxSeq}`)
console.log('')
for (const question of report.questions) {
  const mark = question.ok ? 'PASS' : 'FAIL'
  const chain = question.expectedSeqChain.map((seq) => `#${seq}`).join('→')
  const detail = question.ok
    ? `expanded=${question.expandedSeqs.map((seq) => `#${seq}`).join(',')}`
    : `missingSeq=${question.missingSeqs.map((seq) => `#${seq}`).join(',') || '-'} missingFacts=${question.missingFacts.join('|') || '-'}`
  console.log(
    `[${mark}] ${question.id.padEnd(22)} ${question.kind.padEnd(9)} chain ${chain.padEnd(11)} `
    + `hops=${question.hops} expandChars=${question.expandChars} hopBudgetUsed=${Math.round(question.hopBudgetUsed * 100)}% `
    + `budgetSource=${question.budgetSource} ${detail}`,
  )
  if (question.gaps.length) console.log(`         缺口: ${question.gaps.join('；')}`)
}

const passRate = evalPassRate(report)
console.log('')
console.log(`按类型: single ${report.byKind.single.passed}/${report.byKind.single.total} · multi-hop ${report.byKind['multi-hop'].passed}/${report.byKind['multi-hop'].total}`)
console.log(`总计: ${report.passed}/${report.total} = ${(passRate * 100).toFixed(2)}% · 硬门 ≥ ${(GATE * 100).toFixed(0)}%`)
if (passRate < GATE) {
  console.error(`\n[FAIL] 冷区多跳通过率 ${(passRate * 100).toFixed(2)}% < ${(GATE * 100).toFixed(0)}%：不达标，修实现/评测集，不允许调低门槛。`)
  process.exit(1)
}
console.log(`\n[PASS] 冷区多跳通过率 ${(passRate * 100).toFixed(2)}% ≥ ${(GATE * 100).toFixed(0)}%`)
