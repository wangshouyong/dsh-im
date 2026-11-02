import { describe, expect, it } from 'vitest'
import {
  BoundModelSpeaker,
  MAX_WINDOW_CHARS,
  promptBudgetFor,
  type ModelTransport,
} from '../src/core/runtime.ts'
import { listDshModels, modelContextWindow } from '../src/host/dsh-llm.ts'
import type { Message, SpeakRequest, Thread } from '../src/core/types.ts'

function persona() {
  return {
    id: 'p1',
    name: '产品经理',
    avatar: '产',
    personality: '',
    duties: ['需求'],
    origin: 'mine' as const,
    model: 'deepseek-account::deepseek-flash',
    proactiveDm: false,
    defaultActivity: 'review' as const,
  }
}

function thread(withDigest = false): Thread {
  const messages: Message[] = []
  for (let index = 0; index < 20; index++) {
    const kind: Message['kind'] = index === 19 ? 'user' : index % 2 === 0 ? 'persona' : 'user'
    messages.push({
      id: 'm' + index,
      threadId: 't1',
      seq: index + 1,
      kind,
      authorName: kind === 'user' ? '你' : '架构师',
      text: index === 0 ? '最旧消息锚点' : 'x'.repeat(400),
      createdAt: index,
    })
  }
  return {
    id: 't1',
    kind: 'group',
    title: '方案评审',
    topic: '',
    shortSummary: '',
    memberIds: ['p1'],
    members: [],
    projectRoot: '.',
    messages,
    unread: 0,
    roundMode: 'idle',
    createdAt: 0,
    updatedAt: 0,
    ...(withDigest
      ? {
        summaryState: {
          version: 'digest-v1:x',
          untilSeq: 0,
          l1: 'L'.repeat(6000),
          l2: ['- [决定] 周三上线灰度'],
          factsVersion: 'facts-v1:x',
          at: 0,
        },
      }
      : {}),
  }
}

function request(messageThread: Thread): SpeakRequest {
  return {
    persona: persona(),
    thread: messageThread,
    focus: '需求',
    visibleMessages: messageThread.messages,
    identity: '',
    userGlobal: [],
    threadMemory: [],
    catalog: [],
  }
}

function capture() {
  const prompts: string[] = []
  const transport: ModelTransport = {
    async complete(input) {
      prompts.push(input.messages.map((message) => message.content).join('\n'))
      return '回复'
    },
  }
  return { prompts, transport }
}

describe('prompt 预算（按上下文窗口 60/20/20）', () => {
  it('promptBudgetFor：未知窗口用默认，大窗口按比例并设上限', () => {
    expect(promptBudgetFor()).toEqual({ windowChars: 6000, summaryChars: 2000 })
    const medium = promptBudgetFor(8000)
    expect(medium.windowChars).toBe(6000)
    expect(medium.summaryChars).toBe(1600)
    const large = promptBudgetFor(128_000)
    expect(large.windowChars).toBe(MAX_WINDOW_CHARS)
    expect(large.summaryChars).toBe(8000)
    // 60/20/20：摘要不超过窗口的 1/3（剩 20% 给系统/当前消息/输出）
    expect(large.summaryChars).toBeLessThanOrEqual(Math.floor(large.windowChars / 3))
    const tiny = promptBudgetFor(2000)
    expect(tiny.windowChars).toBe(6000)
  })

  it('窗口预算生效：小模型丢掉最旧消息，大模型保留', async () => {
    const small = capture()
    await new BoundModelSpeaker(small.transport, { contextWindowFor: () => 8000 })
      .complete(request(thread()))
    const large = capture()
    await new BoundModelSpeaker(large.transport, { contextWindowFor: () => 128_000 })
      .complete(request(thread()))
    expect(small.prompts[0]).not.toContain('最旧消息锚点')
    expect(large.prompts[0]).toContain('最旧消息锚点')
    expect(large.prompts[0].length).toBeGreaterThan(small.prompts[0].length)
  })

  it('摘要预算生效：超出按比例截断', async () => {
    const small = capture()
    await new BoundModelSpeaker(small.transport, { contextWindowFor: () => 8000 })
      .complete(request(thread(true)))
    const large = capture()
    await new BoundModelSpeaker(large.transport, { contextWindowFor: () => 128_000 })
      .complete(request(thread(true)))
    expect(small.prompts[0]).toContain('…')
    expect(large.prompts[0]).not.toContain('…')
    // 事实块在摘要最前面，不会被截掉
    expect(small.prompts[0]).toContain('周三上线灰度')
  })
})

describe('模型上下文窗口查询（DSH resolveModelInfo）', () => {
  it('模型目录带上宿主给的 contextWindow；查询失败不影响目录', async () => {
    const listed = await listDshModels({
      listProviders: () => [
        { id: 'deepseek-account', name: 'DeepSeek 账号' },
        { id: 'broken', name: 'Broken' },
      ],
      async listModels(provider) {
        return [{ id: provider + '-model', name: provider }]
      },
      async resolveModelInfo(provider: string, model: string) {
        expect(model).toBe(provider + '-model')
        if (provider === 'broken') throw new Error('no info')
        return { context: { contextWindow: 128_000 } }
      },
    })
    expect(listed.find((option) => option.route === 'deepseek-account')?.contextWindow).toBe(128_000)
    expect(listed.find((option) => option.route === 'broken')?.contextWindow).toBeUndefined()
    expect(listed).toHaveLength(2)
  })

  it('宿主 resolveModelInfo 直接 reject（NO_ADAPTER）时目录仍可用，不产生未处理 rejection', async () => {
    // 2026-10-30 事故回归：以前把 {provider,model} 对象传给 resolveModelInfo，
    // 宿主返回 rejected Promise 而我们没 await，未处理 rejection 让 DSH 主进程直接崩掉。
    const listed = await listDshModels({
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
      },
      resolveModelInfo: () => Promise.reject(Object.assign(
        new Error('no adapter registered for provider "[object Object]"'),
        { code: 'NO_ADAPTER' },
      )),
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ ready: true, id: 'deepseek-account::deepseek-flash' })
    expect(listed[0].contextWindow).toBeUndefined()
  })

  it('只按真实签名 (provider, model) 调用：async + context.contextWindow；失败/缺少字段返回 undefined', async () => {
    const real = { resolveModelInfo: async () => ({ context: { contextWindow: 32_000 } }) }
    await expect(modelContextWindow(real, 'p', 'm')).resolves.toBe(32_000)
    const flat = { resolveModelInfo: async () => ({ context_window: 16_000 }) }
    await expect(modelContextWindow(flat, 'p', 'm')).resolves.toBe(16_000)
    const throwing = { resolveModelInfo: async () => { throw new Error('NO_ADAPTER') } }
    await expect(modelContextWindow(throwing, 'p', 'm')).resolves.toBeUndefined()
    // 关键回归：宿主返回 rejected Promise 时必须被 await+catch 吞掉，
    // 否则 Electron 主进程会因未处理 rejection 直接弹“应用无法启动”。
    const rejecting = { resolveModelInfo: () => Promise.reject(new Error('no adapter registered for provider "[object Object]"')) }
    await expect(modelContextWindow(rejecting, 'p', 'm')).resolves.toBeUndefined()
    await expect(modelContextWindow(undefined, 'p', 'm')).resolves.toBeUndefined()
    const missing = { resolveModelInfo: async () => ({ name: 'm' }) }
    await expect(modelContextWindow(missing, 'p', 'm')).resolves.toBeUndefined()
  })
})
