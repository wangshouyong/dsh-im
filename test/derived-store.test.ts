import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readEvents } from '../src/host/event-store.ts'
import { readFacts, readFloorDecisions } from '../src/host/derived-store.ts'
import { factIdFor } from '../src/core/facts.ts'
import { loadState, saveState } from '../src/core/workspace-node.ts'
import type { ImState, Message, Thread } from '../src/core/types.ts'

function message(seq: number, kind: Message['kind'], authorName: string, text: string): Message {
  return {
    id: 'm' + seq,
    threadId: 't1',
    seq,
    kind,
    authorName,
    text,
    createdAt: 1000 + seq,
  }
}

function threadWith(messages: Message[], extra: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    kind: 'group',
    title: '方案评审',
    topic: '方案评审',
    shortSummary: '',
    memberIds: ['p1'],
    members: [{ personaId: 'p1', activity: 'review', completedRound: false, passedRound: false }],
    projectRoot: '.',
    messages,
    unread: 0,
    roundMode: 'idle',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

function stateWith(thread: Thread): ImState {
  return {
    personas: [],
    threads: [thread],
    memories: [],
    wakeExcerpts: {},
    pendingRecall: null,
    lastProactiveAt: {},
  }
}

describe('事实 / 仲裁事件落盘', () => {
  it('saveState 回填消息 seq，并幂等写入 fact / floor_decision 事件与 facts.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-derived-'))
    const thread = threadWith([
      message(1, 'user', '你', '记住：周三上线灰度'),
      message(2, 'persona', '架构师', '承诺：周五前给出接口契约'),
      message(3, 'system', '系统主持', '本轮开始。'),
    ], {
      floorDecisions: [
        { personaId: 'p1', action: 'speak', reason: '被点名：架构师', at: 3000 },
        { personaId: '', action: 'pass', reason: '本轮没有可发言的角色', at: 3001 },
      ],
    })
    const state = stateWith(thread)
    await saveState(root, state)

    const saved = await loadState(root)
    const savedThread = saved?.threads[0]
    expect(savedThread?.messages.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(savedThread?.facts?.map((fact) => fact.text).sort()).toEqual(['周三上线灰度', '周五前给出接口契约'].sort())
    expect(savedThread?.factsVersion).toMatch(/^facts-v1:/)
    expect(savedThread?.factsUntilSeq).toBe(3)

    const events = await readEvents(root, 't1')
    expect(events.filter((event) => event.kind === 'fact')).toHaveLength(2)
    expect(events.filter((event) => event.kind === 'floor_decision')).toHaveLength(2)
    // 消息事件的 seq 与回填的消息 seq 一致
    expect(events.filter((event) => event.kind !== 'fact' && event.kind !== 'floor_decision').map((event) => event.seq))
      .toEqual([1, 2, 3])

    const facts = await readFacts(root, 't1')
    expect(facts?.facts).toHaveLength(2)
    expect(facts?.version).toBe(savedThread?.factsVersion)
    const decisions = await readFloorDecisions(root, 't1')
    expect(decisions.map((event) => event.floorDecision?.action)).toEqual(['speak', 'pass'])
    expect(decisions[0].text).toContain('被点名')

    // 再存一次：事件不重复、事实版本不变、seq 稳定
    const before = events.length
    await saveState(root, saved!)
    const again = await readEvents(root, 't1')
    expect(again.length).toBe(before)
    expect((await readFacts(root, 't1'))?.version).toBe(facts?.version)
    expect((await loadState(root))?.threads[0].messages.map((item) => item.seq)).toEqual([1, 2, 3])
  })

  it('新消息保存后 seq 连续，旧消息 seq 不改；长会话摘要边界落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-derived-'))
    const messages: Message[] = []
    for (let index = 0; index < 25; index++) {
      messages.push(message(index + 1, index % 3 === 0 ? 'user' : 'persona', index % 3 === 0 ? '你' : '架构师', '第 ' + (index + 1) + ' 条讨论'))
    }
    const state = stateWith(threadWith(messages))
    await saveState(root, state)
    const first = await loadState(root)
    expect(first?.threads[0].summaryUntilSeq).toBe(5)
    expect(first?.threads[0].summaryState?.l1).toContain('[#1]')

    const followUp = message(26, 'user', '你', '第 26 条讨论')
    state.threads[0].messages.push(followUp)
    await saveState(root, state)
    const second = await loadState(root)
    expect(second?.threads[0].messages.map((item) => item.seq)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    )
    expect(second?.threads[0].summaryUntilSeq).toBe(6)

    const eventsPath = join(root, '.dsh-im', 'groups', 't1', 'events.jsonl')
    const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(26)
  })

  it('任务板归档后重复保存不复活；用户再声明一次（更晚）可以恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-derived-'))
    const factId = factIdFor('decision', '周三上线灰度')
    const thread = threadWith([message(1, 'user', '你', '记住：周三上线灰度')], {
      pendingFactOps: [{
        op: 'retract',
        factId,
        kind: 'decision',
        text: '周三上线灰度',
        source: 'user',
        at: 4000,
      }],
      retractedFactIds: [factId],
    })
    const state = stateWith(thread)
    await saveState(root, state)
    const first = await loadState(root)
    expect(first?.threads[0].facts?.some((fact) => fact.factId === factId)).toBe(false)

    // 重复保存同一份 state：派生 assert 不能把已归档事实拉回来
    await saveState(root, first!)
    const second = await loadState(root)
    expect(second?.threads[0].facts?.some((fact) => fact.factId === factId)).toBe(false)
    const factOps = (await readEvents(root, 't1'))
      .filter((event) => event.kind === 'fact')
      .map((event) => event.fact?.op)
    expect(factOps).toEqual(['assert', 'retract'])

    // 用户在归档之后又“记住”了一次（更晚的消息）→ 恢复
    const again = message(2, 'user', '你', '记住：周三上线灰度')
    again.createdAt = 5000
    second!.threads[0].messages.push(again)
    await saveState(root, second!)
    const restored = await loadState(root)
    expect(restored?.threads[0].facts?.some((fact) => fact.factId === factId)).toBe(true)
  })

  it('用户归档后，抽取器再报同一条事实不会复活它', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-derived-'))
    const factId = factIdFor('todo', '补回归用例')
    const state = stateWith(threadWith([message(1, 'user', '你', '记住：周三上线灰度')], {
      pendingFactOps: [{
        op: 'retract',
        factId,
        kind: 'todo',
        text: '补回归用例',
        source: 'user',
        at: 4000,
      }],
    }))
    await saveState(root, state)
    const loaded = await loadState(root)
    // 下一轮异步抽取又抽到同一条（低优先级 assert）
    loaded!.threads[0].pendingFactOps = [{
      op: 'assert',
      factId,
      kind: 'todo',
      text: '补回归用例',
      source: 'extractor',
      at: 6000,
    }]
    await saveState(root, loaded!)
    const after = await loadState(root)
    expect(after?.threads[0].facts?.some((fact) => fact.factId === factId)).toBe(false)
  })

  it('同批保存「消息派生 assert + 任务板 retract」：事件顺序 assert→retract，重载后不复活', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-derived-'))
    const factId = factIdFor('decision', '周三上线灰度')
    const state = stateWith(threadWith([message(1, 'user', '你', '记住：周三上线灰度')], {
      pendingFactOps: [{
        op: 'retract',
        factId,
        kind: 'decision',
        text: '周三上线灰度',
        source: 'user',
        at: 4000,
      }],
      retractedFactIds: [factId],
    }))
    await saveState(root, state)
    const loaded = await loadState(root)
    expect(loaded?.threads[0].facts?.some((fact) => fact.factId === factId)).toBe(false)
    const events = await readEvents(root, 't1')
    expect(events.filter((event) => event.kind === 'fact').map((event) => event.fact?.op)).toEqual(['assert', 'retract'])
    expect((await readFacts(root, 't1'))?.facts.some((fact) => fact.factId === factId)).toBe(false)
  })
})
