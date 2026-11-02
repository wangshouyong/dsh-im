import { arbitrate, type ArbiterCandidate, type ArbiterDecision } from './arbiter.ts'
import { createRuntimeState, type AgentRuntimeState } from './agent-state.ts'

/** 从群成员派生仲裁候选：缺状态的补 idle，避免“没人能说”的假死。 */
export function buildCandidates(input: {
  members: {
    personaId: string
    name: string
    duties: string[]
    activity: 'muted' | 'mention-only' | 'review' | 'high'
    answered: boolean
  }[]
  states: Record<string, AgentRuntimeState>
  now: number
}): ArbiterCandidate[] {
  return input.members.map((member) => ({
    ...member,
    state: input.states[member.personaId] ?? createRuntimeState(member.personaId, input.now),
  }))
}

export interface FloorDecisionInput {
  latestText: string
  mentionedIds: string[]
  replyToPersonaId?: string
  members: Parameters<typeof buildCandidates>[0]['members']
  states: Record<string, AgentRuntimeState>
  spokenIds?: string[]
  now: number
}

/** 地板下一步决策：仲裁器 + 候选装配，一次调用拿到结论和原因。 */
export function decideNext(input: FloorDecisionInput): ArbiterDecision {
  return arbitrate({
    latestText: input.latestText,
    mentionedIds: input.mentionedIds,
    ...(input.replyToPersonaId === undefined ? {} : { replyToPersonaId: input.replyToPersonaId }),
    candidates: buildCandidates({ members: input.members, states: input.states, now: input.now }),
    ...(input.spokenIds === undefined ? {} : { spokenIds: input.spokenIds }),
    now: input.now,
  })
}
