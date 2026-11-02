import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildFactExtractionPrompt,
  factEventsFromMessages,
  factIdFor,
  factInputsFromCandidates,
  parseFactCandidates,
  projectFacts,
  type ExtractedFact,
} from '../src/core/facts.ts'
import { appendEvent } from '../src/core/events.ts'
import { ImService } from '../src/core/im.ts'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import type { Message, Persona, SpeakRequest, SpeakResult, Speaker, Thread } from '../src/core/types.ts'
import { loadState, saveState } from '../src/core/workspace-node.ts'

function message(seq: number, kind: 'user' | 'persona', authorName: string, text: string): Message {
  return { id: 'm' + seq, threadId: 't1', seq, kind, authorName, text, createdAt: seq * 1000 }
}

function threadFixture(): Thread {
  return {
    id: 't1',
    kind: 'group',
    title: '方案评审',
    topic: '',
    shortSummary: '',
    memberIds: ['p1'],
    members: [],
    projectRoot: '.',
    messages: [],
    unread: 0,
    roundMode: 'idle',
    createdAt: 0,
    updatedAt: 0,
  }
}

function personaFixture(): Persona {
  return {
    id: 'p1',
    name: '产品经理',
    avatar: '产',
    personality: '',
    duties: [],
    origin: 'mine',
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('事实 provenance（事件 v2）', () => {
  it('规则抽取的事实带 sourceMessageId / sourceMessageSeq，投影后仍在', () => {
    const messages = [
      message(1, 'user', '你', '记住：周三上线灰度'),
      message(2, 'persona', '敏敏', '承诺：周五前给契约'),
    ]
    const extracted = factEventsFromMessages(messages)
    expect(extracted).toHaveLength(2)
    expect(extracted[0].fact).toMatchObject({ sourceMessageId: 'm1', sourceMessageSeq: 1, source: 'user' })
    expect(extracted[1].fact).toMatchObject({ sourceMessageId: 'm2', sourceMessageSeq: 2, source: 'persona' })

    const events = extracted.map((item) => appendEvent([], {
      at: item.at,
      kind: 'fact',
      actorName: item.fact.owner ?? '群',
      text: item.text,
      fact: item.fact,
    }))
    const projected = projectFacts(events)
    expect(projected.active.find((fact) => fact.text === '周三上线灰度')).toMatchObject({
      sourceMessageId: 'm1',
      sourceMessageSeq: 1,
    })
  })

  it('抽取 prompt 带 [#seq] 与 sourceSeq 硬规则', () => {
    const { system, prompt } = buildFactExtractionPrompt({
      threadTitle: '方案评审',
      messages: [message(1, 'user', '你', '补回归用例定下来了')],
    })
    expect(prompt).toContain('[#1]')
    expect(system).toContain('sourceSeq')
    expect(system).toContain('没有 sourceSeq 或序号不存在的条目会被直接丢弃')
  })

  it('候选 sourceSeq 映射回消息；无效序号被丢弃；旧调用路径不产生 provenance', () => {
    const messages = [message(1, 'user', '你', '补回归'), message(2, 'persona', '敏敏', '收到')]
    const candidates = parseFactCandidates(JSON.stringify([
      { kind: 'todo', text: '补回归用例', sourceSeq: 2 },
      { kind: 'decision', text: '无来源决定' },
    ]))
    expect(candidates[0].sourceSeq).toBe(2)
    const inputs = factInputsFromCandidates(candidates, 1000, messages)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].fact).toMatchObject({ sourceMessageId: 'm2', sourceMessageSeq: 2 })

    const bad = parseFactCandidates(JSON.stringify([{ kind: 'todo', text: '不存在序号', sourceSeq: 99 }]))
    expect(factInputsFromCandidates(bad, 1, messages)).toEqual([])

    const legacy = factInputsFromCandidates(parseFactCandidates(JSON.stringify([
      { kind: 'todo', text: '旧路径事实', sourceSeq: 2 },
    ])), 1)
    expect(legacy[0].fact.sourceMessageId).toBeUndefined()
    expect(legacy[0].fact.sourceMessageSeq).toBeUndefined()
  })

  it('BoundModelSpeaker 只接受带有效 sourceSeq 的候选；全部无效时抛错（不静默写入）', async () => {
    const makeSpeaker = (raw: string) => new BoundModelSpeaker({ async complete() { return raw } })
    const req = {
      thread: threadFixture(),
      messages: [message(1, 'user', '你', '补回归用例定下来了'), message(2, 'persona', '敏敏', '收到')],
      persona: personaFixture(),
    }
    const partial = await makeSpeaker(JSON.stringify([
      { kind: 'todo', text: '带来源', sourceSeq: 1 },
      { kind: 'decision', text: '没来源' },
    ])).extractFacts(req as never)
    expect(partial).toHaveLength(1)
    expect(partial[0].fact).toMatchObject({ sourceMessageId: 'm1', sourceMessageSeq: 1 })

    await expect(makeSpeaker(JSON.stringify([{ kind: 'todo', text: '全无来源' }])).extractFacts(req as never))
      .rejects.toThrow('sourceSeq')
  })

  it('ImService 抽取事实带 provenance，saveState → loadState 后仍在（事件投影）', async () => {
    class ProvenanceSpeaker implements Speaker {
      extractCalls = 0
      async complete(_req: SpeakRequest): Promise<SpeakResult> {
        return { text: '收到' }
      }
      async extractFacts(req: { messages: Message[] }): Promise<ExtractedFact[]> {
        this.extractCalls += 1
        const source = req.messages.find((item) => item.kind === 'user')
        if (!source) return []
        return [{
          at: 5000,
          text: '周三上线灰度',
          fact: {
            op: 'assert',
            factId: factIdFor('decision', '周三上线灰度'),
            factKind: 'decision',
            source: 'extractor',
            confidence: 0.5,
            ...(source.id ? { sourceMessageId: source.id } : {}),
            ...(source.seq ? { sourceMessageSeq: source.seq } : {}),
          },
        }]
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'dshim-prov-'))
    const speaker = new ProvenanceSpeaker()
    const im = new ImService(speaker)
    const persona = im.createPersona({
      name: '产品经理',
      avatar: '产',
      personality: '',
      duties: [],
      proactiveDm: false,
      model: 'mock',
      defaultActivity: 'review',
    })
    const group = im.createGroup('方案评审', [persona.id], root)
    await im.sendUser(group.id, '@产品经理 我们讨论上线节奏，并确认周三上线灰度')
    await flush()
    expect(speaker.extractCalls).toBe(1)
    const userMessage = group.messages.find((item) => item.kind === 'user')!
    const local = im.factsFor(group.id).find((fact) => fact.text === '周三上线灰度')
    expect(local).toMatchObject({ sourceMessageId: userMessage.id, sourceMessageSeq: userMessage.seq })

    await saveState(root, im.snapshot())
    const loaded = await loadState(root)
    const loadedThread = loaded?.threads.find((item) => item.id === group.id)
    expect(loadedThread?.facts?.find((fact) => fact.text === '周三上线灰度')).toMatchObject({
      sourceMessageId: userMessage.id,
      sourceMessageSeq: userMessage.seq,
    })
  })
})
