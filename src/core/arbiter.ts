import { canSpeak, type AgentRuntimeState } from './agent-state.ts'

/** 群聊发言权仲裁：规则层，纯函数，决策可回放。 */
export type ArbiterAction = 'speak' | 'wait' | 'pass'

export interface ArbiterCandidate {
  personaId: string
  name: string
  duties: string[]
  activity: 'muted' | 'mention-only' | 'review' | 'high'
  state: AgentRuntimeState
  /** 本轮是否已经就这条消息发过言。 */
  answered: boolean
}

export interface ArbiterInput {
  latestText: string
  mentionedIds: string[]
  replyToPersonaId?: string
  candidates: ArbiterCandidate[]
  /** 本轮已经发过言的人（防止同一轮重复轮转）。 */
  spokenIds?: string[]
  now: number
}

export interface ArbiterDecision {
  action: ArbiterAction
  personaId?: string
  /** wait 时在等谁。 */
  waitingOn?: string
  reason: string
}

function find(candidates: ArbiterCandidate[], personaId: string | undefined): ArbiterCandidate | undefined {
  if (!personaId) return undefined
  return candidates.find((candidate) => candidate.personaId === personaId)
}

function canTake(candidate: ArbiterCandidate, input: ArbiterInput, spoken: Set<string>): boolean {
  if (spoken.has(candidate.personaId)) return false
  if (candidate.answered) return false
  return canSpeak(candidate.state, input.now).ok
}

export function arbitrate(input: ArbiterInput): ArbiterDecision {
  const spoken = new Set(input.spokenIds ?? [])
  const text = input.latestText.toLowerCase()

  // 1) 显式点名：只有被点名的人能说；若他正在生成，其他人等。
  if (input.mentionedIds.length > 0) {
    for (const id of input.mentionedIds) {
      const candidate = find(input.candidates, id)
      if (!candidate) continue
      if (spoken.has(candidate.personaId)) continue
      const gate = canSpeak(candidate.state, input.now)
      if (gate.ok) return { action: 'speak', personaId: candidate.personaId, reason: '被点名：' + candidate.name }
      return { action: 'wait', personaId: candidate.personaId, waitingOn: candidate.personaId, reason: candidate.name + ' 正在处理（' + (gate.reason ?? '忙') + '）' }
    }
    return { action: 'pass', reason: '被点名者本轮都已发过言' }
  }

  // 2) 回复对象：只能他回。
  const replyTo = find(input.candidates, input.replyToPersonaId)
  if (replyTo && !spoken.has(replyTo.personaId)) {
    const gate = canSpeak(replyTo.state, input.now)
    if (gate.ok) return { action: 'speak', personaId: replyTo.personaId, reason: '回复对象：' + replyTo.name }
    return { action: 'wait', personaId: replyTo.personaId, waitingOn: replyTo.personaId, reason: replyTo.name + ' 正在处理' }
  }

  // 3) 自由发言：高活跃/评审参与里，按职责关键词与冷却挑一个。
  const eligible = input.candidates.filter((candidate) => (
    (candidate.activity === 'high' || candidate.activity === 'review') && canTake(candidate, input, spoken)
  ))
  if (eligible.length === 0) {
    const busy = input.candidates.find((candidate) => candidate.state.status === 'thinking')
    if (busy) return { action: 'wait', waitingOn: busy.personaId, reason: busy.name + ' 正在生成' }
    return { action: 'pass', reason: '没有新的可发言角色（没被点名、都在冷却/已答/资格外）' }
  }
  const scored = eligible.map((candidate) => ({
    candidate,
    score: candidate.duties.reduce((total, duty) => (text.includes(duty.toLowerCase()) ? total + 3 : total), 0),
  }))
  scored.sort((left, right) => right.score - left.score)
  const pick = scored[0]
  return {
    action: 'speak',
    personaId: pick.candidate.personaId,
    reason: pick.score > 0 ? '职责命中：' + pick.candidate.name : '按活跃度补位：' + pick.candidate.name,
  }
}
