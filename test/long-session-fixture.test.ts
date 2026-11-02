/**
 * 长会话 fixture 自检 + 冷区题库 ground truth。
 *
 * 这份 fixture 是 A-1/A-2/A-3 与 B 冷区多跳题的共同输入：
 * - 600 条确定性消息（决定 / 否决/约束 / 数字 / 文件 / 开放问题 / superseded 分布）；
 * - 预算**固化**（`{tier, groupTokens, allocation, groupMinModel}`），公式或输入变了必须显式改；
 * - 冷区题库 ≥30 题，答案全部在 seq < 150（否则测的是热区，不是冷区）。
 */
import { describe, expect, it } from 'vitest'
import {
  LONG_SESSION_BUDGET,
  LONG_SESSION_SEGMENT_SIZE,
  LONG_SESSION_TARGETS,
  LONG_SESSION_TOTAL_MESSAGES,
  buildLongSessionFixture,
  claimsOf,
  recomputeLongSessionBudget,
} from './fixtures/memory/long-session.ts'
import {
  COLD_QUESTIONS,
  COLD_ZONE_MAX_SEQ,
  HOT_WINDOW_KEEP,
  assertColdZoneGroundTruth,
  buildColdQuestions,
} from './fixtures/memory/cold-questions.ts'

const fixture = buildLongSessionFixture()

describe('长会话 fixture（600 条，确定性）', () => {
  it('规模/seq 连续性/话题边界都显式且确定', () => {
    expect(fixture.thread.messages).toHaveLength(LONG_SESSION_TOTAL_MESSAGES)
    expect(fixture.thread.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: LONG_SESSION_TOTAL_MESSAGES }, (_, index) => index + 1),
    )
    expect(fixture.thread.topicBoundaries).toHaveLength(LONG_SESSION_TOTAL_MESSAGES / LONG_SESSION_SEGMENT_SIZE)
    for (const boundary of fixture.thread.topicBoundaries) {
      const row = fixture.thread.messages.find((message) => message.seq === boundary)
      expect(row?.kind).toBe('user')
    }
    expect(buildLongSessionFixture().thread.messages).toEqual(fixture.thread.messages)
    expect(buildLongSessionFixture().thread.claims).toEqual(fixture.thread.claims)
  })

  it('分布齐全：决定 / 约束（否决） / 数字与文件 / 开放问题 / superseded', () => {
    const texts = fixture.thread.messages.map((message) => message.text)
    expect(texts.filter((text) => text.startsWith('决定 D-')).length).toBeGreaterThanOrEqual(10)
    expect(texts.filter((text) => text.startsWith('约束 C-')).length).toBe(6)
    expect(texts.filter((text) => text.startsWith('数字 N-')).length).toBeGreaterThan(0)
    expect(texts.filter((text) => text.startsWith('文件 F-')).length).toBeGreaterThan(0)
    expect(texts.filter((text) => text.includes('待确认 Q-')).length).toBeGreaterThan(0)
    const superseded = fixture.thread.claims.filter((claim) => claim.state === 'superseded')
    expect(superseded).toHaveLength(2)
    for (const claim of superseded) {
      expect(claim.successorSeq).toBeDefined()
      const successor = fixture.thread.claims.find((item) => item.seq === claim.successorSeq)
      expect(successor?.state).toBe('active')
    }
  })

  it('预算固化值未被悄悄改掉（当前公式重算 == 固化值）', () => {
    const recomputed = recomputeLongSessionBudget()
    expect(recomputed).toEqual(LONG_SESSION_BUDGET)
    expect(LONG_SESSION_BUDGET.tier).toBe('standard')
    expect(LONG_SESSION_BUDGET.groupTokens).toBe(64_000)
    expect(LONG_SESSION_BUDGET.groupMinModel).toMatchObject({ personaId: 'p-pm', contextWindow: 256_000 })
    expect(LONG_SESSION_BUDGET.allocation.windowChars).toBe(72_695)
    expect(LONG_SESSION_BUDGET.summarySplit.chapterChars + LONG_SESSION_BUDGET.summarySplit.digestChars)
      .toBe(LONG_SESSION_BUDGET.summarySplit.totalChars)
  })

  it('claim 状态与原文对应（superseded 的决定被"修订"取代）', () => {
    const bySeq = new Map(fixture.thread.messages.map((message) => [message.seq, message]))
    for (const claim of fixture.thread.claims) {
      expect(bySeq.get(claim.seq)?.text).toBeTruthy()
    }
    const claims = claimsOf(fixture)
    for (const claim of fixture.thread.claims.filter((item) => item.state === 'superseded')) {
      expect(claims.get(claim.seq)?.successorSeq).toBe(claim.successorSeq)
      expect(bySeq.get(claim.successorSeq as number)?.text.startsWith('修订')).toBe(true)
    }
  })
})

describe('冷区题库（≥30 题，答案在 seq < 150）', () => {
  it('题量与类型：30 题 = 18 单跳 + 12 双跳', () => {
    expect(COLD_QUESTIONS.length).toBeGreaterThanOrEqual(30)
    expect(COLD_QUESTIONS.filter((question) => question.kind === 'single')).toHaveLength(18)
    expect(COLD_QUESTIONS.filter((question) => question.kind === 'multi-hop')).toHaveLength(12)
    expect(buildColdQuestions().map((question) => question.id)).toEqual(COLD_QUESTIONS.map((question) => question.id))
  })

  it('ground truth 自洽：期望 seq 全部在冷区（< 150），且不是热区窗口 seq', () => {
    expect(assertColdZoneGroundTruth(COLD_QUESTIONS)).toEqual([])
    const hotSeqs = new Set(fixture.thread.messages.slice(-HOT_WINDOW_KEEP).map((message) => message.seq))
    for (const question of COLD_QUESTIONS) {
      expect(Math.max(...question.expectedSeqChain)).toBeLessThan(COLD_ZONE_MAX_SEQ)
      for (const seq of question.expectedSeqChain) expect(hotSeqs.has(seq)).toBe(false)
    }
    expect(Math.min(...hotSeqs)).toBe(LONG_SESSION_TOTAL_MESSAGES - HOT_WINDOW_KEEP + 1)
  })

  it('期望原文片段真的在对应 seq 的原文里（判定基线可复现）', () => {
    const bySeq = new Map(fixture.thread.messages.map((message) => [message.seq, message.text]))
    for (const question of COLD_QUESTIONS) {
      const chainText = question.expectedSeqChain.map((seq) => bySeq.get(seq) ?? '').join('\n')
      for (const fact of question.expectedFacts) {
        // 多跳题的第二跳片段可能只在第二段原文里；整体拼接后必须全部出现。
        expect(chainText).toContain(fact)
      }
    }
    // 目标 seq 与长会话 helper 一致（题目不是手抄 seq）
    expect(LONG_SESSION_TARGETS.decision(1)).toBe(4)
    expect(LONG_SESSION_TARGETS.supplement(1)).toBe(12)
  })

  it('题目文本不允许泄露判定用的答案片段（防自证；句柄代号 D-1/S-1 不算答案）', () => {
    const isHandleCode = (fact: string) => /^[A-Z]-\d+$/.test(fact) || fact.startsWith('#')
    for (const question of COLD_QUESTIONS) {
      for (const fact of question.expectedFacts.filter((item) => !isHandleCode(item))) {
        expect(question.question).not.toContain(fact)
      }
      for (const seq of question.expectedSeqChain) expect(question.question).not.toContain(`#${seq}`)
    }
  })
})
