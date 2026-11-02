import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NativeAgentSessions,
  hostToolSteps,
  nativeTtlMs,
  type NativeAgent,
  type NativeAgentsApi,
  type NativeMessage,
} from '../src/host/agent-session.ts'
import type { NativeFrame } from '../src/core/types.ts'

interface SectionCall {
  name: string
  order: number
  text: string
}

function splitFactory(options: {
  reply?: string
  systemPrompt?: boolean
  tools?: boolean
  restrictThrows?: boolean
  schemaNames?: string[]
  register?: boolean
} = {}) {
  const sections: SectionCall[] = []
  const restricts: { allow?: string[]; deny?: string[] }[] = []
  const guards: Array<(exec: { name?: string }) => string | undefined> = []
  const registered: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<{ text: string }> }> = []
  const sectionDisposed: string[] = []
  const followups: string[] = []
  const created: string[] = []
  const disposed: string[] = []
  let visible = options.schemaNames ?? ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'pwsh', 'shell']
  const agents: NativeAgentsApi = {
    async create(input) {
      const messages: NativeMessage[] = []
      const agent = {
        followup(message: { content: { text?: string }[] }) {
          const text = message.content.map((block) => block.text ?? '').join('')
          followups.push(text)
          messages.push({ role: 'user', content: message.content })
          messages.push({ role: 'assistant', content: [{ type: 'text', text: options.reply ?? '原生回复' }] })
        },
        async whenIdle() {},
        session: { id: input.sessionId, deriveMessages: () => messages },
      } as NativeAgent
      const ctx = {
        get(name: string) {
          if (name === 'systemPrompt' && options.systemPrompt !== false) {
            return {
              section(spec: SectionCall) {
                sections.push(spec)
                return () => { sectionDisposed.push(spec.name) }
              },
            }
          }
          if (name === 'tools' && options.tools !== false) {
            return {
              restrict(filter: { allow?: string[]; deny?: string[] }) {
                if (options.restrictThrows) throw new Error('restrict boom')
                restricts.push(filter)
                if (filter.allow) {
                  const allow = new Set(filter.allow)
                  visible = visible.filter((tool) => allow.has(tool))
                }
                if (filter.deny) {
                  const deny = new Set(filter.deny)
                  visible = visible.filter((tool) => !deny.has(tool))
                }
              },
              ...(options.register ? {
                async register(definition: { name: string; execute: (args: Record<string, unknown>) => Promise<{ text: string }> }) {
                  registered.push(definition)
                  if (!visible.includes(definition.name)) visible = [...visible, definition.name]
                  return () => { visible = visible.filter((name) => name !== definition.name) }
                },
              } : {}),
              guard(fn: (exec: { name?: string }) => string | undefined) { guards.push(fn) },
              schemas() { return visible.map((name) => ({ name })) },
            }
          }
          return undefined
        },
        on() {},
      }
      if (input.setup) await input.setup(ctx, agent)
      created.push(input.sessionId)
      return {
        agent,
        async dispose() { disposed.push(input.sessionId) },
      }
    },
  }
  return { agents, sections, restricts, guards, registered, sectionDisposed, followups, created, disposed }
}

function line(seq: number, kind: NativeFrame['windowLines'][number]['kind'], authorName: string, text: string): NativeFrame['windowLines'][number] {
  return { seq, kind, authorName, text }
}

const base = {
  sessionKey: 'p甲:t1',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  system: '你是实测甲',
  personaName: '甲',
  toolAllow: ['read', 'search', 'write'],
}

describe('原生 session 静态前缀 / 动态增量', () => {
  let savedAllow: string | undefined

  beforeEach(() => {
    savedAllow = process.env.DSH_IM_NATIVE_TOOL_ALLOW
    delete process.env.DSH_IM_NATIVE_TOOL_ALLOW
  })

  afterEach(() => {
    if (savedAllow === undefined) delete process.env.DSH_IM_NATIVE_TOOL_ALLOW
    else process.env.DSH_IM_NATIVE_TOOL_ALLOW = savedAllow
  })

  it('setup 只调用一次，section 名称/order/text 正确', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    const frame: NativeFrame = {
      windowLines: [line(1, 'user', '你', '你好')],
      currentLine: line(1, 'user', '你', '你好'),
      factsL2: ['- [约束] 不做 shell'],
      factsUntilSeq: 4,
    }
    await sessions.complete({ ...base, prompt: '回退', frame })
    await sessions.complete({ ...base, prompt: '回退', frame: { ...frame, currentLine: line(2, 'user', '你', '再说') } })
    expect(fake.created).toHaveLength(1)
    expect(fake.sections.map((section) => section.name)).toEqual(['dsh-im:persona', 'dsh-im:facts-l2'])
    expect(fake.sections[0]).toMatchObject({ order: 9000, text: '你是实测甲' })
    expect(fake.sections[1].order).toBe(9100)
    expect(fake.sections[1].text).toContain('截止 #4')
    expect(fake.sections[1].text).toContain('不做 shell')
    const info = sessions.debug().sessions[0]
    expect(info.setupCalls).toBe(1)
    expect(info.allow).toEqual([])
    expect(info.toolAllow).toEqual(['read', 'search', 'write'])
    expect(fake.restricts).toEqual([])
    expect(fake.guards).toHaveLength(1)
    expect(fake.guards[0]({ name: 'bash' })).toMatch(/没有授予/)
    expect(fake.guards[0]({ name: 'write' })).toMatch(/没有授予/)
    expect(fake.guards[0]({ name: 'read_file' })).toBeUndefined()
  })

  it('事实段变了就换掉，没变不重注册', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    const frame: NativeFrame = {
      windowLines: [line(1, 'user', '你', '你好')],
      currentLine: line(1, 'user', '你', '你好'),
      factsL2: ['- [约束] 不做 shell'],
      factsUntilSeq: 4,
    }
    await sessions.complete({ ...base, prompt: '回退', frame })
    await sessions.complete({ ...base, prompt: '回退', frame: { ...frame, currentLine: line(2, 'user', '你', '再说') } })
    expect(fake.sections.filter((section) => section.name === 'dsh-im:facts-l2')).toHaveLength(1)
    expect(fake.sectionDisposed).toEqual([])
    await sessions.complete({
      ...base,
      prompt: '回退',
      frame: { ...frame, factsL2: ['- [决定] 改用原生会话'], factsUntilSeq: 8, currentLine: line(3, 'user', '你', '更新') },
    })
    const facts = fake.sections.filter((section) => section.name === 'dsh-im:facts-l2')
    expect(facts).toHaveLength(2)
    expect(facts[1].text).toContain('截止 #8')
    expect(facts[1].text).toContain('改用原生会话')
    expect(fake.sectionDisposed).toEqual(['dsh-im:facts-l2'])
    await sessions.complete({
      ...base,
      prompt: '回退',
      frame: { ...frame, factsL2: [], factsUntilSeq: 9, currentLine: line(4, 'user', '你', '清空') },
    })
    expect(fake.sections.filter((section) => section.name === 'dsh-im:facts-l2')).toHaveLength(2)
    expect(fake.sectionDisposed).toEqual(['dsh-im:facts-l2', 'dsh-im:facts-l2'])
  })

  it('guard 按 toolAllow 收窄插件工具（只有 read 时拒 write_file/run_check）', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await sessions.complete({ ...base, toolAllow: ['read'], prompt: '只读', frame: { windowLines: [], currentLine: line(1, 'user', '你', '只读') } })
    const guard = fake.guards[0]
    expect(guard({ name: 'read_file' })).toBeUndefined()
    expect(guard({ name: 'write_file' })).toMatch(/没有「write」能力/)
    expect(guard({ name: 'run_check' })).toMatch(/没有「check」能力/)

    // 同会话内改勾选：下一轮按新能力生效。
    await sessions.complete({ ...base, toolAllow: ['read', 'write'], prompt: '加写', frame: { windowLines: [], currentLine: line(2, 'user', '你', '加写') } })
    expect(guard({ name: 'write_file' })).toBeUndefined()
    await sessions.complete({ ...base, toolAllow: ['search'], prompt: '只搜', frame: { windowLines: [], currentLine: line(3, 'user', '你', '只搜') } })
    expect(guard({ name: 'list_dir' })).toBeUndefined()
    expect(guard({ name: 'read_file' })).toMatch(/没有「read」能力/)
    // undefined = 继承主会话全部能力（显式语义，不是隐式放行）。
    await sessions.complete({ ...base, toolAllow: undefined, prompt: '继承', frame: { windowLines: [], currentLine: line(3, 'user', '你', '继承') } })
    expect(guard({ name: 'run_check' })).toBeUndefined()
  })

  it('浏览器和画图要单独勾，连接器管理操作始终拒绝', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await sessions.complete({ ...base, toolAllow: ['read'], prompt: '只读', frame: { windowLines: [], currentLine: line(1, 'user', '你', '只读') } })
    const guard = fake.guards[0]
    expect(guard({ name: 'bcdp_snapshot' })).toMatch(/没有授予/)
    expect(guard({ name: 'mcp__magpie-image__generate_image' })).toMatch(/没有授予/)
    expect(guard({ name: 'mcp_connector_disconnect' })).toMatch(/连接器管理/)
    await sessions.complete({
      ...base,
      toolAllow: ['read', 'browser', 'image'],
      prompt: '开',
      frame: { windowLines: [], currentLine: line(2, 'user', '你', '开') },
    })
    expect(guard({ name: 'bcdp_snapshot' })).toBeUndefined()
    expect(guard({ name: 'mcp__magpie-image__generate_image' })).toBeUndefined()
    expect(guard({ name: 'mcp__magpie-image__generate_video' })).toBeUndefined()
    expect(guard({ name: 'mcp_connector_publish' })).toMatch(/连接器管理/)
    expect(guard({ name: 'bash' })).toMatch(/没有授予/)
    expect(hostToolSteps([
      { role: 'assistant', content: [{ type: 'tool-call', name: 'bcdp_snapshot', arguments: { url: 'https://example.com' } }] },
      { role: 'tool', content: [{ type: 'text', text: '页面标题' }] },
      { role: 'assistant', content: [{ type: 'tool-call', name: 'read_file', arguments: { path: 'a' } }] },
      { role: 'tool', content: [{ type: 'text', text: '文件' }] },
    ])).toEqual([
      expect.objectContaining({ name: 'bcdp_snapshot', ok: true, result: '页面标题' }),
    ])
  })

  it('debug 区分 []（全拒）和 undefined（继承）', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await sessions.complete({ ...base, toolAllow: [], prompt: '全拒', frame: { windowLines: [], currentLine: line(1, 'user', '你', '全拒') } })
    expect(sessions.debug().sessions[0].toolAllow).toEqual([])
    await sessions.complete({ ...base, toolAllow: undefined, prompt: '继承', frame: { windowLines: [], currentLine: line(2, 'user', '你', '继承') } })
    expect(sessions.debug().sessions[0].toolAllow).toBeUndefined()
  })

  it('收窄变 undefined 时打 warn', async () => {
    const warns: string[] = []
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents, logger: { warn: (message) => warns.push(message) } })
    await sessions.complete({ ...base, toolAllow: ['read'], prompt: '收窄', frame: { windowLines: [], currentLine: line(1, 'user', '你', '收窄') } })
    // 同一收窄值重复 / 数组内加宽都不该响。
    await sessions.complete({ ...base, toolAllow: ['read'], prompt: '再收窄', frame: { windowLines: [], currentLine: line(2, 'user', '你', '再收窄') } })
    expect(warns.filter((message) => message.includes('放宽为“继承全部”'))).toHaveLength(0)
    await sessions.complete({ ...base, toolAllow: ['read', 'write'], prompt: '加宽', frame: { windowLines: [], currentLine: line(3, 'user', '你', '加宽') } })
    expect(warns.filter((message) => message.includes('放宽为“继承全部”'))).toHaveLength(0)
    await sessions.complete({ ...base, toolAllow: undefined, prompt: '放宽', frame: { windowLines: [], currentLine: line(4, 'user', '你', '放宽') } })
    expect(warns.filter((message) => message.includes('放宽为“继承全部”'))).toHaveLength(1)
  })

  it('首轮投喂全窗口；第二轮只投 seq 更大的行', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    const first: NativeFrame = {
      windowLines: [
        line(1, 'user', '你', '窗口甲'),
        line(2, 'persona', '乙', '窗口乙'),
      ],
      currentLine: line(3, 'user', '你', '当前一'),
    }
    await sessions.complete({ ...base, prompt: '整段不该出现', frame: first })
    const second: NativeFrame = {
      windowLines: [
        line(1, 'user', '你', '窗口甲'),
        line(2, 'persona', '乙', '窗口乙'),
        line(3, 'user', '你', '当前一'),
      ],
      currentLine: line(4, 'user', '你', '当前二'),
    }
    await sessions.complete({ ...base, prompt: '整段不该出现', frame: second })
    expect(fake.followups[0]).toContain('窗口甲')
    expect(fake.followups[0]).toContain('窗口乙')
    expect(fake.followups[0]).toContain('当前一')
    expect(fake.followups[0]).not.toContain('整段不该出现')
    expect(fake.followups[1]).toBe('[#4][用户 你] 当前二')
    expect(fake.followups[1].length).toBeLessThan(fake.followups[0].length)
    const chars = sessions.debug().sessions[0].feedChars
    expect(chars).toHaveLength(2)
    expect(chars[1]).toBeLessThan(chars[0])
    expect(sessions.debug().sessions[0].lastDeliveredSeq).toBe(4)
  })

  it('自己的发言不投喂', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await sessions.complete({
      ...base,
      prompt: '回退',
      frame: {
        windowLines: [
          line(1, 'user', '你', '请介绍'),
          line(2, 'persona', '甲', '我自己说的秘密'),
        ],
        currentLine: line(1, 'user', '你', '请介绍'),
      },
    })
    expect(fake.followups[0]).toContain('请介绍')
    expect(fake.followups[0]).not.toContain('我自己说的秘密')
  })

  it('无新增窗口行时只投当前消息', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    const frame: NativeFrame = {
      windowLines: [line(1, 'user', '你', '原来的话')],
      currentLine: line(1, 'user', '你', '原来的话'),
    }
    await sessions.complete({ ...base, prompt: '回退提示', frame })
    await sessions.complete({
      ...base,
      prompt: '回退提示',
      frame: {
        windowLines: [line(1, 'user', '你', '原来的话')],
        currentLine: line(1, 'user', '你', '重试这句话'),
      },
    })
    expect(fake.followups[1]).toBe('[#1][用户 你] 重试这句话')
    expect(fake.followups[1]).not.toContain('回退提示')
    expect(fake.followups[1]).not.toContain('原来的话')
  })

  it('LRU 释放后重建：再次全量，setupCalls 重新计为 1', async () => {
    const fake = splitFactory()
    let now = 0
    const sessions = new NativeAgentSessions({ agents: () => fake.agents, ttlMs: 1000, now: () => now })
    const frame: NativeFrame = {
      windowLines: [line(1, 'user', '你', '冷启动全文')],
      currentLine: line(2, 'user', '你', '接着'),
    }
    await sessions.complete({ ...base, prompt: '回退', frame })
    now = 1000
    await sessions.complete({ ...base, prompt: '回退', frame })
    expect(fake.disposed).toHaveLength(1)
    expect(fake.created).toHaveLength(2)
    expect(fake.followups[1]).toContain('冷启动全文')
    expect(fake.followups[1]).toContain('接着')
    expect(sessions.debug().sessions).toHaveLength(1)
    expect(sessions.debug().sessions[0].setupCalls).toBe(1)
    expect(fake.sections.filter((section) => section.name === 'dsh-im:persona')).toHaveLength(2)
  })

  it('restrict 抛错时 complete 抛错，不静默', async () => {
    process.env.DSH_IM_NATIVE_TOOL_ALLOW = 'read'
    const fake = splitFactory({ restrictThrows: true })
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await expect(sessions.complete({ ...base, prompt: '回退', frame: { windowLines: [] } }))
      .rejects.toThrow(/restrict boom/)
    expect(fake.followups).toHaveLength(0)
    expect(sessions.liveSessionIds()).toEqual([])
  })

  it('取不到 systemPrompt 时 warn 并退回整段投喂，不抛', async () => {
    const fake = splitFactory({ systemPrompt: false })
    const warns: string[] = []
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      logger: { warn: (message) => warns.push(message) },
    })
    await expect(sessions.complete({
      ...base,
      system: '静态人设',
      prompt: '整段提示',
      frame: {
        windowLines: [line(1, 'user', '你', '仅增量行')],
        currentLine: line(1, 'user', '你', '仅增量行'),
      },
    })).resolves.toMatchObject({ text: '原生回复' })
    expect(fake.followups[0]).toContain('静态人设')
    expect(fake.followups[0]).toContain('整段提示')
    expect(warns.some((message) => message.includes('宿主无 systemPrompt'))).toBe(true)
  })

  it('把勾选的插件工具注册进 agent，并藏起宿主工具', async () => {
    const fake = splitFactory({ register: true })
    const calls: string[] = []
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async (call) => {
        calls.push(call.name)
        return '文件正文'
      },
    })
    await sessions.complete({
      ...base,
      toolAllow: ['read', 'search'],
      prompt: '读',
      frame: { windowLines: [line(1, 'user', '你', '读一下')] },
    })
    expect(fake.registered.map((item) => item.name).sort()).toEqual(['list_dir', 'read_file', 'search_files'])
    expect(sessions.debug().sessions[0].allow.sort()).toEqual(['list_dir', 'read_file', 'search_files'])
    expect(fake.restricts[0].deny?.sort()).toEqual(['bash', 'edit', 'glob', 'grep', 'pwsh', 'read', 'shell', 'write'])
    const read = fake.registered.find((item) => item.name === 'read_file')
    await expect(read?.execute({ path: 'a.ts' })).resolves.toEqual({ text: '文件正文' })
    expect(calls).toEqual(['read_file'])
    expect(sessions.debug().sessions[0].schemas).toEqual(expect.arrayContaining(['read_file', 'search_files']))
    expect(sessions.debug().sessions[0].schemas.join(',')).not.toMatch(/bash|shell/)
    expect(fake.guards[0]({ name: 'write_file' })).toMatch(/没有「write」能力/)
    expect(fake.guards[0]({ name: 'bash' })).toMatch(/没有授予/)
  })

  it('宿主没有 register 时明确走兼容路径', async () => {
    const fake = splitFactory()
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async () => 'x',
    })
    await expect(sessions.complete({
      ...base,
      toolAllow: ['check'],
      prompt: '查',
      frame: { windowLines: [] },
    })).rejects.toThrow(/兼容路径/)
    expect(fake.followups).toHaveLength(0)
  })

  it('宿主没有同名工具时不换成浏览器工具，并用 guard 拒绝宿主工具', async () => {
    const fake = splitFactory({
      schemaNames: ['bcdp_cli', 'bcdp_js', 'bcdp_snapshot', 'bcdp_status', 'bash', 'send_message', 'spawn_teammate'],
    })
    const sessions = new NativeAgentSessions({ agents: () => fake.agents })
    await sessions.complete({ ...base, prompt: '回退', frame: { windowLines: [line(1, 'user', '你', '看一眼')] } })
    expect(fake.restricts).toEqual([])
    expect(fake.guards).toHaveLength(1)
    expect(fake.guards[0]({ name: 'bash' })).toMatch(/没有授予/)
    expect(fake.guards[0]({ name: 'bcdp_cli' })).toMatch(/没有授予/)
    expect(fake.guards[0]({ name: 'send_message' })).toMatch(/没有授予/)
    expect(fake.guards[0]({ name: 'spawn_teammate' })).toMatch(/没有授予/)
    expect(fake.guards[0]({ name: 'read_file' })).toBeUndefined()
    expect(fake.guards[0]({ name: 'run_check' })).toMatch(/没有「check」能力/)
  })

  it('session 已存在时改走 resume，不把旧窗口再灌一遍', async () => {
    const fake = splitFactory()
    let creates = 0
    const agents: NativeAgentsApi = {
      async create() {
        creates += 1
        throw new Error('session "im-x" already exists')
      },
      resume: (input) => fake.agents.create(input),
    }
    const sessions = new NativeAgentSessions({ agents: () => agents })
    await sessions.complete({
      ...base,
      prompt: '整段不该出现',
      frame: {
        windowLines: [line(1, 'user', '你', '旧窗口'), line(2, 'user', '你', '也是旧的')],
        currentLine: line(3, 'user', '你', '刚到的新消息'),
      },
    })
    expect(creates).toBe(1)
    expect(fake.followups[0]).toContain('刚到的新消息')
    expect(fake.followups[0]).not.toContain('旧窗口')
    expect(fake.followups[0]).not.toContain('整段不该出现')
    expect(sessions.debug().sessions[0].setupCalls).toBe(1)
  })

  it('DSH_IM_NATIVE_TTL_MS 生效', async () => {
    expect(nativeTtlMs('4000')).toBe(4000)
    expect(nativeTtlMs('nope')).toBe(30 * 60 * 1000)
    const prev = process.env.DSH_IM_NATIVE_TTL_MS
    process.env.DSH_IM_NATIVE_TTL_MS = '1000'
    try {
      let now = 0
      const fake = splitFactory({ systemPrompt: false, tools: false })
      const sessions = new NativeAgentSessions({ agents: () => fake.agents, now: () => now })
      await sessions.complete({ sessionKey: 'p:t', provider: 'x', model: 'm', prompt: 'a', system: 's' })
      now = 1000
      await sessions.complete({ sessionKey: 'p:t', provider: 'x', model: 'm', prompt: 'b', system: 's' })
      expect(fake.created).toHaveLength(2)
    } finally {
      if (prev === undefined) delete process.env.DSH_IM_NATIVE_TTL_MS
      else process.env.DSH_IM_NATIVE_TTL_MS = prev
    }
  })
})
