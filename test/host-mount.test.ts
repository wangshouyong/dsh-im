import { describe, expect, it } from 'vitest'
import { apply } from '../src/host/index.ts'

interface MountedRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

function fakeLlm() {
  return {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
    async listModels() {
      return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
    },
    async *stream() {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function fakeAgents() {
  return {
    async create() {
      return {
        agent: {
          followup() {},
          async whenIdle() {},
          session: { id: 's', deriveMessages: () => [{ role: 'assistant', content: 'hi' }] },
        },
        async dispose() {},
      }
    },
  }
}

function fakeTools() {
  return {
    register() {},
    guard() {},
    restrict() {},
    schemas() { return [] },
  }
}

function setupCtx(options: { agents?: boolean; forceOff?: boolean }) {
  const routes: MountedRoute[] = []
  let dispose: (() => void) | undefined
  let archiveCalls = 0
  const ctx = {
    effect(fn: () => (() => void) | void) {
      dispose = fn() as (() => void) | undefined
    },
    inject(_deps: string[], fn: (sub: Record<string, unknown>) => void) {
      fn({
        workspaceRegistry: {
          archiveSession: async () => { archiveCalls += 1 },
        },
        webServer: {
          register(row: MountedRoute) {
            routes.push(row)
            return () => undefined
          },
        },
        webRuntime: {},
      })
    },
    get(name: string) {
      if (name === 'llm') return fakeLlm()
      if (name === 'agents' && options.agents) return fakeAgents()
      if (name === 'tools') return fakeTools()
      return undefined
    },
    logger: { info() {}, warn() {} },
  }
  if (options.forceOff) process.env.DSH_IM_NATIVE_SESSION = '0'
  else delete process.env.DSH_IM_NATIVE_SESSION
  apply(ctx)
  return { routes, dispose: () => dispose?.(), archiveCalls: () => archiveCalls }
}

function fakeResponse() {
  const out = { status: 0, body: '' }
  return {
    set statusCode(value: number) { out.status = value },
    setHeader() {},
    end(body: string) { out.body = body },
    read: () => out,
  }
}

async function get(routes: MountedRoute[], url: string) {
  const route = routes[0]
  const res = fakeResponse()
  await route.handler({ url, method: 'GET', headers: { host: 'localhost' } }, res)
  return { status: res.read().status, body: JSON.parse(res.read().body) }
}

describe('host 挂载（/api/im 路由 + 原生 session 开关）', () => {
  it('默认有 agents 时 native-status 可用；DSH_IM_NATIVE_SESSION=0 整段关掉', async () => {
    const off = setupCtx({ forceOff: true, agents: true })
    const blocked = await get(off.routes, '/api/im/native-status')
    expect(blocked.body.reason).toContain('DSH_IM_NATIVE_SESSION=0')
    expect(blocked.body.enabled).toBe(false)

    const { routes } = setupCtx({})
    expect(routes[0].path).toBe('/api/im')
    const noAgents = await get(routes, '/api/im/native-status')
    expect(noAgents.body.enabled).toBe(false)
    expect(noAgents.body.reason).toContain('ctx.agents')
  })

  it('有 ctx.agents 且未强制关闭时 native-status=true；卸载会释放原生会话', async () => {
    const { routes, dispose } = setupCtx({ agents: true })
    const status = await get(routes, '/api/im/native-status')
    expect(status).toEqual({
      status: 200,
      body: {
        enabled: true,
        capabilities: { read: true, search: true, write: true, check: true },
        hostToolGroups: 0,
      },
    })
    expect(() => dispose()).not.toThrow()
    delete process.env.DSH_IM_NATIVE_SESSION
  })

  it('路由注册后 404 兜底与 403 跨站校验仍生效', async () => {
    const { routes } = setupCtx({})
    const route = routes[0]
    const forbidden = fakeResponse()
    await route.handler({ url: '/api/im/native-status', method: 'GET', headers: { host: 'a', origin: 'http://b' } }, forbidden)
    expect(forbidden.read().status).toBe(403)
    const missing = fakeResponse()
    await route.handler({ url: '/api/im/nope', method: 'GET', headers: { host: 'localhost' } }, missing)
    expect(missing.read().status).toBe(404)
  })

  it('/api/im/roots 是可用的只读数据根体检（当前根必在列表里）', async () => {
    const { routes } = setupCtx({})
    const res = await get(routes, '/api/im/roots')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(0)
    const current = res.body[0]
    expect(typeof current.path).toBe('string')
    expect(current.path.length).toBeGreaterThan(0)
    // 只读体检字段齐全：面板失败页要靠这些字段告诉用户「哪个根里还有数据」。
    for (const key of ['registered', 'hasState', 'personas', 'threads', 'messages']) {
      expect(current).toHaveProperty(key)
    }
  })
})
