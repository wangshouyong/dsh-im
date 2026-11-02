import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { factIdFor, type ExtractedFact } from '../src/core/facts.ts'
import { ImService } from '../src/core/im.ts'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import type { ImState, SpeakRequest, SpeakResult, Speaker } from '../src/core/types.ts'
import { loadState, saveState } from '../src/core/workspace-node.ts'

class ExtractionSpeaker implements Speaker {
  readonly requests: SpeakRequest[] = []
  readonly extractCalls: { personaId: string; messages: number }[] = []
  failExtraction = false
  async complete(req: SpeakRequest): Promise<SpeakResult> {
    this.requests.push(req)
    return { text: `【${req.persona.name}】收到：${req.focus}` }
  }
  async extractFacts(req: { thread: { id: string }; messages: { kind: string }[]; persona: { id: string } }): Promise<ExtractedFact[]> {
    this.extractCalls.push({ personaId: req.persona.id, messages: req.messages.length })
    if (this.failExtraction) throw new Error('抽取模型挂了')
    return [
      // 和规则抽取重复（同 factId）→ 不该覆盖用户事实
      {
        at: 5000,
        text: '周三上线灰度',
        fact: { op: 'assert', factId: factIdFor('decision', '周三上线灰度'), factKind: 'decision', source: 'extractor', confidence: 0.5 },
      },
      // 新增事实 → 进入本地投影并排队落盘
      {
        at: 5001,
        text: '周五跑一次全量回归',
        fact: { op: 'assert', factId: factIdFor('todo', '周五跑一次全量回归'), factKind: 'todo', source: 'extractor', confidence: 0.5 },
      },
    ]
  }
}

function seed(im: ImService, root: string) {
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '挑需求缺口',
    duties: ['需求'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const qa = im.createPersona({
    name: '测试',
    avatar: '测',
    personality: '挑可测性',
    duties: ['可测性'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const group = im.createGroup('方案评审', [pm.id, qa.id], root)
  return { pm, qa, group }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('异步事实抽取（LLM 通道）', () => {
  it('每轮结束异步抽事实：不阻塞回复、合并进本地事实、排队等落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-extract-'))
    const speaker = new ExtractionSpeaker()
    const im = new ImService(speaker)
    const { group } = seed(im, root)
    const onChange = vi.fn()
    im.onAsyncChange = onChange
    await im.sendUser(group.id, '@产品经理 我们讨论一下上线节奏，记住：周三上线灰度')
    expect(speaker.extractCalls).toHaveLength(1)
    expect(speaker.extractCalls[0].messages).toBeGreaterThan(1)
    await flush()

    const facts = im.factsFor(group.id)
    expect(facts.some((fact) => fact.text === '周三上线灰度')).toBe(true)
    const extracted = facts.find((fact) => fact.text === '周五跑一次全量回归')
    expect(extracted?.source).toBe('extractor')
    // 两条抽取结果都进本地（其中一条与规则抽取同 factId，投影时用户事实优先）
    expect(group.extractedFacts?.length).toBe(2)
    expect(group.pendingFactOps?.some((op) => op.op === 'assert' && op.text === '周五跑一次全量回归')).toBe(true)
    expect(onChange).toHaveBeenCalled()

    // 任务板归档 → 本地立刻消失 + 排队 retract
    im.completeFact(group.id, extracted!.factId)
    expect(im.factsFor(group.id).some((fact) => fact.text === '周五跑一次全量回归')).toBe(false)
    expect(group.pendingFactOps?.some((op) => op.op === 'retract' && op.factId === extracted!.factId)).toBe(true)
    expect(group.messages.at(-1)?.text).toContain('归档')
  })

  it('host 投影已覆盖的消息不再本地重算：归档过的事实重载后不复活', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-extract-'))
    const im = new ImService()
    const { group } = seed(im, root)
    group.messages.push({
      id: 'm1',
      threadId: group.id,
      seq: 1,
      kind: 'user',
      authorName: '你',
      text: '记住：周三上线灰度',
      createdAt: 1000,
    })
    // host 已投影且已归档：facts 为空 + 覆盖到 #1
    group.facts = []
    group.factsUntilSeq = 1
    expect(im.factsFor(group.id)).toHaveLength(0)
    // 归档之后用户又声明一次（更新的消息）→ 本地能看到
    group.messages.push({
      id: 'm2',
      threadId: group.id,
      seq: 2,
      kind: 'user',
      authorName: '你',
      text: '记住：周三上线灰度',
      createdAt: 2000,
    })
    expect(im.factsFor(group.id).some((fact) => fact.text === '周三上线灰度')).toBe(true)
  })

  it('抽取失败/短招呼不抽：回复照常，不抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-extract-'))
    const speaker = new ExtractionSpeaker()
    speaker.failExtraction = true
    const im = new ImService(speaker)
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@产品经理 我们讨论一下上线节奏与排期')
    await flush()
    expect(group.extractedFacts).toBeUndefined()
    expect(group.messages.some((message) => message.kind === 'persona')).toBe(true)

    speaker.extractCalls.length = 0
    await im.sendUser(group.id, '在吗')
    await flush()
    expect(speaker.extractCalls).toHaveLength(0)
  })

  it('抽取/归档随 saveState 落成 fact 事件，重载后以事件投影为准', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-extract-'))
    const speaker = new ExtractionSpeaker()
    const im = new ImService(speaker)
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@产品经理 我们讨论一下上线节奏，记住：周三上线灰度')
    await flush()

    const state = im.snapshot()
    await saveState(root, state)
    const loaded = await loadState(root)
    const loadedThread = loaded?.threads.find((thread) => thread.id === group.id)
    expect(loadedThread?.facts?.some((fact) => fact.text === '周五跑一次全量回归')).toBe(true)
    expect(loadedThread?.pendingFactOps).toBeUndefined()
    expect(loadedThread?.extractedFacts).toBeUndefined()

    // 再归档一条并保存：事实事件里有 retract，投影后不在了
    const target = im.factsFor(group.id).find((fact) => fact.text === '周五跑一次全量回归')!
    im.completeFact(group.id, target.factId)
    await saveState(root, im.snapshot())
    const after = await loadState(root)
    const afterThread = after?.threads.find((thread) => thread.id === group.id)
    expect(afterThread?.facts?.some((fact) => fact.text === '周五跑一次全量回归')).toBe(false)
    // 保存后本地待落盘操作清空
    const again = await loadState(root)
    expect(again?.threads.find((thread) => thread.id === group.id)?.pendingFactOps).toBeUndefined()
  })
})

describe('BoundModelSpeaker.extractFacts', () => {
  it('调 transport 抽事实：专用 system、最近消息、结果来源 extractor', async () => {
    const calls: Parameters<ModelTransport['complete']>[0][] = []
    const speaker = new BoundModelSpeaker({
      async complete(input) {
        calls.push(input)
        return '```json\n[{"kind":"待办","text":"补回归用例","owner":"测试","sourceSeq":1}]\n```'
      },
    })
    const facts = await speaker.extractFacts({
      thread: {
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
      },
      messages: [
        { id: 'm1', threadId: 't1', seq: 1, kind: 'user', authorName: '你', text: '补回归用例这件事定下来了', createdAt: 1 },
        { id: 'm2', threadId: 't1', seq: 2, kind: 'persona', authorName: '测试', text: '收到，我来补', createdAt: 2 },
      ],
      persona: {
        id: 'p1',
        name: '产品经理',
        avatar: '产',
        personality: '',
        duties: [],
        origin: 'mine',
        model: 'deepseek-chat',
        proactiveDm: false,
        defaultActivity: 'review',
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('deepseek-chat')
    expect(calls[0].system).toContain('事实抽取器')
    expect(calls[0].messages[0].content).toContain('补回归用例这件事定下来了')
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      text: '补回归用例',
      fact: { op: 'assert', factKind: 'todo', source: 'extractor' },
    })
    // provenance：候选的 sourceSeq 映射回真实消息 id/seq
    expect(facts[0].fact).toMatchObject({ sourceMessageId: 'm1', sourceMessageSeq: 1 })
  })

  it('模型返回垃圾不抛错，返回空数组', async () => {
    const speaker = new BoundModelSpeaker({ async complete() { return '我觉得没啥事实' } })
    const persona = {
      id: 'p1',
      name: '产品经理',
      avatar: '产',
      personality: '',
      duties: [],
      origin: 'mine' as const,
      model: 'm',
      proactiveDm: false,
      defaultActivity: 'review' as const,
    }
    const threadState: ImState['threads'][number] = {
      id: 't1',
      kind: 'group',
      title: '群',
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
    await expect(speaker.extractFacts({ thread: threadState, messages: [], persona })).resolves.toEqual([])
  })
})
