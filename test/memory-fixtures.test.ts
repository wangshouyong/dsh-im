/**
 * pilot fixture 自洽性（Phase 0）。
 *
 * 这里守的不是"功能"，而是**验收口径**：没有这份 ground truth，
 * `目录兜底率 ≥50%` / `双传输一致率 ≥90%` 都无法客观判定。
 */
import { describe, expect, it } from 'vitest'
import { buildPilotFixture, messagesInSegment, FIXTURE_SAMPLE } from './fixtures/memory/build.ts'
import { countByAnchorType, validateMemoryFixture } from './fixtures/memory/schema.ts'

describe('记忆层 pilot fixture', () => {
  const fixture = buildPilotFixture()

  it('schema 自洽：无校验错误', () => {
    expect(validateMemoryFixture(fixture)).toEqual([])
  })

  it('确定性：同一份生成器两次产出完全一致（可随测试提交、可进回放）', () => {
    expect(buildPilotFixture()).toEqual(buildPilotFixture())
  })

  it('每类 6 题（pilot），共 36 题；Phase 1 硬门样本量是 30/类', () => {
    const counts = countByAnchorType(fixture)
    expect(counts).toEqual({
      anchored: 6,
      paraphrase: 6,
      'multi-hop': 6,
      negative: 6,
      injection: 6,
      'stale-conflict': 6,
    })
    expect(fixture.questions).toHaveLength(36)
    expect(FIXTURE_SAMPLE.pilotPerCategory).toBe(6)
    expect(FIXTURE_SAMPLE.gatePerCategory).toBe(30)
  })

  it('植入点与话题边界严格对齐（拼接边界不能污染分段测试）', () => {
    const bySeq = new Map(fixture.thread.messages.map((message) => [message.seq, message]))
    for (const planted of fixture.thread.planted) {
      expect(bySeq.get(planted.seq)?.text).toBe(planted.text)
    }
    // 每个边界都是用户消息
    for (const boundary of fixture.thread.topicBoundaries) {
      expect(bySeq.get(boundary)?.kind).toBe('user')
    }
    // #12 落在段 11 里
    expect(messagesInSegment(fixture, 11)).toContain(12)
    expect(messagesInSegment(fixture, 11)).not.toContain(21)
  })

  it('claim ground truth：82 被 142 取代，142 有效', () => {
    const claims = new Map(fixture.thread.claims.map((claim) => [claim.seq, claim]))
    expect(claims.get(82)).toEqual({ seq: 82, state: 'superseded', successorSeq: 142 })
    expect(claims.get(142)).toEqual({ seq: 142, state: 'active' })
    // stale 题的目标 seq 必须在 claims 里被标 superseded
    const stale = fixture.questions.filter((question) => question.anchorType === 'stale-conflict')
    for (const question of stale) {
      expect(claims.get(82)?.state).toBe('superseded')
      expect(question.expectation).toBe('downgrade')
    }
  })

  it('负例题不要求触发记忆工具（双向门负向侧）', () => {
    for (const question of fixture.questions.filter((item) => item.anchorType === 'negative')) {
      expect(question.relatedSeqs).toEqual([])
      expect(question.relatedSegments).toEqual([])
      expect(question.needsHistoryTool).toBe(false)
      expect(question.expectation).toBe('no-hit')
    }
  })

  it('注入题标注了"包裹/指令隔离"要求，且目标是被标记的指令性消息', () => {
    const injection = fixture.questions.filter((question) => question.anchorType === 'injection')
    expect(injection).toHaveLength(6)
    for (const question of injection) {
      expect(question.notes).toContain('包裹')
      expect(question.relatedSeqs).toEqual([62])
    }
    expect(fixture.thread.messages.find((message) => message.seq === 62)?.text).toContain('忽略以上')
  })

  it('anchorType 与 expectation 的对应关系符合验收口径', () => {
    for (const question of fixture.questions) {
      if (question.anchorType === 'anchored' || question.anchorType === 'multi-hop') {
        expect(question.expectation).toBe('hit')
      }
      if (question.anchorType === 'multi-hop') expect(question.relatedSeqs.length).toBeGreaterThanOrEqual(2)
    }
  })
})
