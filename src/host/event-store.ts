import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertSafeThreadId } from '../core/workspace.ts'
import {
  appendEvent,
  isChatEvent,
  lastSeq,
  migrateMessages,
  toEventInput,
  type ChatEvent,
  type EventInput,
  type LeaseRecord,
  type LeaseStore,
} from '../core/events.ts'

/** 每群的私有目录：`.dsh-im/groups/<threadId>/` */
export function groupDir(root: string, threadId: string): string {
  assertSafeThreadId(threadId)
  return join(root, '.dsh-im', 'groups', threadId)
}

export function eventsPath(root: string, threadId: string): string {
  return join(groupDir(root, threadId), 'events.jsonl')
}

export function leasePath(root: string, threadId: string): string {
  return join(groupDir(root, threadId), 'lease.json')
}

/** 读事件日志：坏行跳过（不让一行脏数据炸整个群）。 */
export async function readEvents(root: string, threadId: string): Promise<ChatEvent[]> {
  let raw: string
  try {
    raw = await readFile(eventsPath(root, threadId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const events: ChatEvent[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as ChatEvent
      if (typeof parsed?.seq === 'number' && typeof parsed?.text === 'string') events.push(parsed)
    } catch {
      continue
    }
  }
  return events.sort((left, right) => left.seq - right.seq)
}

/** 追加一条事件并落盘（只追加，不重写历史）。 */
export async function appendChatEvent(root: string, threadId: string, input: EventInput): Promise<ChatEvent> {
  const events = await readEvents(root, threadId)
  const event = appendEvent(events, input)
  await mkdir(groupDir(root, threadId), { recursive: true })
  await appendFile(eventsPath(root, threadId), JSON.stringify(event) + '\n', 'utf8')
  return event
}

/**
 * 老 `state.json` 的 messages → 事件日志。幂等：已有事件就不动。
 * @returns 是否真的迁移了，以及当前事件流。
 */
export async function migrateThreadEvents(
  root: string,
  threadId: string,
  messages: readonly { id: string; kind: 'user' | 'persona' | 'system'; authorName: string; text: string; createdAt: number }[],
): Promise<{ migrated: boolean; events: ChatEvent[] }> {
  const existing = await readEvents(root, threadId)
  if (existing.length > 0 || messages.length === 0) return { migrated: false, events: existing }
  const events = migrateMessages(messages)
  await mkdir(groupDir(root, threadId), { recursive: true })
  await writeFile(eventsPath(root, threadId), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  return { migrated: true, events }
}

/** 文件版租约存储（host 侧；同步实现，文件很小）。 */
export function createFileLeaseStore(root: string): LeaseStore {
  const pathOf = (groupId: string) => leasePath(root, groupId)
  return {
    read(groupId) {
      try {
        const parsed = JSON.parse(readFileSync(pathOf(groupId), 'utf8')) as LeaseRecord
        if (typeof parsed?.owner === 'string' && typeof parsed?.fencingToken === 'number') return parsed
        return undefined
      } catch {
        return undefined
      }
    },
    write(record) {
      // 先校验 groupId（groupDir 内断言）再建目录，避免 `../` 在 groups 外留下空目录。
      const dir = groupDir(root, record.groupId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(pathOf(record.groupId), JSON.stringify(record), 'utf8')
    },
  }
}

export function lastEventSeq(events: readonly ChatEvent[]): number {
  return lastSeq(events)
}


/** 每个群已同步进事件日志的消息条数（双写过渡期的游标）。 */
export function syncPath(root: string, threadId: string): string {
  return join(groupDir(root, threadId), 'sync.json')
}

export interface SyncResult {
  appended: number
  rewritten: boolean
  /** 与 messages 一一对应的持久 seq；对不上时为空数组（不覆盖已有 seq）。 */
  seqs: number[]
}

/**
 * 把 state.json 里的 messages 增量同步进事件日志（过渡期双写，读仍以 state 为准）。
 *
 * 消息事件按顺序对应；`seqs` 回传每条消息在事件日志里的持久序号，
 * saveState 用它回填 `message.seq`。非消息事件（事实/仲裁）在整份重写时保留。
 */
export async function syncThreadEvents(
  root: string,
  threadId: string,
  messages: readonly { id: string; kind: 'user' | 'persona' | 'system'; authorName: string; text: string; createdAt: number }[],
): Promise<SyncResult> {
  await mkdir(groupDir(root, threadId), { recursive: true })
  let synced = 0
  try {
    const meta = JSON.parse(await readFile(syncPath(root, threadId), 'utf8')) as { messageCount?: number }
    synced = typeof meta.messageCount === 'number' && meta.messageCount >= 0 ? meta.messageCount : 0
  } catch {
    synced = 0
  }
  const existing = await readEvents(root, threadId)
  const chatEvents = existing.filter((event) => isChatEvent(event))
  const stale = synced > messages.length
  const emptyButHasMessages = chatEvents.length === 0 && messages.length > 0
  if (stale || emptyButHasMessages) {
    const rebuilt = migrateMessages(messages)
    const events = [...rebuilt]
    // 保留推导出来的事实/仲裁事件：重写消息区不能把它们冲掉。
    for (const event of existing) {
      if (isChatEvent(event)) continue
      events.push(appendEvent(events, toEventInput(event)))
    }
    const body = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
    await writeFile(eventsPath(root, threadId), body, 'utf8')
    await writeFile(syncPath(root, threadId), JSON.stringify({ messageCount: messages.length }), 'utf8')
    return { appended: 0, rewritten: true, seqs: rebuilt.map((event) => event.seq) }
  }
  const fresh = messages.slice(synced)
  if (fresh.length === 0) {
    const seqs = chatEvents.length === messages.length ? chatEvents.map((event) => event.seq) : []
    return { appended: 0, rewritten: false, seqs }
  }
  let events = existing
  const freshEvents: ChatEvent[] = []
  for (const message of fresh) {
    const event = appendEvent(events, {
      at: message.createdAt,
      kind: message.kind,
      actorName: message.authorName,
      text: message.text,
      producer: 'plugin',
      ...(message.kind === 'user' ? { untrusted: true as const } : {}),
    })
    events = [...events, event]
    freshEvents.push(event)
  }
  await appendFile(eventsPath(root, threadId), freshEvents.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  await writeFile(syncPath(root, threadId), JSON.stringify({ messageCount: messages.length }), 'utf8')
  const seqs = chatEvents.length === synced
    ? [...chatEvents.map((event) => event.seq), ...freshEvents.map((event) => event.seq)]
    : []
  return { appended: fresh.length, rewritten: false, seqs }
}
