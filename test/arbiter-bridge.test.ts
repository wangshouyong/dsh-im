import { describe, expect, it } from 'vitest'
import { buildCandidates, decideNext } from '../src/core/arbiter-bridge.ts'
import { beginThinking, createRuntimeState } from '../src/core/agent-state.ts'

const members = [
  { personaId: 'p1', name: '淇淇', duties: [], activity: 'high' as const, answered: false },
  { personaId: 'p2', name: '测试2', duties: ['测试'], activity: 'high' as const, answered: false },
]

describe('地板仲裁桥接', () => {
  it('缺状态的角色自动补 idle，不会因为状态缺失假死', () => {
    const candidates = buildCandidates({ members, states: {}, now: 100 })
    expect(candidates.every((candidate) => candidate.state.status === 'idle')).toBe(true)
    const decision = decideNext({ latestText: '看下', mentionedIds: [], members, states: {}, now: 100 })
    expect(decision.action).toBe('speak')
  })

  it('点名在忙 → 返回 wait 并指出等谁', () => {
    const states = { p2: beginThinking(createRuntimeState('p2', 0), 0) }
    const decision = decideNext({ latestText: '@测试2 看下', mentionedIds: ['p2'], members, states, now: 100 })
    expect(decision).toMatchObject({ action: 'wait', waitingOn: 'p2' })
  })

  it('职责命中者被选中', () => {
    const decision = decideNext({ latestText: '测试一下这个改动', mentionedIds: [], members, states: {}, now: 100 })
    expect(decision).toMatchObject({ action: 'speak', personaId: 'p2' })
  })
})
