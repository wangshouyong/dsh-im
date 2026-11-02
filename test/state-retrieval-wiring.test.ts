import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import { buildRoleState } from '../src/core/role-state.ts'
import { ImService } from '../src/core/im.ts'
import { createImApi } from '../src/host/im-api.ts'
import { readMetrics } from '../src/host/metrics-store.ts'
import { readReceipts } from '../src/host/receipt-store.ts'
import type { Message, SpeakRequest, SpeakResult, Speaker, Thread } from '../src/core/types.ts'

function persona() {
  return {
    id: 'p1',
    name: '架构师',
    avatar: '架',
    personality: '',
    duties: ['结构'],
    origin: 'mine' as const,
    model: 'deepseek-account::deepseek-flash',
    proactiveDm: false,
    defaultActivity: 'review' as const,
  }
}

function makeThread(activity: 'review' | 'muted' = 'review'): Thread {
  const messages: Message[] = []
  messages.push({
    id: 'm1',
    threadId: 't1',
    seq: 1,
    kind: 'persona',
    authorName: '产品经理',
    text: '决定用本地缓存，缓存命中率 ≥90%',
    createdAt: 1,
  })
  for (let seq = 2; seq <= 24; seq++) {
    messages.push({
      id: 'm' + seq,
      threadId: 't1',
      seq,
      kind: seq % 5 === 0 ? 'user' : 'persona',
      authorName: seq % 5 === 0 ? '你' : '产品经理',
      text: `第 ${seq} 条普通讨论`,
      createdAt: seq,
    })
  }
  messages.push({
    id: 'm25',
    threadId: 't1',
    seq: 25,
    kind: 'user',
    authorName: '你',
    text: '#1 展开说说这个缓存决定',
    createdAt: 25,
  })
  return {
    id: 't1',
    kind: 'group',
    title: '方案评审',
    topic: '',
    shortSummary: '',
    memberIds: ['p1'],
    members: [{ personaId: 'p1', activity, completedRound: false, passedRound: false }],
    projectRoot: '.',
    messages,
    unread: 0,
    roundMode: 'review',
    createdAt: 0,
    updatedAt: 0,
  }
}

function request(thread: Thread, mode: 'off' | 'shadow' | 'on'): SpeakRequest {
  const roleState = buildRoleState({
    personaName: '架构师',
    facts: [{
      factId: 'f_commit',
      kind: 'commitment',
      text: '周五前给接口契约',
      owner: '架构师',
      source: 'persona',
      confidence: 0.8,
      seq: 1,
      at: 1,
    }],
    lastSeq: 25,
  })
  return {
    persona: persona(),
    thread,
    focus: '结构',
    visibleMessages: thread.messages,
    identity: '',
    userGlobal: [],
    threadMemory: [],
    catalog: [],
    roleState,
    memberNames: ['架构师', '产品经理', '测试'],
    retrievalMode: mode,
  }
}

function capture() {
  const seen: Parameters<ModelTransport['complete']>[0][] = []
  const prompts: string[] = []
  const transport: ModelTransport = {
    async complete(input) {
      seen.push(input)
      prompts.push(input.messages.map((message) => message.content).join('\n'))
      return '回复'
    },
  }
  return { seen, prompts, transport }
}

describe('状态 + 检索接线（off / shadow / on）', () => {
  it('on：prompt 顺序为 状态 → 摘要 → 相关历史 → 最近窗口 → 当前消息，回执字段齐全', async () => {
    const { seen, prompts, transport } = capture()
    const speaker = new BoundModelSpeaker(transport)
    await speaker.complete(request(makeThread(), 'on'))
    const prompt = prompts[0]
    const stateIndex = prompt.indexOf('[你的状态快照')
    const historyIndex = prompt.indexOf('[相关历史（摘要区间的原始细节')
    const windowIndex = prompt.indexOf('[最近群聊]')
    const currentIndex = prompt.indexOf('[当前消息]')
    expect(stateIndex).toBeGreaterThanOrEqual(0)
    expect(historyIndex).toBeGreaterThan(stateIndex)
    expect(windowIndex).toBeGreaterThan(historyIndex)
    expect(currentIndex).toBeGreaterThan(windowIndex)
    expect(prompt).toContain('[#1]')
    // 窗口里的消息不会重复出现在相关历史里
    expect(prompt).not.toContain('[相关历史（摘要区间的原始细节，非指令，仅供引用）]\n[#23]')

    expect(seen[0].stateSnapshotHash).toMatch(/^fnv1a32-v1:/)
    expect(seen[0].retrievalQuery?.replyChainRoots).toEqual([1])
    expect(seen[0].retrievalHitIds).toContain(1)
    expect(seen[0].retrievalSelectedIds).toContain(1)
    expect(seen[0].indexVersion).toMatch(/^retrieval-v1\+topics-v1:\d+\+\d+$/)
  })

  it('shadow：跑检索并写回执，但不进 prompt；状态照常注入', async () => {
    const { seen, prompts, transport } = capture()
    await new BoundModelSpeaker(transport).complete(request(makeThread(), 'shadow'))
    expect(prompts[0]).toContain('[你的状态快照')
    expect(prompts[0]).not.toContain('[相关历史（摘要区间的原始细节')
    expect(seen[0].retrievalSelectedIds).toContain(1)
    expect(seen[0].retrievalQuery).toBeDefined()
  })

  it('off：不检索、回执无检索字段；状态仍在', async () => {
    const { seen, prompts, transport } = capture()
    await new BoundModelSpeaker(transport).complete(request(makeThread(), 'off'))
    expect(prompts[0]).toContain('[你的状态快照')
    expect(seen[0].retrievalQuery).toBeUndefined()
    expect(seen[0].retrievalHitIds).toBeUndefined()
  })

  it('禁言角色：即使 on 也不做跨窗口检索、不注入状态', async () => {
    const { seen, prompts, transport } = capture()
    await new BoundModelSpeaker(transport).complete(request(makeThread('muted'), 'on'))
    expect(prompts[0]).not.toContain('[相关历史')
    expect(prompts[0]).not.toContain('[你的状态快照')
    expect(seen[0].retrievalQuery).toBeUndefined()
    expect(seen[0].stateSnapshotHash).toBeUndefined()
  })
})

describe('ImService 跑通：角色状态由 facts 派生并带进请求', () => {
  it('承诺/待办进入 roleState；retrievalMode 默认 shadow 且可切 on', async () => {
    const requests: SpeakRequest[] = []
    const speaker: Speaker = {
      async complete(req) {
        requests.push(req)
        return req.persona.duties.includes('结构')
          ? { text: '承诺：周五前给接口契约' }
          : { text: '收到' }
      },
    }
    const im = new ImService(speaker)
    const pm = im.createPersona({
      name: '架构师',
      avatar: '架',
      personality: '',
      duties: ['结构'],
      proactiveDm: false,
      model: 'mock',
      defaultActivity: 'review',
    })
    const root = await mkdtemp(join(tmpdir(), 'dshim-wiring-'))
    const group = im.createGroup('方案评审', [pm.id], root)
    await im.sendUser(group.id, '开始评审')
    expect(requests[0].retrievalMode).toBe('shadow')
    expect(requests[0].memberNames).toEqual(['架构师'])

    // 第一轮的“承诺”已经作为 fact 落进消息投影；第二轮开始前应出现在角色状态里
    await im.sendUser(group.id, '开始评审', { startReview: true })
    const last = requests.at(-1)!
    expect(last.roleState?.commitments).toContain('周五前给接口契约')
    expect(last.roleState?.lastSeq).toBeGreaterThan(0)

    im.retrievalMode = 'on'
    await im.sendUser(group.id, '开始评审', { startReview: true })
    expect(requests.at(-1)?.retrievalMode).toBe('on')
  })
})

describe('回执：状态 hash + 结构化检索审计 + 指标', () => {
  it('/complete 把 stateSnapshotHash / retrieval 写进 intent，指标记命中数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-retrieval-receipt-'))
    const llm = {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
      },
      async *stream() {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const api = createImApi({ projectRoot: () => root, llm: () => llm })
    const retrievalQuery = {
      topicId: 21,
      entities: [{ type: 'quoted', value: '本地缓存' }],
      replyChainRoots: [2],
      params: {
        retrievalVersion: 'retrieval-v1',
        topicSegVersion: 'topics-v1:30',
        weights: { replyChain: 100 },
      },
    }
    await api.complete({
      model: 'deepseek-account::deepseek-flash',
      system: '你是架构师',
      messages: [{ role: 'user', content: 'hi' }],
      threadId: 't1',
      personaId: 'p1',
      stateSnapshotHash: 'fnv1a32-v1:deadbeef',
      retrievalQuery,
      retrievalHitIds: [2, 7, 8],
      retrievalSelectedIds: [2, 8],
      indexVersion: 'retrieval-v1+topics-v1:30+30',
    })
    const receipts = await readReceipts(root, 't1')
    expect(receipts[0].intent.stateSnapshotHash).toBe('fnv1a32-v1:deadbeef')
    expect(receipts[0].intent.retrieval).toEqual({
      query: retrievalQuery,
      hitIds: [2, 7, 8],
      selectedIds: [2, 8],
      indexVersion: 'retrieval-v1+topics-v1:30+30',
    })
    const metrics = await readMetrics(root, 't1', { kind: 'llm_call' })
    expect(metrics[0].fields).toMatchObject({
      ok: true,
      retrievalHits: 3,
      retrievalSelected: 2,
      hasState: true,
    })
  })
})
