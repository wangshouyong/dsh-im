import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createNativeRuntime,
  lastAssistantText,
  NativeAgentSessions,
  nativeSessionId,
  type NativeAgentHandle,
  type NativeAgentsApi,
  type NativeMessage,
} from '../src/host/agent-session.ts'
import { createImApi } from '../src/host/im-api.ts'
import { readMetrics } from '../src/host/metrics-store.ts'
import { readReceipts } from '../src/host/receipt-store.ts'

function fakeAgentFactory(options: {
  reply?: string
  onFollowup?: (text: string, sessionId: string) => void
  failCreate?: Error
} = {}) {
  const created: string[] = []
  const archived: string[] = []
  const disposed: string[] = []
  const followups: { sessionId: string; text: string }[] = []
  /** followup 传进来的原始消息形状：必须带 role/id，否则 DSH 会派生无角色消息。 */
  const followupMessages: { role?: string; hasId: boolean; sourceKind?: string }[] = []
  let waitIdleCalls = 0
  const agents: NativeAgentsApi = {
    async create(input) {
      if (options.failCreate) throw options.failCreate
      created.push(input.sessionId)
      const messages: NativeMessage[] = []
      const handle: NativeAgentHandle = {
        agent: {
          followup(message) {
            const text = message.content.map((block) => block.text ?? '').join('')
            followupMessages.push({
              role: message.role,
              hasId: typeof message.id === 'string' && message.id.length > 0,
              sourceKind: message.source?.kind,
            })
            followups.push({ sessionId: input.sessionId, text })
            options.onFollowup?.(text, input.sessionId)
            messages.push({ role: 'user', content: message.content })
            messages.push({ role: 'assistant', content: [{ type: 'text', text: options.reply ?? '原生回复' }] })
          },
          async whenIdle() {
            waitIdleCalls += 1
          },
          session: {
            id: input.sessionId,
            deriveMessages: () => messages,
          },
        },
        async dispose() {
          disposed.push(input.sessionId)
        },
      }
      return handle
    },
  }
  return { agents, created, archived, disposed, followups, followupMessages, waitIdle: () => waitIdleCalls, archive: (id: string) => archived.push(id) }
}

describe('原生 session（M2.1，实验开关）', () => {
  it('同一“角色×群”复用同一个原生会话：create/archive 各一次，回复取最后一条 assistant', async () => {
    const fake = fakeAgentFactory({ reply: '产品视角的回复' })
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      workspace: () => ({ archiveSession: async (id) => { fake.archive(id) } }),
    })
    const first = await sessions.complete({
      sessionKey: 'p1:t1',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      system: '你是产品经理',
      prompt: '当前消息：看下这个方案',
    })
    const second = await sessions.complete({
      sessionKey: 'p1:t1',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      system: '你是产品经理',
      prompt: '当前消息：接着说',
    })
    expect(first.text).toBe('产品视角的回复')
    expect(second.text).toBe('产品视角的回复')
    expect(fake.created).toHaveLength(1)
    // 活会话不能归档：归档写入会把紧接着的 followup 收成 blocked，deriveMessages 一直是 0。
    expect(fake.archived).toEqual([])
    expect(fake.waitIdle()).toBe(2)
    expect(fake.followups[0].text).toContain('你是产品经理')
    expect(fake.followups[0].text).toContain('看下这个方案')
    expect(fake.followups[1].text).toContain('接着说')
    // 回归：followup 必须给完整 user Message（role + id），否则 DSH 的
    // deriveMessages 会派生无角色消息，deepseek 适配器 serialize 抛 TypeError
    // 并被包成 TRANSPORT（native 一直 ok:false 的根因）。
    expect(fake.followupMessages).toHaveLength(2)
    expect(fake.followupMessages.map((message) => message.role)).toEqual(['user', 'user'])
    expect(fake.followupMessages.every((message) => message.hasId)).toBe(true)
    expect(fake.followupMessages.every((message) => message.sourceKind === 'user')).toBe(true)
    expect(sessions.liveSessionIds()).toEqual([nativeSessionId('p1:t1')])
    await sessions.disposeAll()
    expect(fake.archived).toEqual([nativeSessionId('p1:t1')])
    expect(sessions.liveSessionIds()).toEqual([])
  })

  it('不同群/角色 → 不同 sessionId（按“角色×群”隔离，避免串台）', async () => {
    expect(nativeSessionId('p1:t1')).not.toBe(nativeSessionId('p1:t2'))
    expect(nativeSessionId('p1:t1')).not.toBe(nativeSessionId('p2:t1'))
    const fake = fakeAgentFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await sessions.complete({ sessionKey: 'p1:t1', provider: 'x', model: 'm', prompt: 'a' })
    await sessions.complete({ sessionKey: 'p1:t2', provider: 'x', model: 'm', prompt: 'b' })
    expect(new Set(fake.created).size).toBe(2)
  })

  it('原生会话返回空内容 → 报错，不假装成功', async () => {
    const fake = fakeAgentFactory({ reply: '   ' })
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await expect(sessions.complete({ sessionKey: 'p1:t1', provider: 'x', model: 'm', prompt: 'a' }))
      .rejects.toMatchObject({ code: 'NATIVE_EMPTY' })
  })

  it('空闲超时释放原生会话；disposeAll 释放全部', async () => {
    vi.useFakeTimers()
    try {
      let now = 1000
      const fake = fakeAgentFactory()
      const sessions = new NativeAgentSessions({ agents: () => fake.agents, ttlMs: 5000, now: () => now })
      await sessions.complete({ sessionKey: 'p1:t1', provider: 'x', model: 'm', prompt: 'a' })
      expect(fake.created).toHaveLength(1)
      now = 7000 // 超过 TTL
      await sessions.complete({ sessionKey: 'p1:t1', provider: 'x', model: 'm', prompt: 'b' })
      expect(fake.disposed).toEqual([nativeSessionId('p1:t1')])
      expect(fake.created).toHaveLength(2)
      await sessions.disposeAll()
      expect(fake.disposed).toHaveLength(2)
      expect(sessions.liveSessionIds()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('create 失败向上抛；archive 失败只记日志不挡创建', async () => {
    const failing = fakeAgentFactory({ failCreate: new Error('agents 崩了') })
    const sessions = new NativeAgentSessions({ agents: () => failing.agents })
    await expect(sessions.complete({ sessionKey: 'p1:t1', provider: 'x', model: 'm', prompt: 'a' }))
      .rejects.toThrow(/agents 崩了/)

    const fake = fakeAgentFactory()
    const warns: string[] = []
    const sessions2 = new NativeAgentSessions({
      agents: () => fake.agents,
      workspace: () => ({ archiveSession: async () => { throw new Error('archive 失败') } }),
      logger: { warn: (message) => warns.push(message) },
    })
    await expect(sessions2.complete({ sessionKey: 'p1:t1', provider: 'x', model: 'm', prompt: 'a' }))
      .resolves.toMatchObject({ text: '原生回复' })
    await sessions2.disposeAll()
    expect(warns.some((message) => message.includes('archive'))).toBe(true)
  })

  it('createNativeRuntime：开关关闭返回空；打开但宿主无 agents 时 status 明确不可用', async () => {
    const off = createNativeRuntime({ enabled: false, agents: () => undefined })
    expect(off.bridge).toBeUndefined()
    await expect(off.disposeAll()).resolves.toBeUndefined()

    const on = createNativeRuntime({ enabled: true, agents: () => undefined })
    expect(on.bridge?.status()).toMatchObject({ enabled: false })
    await expect(on.bridge!.complete({ sessionKey: 'p1:t1', provider: 'x', model: 'm', prompt: 'a' }))
      .rejects.toMatchObject({ code: 'NATIVE_UNAVAILABLE' })
  })

  it('lastAssistantText：只要 assistant 的非空文本，兼容字符串内容', () => {
    expect(lastAssistantText([
      { role: 'assistant', content: '旧回复' },
      { role: 'user', content: [{ type: 'text', text: '用户' }] },
      { role: 'assistant', content: [{ type: 'text', text: ' 新回复 ' }] },
    ])).toBe('新回复')
    expect(lastAssistantText([{ role: 'user', content: 'hi' }])).toBe('')
  })
})

describe('原生 session 的 host 接口（/native-status、/native-complete）', () => {
  function llm() {
    return {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
      },
      async *stream() {
        yield { type: 'text-delta', text: '不该走这里' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }

  it('未开启时 nativeStatus=false、nativeComplete 503', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-native-'))
    const api = createImApi({ projectRoot: () => root, llm: () => llm() })
    expect(api.nativeStatus()).toMatchObject({ enabled: false })
    await expect(api.nativeComplete({ sessionKey: 'p1:t1', prompt: 'x' })).rejects.toMatchObject({ status: 503 })
  })

  it('开启后：校验模型绑定、调 bridge、写回执与 purpose=native 指标', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-native-'))
    const complete = vi.fn(async () => ({ text: '原生模型回复' }))
    const api = createImApi({
      projectRoot: () => root,
      llm: () => llm(),
      native: () => ({ status: () => ({ enabled: true }), complete }),
    })
    expect(api.nativeStatus()).toEqual({ enabled: true })
    const { text } = await api.nativeComplete({
      sessionKey: 'p1:t1',
      personaId: 'p1',
      model: 'deepseek-account::deepseek-flash',
      system: '你是产品经理',
      prompt: '当前消息：看方案',
      threadId: 't1',
      windowSeqs: [1, 2],
      summaryUntil: 0,
      factsVersion: 'facts-v1:x',
    })
    expect(text).toBe('原生模型回复')
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'p1:t1',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      system: '你是产品经理',
      prompt: '当前消息：看方案',
    }))
    const metrics = await readMetrics(root, 't1', { kind: 'llm_call' })
    expect(metrics[0].fields).toMatchObject({ ok: true, purpose: 'native', personaId: 'p1', windowCount: 2 })
    const receipts = await readReceipts(root, 't1')
    expect(receipts[0].outcome?.finish).toBe('stop')
    expect(receipts[0].intent.untrusted).toBe(true)
  })

  it('nativeComplete 缺 sessionKey/prompt 返回 400；bridge 失败写 error 指标并抛错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-native-'))
    const api = createImApi({
      projectRoot: () => root,
      llm: () => llm(),
      native: () => ({ status: () => ({ enabled: true }), complete: async () => { throw new Error('NATIVE_BOOM') } }),
    })
    await expect(api.nativeComplete({ prompt: 'x' })).rejects.toMatchObject({ status: 400 })
    await expect(api.nativeComplete({ sessionKey: 'p1:t1', prompt: '' })).rejects.toMatchObject({ status: 400 })
    await expect(api.nativeComplete({
      sessionKey: 'p1:t1',
      prompt: 'x',
      model: 'deepseek-account::deepseek-flash',
      toolAllow: 'read' as unknown as string[],
    })).rejects.toMatchObject({ status: 400 })
    await expect(api.nativeComplete({
      sessionKey: 'p1:t1',
      prompt: 'x',
      model: 'deepseek-account::deepseek-flash',
      threadId: 't1',
      toolAllow: ['read', 'check'],
    })).rejects.toThrow(/NATIVE_BOOM/)
    await expect(api.nativeComplete({
      sessionKey: 'p1:t1',
      prompt: 'x',
      model: 'deepseek-account::deepseek-flash',
      threadId: 't1',
    })).rejects.toThrow(/NATIVE_BOOM/)
    const metrics = await readMetrics(root, 't1', { kind: 'llm_call' })
    expect(metrics[0].fields).toMatchObject({ ok: false, purpose: 'native' })
    expect(String(metrics[0].fields?.error)).toContain('NATIVE_BOOM')
  })
})
