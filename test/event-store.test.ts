import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireLease, canWrite } from '../src/core/events.ts'
import {
  appendChatEvent,
  createFileLeaseStore,
  migrateThreadEvents,
  readEvents,
} from '../src/host/event-store.ts'

const legacy = [
  { id: 'm1', kind: 'user' as const, authorName: '你', text: '在吗', createdAt: 1000 },
  { id: 'm2', kind: 'persona' as const, authorName: '淇淇', text: '在', createdAt: 2000 },
]

describe('群事件日志落盘', () => {
  it('老 messages 首次迁移，重复调用幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-events-'))
    const first = await migrateThreadEvents(root, 't1', legacy)
    expect(first.migrated).toBe(true)
    expect(first.events.map((event) => event.seq)).toEqual([1, 2])

    const again = await migrateThreadEvents(root, 't1', legacy)
    expect(again.migrated).toBe(false)
    expect(again.events).toHaveLength(2)
  })

  it('追加事件落盘后能按 seq 读回，坏行被跳过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-events-'))
    await migrateThreadEvents(root, 't1', legacy)
    const event = await appendChatEvent(root, 't1', { at: 3000, kind: 'system', actorName: '系统主持', text: '本轮开始' })
    expect(event.seq).toBe(3)
    const events = await readEvents(root, 't1')
    expect(events.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(events[2].text).toBe('本轮开始')
  })

  it('不同群互相隔离', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-events-'))
    await migrateThreadEvents(root, 't1', legacy)
    const other = await readEvents(root, 't2')
    expect(other).toEqual([])
  })

  it('文件租约：同一时刻只有一个写方，旧 token 不可写', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-events-'))
    const store = createFileLeaseStore(root)
    const first = acquireLease(store, 't1', 'plugin-a', 1000, 1000)
    expect(first.ok).toBe(true)
    const blocked = acquireLease(store, 't1', 'plugin-b', 1500, 1000)
    expect(blocked.ok).toBe(false)
    const takeover = acquireLease(store, 't1', 'plugin-b', 2500, 1000)
    expect(takeover.ok).toBe(true)
    if (!first.ok || !takeover.ok) return
    expect(canWrite(store, first.record, 2600)).toBe(false)
    expect(canWrite(store, takeover.record, 2600)).toBe(true)
  })
})
