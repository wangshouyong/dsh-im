/**
 * B-2 评测集与判定（硬门 ≥90%，数字来自真实执行）。
 *
 * 这里不写死"通过率 = 100%"：跑一遍 `evaluateColdQuestions`，用真实结果断言 ≥90%，
 * 并把每题判定（期望 seq 链 / 命中片段 / hops / expandChars / hopBudgetUsed / gaps）作为证据。
 *
 * 防自证：
 * - 期望 seq 必须**不在热区窗口**（否则测的是热区）；
 * - 判定只看 `expectedSeqChain` 命中 + `expectedFacts` 子串，不调用任何模型；
 * - 期望答案片段不允许出现在系统提示词里。
 */
import { describe, expect, it } from 'vitest'
import { buildSystem } from '../src/core/prompt.ts'
import { evalPassRate } from './fixtures/memory/evaluate.ts'
import { COLD_QUESTIONS, COLD_ZONE_MAX_SEQ, HOT_WINDOW_KEEP, assertColdZoneGroundTruth } from './fixtures/memory/cold-questions.ts'
import { buildLongSessionFixture } from './fixtures/memory/long-session.ts'
import { evaluateColdQuestions } from './fixtures/memory/evaluate.ts'

const fixture = buildLongSessionFixture()

describe('B-2 冷区多跳评测（真实执行，硬门 ≥90%）', () => {
  it('fixture 规模与冷区 ground truth 自洽', () => {
    expect(fixture.thread.messages.length).toBe(600)
    expect(COLD_QUESTIONS.length).toBeGreaterThanOrEqual(30)
    expect(assertColdZoneGroundTruth(COLD_QUESTIONS)).toEqual([])
    expect(COLD_ZONE_MAX_SEQ).toBe(150)
    expect(HOT_WINDOW_KEEP).toBe(20)
  })

  it('每题判定 + 总体通过率 ≥ 90%（数字来自实际执行，不是写死断言）', async () => {
    const report = await evaluateColdQuestions(fixture, COLD_QUESTIONS)
    // 证据：真实规模 + 真实通过数
    expect(report.total).toBe(COLD_QUESTIONS.length)
    expect(report.fixture.messages).toBe(600)
    expect(report.fixture.groupTokens).toBe(64_000)
    expect(report.fixture.windowChars).toBe(72_695)
    expect(report.hotSeqs).toEqual(
      fixture.thread.messages.slice(-HOT_WINDOW_KEEP).map((message) => message.seq),
    )
    for (const question of report.questions) {
      expect(question.expectedSeqChain.length).toBeGreaterThanOrEqual(1)
      // 期望 seq 不得命中热区（防自证）
      for (const seq of question.expectedSeqChain) expect(report.hotSeqs).not.toContain(seq)
      // 命中时：期望 seq 都被展开、期望片段都出现
      if (question.ok) {
        for (const seq of question.expectedSeqChain) expect(question.expandedSeqs).toContain(seq)
        expect(question.missingFacts).toEqual([])
      }
      // 触顶必须显式说明（不允许静默丢）
      if (question.missingSeqs.length > 0) expect(question.gaps.length).toBeGreaterThan(0)
    }
    const passRate = report.passed / report.total
    expect(report.passRate).toBe(Math.round(passRate * 10_000) / 10_000)
    expect(passRate).toBeGreaterThanOrEqual(0.9)
    expect(report.byKind['multi-hop'].total).toBeGreaterThan(0)
    expect(report.byKind.single.total).toBeGreaterThan(0)
    // runner 与单测共用同一个通过率口径
    expect(evalPassRate(report)).toBe(report.passRate)
  })

  it('确定性与防自证：两次评测结果一致；期望答案不在系统提示词里', async () => {
    const first = await evaluateColdQuestions(fixture, COLD_QUESTIONS)
    const second = await evaluateColdQuestions(fixture, COLD_QUESTIONS)
    expect(second).toEqual(first)
    const system = buildSystem(
      {
        id: 'p-pm',
        name: '产品经理',
        personality: '',
        duties: [],
      },
      fixture.thread.title,
      'group',
    )
    for (const question of COLD_QUESTIONS) {
      for (const fact of question.expectedFacts) {
        // 句柄代号（D-1/S-1）允许作为定位词，但答案片段不得出现在系统提示词里。
        if (/^[A-Z]-\d+$/.test(fact)) continue
        expect(system.includes(fact)).toBe(false)
      }
    }
  })
})
