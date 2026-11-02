import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildConsensusState, type ConsensusDraft, type ConsensusFact } from '../src/core/consensus.ts'
import { ImService } from '../src/core/im.ts'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import type { SpeakRequest, SpeakResult, Speaker } from '../src/core/types.ts'
import type { ConsensusCurateRequest, ConsensusCurator } from '../src/core/runtime.ts'
import { loadState, saveState } from '../src/core/workspace-node.ts'

class ConsensusSpeaker implements Speaker, ConsensusCurator {
  readonly curateCalls: ConsensusCurateRequest[] = []
  failCurate = false
  replyText = '收到'
  async complete(_req: SpeakRequest): Promise<SpeakResult> {
    return { text: this.replyText }
  }
  async extractFacts(): Promise<never[]> {
    return []
  }
  async curate(req: ConsensusCurateRequest): Promise<ConsensusDraft> {
    this.curateCalls.push(req)
    if (this.failCurate) throw new Error('curator 挂了')
    return {
      clusters: req.facts.map((fact, index) => {
        const userOwned = fact.owner === '用户' || fact.owner === '你'
        return {
          key: `A${index + 1}`,
          lane: userOwned ? 'A' as const : 'B' as const,
          kind: userOwned ? '决定' : '立场',
          factIds: [fact.factId],
          text: fact.text,
        }
      }),
      derived: [],
    }
  }
}

function seed(im: ImService, root: string) {
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '',
    duties: [],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const group = im.createGroup('方案评审', [pm.id], root)
  return { pm, group }
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function consensusFactsFixture(): { facts: ConsensusFact[]; draft: ConsensusDraft } {
  const facts: ConsensusFact[] = [
    { factId: 'f1', eventSeq: 1, kind: 'decision', owner: '用户', text: 'threadId 只允许字母数字', sourceMessageId: 'm1', sourceMessageSeq: 1 },
    { factId: 'f2', eventSeq: 2, kind: 'constraint', owner: '淇淇', text: '淇淇没有 run_check，跑不了 tsc', sourceMessageId: 'm2', sourceMessageSeq: 2 },
  ]
  const draft: ConsensusDraft = {
    clusters: [
      { key: 'A1', lane: 'A', kind: '约束', factIds: ['f1'], text: 'threadId 只允许字母数字' },
      { key: 'D1', lane: 'D', kind: '能力自述', factIds: ['f2'], text: '淇淇没有 run_check，跑不了 tsc' },
    ],
    derived: [],
  }
  return { facts, draft }
}

describe('共识状态接线（开关 / curator / prompt / 持久化）', () => {
  it('开关打开：curator 产出草稿 → builder 生成 thread.consensusState 并记指标', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-'))
    const speaker = new ConsensusSpeaker()
    const im = new ImService(speaker)
    im.consensusEnabled = true
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@产品经理 记住：周三上线灰度')
    await flush()
    const thread = im.requireThread(group.id)
    expect(speaker.curateCalls.length).toBeGreaterThan(0)
    expect(thread.consensusState).toBeDefined()
    expect(thread.consensusError).toBeUndefined()
    expect(thread.consensusState!.schema).toBe('consensus-v1')
    expect(thread.consensusState!.metrics.facts).toBeGreaterThan(0)
    expect(thread.pendingMetrics?.some((metric) => metric.kind === 'consensus' && metric.fields?.ok === true)).toBe(true)
    // 规则抽取的用户事实带 provenance → new 模式
    expect(thread.consensusState!.mode).toBe('new')
    expect(thread.consensusState!.provenance.resolved).toBe(thread.consensusState!.provenance.expected)
  })

  it('默认开；显式关闭（localStorage=off）时不调 curator、不生成 consensusState', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-off-'))
    const speaker = new ConsensusSpeaker()
    const im = new ImService(speaker)
    const { group } = seed(im, root)
    expect(im.consensusEnabled).toBe(true)
    im.consensusEnabled = false
    await im.sendUser(group.id, '@产品经理 记住：周三上线灰度')
    await flush()
    expect(speaker.curateCalls).toHaveLength(0)
    expect(im.requireThread(group.id).consensusState).toBeUndefined()
  })

  it('curator 失败：只记失败指标，不写假状态、不抛未处理异常', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-fail-'))
    const speaker = new ConsensusSpeaker()
    speaker.failCurate = true
    const im = new ImService(speaker)
    im.consensusEnabled = true
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@产品经理 记住：周三上线灰度')
    await flush()
    const thread = im.requireThread(group.id)
    expect(thread.consensusState).toBeUndefined()
    expect(thread.consensusError).toContain('curator 挂了')
    expect(thread.pendingMetrics?.some((metric) => metric.kind === 'consensus' && metric.fields?.ok === false)).toBe(true)
  })

  it('prompt 注入共识块：A 用户指令进入，D 归档不进', async () => {
    const { facts, draft } = consensusFactsFixture()
    const built = buildConsensusState(facts, draft, { mode: 'new', knownMessageIds: ['m1', 'm2'] })
    expect(built.ok).toBe(true)
    const calls: Parameters<ModelTransport['complete']>[0][] = []
    const speaker = new BoundModelSpeaker({
      async complete(input) {
        calls.push(input)
        return '收到'
      },
    })
    const thread = {
      id: 't1',
      kind: 'group' as const,
      title: '方案评审',
      topic: '',
      shortSummary: '',
      memberIds: ['p1'],
      members: [],
      projectRoot: '.',
      messages: [],
      unread: 0,
      roundMode: 'idle' as const,
      createdAt: 0,
      updatedAt: 0,
      consensusState: built.state,
    }
    const persona = {
      id: 'p1',
      name: '产品经理',
      avatar: '产',
      personality: '',
      duties: [],
      origin: 'mine' as const,
      model: 'mock',
      proactiveDm: false,
      defaultActivity: 'review' as const,
    }
    await speaker.complete({
      persona,
      thread,
      focus: '',
      visibleMessages: [{ id: 'm1', threadId: 't1', seq: 1, kind: 'user', authorName: '你', text: '继续', createdAt: 1 }],
      identity: '',
      userGlobal: [],
      threadMemory: [],
      catalog: [],
    })
    expect(calls).toHaveLength(1)
    const content = String(calls[0].messages[0].content)
    expect(content).toContain('[用户指令]')
    expect(content).toContain('threadId 只允许字母数字')
    expect(content).not.toContain('淇淇没有 run_check')
  })

  it('consensusState 随 state.json 持久化，重载后仍在', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-save-'))
    const speaker = new ConsensusSpeaker()
    const im = new ImService(speaker)
    im.consensusEnabled = true
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@产品经理 记住：周三上线灰度')
    await flush()
    const version = im.requireThread(group.id).consensusState!.version
    await saveState(root, im.snapshot())
    const loaded = await loadState(root)
    const loadedThread = loaded?.threads.find((item) => item.id === group.id)
    expect(loadedThread?.consensusState?.version).toBe(version)
    expect(loadedThread?.consensusState?.clusters.length).toBeGreaterThan(0)
  })

  it('能力自述由确定性规则直接归档到 D，不进入 curator 输入、不进 A/B/C', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-transient-'))
    const speaker = new ConsensusSpeaker()
    speaker.replyText = '约束：我没有 shell，无法执行命令'
    const im = new ImService(speaker)
    im.consensusEnabled = true
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@产品经理 记住：周三上线灰度')
    await flush()
    const thread = im.requireThread(group.id)
    expect(thread.consensusState).toBeDefined()
    const state = thread.consensusState!
    const archived = state.clusters.filter((cluster) => cluster.lane === 'D')
    expect(archived.some((cluster) => cluster.text.includes('我没有 shell'))).toBe(true)
    expect(archived.every((cluster) => cluster.status === 'archived')).toBe(true)
    expect(state.clusters.filter((cluster) => cluster.lane !== 'D').some((cluster) => cluster.text.includes('我没有 shell'))).toBe(false)
    expect(speaker.curateCalls.length).toBeGreaterThan(0)
    for (const call of speaker.curateCalls) {
      expect(call.facts.some((fact) => fact.text.includes('我没有 shell'))).toBe(false)
    }
  })

  it('refreshConsensus 可手动强制生成（显式关闭时也生效）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-manual-'))
    const speaker = new ConsensusSpeaker()
    const im = new ImService(speaker)
    im.consensusEnabled = false
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@产品经理 记住：周三上线灰度')
    await flush()
    expect(im.requireThread(group.id).consensusState).toBeUndefined()
    im.refreshConsensus(group.id)
    await flush()
    expect(im.requireThread(group.id).consensusState).toBeDefined()
  })

  it('ensureConsensus 自动为“有事实但无共识”的群生成一次；不重复调用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-ensure-'))
    const speaker = new ConsensusSpeaker()
    const im = new ImService(speaker)
    const { group } = seed(im, root)
    group.messages.push({
      id: 'm_ensure_1',
      threadId: group.id,
      seq: 1,
      kind: 'user',
      authorName: '你',
      text: '记住：周三上线灰度',
      createdAt: 1000,
    })
    expect(im.factsFor(group.id).length).toBeGreaterThan(0)
    im.ensureConsensus(group.id)
    await flush()
    expect(group.consensusState).toBeDefined()
    const calls = speaker.curateCalls.length
    im.ensureConsensus(group.id)
    await flush()
    expect(speaker.curateCalls.length).toBe(calls)
  })

  it('ensureConsensus 只在“有新事实”时重建（回复消息本身不算新事实）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-consensus-stale-'))
    const speaker = new ConsensusSpeaker()
    const im = new ImService(speaker)
    const { group } = seed(im, root)
    group.messages.push({
      id: 'm_stale_1', threadId: group.id, seq: 1, kind: 'user', authorName: '你', text: '记住：周三上线灰度', createdAt: 1000,
    })
    im.ensureConsensus(group.id)
    await flush()
    expect(group.consensusState).toBeDefined()
    const before = speaker.curateCalls.length
    group.messages.push({
      id: 'm_stale_2', threadId: group.id, seq: 2, kind: 'persona', authorName: '产品经理', text: '收到，我盯着。', createdAt: 2000,
    })
    im.ensureConsensus(group.id)
    await flush()
    expect(speaker.curateCalls.length).toBe(before)
    group.messages.push({
      id: 'm_stale_3', threadId: group.id, seq: 3, kind: 'user', authorName: '你', text: '记住：周五发版', createdAt: 3000,
    })
    im.ensureConsensus(group.id)
    await flush()
    expect(speaker.curateCalls.length).toBe(before + 1)
  })
})
