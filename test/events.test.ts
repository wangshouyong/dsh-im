import { describe, expect, it } from 'vitest'
import {
  appendEvent,
  acquireLease,
  canWrite,
  createMemoryLeaseStore,
  lastSeq,
  migrateMessages,
  projectMessages,
  renewLease,
} from '../src/core/events.ts'

describe('群事件日志', () => {
  it('只追加：seq 单调递增，schemaVersion 自带', () => {
    const first = appendEvent([], { at: 1000, kind: 'user', actorName: '你', text: '在吗' })
    const second = appendEvent([first], { at: 2000, kind: 'persona', actorName: '淇淇', text: '在' })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(second.schemaVersion).toBe(1)
    expect(lastSeq([first, second])).toBe(2)
  })

  it('老 messages 能迁移成事件并按原顺序投影回来', () => {
    const legacy = [
      { id: 'm1', kind: 'user' as const, authorName: '你', text: '开始吧', createdAt: 1 },
      { id: 'm2', kind: 'persona' as const, authorName: '淇淇', text: '收到', createdAt: 2 },
      { id: 'm3', kind: 'system' as const, authorName: '系统主持', text: '本轮已移除 X', createdAt: 3 },
    ]
    const events = migrateMessages(legacy)
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(events[0].untrusted).toBe(true)
    const messages = projectMessages(events)
    expect(messages.map((message) => message.text)).toEqual(['开始吧', '收到', '本轮已移除 X'])
    expect(messages.map((message) => message.authorName)).toEqual(['你', '淇淇', '系统主持'])
  })

  it('因果字段可以落在 persona 事件上', () => {
    const events = migrateMessages([
      { id: 'm1', kind: 'user' as const, authorName: '你', text: 'a', createdAt: 1 },
      { id: 'm2', kind: 'persona' as const, authorName: '淇淇', text: 'b', createdAt: 2 },
    ])
    const withCausal = appendEvent(events, { at: 3, kind: 'persona', actorName: '测试2', text: 'c', basedOnSeq: 2 })
    expect(withCausal.basedOnSeq).toBe(2)
    expect(withCausal.seq).toBe(3)
  })
})

describe('群写租约（fencing）', () => {
  it('同一时刻只有一个写方；过期后可抢占且 token +1', () => {
    const store = createMemoryLeaseStore()
    const first = acquireLease(store, 'g1', 'plugin-a', 1000, 1000)
    expect(first.ok).toBe(true)
    const blocked = acquireLease(store, 'g1', 'plugin-b', 1500, 1000)
    expect(blocked).toEqual({ ok: false, holder: 'plugin-a' })

    const takeover = acquireLease(store, 'g1', 'plugin-b', 2500, 1000)
    expect(takeover.ok).toBe(true)
    if (!takeover.ok) return
    expect(takeover.record.fencingToken).toBe(2)

    if (!first.ok) return
    expect(canWrite(store, first.record, 2600)).toBe(false)
    expect(canWrite(store, takeover.record, 2600)).toBe(true)
  })

  it('续期只有同一 token 能续，续期失败即不可写', () => {
    const store = createMemoryLeaseStore()
    const lease = acquireLease(store, 'g1', 'a', 1000, 1000)
    if (!lease.ok) throw new Error('lease failed')
    const renewed = renewLease(store, lease.record, 1800, 1000)
    expect(renewed?.expiresAt).toBe(2800)
    expect(canWrite(store, renewed!, 2700)).toBe(true)
    expect(renewLease(store, { ...lease.record, fencingToken: 99 }, 2800, 1000)).toBeNull()
    expect(canWrite(store, lease.record, 9000)).toBe(false)
  })
})
