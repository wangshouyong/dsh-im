import type { ImState, MessageKind, Thread } from './types.ts'
import { normalizeToolAllow } from './tools.ts'

export function stateRelPath(): string {
  return 'state.json'
}

export function emptyState(): ImState {
  return {
    personas: [],
    threads: [],
    memories: [],
    wakeExcerpts: {},
    pendingRecall: null,
    lastProactiveAt: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * DM / 三人小窗的标题默认从角色名派生：
 * - DM 没有改名入口，永远按当前角色名重建；
 * - 三人小窗点标题改名后带 `titleCustom: true`，此后角色改名不再覆盖用户起的名字；
 * - 群标题由用户起（建群时填），不参与派生。
 * 旧数据没有该标记 → 继续按角色名自愈（例如角色已叫"敏敏"、会话还叫"测试2"）。
 */
export function repairDerivedThreadTitles(state: ImState): ImState {
  const nameOf = (id: string): string | undefined => state.personas.find((persona) => persona.id === id)?.name
  for (const thread of state.threads) {
    if (!Array.isArray(thread.memberIds)) continue
    if (thread.kind === 'dm' && thread.memberIds.length === 1) {
      const name = nameOf(thread.memberIds[0])
      if (name && thread.title !== name) thread.title = name
      continue
    }
    if (thread.kind === 'triad' && thread.memberIds.length === 2 && !thread.titleCustom) {
      const names = thread.memberIds.map(nameOf)
      if (names.every((name): name is string => Boolean(name))) thread.title = names.join('、')
    }
  }
  return state
}

export function parseState(raw: string): ImState {
  const data = JSON.parse(raw) as Partial<ImState>
  const personas = (Array.isArray(data.personas) ? data.personas : []).filter(
    (persona) => isRecord(persona) && typeof persona.id === 'string' && typeof persona.name === 'string',
  )
  return repairDerivedThreadTitles({
    // 老数据里的工具 id（例如已下线的 shell）在加载时收敛；旧 browser/image 迁移成 grp:。
    personas: personas.map((persona) => {
      const toolAllow = normalizeToolAllow(persona.toolAllow, persona.toolDeny)
      return toolAllow === undefined ? persona : { ...persona, toolAllow, toolDeny: undefined }
    }),
    threads: (Array.isArray(data.threads) ? data.threads : []).filter(
      (thread) => isRecord(thread) && typeof thread.id === 'string' && typeof thread.title === 'string',
    ).map(normalizeThreadMessages),
    memories: (Array.isArray(data.memories) ? data.memories : []).filter(
      (memory) => isRecord(memory) && typeof memory.id === 'string',
    ),
    wakeExcerpts: data.wakeExcerpts && typeof data.wakeExcerpts === 'object' ? data.wakeExcerpts : {},
    pendingRecall: data.pendingRecall ?? null,
    lastProactiveAt: data.lastProactiveAt && typeof data.lastProactiveAt === 'object' ? data.lastProactiveAt : {},
  })
}

/**
 * 消息 kind 收敛：只认 user / persona / system 三态。
 *
 * 现实里 state.json 可能被外部脚本、演示数据、别的工具写进来（已经遇到一份 `kind: 'text'` 的手工演示数据），
 * 非标准 kind 会让界面把「你的发言」当角色发言排到左边，也会影响 prompt 里用户/角色的区分。
 * 这里按「有没有 authorId」归一：有作者 → persona；没有作者 → user；作者名像系统 → system。
 * 标准 kind 原样保留（幂等）。
 */
export function normalizeMessageKind(kind: unknown, authorId: unknown, authorName: unknown): MessageKind {
  if (kind === 'user' || kind === 'persona' || kind === 'system') return kind
  if (typeof authorId === 'string' && authorId) return 'persona'
  const name = typeof authorName === 'string' ? authorName.trim() : ''
  if (!name || name === '你' || name === '我' || name.toLowerCase() === 'user') return 'user'
  if (/系统|主持|system|assistant/i.test(name)) return 'system'
  return 'persona'
}

function normalizeThreadMessages(thread: Thread): Thread {
  if (!Array.isArray(thread.messages)) return thread
  let changed = false
  const messages = thread.messages.map((message) => {
    if (!isRecord(message)) return message
    const kind = normalizeMessageKind(message.kind, message.authorId, message.authorName)
    if (kind === message.kind) return message
    changed = true
    return { ...message, kind }
  })
  return changed ? { ...thread, messages } : thread
}
