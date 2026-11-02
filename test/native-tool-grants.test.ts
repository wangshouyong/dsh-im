import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TOOL_GROUPS,
  discoverToolGroups,
  effectiveHostTools,
  groupIdForTool,
  hostToolGranted,
  labelForGrant,
  normalizeToolAllow,
  parseGrant,
  personaHostToolDenial,
  pluginToolGranted,
  toolGroupCatalog,
  type ToolGroupDecl,
} from '../src/core/tools.ts'
import { NativeAgentSessions, type NativeAgent, type NativeAgentsApi, type NativeMessage } from '../src/host/agent-session.ts'

describe('工具来源组发现', () => {
  it('MCP 按 server 分组、bcdp 按出厂声明归浏览器、其余落兜底组', () => {
    const groups = discoverToolGroups([
      'mcp__github__create_issue',
      'mcp__github__search',
      'bcdp_status',
      'bcdp_click',
      'mcp__aippt__ppt_list',
      'send_message',
      'read_file',
    ])
    const byId = new Map(groups.map((group) => [group.id, group]))
    expect(byId.get('browser')?.tools.sort()).toEqual(['bcdp_click', 'bcdp_status'])
    expect(byId.get('browser')?.kind).toBe('builtin')
    expect(byId.get('mcp:github')?.tools.sort()).toEqual(['mcp__github__create_issue', 'mcp__github__search'])
    expect(byId.get('mcp:github')?.kind).toBe('mcp')
    expect(byId.get('mcp:aippt')?.tools).toEqual(['mcp__aippt__ppt_list'])
    expect(byId.get('ext:other')?.tools.sort()).toEqual(['send_message'])
    // 插件工具不是宿主工具，不参与来源组。
    expect(groups.some((group) => group.tools.includes('read_file'))).toBe(false)
  })

  it('配置声明优先于 MCP 命名约定（非 MCP 第三方插件也能分组）', () => {
    const declared: ToolGroupDecl[] = [
      ...BUILTIN_TOOL_GROUPS,
      { id: 'ext:knowledge', label: '知识库插件', match: { prefixes: ['kb_'] } },
      { id: 'mcp:special', label: '特例 MCP', match: { mcpServers: ['special'] } },
    ]
    expect(discoverToolGroups(['kb_search', 'mcp__special__x', 'mcp__other__y'], declared).map((group) => [group.id, group.kind]))
      .toEqual([['ext:knowledge', 'declared'], ['mcp:other', 'mcp'], ['mcp:special', 'declared']])
    expect(groupIdForTool('kb_search', declared)).toBe('ext:knowledge')
  })

  it('目录同时给出内置能力与来源组', () => {
    const catalog = toolGroupCatalog(['bcdp_status', 'mcp__x__y'])
    expect(catalog.capabilities.map((capability) => capability.id)).toEqual(['read', 'search', 'write', 'check', 'memory'])
    expect(catalog.groups.map((group) => group.id).sort()).toEqual(['browser', 'mcp:x'])
  })
})

describe('永远不可授予的宿主工具', () => {
  it('连接器管理工具不进入来源组目录，也不能被 tool:/grp: 授权', () => {
    const groups = discoverToolGroups([
      'mcp_connector_install_from_url',
      'mcp_connector_publish',
      'mcp__demo__ping',
      'bcdp_status',
    ])
    expect(groups.flatMap((group) => group.tools)).toEqual(['bcdp_status', 'mcp__demo__ping'])
    expect(hostToolGranted('mcp_connector_publish', ['grp:ext:other'])).toBe(false)
    expect(hostToolGranted('mcp_connector_publish', ['tool:mcp_connector_publish'])).toBe(false)
    expect(effectiveHostTools(['mcp_connector_publish', 'send_message'], ['grp:ext:other'])).toEqual(['send_message'])
    expect(personaHostToolDenial('mcp_connector_publish', ['grp:ext:other'])).toMatch(/连接器管理/)
  })
})

describe('授权条目解析与兼容', () => {
  it('旧 browser/image 迁移成 grp:，grp:/tool: 保留，非法条目丢弃', () => {
    expect(normalizeToolAllow(['read', 'browser', 'image'])).toEqual(['read', 'grp:browser', 'grp:image'])
    expect(normalizeToolAllow(['grp:mcp:github', 'tool:mcp__x__y', 'read'])).toEqual(['grp:mcp:github', 'tool:mcp__x__y', 'read'])
    expect(normalizeToolAllow(['read', 'shell', 'grp:', 'tool:', 42, 'read'])).toEqual(['read'])
    expect(normalizeToolAllow(undefined)).toBeUndefined()
  })

  it('旧 toolDeny 换算成 toolAllow', () => {
    expect(normalizeToolAllow(undefined, ['browser', 'image'])).toEqual(['read', 'search', 'write', 'check', 'memory'])
  })

  it('parseGrant 拒绝空值与非法工具名', () => {
    expect(parseGrant('grp:')).toBeNull()
    expect(parseGrant('tool:')).toBeNull()
    expect(parseGrant('tool:bad name')).toBeNull()
    expect(parseGrant('bcdp_status')).toBeNull()
    expect(parseGrant('grp:mcp:github')).toEqual({ kind: 'group', value: 'mcp:github' })
  })
})

describe('生效判定：组 / 单工具 / 插件能力', () => {
  const host = ['bcdp_status', 'bcdp_click', 'mcp__github__create_issue', 'mcp__github__search', 'send_message', 'bash']

  it('整组授予包含组内新增工具；单工具只授予自己', () => {
    expect(effectiveHostTools(host, ['grp:mcp:github'])).toEqual(['mcp__github__create_issue', 'mcp__github__search'])
    expect(effectiveHostTools(host, ['tool:mcp__github__search'])).toEqual(['mcp__github__search'])
    expect(effectiveHostTools(host, ['grp:browser'])).toEqual(['bcdp_click', 'bcdp_status'])
    expect(effectiveHostTools(host, ['read'])).toEqual([])
    expect(effectiveHostTools(host, undefined)).toEqual([])
  })

  it('旧 browser id 仍然生效（读入即可用）', () => {
    expect(hostToolGranted('bcdp_status', ['browser'])).toBe(true)
    expect(hostToolGranted('mcp__magpie-image__generate_image', ['image'])).toBe(true)
    expect(hostToolGranted('bcdp_status', ['grp:image'])).toBe(false)
  })

  it('插件工具按能力判定；能力未授予时守卫给出清晰拒绝', () => {
    expect(pluginToolGranted('read_file', ['read'])).toBe(true)
    expect(pluginToolGranted('read_file', ['search'])).toBe(false)
    expect(pluginToolGranted('list_dir', ['search'])).toBe(true)
    expect(pluginToolGranted('write_file', undefined)).toBe(true)
    expect(personaHostToolDenial('send_message', ['read'])).toMatch(/没有授予/)
    expect(personaHostToolDenial('send_message', ['grp:other'])).toMatch(/没有授予/)
    expect(personaHostToolDenial('mcp_connector_install', ['grp:ext:other'])).toMatch(/连接器管理/)
    expect(personaHostToolDenial('mcp__github__search', ['tool:mcp__github__search'])).toBeUndefined()
  })

  it('授权标签可读', () => {
    const catalog = toolGroupCatalog(['bcdp_status', 'mcp__github__x'])
    expect(labelForGrant('grp:mcp:github', catalog)).toBe('MCP：github')
    expect(labelForGrant('grp:browser', catalog)).toBe('浏览器（bcdp）')
    expect(labelForGrant('read', catalog)).toBe('读文件')
    expect(labelForGrant('tool:mcp__github__x', catalog)).toBe('工具 mcp__github__x')
  })
})

function sessionsFactory(options: {
  hostNames?: string[]
  hasRegister?: boolean
  hasGuard?: boolean
  reply?: string
} = {}) {
  const hostNames = options.hostNames ?? ['bcdp_status', 'bcdp_click', 'bash', 'send_message']
  const registered: string[] = []
  const restricts: { allow?: string[]; deny?: string[] }[] = []
  const guards: Array<(exec: { name?: string }) => string | undefined> = []
  const created: string[] = []
  const disposed: string[] = []
  const followups: string[] = []
  const agents: NativeAgentsApi = {
    async create(input) {
      const messages: NativeMessage[] = []
      const agent = {
        followup(message: { content: { text?: string }[] }) {
          followups.push(message.content.map((block) => block.text ?? '').join(''))
          messages.push({ role: 'user', content: message.content })
          messages.push({ role: 'assistant', content: [{ type: 'text', text: options.reply ?? '回复' }] })
        },
        async whenIdle() {},
        session: { id: input.sessionId, deriveMessages: () => messages },
      } as NativeAgent
      const ctx = {
        get(name: string) {
          if (name === 'systemPrompt') return { section() { return () => undefined } }
          if (name === 'tools') {
            return {
              schemas: () => hostNames.map((tool) => ({ name: tool })),
              restrict(filter: { allow?: string[]; deny?: string[] }) { restricts.push(filter) },
              guard(fn: (exec: { name?: string }) => string | undefined) { guards.push(fn) },
              ...(options.hasRegister === false ? {} : {
                async register(definition: { name: string }) {
                  registered.push(definition.name)
                  return () => undefined
                },
              }),
            }
          }
          return undefined
        },
        on() {},
      }
      if (input.setup) await input.setup(ctx, agent)
      created.push(input.sessionId)
      return { agent, async dispose() { disposed.push(input.sessionId) } }
    },
  }
  return { agents, registered, restricts, guards, created, disposed, followups, hostNames }
}

const baseInput = {
  sessionKey: 'p1:t1',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  system: '你是实测甲',
  prompt: '看下',
}

function cloneHostProbe(field: ReturnType<typeof sessionsFactory>) {
  return () => ({
    register: () => undefined,
    guard: () => undefined,
    restrict: () => undefined,
    schemas: () => field.hostNames.map((name) => ({ name })),
  })
}

describe('原生会话按授权组收窄 + 授权变更重建', () => {
  it('整组授予保留组内工具，其余宿主工具 restrict deny', async () => {
    const fake = sessionsFactory()
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async () => 'ok',
      hostTools: cloneHostProbe(fake),
    })
    await sessions.complete({ ...baseInput, toolAllow: ['read', 'grp:browser'] })
    const deny = fake.restricts[0]?.deny ?? []
    expect(deny).toContain('bash')
    expect(deny).toContain('send_message')
    expect(deny).not.toContain('bcdp_status')
    expect(deny).not.toContain('bcdp_click')
    const guard = fake.guards[0]
    expect(guard({ name: 'bcdp_status' })).toBeUndefined()
    expect(guard({ name: 'bash' })).toMatch(/没有授予/)
  })

  it('授权变化（新增组）→ 下一轮重建会话并重新计算可见性', async () => {
    const fake = sessionsFactory()
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async () => 'ok',
      hostTools: cloneHostProbe(fake),
    })
    await sessions.complete({ ...baseInput, toolAllow: ['read'] })
    expect(fake.created).toHaveLength(1)
    expect(fake.restricts[0]?.deny).toContain('bcdp_status')

    await sessions.complete({ ...baseInput, prompt: '再看', toolAllow: ['read', 'grp:browser'] })
    expect(fake.disposed).toHaveLength(1)
    expect(fake.created).toHaveLength(2)
    const guard = fake.guards.at(-1)
    expect(guard?.({ name: 'bcdp_status' })).toBeUndefined()
    expect(fake.restricts.at(-1)?.deny).not.toContain('bcdp_status')
  })

  it('组内新增工具会让签名变化，下一轮重建（组授权包含未来工具）', async () => {
    const fake = sessionsFactory({ hostNames: ['bcdp_status', 'bash'] })
    const sessions = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async () => 'ok',
      hostTools: cloneHostProbe(fake),
    })
    await sessions.complete({ ...baseInput, toolAllow: ['read', 'grp:browser'] })
    expect(fake.created).toHaveLength(1)
    fake.hostNames.push('bcdp_new_tool')
    await sessions.complete({ ...baseInput, prompt: '继续', toolAllow: ['read', 'grp:browser'] })
    expect(fake.created).toHaveLength(2)
    expect(fake.restricts.at(-1)?.deny).not.toContain('bcdp_new_tool')
  })

  it('宿主缺 register/guard 时整体不可用（诚实回退，不半残运行）', () => {
    const fake = sessionsFactory({ hasRegister: false })
    const noRegister = new NativeAgentSessions({
      agents: () => fake.agents,
      executeTool: async () => 'ok',
      // 探测面如实反映宿主：没有 register。
      hostTools: () => ({ guard: () => undefined, schemas: () => [] }),
    })
    expect(noRegister.status().enabled).toBe(false)
    expect(noRegister.status().reason).toMatch(/register|守卫/)
    const fake2 = sessionsFactory()
    const noGuard = new NativeAgentSessions({
      agents: () => fake2.agents,
      executeTool: async () => 'ok',
      hostTools: () => ({ register: () => undefined, schemas: () => [] }),
    })
    expect(noGuard.status().enabled).toBe(false)
    expect(noGuard.status().reason).toMatch(/register|守卫/)
  })

  it('宿主齐全时 status 上报能力与来源组数量', () => {
    const fake = sessionsFactory()
    const sessions = new NativeAgentSessions({ agents: () => fake.agents, executeTool: async () => 'ok', hostTools: cloneHostProbe(fake) })
    const status = sessions.status()
    expect(status.enabled).toBe(true)
    expect(status.capabilities).toEqual({ read: true, search: true, write: true, check: true })
    expect(status.hostToolGroups).toBeGreaterThan(0)
  })
})
