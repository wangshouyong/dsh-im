import { describe, expect, it } from 'vitest'
import { arbitrate, type ArbiterCandidate } from '../src/core/arbiter.ts'
import { beginThinking, createRuntimeState } from '../src/core/agent-state.ts'

function candidate(personaId: string, name: string, extra: Partial<ArbiterCandidate> = {}): ArbiterCandidate {
  return {
    personaId,
    name,
    duties: [],
    activity: 'high',
    state: createRuntimeState(personaId, 0),
    answered: false,
    ...extra,
  }
}

const base = { latestText: '大家看下这个 bug', mentionedIds: [], now: 10_000 }

describe('发言权仲裁', () => {
  it('被点名者优先，其他人一律 wait/不参与', () => {
    const decision = arbitrate({
      ...base,
      mentionedIds: ['p2'],
      candidates: [candidate('p1', '淇淇'), candidate('p2', '测试2')],
    })
    expect(decision).toMatchObject({ action: 'speak', personaId: 'p2' })
    expect(decision.reason).toContain('被点名')
  })

  it('被点名者正在生成 → 其他人等它，而不是抢答', () => {
    const busy = candidate('p2', '测试2', { state: beginThinking(createRuntimeState('p2', 0), 0) })
    const decision = arbitrate({
      ...base,
      mentionedIds: ['p2'],
      candidates: [candidate('p1', '淇淇'), busy],
    })
    expect(decision).toMatchObject({ action: 'wait', waitingOn: 'p2' })
  })

  it('回复对象优先于自由发言', () => {
    const decision = arbitrate({
      ...base,
      replyToPersonaId: 'p3',
      candidates: [candidate('p1', '淇淇'), candidate('p3', '产品经理')],
    })
    expect(decision).toMatchObject({ action: 'speak', personaId: 'p3' })
    expect(decision.reason).toContain('回复对象')
  })

  it('职责命中者优先；同一轮已发过言的不再轮转', () => {
    const duties = [{ responsibilities: ['测试', '质量'] }, { responsibilities: ['需求分析'] }]
    const candidates = [
      candidate('p1', '产品经理', { duties: duties[1].responsibilities }),
      candidate('p2', '测试2', { duties: duties[0].responsibilities }),
    ]
    const text = { ...base, latestText: '测试这个 bug 的质量问题' }
    expect(arbitrate({ ...text, candidates })).toMatchObject({ action: 'speak', personaId: 'p2' })
    expect(arbitrate({ ...text, candidates, spokenIds: ['p2'] })).toMatchObject({ action: 'speak', personaId: 'p1' })
  })

  it('都在冷却/已答/资格外时返回 pass，不硬选人', () => {
    const decision = arbitrate({
      ...base,
      candidates: [
        candidate('p1', '淇淇', { activity: 'muted' }),
        candidate('p2', '测试2', { answered: true }),
      ],
    })
    expect(decision.action).toBe('pass')
  })
})
