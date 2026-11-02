import { describe, expect, it } from 'vitest'
import {
  applyDecision,
  beginThinking,
  canSpeak,
  createRuntimeState,
  expireIfStale,
  finishSpeaking,
  resolveWait,
  waitOn,
} from '../src/core/agent-state.ts'

describe('角色运行时状态机', () => {
  it('正常迁移：idle → thinking → idle，冷却期内不能再抢话', () => {
    let state = createRuntimeState('p1', 0)
    expect(canSpeak(state, 0).ok).toBe(true)
    state = beginThinking(state, 0)
    expect(canSpeak(state, 10).reason).toBe('正在生成')
    state = finishSpeaking(state, 100)
    expect(canSpeak(state, 200).reason).toBe('冷却中')
    expect(canSpeak(state, 10_000).ok).toBe(true)
  })

  it('thinking 卡死会按 TTL 自动回 idle（崩了不会永久占位）', () => {
    let state = beginThinking(createRuntimeState('p1', 0), 0)
    expect(expireIfStale(state, 60_000).status).toBe('thinking')
    state = expireIfStale(state, 200_000)
    expect(state.status).toBe('idle')
    expect(canSpeak(state, 200_001).ok).toBe(true)
  })

  it('waiting_on：目标发言后解除等待', () => {
    let state = waitOn(createRuntimeState('p1', 0), 'p2', 10)
    expect(canSpeak(state, 20).reason).toContain('在等')
    state = resolveWait(state, 'p3', 30)
    expect(state.status).toBe('waiting_on')
    state = resolveWait(state, 'p2', 40)
    expect(state.status).toBe('idle')
  })

  it('仲裁决策落到状态：speak/wait/pass', () => {
    const base = createRuntimeState('p1', 0)
    expect(applyDecision(base, 'speak', 10).status).toBe('thinking')
    expect(applyDecision(base, 'wait', 10, 'p2')).toMatchObject({ status: 'waiting_on', waitingOn: 'p2' })
    expect(applyDecision(base, 'pass', 10).status).toBe('pass')
  })
})
