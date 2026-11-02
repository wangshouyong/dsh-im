/**
 * 可寻址记忆层 · 消息索引投影（Phase 0）。
 *
 * 定位：`events.jsonl` 是唯一事实源，本索引是它的**派生投影**，回答
 * 「某条消息在哪个话题段、有没有 claim 状态、要不要按不可信输入处理」，
 * 让"冷区可寻址"成立：prompt 里放目录/句柄，正文需要时再按 seq 取回。
 *
 * 三条设计约束：
 * 1. **不复制正文**：只存 `textHash + textLen`，展开时从 events.jsonl 取——索引丢了随时可重建，
 *    不会变成第二份真相；
 * 2. **增量游标**：`lastSeq + lastTopicId + sourceSize`；文件变小/条目对不上/增量过大 → 全量重建；
 * 3. **弱状态预计算 + 脏区重算**：claim 状态（active/superseded/raw）来自 fact/consensus，
 *    每次构建只重写「本次有 claim 或上次有 claim」的条目（`dirtySeqs`）。
 *
 * Phase 0 只建索引并写入回执/诊断，**不接 prompt**（零行为变更）。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { stableHash } from '../core/receipt.ts'
import { assertSafeThreadId } from '../core/workspace.ts'
import { applyClaimStatuses, deriveClaimStatuses, MEMORY_IMPERATIVE, type MemoryClaimState } from '../core/memory-claims.ts'
import type { ConsensusState } from '../core/consensus.ts'
import { isChatEvent, type ChatEvent } from '../core/events.ts'
import { eventsPath, groupDir, readEvents } from './event-store.ts'
import { writeFileAtomic } from './fs-atomic.ts'
import { logWarn } from '../core/log.ts'

export const MEMORY_INDEX_SCHEMA = 1
/** 单群索引条目上限：超过就拒绝构建（不静默截断，避免"可寻址"变成"部分可寻址"）。 */
export const INDEX_MAX_ENTRIES = 50_000
/** 增量条目超过已有条目的这个比例时改为全量重建。 */
export const INDEX_REBUILD_DELTA_RATIO = 0.5
/** 兼容旧引用：指令性语句正则现在定义在 core（客户端也要用）。 */
export const INDEX_IMPERATIVE = MEMORY_IMPERATIVE

export interface MemoryIndexEntry {
  seq: number
  at: number
  actorName: string
  actorId?: string
  /** 话题段号 = 该段首条用户消息的 seq（0 = 尚无用户消息）。 */
  topicId: number
  claim: MemoryClaimState
  successorSeq?: number
  /** 正文指纹（正文不复制；展开时回 events.jsonl 取）。 */
  textHash: string
  textLen: number
  untrusted: boolean
  imperative: boolean
}

export interface MemoryIndexCursor {
  lastSeq: number
  lastTopicId: number
  sourceSize: number
  builtAt: number
  rebuilds: number
  dirtySeqs: number[]
}

export interface MemoryIndex {
  schema: number
  threadId: string
  entries: MemoryIndexEntry[]
  cursor: MemoryIndexCursor
  stats: {
    messages: number
    topics: number
    active: number
    superseded: number
    raw: number
    untrusted: number
    imperative: number
  }
}

export function memoryIndexPath(root: string, threadId: string): string {
  return join(groupDir(root, threadId), 'index.json')
}

function toEntry(event: ChatEvent, topicId: number): MemoryIndexEntry {
  return {
    seq: event.seq,
    at: event.at,
    actorName: event.actorName,
    ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
    topicId,
    claim: 'raw',
    textHash: stableHash(event.text ?? '').split(':').at(-1) ?? '',
    textLen: (event.text ?? '').length,
    untrusted: event.untrusted ?? true,
    imperative: MEMORY_IMPERATIVE.test(event.text ?? ''),
  }
}

function deriveEntries(events: readonly ChatEvent[]): { entries: MemoryIndexEntry[]; lastTopicId: number } {
  let topicId = 0
  const entries: MemoryIndexEntry[] = []
  for (const event of events) {
    if (!isChatEvent(event)) continue
    if (event.kind === 'user') topicId = event.seq
    entries.push(toEntry(event, topicId))
  }
  return { entries, lastTopicId: topicId }
}

export async function loadMemoryIndex(root: string, threadId: string): Promise<MemoryIndex | null> {
  let raw: string
  try {
    raw = await readFile(memoryIndexPath(root, threadId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as MemoryIndex
    if (parsed?.schema !== MEMORY_INDEX_SCHEMA) return null
    if (!Array.isArray(parsed.entries) || typeof parsed.cursor?.lastSeq !== 'number') return null
    return parsed
  } catch {
    logWarn('[dsh-im] 记忆索引损坏，将重建', { threadId })
    return null
  }
}

export interface BuildIndexOptions {
  force?: boolean
  consensus?: ConsensusState
  now?: number
  /** 是否落盘（默认 true；诊断预览传 false）。 */
  persist?: boolean
}

export interface BuildIndexResult {
  index: MemoryIndex
  rebuilt: boolean
  reason: string
}

export async function buildMemoryIndex(
  root: string,
  threadId: string,
  options: BuildIndexOptions = {},
): Promise<BuildIndexResult> {
  assertSafeThreadId(threadId)
  const events = await readEvents(root, threadId)
  const chatEvents = events.filter(isChatEvent)
  if (chatEvents.length > INDEX_MAX_ENTRIES) {
    throw Object.assign(
      new Error(`会话 ${threadId} 消息数 ${chatEvents.length} 超过索引上限 ${INDEX_MAX_ENTRIES}，需要先做分片`),
      { code: 'INDEX_TOO_LARGE' },
    )
  }
  let sourceSize = 0
  try {
    sourceSize = (await stat(eventsPath(root, threadId))).size
  } catch {
    sourceSize = 0
  }

  const previous = await loadMemoryIndex(root, threadId)
  const reasons: string[] = []
  if (!previous) reasons.push('no-index')
  else if (previous.threadId !== threadId) reasons.push('thread-changed')
  else {
    if (sourceSize < previous.cursor.sourceSize) reasons.push('source-shrank')
    const lastIndexed = previous.cursor.lastSeq
    if (chatEvents.length && chatEvents[chatEvents.length - 1].seq < lastIndexed) reasons.push('seq-rewind')
    if (previous.entries.length && chatEvents.length < previous.entries.length) reasons.push('entries-shrunk')
    const freshCount = chatEvents.filter((event) => event.seq > lastIndexed).length
    if (freshCount > Math.max(1, previous.entries.length) * INDEX_REBUILD_DELTA_RATIO) reasons.push('delta-too-large')
  }
  if (options.force) reasons.push('forced')
  const rebuilt = reasons.length > 0

  let entries: MemoryIndexEntry[]
  let lastTopicId: number
  if (rebuilt || !previous) {
    const derived = deriveEntries(chatEvents)
    entries = derived.entries
    lastTopicId = derived.lastTopicId
  } else {
    entries = [...previous.entries]
    lastTopicId = previous.cursor.lastTopicId
    for (const event of chatEvents) {
      if (event.seq <= previous.cursor.lastSeq) continue
      if (event.kind === 'user') lastTopicId = event.seq
      entries.push(toEntry(event, lastTopicId))
    }
  }

  const claims = deriveClaimStatuses({ events, ...(options.consensus ? { consensus: options.consensus } : {}) })
  const applied = applyClaimStatuses(entries, claims.bySeq)
  entries = applied.entries

  const now = options.now ?? Date.now()
  const index: MemoryIndex = {
    schema: MEMORY_INDEX_SCHEMA,
    threadId,
    entries,
    cursor: {
      lastSeq: entries.length ? entries[entries.length - 1].seq : 0,
      lastTopicId,
      sourceSize,
      builtAt: now,
      rebuilds: (previous?.cursor.rebuilds ?? 0) + (rebuilt ? 1 : 0),
      dirtySeqs: applied.dirtySeqs,
    },
    stats: {
      messages: entries.length,
      topics: new Set(entries.map((entry) => entry.topicId).filter((topic) => topic > 0)).size,
      active: entries.filter((entry) => entry.claim === 'active').length,
      superseded: entries.filter((entry) => entry.claim === 'superseded').length,
      raw: entries.filter((entry) => entry.claim === 'raw').length,
      untrusted: entries.filter((entry) => entry.untrusted).length,
      imperative: entries.filter((entry) => entry.imperative).length,
    },
  }
  if (options.persist !== false) {
    await writeFileAtomic(memoryIndexPath(root, threadId), JSON.stringify(index))
  }
  return { index, rebuilt, reason: rebuilt ? reasons.join('+') : 'incremental' }
}

/** 按 seq 取回原文（expand 路径）。正文只从 events.jsonl 取，索引不复制正文。 */
export async function resolveMemoryMessages(
  root: string,
  threadId: string,
  seqs: readonly number[],
): Promise<Map<number, ChatEvent>> {
  const wanted = new Set(seqs.filter((seq) => Number.isFinite(seq) && seq > 0))
  const out = new Map<number, ChatEvent>()
  if (wanted.size === 0) return out
  const events = await readEvents(root, threadId)
  for (const event of events) {
    if (wanted.has(event.seq)) out.set(event.seq, event)
  }
  return out
}
