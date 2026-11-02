import type { CatalogCard, MemoryEntry, Message, Persona, Thread } from './types.ts'
import { createId } from './ids.ts'

export function identityText(persona: Persona): string {
  return `${persona.name}。${persona.personality}。职责：${persona.duties.join('、') || '综合'}`
}

export function threadMemories(memories: MemoryEntry[], threadId: string): MemoryEntry[] {
  return memories.filter((m) => m.scope === 'thread' && m.threadId === threadId)
}

export function userGlobals(memories: MemoryEntry[]): MemoryEntry[] {
  return memories.filter((m) => m.scope === 'user_global')
}

export function catalogFor(personaId: string, threads: Thread[]): CatalogCard[] {
  return threads
    .filter((t) => t.memberIds.includes(personaId))
    .map((t) => ({
      threadId: t.id,
      title: t.title,
      topic: sanitizeCatalogSummary(t.topic),
      shortSummary: sanitizeCatalogSummary(t.shortSummary),
    }))
}

const SECRET = /密钥|密码|token|薪资|工资|secret|password/i

export function sanitizeCatalogSummary(text: string): string {
  return text
    .split(/[。\n]/)
    .filter((s) => s.trim() && !SECRET.test(s))
    .slice(0, 4)
    .join('。')
}

export function appendThreadMemory(memories: MemoryEntry[], threadId: string, text: string): MemoryEntry {
  return {
    id: createId('mem'),
    scope: 'thread',
    threadId,
    text,
    createdAt: Date.now(),
  }
}

export function wakeKey(personaId: string, threadId: string): string {
  return `${personaId}:${threadId}`
}

export function windowMessages(messages: Message[], aroundId: string, before = 6): Message[] {
  const idx = messages.findIndex((m) => m.id === aroundId)
  if (idx < 0) return messages.slice(-before)
  const start = Math.max(0, idx - before)
  return messages.slice(start)
}

function compact(text: string): string {
  return text.replace(/\s+/g, '')
}

/** 回复里如果带上了另一场正文（目录短摘要除外），返回 true。 */
export function speechLeaksOtherThread(text: string, foreignBodies: string[], allowed: string[]): boolean {
  const folded = compact(text)
  const allow = compact(allowed.join('\n'))
  for (const raw of foreignBodies) {
    const body = compact(raw)
    if (body.length < 8) continue
    const probe = body.slice(0, Math.min(32, body.length))
    if (probe.length < 8) continue
    if (allow.includes(probe)) continue
    if (folded.includes(probe)) return true
  }
  return false
}

export function refreshThreadSummary(thread: Thread): void {
  const recent = thread.messages.filter((m) => m.kind !== 'system').slice(-6)
  thread.topic = recent[0]?.text.slice(0, 24) || thread.title
  thread.shortSummary = sanitizeCatalogSummary(
    recent.map((m) => `${m.authorName}：${m.text.slice(0, 40)}`).join('。'),
  )
}
