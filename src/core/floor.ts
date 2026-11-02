import { mentionIds, wantsReview } from './ids.ts'
import type { Activity, ChairSelector, Persona, Thread, ThreadMember } from './types.ts'

export function memberOf(thread: Thread, personaId: string): ThreadMember | undefined {
  return thread.members.find((m) => m.personaId === personaId)
}

export function isEligible(
  thread: Thread,
  member: ThreadMember,
  mentionedIds: string[],
): boolean {
  if (member.completedRound || member.passedRound) {
    return mentionedIds.includes(member.personaId)
  }
  if (mentionedIds.includes(member.personaId)) return true
  if (thread.kind === 'dm') return true
  if (thread.roundMode !== 'review') {
    return member.activity === 'high'
  }
  if (member.activity === 'muted') return mentionedIds.includes(member.personaId)
  if (member.activity === 'mention-only') return mentionedIds.includes(member.personaId)
  return member.activity === 'review' || member.activity === 'high'
}

export function eligiblePersonaIds(
  thread: Thread,
  mentionedIds: string[],
): string[] {
  return thread.members
    .filter((m) => isEligible(thread, m, mentionedIds))
    .map((m) => m.personaId)
}

export class DutyChair implements ChairSelector {
  pickNext(input: {
    candidates: Persona[]
    dutiesLeft: string[]
    latestText: string
    mentionedIds: string[]
  }): { personaId: string; focus: string } | null {
    if (input.candidates.length === 0) return null
    const mentioned = input.mentionedIds
      .map((id) => input.candidates.find((c) => c.id === id))
      .filter((c): c is Persona => Boolean(c))
    if (mentioned.length > 0) {
      return { personaId: mentioned[0].id, focus: mentioned[0].duties[0] || '回应点名' }
    }
    const scored = input.candidates.map((c) => ({
      c,
      score: scoreDuty(c, input.latestText, input.dutiesLeft),
    }))
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]
    if (!best) return null
    const mismatch = best.score === 0 && scored.some((s) => s.score > 0)
    const pick = mismatch ? scored.find((s) => s.score > 0)?.c ?? best.c : best.c
    const used = new Set(input.dutiesLeft)
    const focus = pick.duties.find((d) => !used.has(`used:${d}`)) || pick.duties[0] || '增量补充'
    return { personaId: pick.id, focus }
  }
}

function scoreDuty(persona: Persona, latest: string, dutiesLeft: string[]): number {
  const text = latest.toLowerCase()
  let score = 0
  for (const d of persona.duties) {
    if (text.includes(d.toLowerCase())) score += 3
    if (dutiesLeft.includes(d)) score += 1
  }
  return score
}

export function parseMentions(text: string, personas: Persona[]): string[] {
  return mentionIds(text, personas)
}

export function shouldEnterReview(text: string, explicit: boolean): boolean {
  return explicit || wantsReview(text)
}

export function activityLabel(activity: Activity): string {
  switch (activity) {
    case 'muted':
      return '禁言'
    case 'mention-only':
      return '仅@'
    case 'review':
      return '评审才参与'
    case 'high':
      return '高活跃'
  }
}
