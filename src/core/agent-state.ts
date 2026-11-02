/**
 * 角色运行时状态机（仲裁的输入）。
 *
 * 只放内存、带 TTL：崩溃留下的 thinking 靠过期自动回 idle，
 * 不把“正在想”写进事件日志（那正是崩溃时写不出来的东西）。
 */
export type AgentStatus = 'idle' | 'thinking' | 'waiting_on' | 'pass'

export interface AgentRuntimeState {
  personaId: string
  status: AgentStatus
  since: number
  /** waiting_on 时在等谁。 */
  waitingOn?: string
  lastSpokeAt?: number
}

/** thinking / waiting_on 超过这个时间视为失效（崩了/卡了）。 */
export const THINKING_TTL_MS = 120_000
/** 同一角色两次主动发言之间的冷却。 */
export const SPEAK_COOLDOWN_MS = 3_000

export function createRuntimeState(personaId: string, now: number): AgentRuntimeState {
  return { personaId, status: 'idle', since: now }
}

function move(state: AgentRuntimeState, status: AgentStatus, now: number, extra: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return { ...state, status, since: now, ...extra }
}

export function beginThinking(state: AgentRuntimeState, now: number): AgentRuntimeState {
  return move(state, 'thinking', now)
}

export function finishSpeaking(state: AgentRuntimeState, now: number): AgentRuntimeState {
  return move(state, 'idle', now, { lastSpokeAt: now, waitingOn: undefined })
}

export function waitOn(state: AgentRuntimeState, targetPersonaId: string, now: number): AgentRuntimeState {
  return move(state, 'waiting_on', now, { waitingOn: targetPersonaId })
}

export function pass(state: AgentRuntimeState, now: number): AgentRuntimeState {
  return move(state, 'pass', now)
}

/** 过期回收：thinking / waiting_on 卡太久就回 idle。 */
export function expireIfStale(state: AgentRuntimeState, now: number, ttlMs = THINKING_TTL_MS): AgentRuntimeState {
  const busy = state.status === 'thinking' || state.status === 'waiting_on'
  if (!busy) return state
  if (now - state.since < ttlMs) return state
  return move(state, 'idle', now, { waitingOn: undefined })
}

/** 等待目标已经发过言 → 解除等待。 */
export function resolveWait(state: AgentRuntimeState, spokePersonaId: string, now: number): AgentRuntimeState {
  if (state.status !== 'waiting_on' || state.waitingOn !== spokePersonaId) return state
  return move(state, 'idle', now, { waitingOn: undefined })
}

/** 现在能不能主动发言：必须 idle，且过了冷却。 */
export function canSpeak(
  state: AgentRuntimeState,
  now: number,
  options: { cooldownMs?: number } = {},
): { ok: boolean; reason?: string } {
  const cooldown = options.cooldownMs ?? SPEAK_COOLDOWN_MS
  if (state.status === 'thinking') return { ok: false, reason: '正在生成' }
  if (state.status === 'waiting_on') return { ok: false, reason: '在等 ' + (state.waitingOn ?? '他人') }
  if (state.status === 'pass') return { ok: false, reason: '本轮已弃权' }
  if (state.lastSpokeAt !== undefined && now - state.lastSpokeAt < cooldown) {
    return { ok: false, reason: '冷却中' }
  }
  return { ok: true }
}

export type TurnDecision = 'speak' | 'wait' | 'pass'

/** 把仲裁结果落成状态迁移（仲裁器只管决策，这里管状态）。 */
export function applyDecision(
  state: AgentRuntimeState,
  decision: TurnDecision,
  now: number,
  targetPersonaId?: string,
): AgentRuntimeState {
  if (decision === 'speak') return beginThinking(state, now)
  if (decision === 'wait') return targetPersonaId ? waitOn(state, targetPersonaId, now) : waitOn(state, '他人', now)
  return pass(state, now)
}
