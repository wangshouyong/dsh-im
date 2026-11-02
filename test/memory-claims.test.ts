/**
 * claim 状态推导（Phase 0）回归。
 *
 * 这是"状态贯穿检索块"的地基：旧消息被拉回时，body 只允许放 active，
 * superseded 只进目录并指向接手者。所以推导错了，A 的过期冲突门一定红。
 */
import { describe, expect, it } from 'vitest'
import { appendChatEvent } from '../src/host/event-store.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEvents } from '../src/host/event-store.ts'
import { deriveClaimStatuses, applyClaimStatuses, claimsFromThread } from '../src/core/memory-claims.ts'
import type { ChatEvent } from '../src/core/events.ts'

async function groupWithEvents(build: (root: string) => Promise<void>): Promise<ChatEvent[]> {
  const root = await mkdtemp(join(tmpdir(), 'dshim-claims-'))
  await build(root)
  return readEvents(root, 't1')
}

describe('claim 状态：fact 事件', () => {
  it('assert → active；supersede → 旧消息 superseded 且指向新消息 seq', async () => {
    const events = await groupWithEvents(async (root) => {
      await appendChatEvent(root, 't1', { at: 1, kind: 'user', actorName: '你', text: '记住：周三上线灰度' })
      await appendChatEvent(root, 't1', {
        at: 2,
        kind: 'fact',
        actorName: '系统',
        text: '决定：周三上线灰度',
        fact: { op: 'assert', factId: 'f1', factKind: 'decision', source: 'user', sourceMessageSeq: 1 },
      })
      await appendChatEvent(root, 't1', { at: 3, kind: 'user', actorName: '你', text: '改成周四上线灰度' })
      await appendChatEvent(root, 't1', {
        at: 4,
        kind: 'fact',
        actorName: '系统',
        text: '决定：周四上线灰度',
        fact: { op: 'supersede', factId: 'f2', factKind: 'decision', source: 'user', supersedes: 'f1', sourceMessageSeq: 3 },
      })
    })
    const result = deriveClaimStatuses({ events })
    expect(result.bySeq.get(1)).toEqual({ state: 'superseded', successorSeq: 3 })
    expect(result.bySeq.get(3)).toEqual({ state: 'active' })
    expect(result.claimedSeqs).toEqual([1, 3])
    expect(result.active).toBe(1)
    expect(result.superseded).toBe(1)
  })

  it('retract → superseded 但没有 successor；低优先级来源撤不掉用户事实', async () => {
    const events = await groupWithEvents(async (root) => {
      await appendChatEvent(root, 't1', { at: 1, kind: 'user', actorName: '你', text: '记住：周三上线灰度' })
      await appendChatEvent(root, 't1', {
        at: 2,
        kind: 'fact',
        actorName: '系统',
        text: '决定：周三上线灰度',
        fact: { op: 'assert', factId: 'f1', factKind: 'decision', source: 'user', sourceMessageSeq: 1 },
      })
      // 抽取器试图撤销用户事实：必须被优先级挡住
      await appendChatEvent(root, 't1', {
        at: 3,
        kind: 'fact',
        actorName: '系统',
        text: '抽取器撤销',
        fact: { op: 'retract', factId: 'f1', factKind: 'decision', source: 'extractor', sourceMessageSeq: 1 },
      })
    })
    const result = deriveClaimStatuses({ events })
    expect(result.bySeq.get(1)).toEqual({ state: 'active' })
    expect(result.superseded).toBe(0)
  })

  it('同一消息里的多个 claim 有一个失效 → 整条按 superseded（保守，不把过期口径当现状）', async () => {
    const events = await groupWithEvents(async (root) => {
      await appendChatEvent(root, 't1', { at: 1, kind: 'user', actorName: '你', text: '两个决定' })
      await appendChatEvent(root, 't1', {
        at: 2, kind: 'fact', actorName: '系统', text: '决定A',
        fact: { op: 'assert', factId: 'fa', factKind: 'decision', source: 'user', sourceMessageSeq: 1 },
      })
      await appendChatEvent(root, 't1', {
        at: 3, kind: 'fact', actorName: '系统', text: '决定B',
        fact: { op: 'assert', factId: 'fb', factKind: 'decision', source: 'user', sourceMessageSeq: 1 },
      })
      await appendChatEvent(root, 't1', { at: 4, kind: 'user', actorName: '你', text: 'B 作废' })
      await appendChatEvent(root, 't1', {
        at: 5, kind: 'fact', actorName: '系统', text: '撤销 B',
        fact: { op: 'retract', factId: 'fb', factKind: 'decision', source: 'user', sourceMessageSeq: 4 },
      })
    })
    const result = deriveClaimStatuses({ events })
    expect(result.bySeq.get(1)?.state).toBe('superseded')
    // retract 没带 successor → 不编造指向
    expect(result.bySeq.get(1)?.successorSeq).toBeUndefined()
  })

  it('没有 claim 的消息保持 raw（不进 body，只可进目录）', async () => {
    const events = await groupWithEvents(async (root) => {
      await appendChatEvent(root, 't1', { at: 1, kind: 'user', actorName: '你', text: '随便聊聊' })
      await appendChatEvent(root, 't1', { at: 2, kind: 'persona', actorName: '产品经理', text: '好的' })
    })
    const result = deriveClaimStatuses({ events })
    expect(result.claimedSeqs).toEqual([])
    expect(result.bySeq.size).toBe(0)
  })
})

describe('claim 状态：共识层覆盖', () => {
  it('cluster=superseded 时把 refs 指向的消息标 superseded，并指向接手簇的 seq', () => {
    const events: ChatEvent[] = []
    const consensus = {
      schema: 1,
      version: 'v1',
      builtAt: 0,
      mode: 'new' as const,
      clusters: [
        {
          key: 'old', lane: 'A' as const, kind: '决定' as never, text: '周三灰度', factIds: ['f1'],
          refs: [{ factId: 'f1', factEventSeq: 2, sourceMessageId: 'm1', sourceMessageSeq: 1 }],
          status: 'superseded' as const, supersededByKey: 'new', chars: 4,
        },
        {
          key: 'new', lane: 'A' as const, kind: '决定' as never, text: '周四灰度', factIds: ['f2'],
          refs: [{ factId: 'f2', factEventSeq: 4, sourceMessageId: 'm3', sourceMessageSeq: 3 }],
          status: 'active' as const, chars: 4,
        },
      ],
      stats: { factCount: 2, clusterCount: 2, statusCounts: {} as never },
    }
    const result = deriveClaimStatuses({ events, consensus: consensus as never })
    expect(result.bySeq.get(1)).toEqual({ state: 'superseded', successorSeq: 3 })
    expect(result.bySeq.get(3)).toEqual({ state: 'active' })
  })
})

describe('applyClaimStatuses：脏区最小化', () => {
  it('只改动状态变化的条目，其余保持引用不变', () => {
    const entries = [
      { seq: 1, claim: 'raw' as const },
      { seq: 2, claim: 'active' as const },
      { seq: 3, claim: 'raw' as const },
    ]
    const bySeq = new Map([[1, { state: 'active' as const }], [2, { state: 'raw' as const }]])
    const result = applyClaimStatuses(entries, bySeq)
    expect(result.dirtySeqs).toEqual([1, 2])
    expect(result.entries[0].claim).toBe('active')
    expect(result.entries[1].claim).toBe('raw')
    // 未受影响的条目保持原对象引用（避免无意义重写）
    expect(result.entries[2]).toBe(entries[2])
  })

  it('claim 从有到无（事实回退）也会被清回 raw', () => {
    const entries = [{ seq: 5, claim: 'superseded' as const, successorSeq: 9 }]
    const result = applyClaimStatuses(entries, new Map())
    expect(result.dirtySeqs).toEqual([5])
    expect(result.entries[0]).toEqual({ seq: 5, claim: 'raw' })
  })
})

describe('claimsFromThread：客户端轻量版（没有事件日志）', () => {
  const consensus = {
    clusters: [
      {
        key: 'old', lane: 'A', kind: '决定', text: '周三灰度', factIds: ['f1'],
        refs: [{ factId: 'f1', factEventSeq: 2, sourceMessageId: null, sourceMessageSeq: 5 }],
        status: 'superseded', supersededByKey: 'new', chars: 4,
      },
      {
        key: 'new', lane: 'A', kind: '决定', text: '周四灰度', factIds: ['f2'],
        refs: [{ factId: 'f2', factEventSeq: 4, sourceMessageId: null, sourceMessageSeq: 7 }],
        status: 'active', chars: 4,
      },
    ],
  }

  it('facts 的 sourceMessageSeq → active；没有 claim 的消息不出现（保持 raw）', () => {
    const map = claimsFromThread({ facts: [{ sourceMessageSeq: 3 }, {}, { sourceMessageSeq: 0 }] })
    expect(map.get(3)?.state).toBe('active')
    expect(map.size).toBe(1)
  })

  it('共识 superseded → superseded + successor；有效簇标 active', () => {
    const map = claimsFromThread({ consensus: consensus as never })
    expect(map.get(5)).toEqual({ state: 'superseded', successorSeq: 7 })
    expect(map.get(7)).toEqual({ state: 'active' })
  })

  it('失效优先：同一 seq 既被有效事实引用、又被取代 → 仍按 superseded（保守）', () => {
    const map = claimsFromThread({ facts: [{ sourceMessageSeq: 5 }], consensus: consensus as never })
    expect(map.get(5)?.state).toBe('superseded')
  })
})
