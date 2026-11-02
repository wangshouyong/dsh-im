/**
 * 群事件日志（唯一事实源）与写租约。
 *
 * 只追加：事件永远不修改；messages / 摘要 / 任务板都是它的投影。
 * 租约带 fencingToken：旧 token 的写入必须被拒，避免并发下 seq 断裂。
 */
export const EVENT_SCHEMA_VERSION = 1

export type EventKind =
  | 'user'
  | 'persona'
  | 'system'
  | 'tool_call'
  | 'tool_result'
  | 'fact'
  | 'floor_decision'

/** 只有这三类事件是“消息”，会被投影成聊天记录；其余事件（工具/事实/仲裁）不占消息位。 */
export const CHAT_EVENT_KINDS: readonly EventKind[] = ['user', 'persona', 'system']

export function isChatEvent(event: { kind: EventKind }): boolean {
  return CHAT_EVENT_KINDS.includes(event.kind)
}

/** 事实事件的结构化载荷；text 存事实正文。 */
export interface FactEventPayload {
  op: 'assert' | 'supersede' | 'retract'
  factId: string
  factKind: string
  owner?: string
  source: 'user' | 'persona' | 'extractor'
  confidence?: number
  /** supersede 时被替换的旧 factId。 */
  supersedes?: string
  /** 事实来源消息的事件 id（新写入必填；旧数据可能缺失）。 */
  sourceMessageId?: string
  /** 事实来源消息的持久 seq（与 message.seq 对应）。 */
  sourceMessageSeq?: number
}

/** 发言权仲裁事件的结构化载荷；text 存 reason。 */
export interface FloorDecisionPayload {
  personaId: string
  action: 'speak' | 'wait' | 'pass'
}

export interface ChatEvent {
  schemaVersion: number
  seq: number
  id: string
  at: number
  kind: EventKind
  actorId?: string
  actorName: string
  text: string
  /** 这条发言基于哪个 seq 的视图；用于因果一致性检测。 */
  basedOnSeq?: number
  producer: 'plugin' | 'session' | 'tool'
  /** 内容允许的最高可见级别；真正的裁决在读时由策略函数做。 */
  sensitivity?: 'group' | 'caller' | 'admin'
  /** 群消息/工具结果属于不可信输入（可能含 prompt 注入）。 */
  untrusted?: boolean
  fact?: FactEventPayload
  floorDecision?: FloorDecisionPayload
}

export interface EventInput {
  at: number
  kind: EventKind
  actorId?: string
  actorName: string
  text: string
  basedOnSeq?: number
  producer?: ChatEvent['producer']
  sensitivity?: ChatEvent['sensitivity']
  untrusted?: boolean
  fact?: FactEventPayload
  floorDecision?: FloorDecisionPayload
}

export function lastSeq(events: readonly ChatEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

/** 追加一条事件：seq 单调递增，schemaVersion 自动带上。 */
export function appendEvent(events: readonly ChatEvent[], input: EventInput): ChatEvent {
  const seq = lastSeq(events) + 1
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    id: 'e' + seq,
    at: input.at,
    kind: input.kind,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    actorName: input.actorName,
    text: input.text,
    ...(input.basedOnSeq === undefined ? {} : { basedOnSeq: input.basedOnSeq }),
    producer: input.producer ?? 'plugin',
    ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
    ...(input.untrusted === undefined ? {} : { untrusted: input.untrusted }),
    ...(input.fact === undefined ? {} : { fact: input.fact }),
    ...(input.floorDecision === undefined ? {} : { floorDecision: input.floorDecision }),
  }
}

/** 把一条已存在的事件重新变成可再追加的输入（重建事件流时保留非消息事件用）。 */
export function toEventInput(event: ChatEvent): EventInput {
  return {
    at: event.at,
    kind: event.kind,
    ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
    actorName: event.actorName,
    text: event.text,
    ...(event.basedOnSeq === undefined ? {} : { basedOnSeq: event.basedOnSeq }),
    producer: event.producer,
    ...(event.sensitivity === undefined ? {} : { sensitivity: event.sensitivity }),
    ...(event.untrusted === undefined ? {} : { untrusted: event.untrusted }),
    ...(event.fact === undefined ? {} : { fact: event.fact }),
    ...(event.floorDecision === undefined ? {} : { floorDecision: event.floorDecision }),
  }
}

/** 老 state.json 里的 messages → 初始事件流（一次性迁移，幂等）。 */
export function migrateMessages(messages: readonly {
  id: string
  kind: 'user' | 'persona' | 'system'
  authorName: string
  text: string
  createdAt: number
}[]): ChatEvent[] {
  const events: ChatEvent[] = []
  for (const message of messages) {
    const input: EventInput = {
      at: message.createdAt,
      kind: message.kind,
      actorName: message.authorName,
      text: message.text,
      producer: 'plugin',
      ...(message.kind === 'persona' ? { sensitivity: 'group' as const } : {}),
      ...(message.kind === 'user' ? { untrusted: true } : {}),
    }
    events.push(appendEvent(events, input))
  }
  return events
}

/** 从事件重放界面需要的 messages 投影。 */
export function projectMessages(events: readonly ChatEvent[]): {
  id: string
  kind: 'user' | 'persona' | 'system'
  authorName: string
  text: string
  createdAt: number
}[] {
  return events
    .filter((event) => event.kind === 'user' || event.kind === 'persona' || event.kind === 'system')
    .map((event) => ({
      id: event.id,
      kind: event.kind as 'user' | 'persona' | 'system',
      authorName: event.actorName,
      text: event.text,
      createdAt: event.at,
    }))
}

export interface LeaseRecord {
  groupId: string
  owner: string
  fencingToken: number
  expiresAt: number
}

export interface LeaseStore {
  read(groupId: string): LeaseRecord | undefined
  write(record: LeaseRecord): void
}

export function createMemoryLeaseStore(): LeaseStore {
  const rows = new Map<string, LeaseRecord>()
  return {
    read: (groupId) => rows.get(groupId),
    write: (record) => { rows.set(record.groupId, record) },
  }
}

export type LeaseResult =
  | { ok: true; record: LeaseRecord }
  | { ok: false; holder: string }

/** 抢占/续期写租约：已过期可抢占，fencingToken 单调 +1。 */
export function acquireLease(
  store: LeaseStore,
  groupId: string,
  owner: string,
  now: number,
  ttlMs = 20_000,
): LeaseResult {
  const current = store.read(groupId)
  const expired = !current || current.expiresAt <= now
  if (current && !expired && current.owner !== owner) {
    return { ok: false, holder: current.owner }
  }
  const record: LeaseRecord = {
    groupId,
    owner,
    fencingToken: (current?.fencingToken ?? 0) + 1,
    expiresAt: now + ttlMs,
  }
  store.write(record)
  return { ok: true, record }
}

/** 续期：只有仍持有同一 fencingToken 的写入方能续。 */
export function renewLease(store: LeaseStore, record: LeaseRecord, now: number, ttlMs = 20_000): LeaseRecord | null {
  const current = store.read(record.groupId)
  if (!current || current.owner !== record.owner || current.fencingToken !== record.fencingToken) return null
  const next: LeaseRecord = { ...current, expiresAt: now + ttlMs }
  store.write(next)
  return next
}

/** 写入校验：token 必须仍是当前 token 且未过期，否则拒绝（fail-closed）。 */
export function canWrite(store: LeaseStore, record: LeaseRecord, now: number): boolean {
  const current = store.read(record.groupId)
  return Boolean(current && current.owner === record.owner && current.fencingToken === record.fencingToken && current.expiresAt > now)
}
