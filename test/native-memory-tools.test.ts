/**
 * 原生会话（默认路径）的 memory 能力与预算透传（真机复验补充）。
 *
 * 真机发现：`pluginToolsForAllow` 漏了 `memory`，原生会话根本没注册 memory_search/memory_expand，
 * 导致「memoryBudgetChars 透传到工具」这条路无法成立（模型以为工具被授权却调不出来）。
 * 这里用假 agents/tools 锁住：
 * 1. toolAllow=['memory'] → 注册两个 memory 工具；
 * 2. executeTool 收到 memoryBudgetChars（预算透传）；
 * 3. 单轮 15 次工具调用 → 只执行 12 次、超限返回“已达上限”、toolStats 正确。
 */
import { describe, expect, it } from 'vitest'
import {
  NativeAgentSessions,
  type NativeAgentCreateOptions,
  type NativeAgentHandle,
  type NativeAgentsApi,
  type NativeMessage,
} from '../src/host/agent-session.ts'
import { DEFAULT_TOOL_CALL_LIMIT } from '../src/host/tool-call-budget.ts'

interface Registered {
  name: string
  execute: (args: Record<string, unknown>) => Promise<{ text: string }>
}

function fakeHostTools() {
  const registered = new Map<string, Registered>()
  const tools = {
    register(definition: { name: string; execute: (args: Record<string, unknown>) => Promise<{ text: string }> }) {
      registered.set(definition.name, definition)
      return () => { registered.delete(definition.name) }
    },
    guard: () => undefined,
    restrict: async () => undefined,
    schemas: () => [...registered.keys()],
  }
  return { tools, registered }
}

function fakeAgents(options: {
  tools: ReturnType<typeof fakeHostTools>['tools']
  followup?: () => Promise<void>
}) {
  const created: string[] = []
  const agents: NativeAgentsApi = {
    async create(input: NativeAgentCreateOptions) {
      created.push(input.sessionId)
      const messages: NativeMessage[] = []
      const ctx = {
        get: (name: string) => (name === 'tools' ? options.tools : undefined),
        tools: options.tools,
        on: () => undefined,
      }
      const handle: NativeAgentHandle = {
        agent: {
          followup(message) {
            messages.push({ role: 'user', content: message.content })
            // 模拟 agent 在 followup 后调用工具（异步），whenIdle 时收尾。
            void Promise.resolve().then(() => options.followup?.()).then(() => {
              messages.push({ role: 'assistant', content: [{ type: 'text', text: '原生作答' }] })
            })
          },
          async whenIdle() {
            // followup 的 Promise 链在上面已排好；这里再让微任务跑完。
            await new Promise((resolve) => setTimeout(resolve, 20))
          },
          session: { id: input.sessionId, deriveMessages: () => messages },
        },
        dispose: async () => undefined,
      }
      await input.setup?.(ctx, handle.agent)
      return handle
    },
  }
  return { agents, created }
}

describe('原生会话：memory 工具注册与预算透传', () => {
  it('toolAllow=[memory] 注册两个 memory 工具，budgetChars 透传到执行器', async () => {
    const host = fakeHostTools()
    const calls: { name: string; budgetChars?: number }[] = []
    let toolRan = false
    // followup 里直接调用已注册的 memory_expand（等价于 agent 调工具）。
    const followup = async () => {
      if (toolRan) return
      toolRan = true
      const tool = host.registered.get('memory_expand')
      await tool?.execute({ question: '三行是什么？' })
    }
    const fake = fakeAgents({ tools: host.tools, followup })
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async (call) => {
        calls.push({ name: call.name, ...(call.budgetChars === undefined ? {} : { budgetChars: call.budgetChars }) })
        return '[展开回执] budgetSource=budget'
      },
      hostTools: () => host.tools,
      logger: { warn: () => undefined },
    })
    const done = await sessions.complete({
      sessionKey: 'p1:t1',
      provider: 'p',
      model: 'm',
      system: 'sys',
      prompt: '问题',
      toolAllow: ['memory'],
      memoryBudgetChars: 73_500,
      threadId: 't1',
    })
    expect([...host.registered.keys()].sort()).toEqual(['memory_expand', 'memory_search'])
    expect(calls).toEqual([{ name: 'memory_expand', budgetChars: 73_500 }])
    expect(done.text).toBe('原生作答')
    expect(done.toolStats?.toolCalls).toBe(1)
    expect(done.toolStats?.toolExecuted).toBe(1)
    expect(done.toolStats?.toolCallLimit).toBe(DEFAULT_TOOL_CALL_LIMIT)
    // trace 里有 tool-budget 审计步
    expect(done.trace?.some((step) => step.name === 'tool-budget')).toBe(true)
  })

  it('单轮 15 次工具 → 只执行 12 次并强制作答（toolStats.toolBudgetExhausted=true）', async () => {
    const host = fakeHostTools()
    const calls: string[] = []
    let fired = false
    const followup = async () => {
      if (fired) return
      fired = true
      const tool = host.registered.get('memory_search')
      for (let index = 0; index < 15; index++) {
        await tool?.execute({ query: `q${index}` })
      }
    }
    const fake = fakeAgents({ tools: host.tools, followup })
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async (call) => {
        calls.push(call.name)
        return '结果'
      },
      hostTools: () => host.tools,
      logger: { warn: () => undefined },
    })
    const done = await sessions.complete({
      sessionKey: 'p1:t1',
      provider: 'p',
      model: 'm',
      system: 'sys',
      prompt: '问题',
      toolAllow: ['memory'],
      threadId: 't1',
    })
    expect(calls).toHaveLength(DEFAULT_TOOL_CALL_LIMIT)
    expect(done.toolStats).toMatchObject({
      toolCalls: DEFAULT_TOOL_CALL_LIMIT,
      toolExecuted: DEFAULT_TOOL_CALL_LIMIT,
      toolBudgetExhausted: true,
    })
    expect(done.trace?.some((step) => (step.result ?? '').includes('已达上限'))).toBe(true)
  })

  it('toolAllow 不含 memory 时不注册（不能静默假装有）', async () => {
    const host = fakeHostTools()
    const fake = fakeAgents({ tools: host.tools })
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async () => '结果',
      hostTools: () => host.tools,
      logger: { warn: () => undefined },
    })
    await sessions.complete({
      sessionKey: 'p1:t1',
      provider: 'p',
      model: 'm',
      system: 'sys',
      prompt: '问题',
      toolAllow: ['read'],
      threadId: 't1',
    })
    expect(host.registered.has('memory_search')).toBe(false)
    expect(host.registered.has('memory_expand')).toBe(false)
  })
})
