/**
 * 活体测试：真实 DSH 宿主 + 真实群流程 + 真实原生会话。
 *
 * 默认跳过；用 `DSH_IM_LIVE=http://127.0.0.1:19387 npx vitest run test/live-native-group.test.ts` 跑。
 * 覆盖：群消息 → 仲裁/地板 → BoundModelSpeaker → httpNativeTransport → /api/im/native-complete
 *      → 角色真实调用 read_file / write_file / run_check → 回执、指标、执行轨迹、原生会话复用。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ImService } from '../src/core/im.ts'
import { BoundModelSpeaker, defaultChair } from '../src/core/runtime.ts'
import type { Persona, Thread } from '../src/core/types.ts'
import { httpNativeTransport } from '../src/client/httpStore.ts'

const BASE = process.env.DSH_IM_LIVE?.trim()
const live = BASE ? describe : describe.skip
const ROOT = process.env.DSH_IM_LIVE_ROOT?.trim() || process.cwd()
/** 能力对齐报告：测试跑完把“每个能力是否真的生效”写成机器可读 JSON，而不是只有 exit code。 */
const REPORT_PATH = process.env.DSH_IM_LIVE_REPORT?.trim() || join(process.cwd(), 'native-e2e', 'capability.json')

const capability: Record<string, unknown> = {
  base: BASE ?? null,
  root: ROOT,
  runAt: new Date().toISOString(),
}

const originalFetch = globalThis.fetch

function nativeMetrics(threadId: string): { ok?: boolean; purpose?: string; ms?: number }[] {
  try {
    const raw = readFileSync(join(ROOT, '.dsh-im', 'groups', threadId, 'metrics.jsonl'), 'utf8')
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry?.kind === 'llm_call')
      .map((entry) => ({ ok: entry.fields?.ok, purpose: entry.fields?.purpose, ms: entry.value }))
  } catch {
    return []
  }
}

function lastPersonaMessage(thread: Thread): string {
  return thread.messages.filter((message) => message.kind === 'persona').at(-1)?.text ?? ''
}

async function nativeDebugSessions(): Promise<{ sessionKey?: string; roles?: string[]; lastText?: string }[]> {
  const res = await fetch(`${BASE}/api/im/native-debug`)
  const data = (await res.json()) as { sessions?: { sessionKey?: string; roles?: string[]; lastText?: string }[] }
  return data.sessions ?? []
}

function makeIm(): ImService {
  const speaker = new BoundModelSpeaker(httpNativeTransport(), {
    contextWindowFor: () => 128_000,
  })
  return new ImService(speaker, defaultChair())
}

function createPersona(im: ImService, name: string, toolAllow: string[]): Persona {
  return im.createPersona({
    name,
    avatar: name.slice(0, 1),
    personality: '只做被要求的事，需要证据就调工具。',
    duties: ['协作'],
    model: 'deepseek-account::deepseek-flash',
    provider: 'deepseek-account',
    toolAllow,
    proactiveDm: false,
    defaultActivity: 'high',
  })
}

live('真实宿主：群角色调用原生工具', () => {
  beforeAll(() => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string' && input.startsWith('/')) return originalFetch(`${BASE}${input}`, init)
      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    const transportOk = capability.nativeOk === true
    const aligned = capability.read === true
      && capability.write === true
      && capability.runCheck === true
      && capability.deniedTool === true
      && capability.dmPrivateChat === true
    const report = {
      ...capability,
      transportOk,
      aligned,
      verdict: transportOk && aligned ? 'PASS' : 'FAIL',
      note: 'transportOk 只代表 native 传输成功（旧报告的“PASS 只说明传输能通”）；aligned 才代表 read/write/run_check/越权拒绝四项能力真按契约生效。',
    }
    try {
      mkdirSync(dirname(REPORT_PATH), { recursive: true })
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
    } catch {
      // 报告写不出去不影响测试结论（报告路径可用 DSH_IM_LIVE_REPORT 覆盖）。
    }
  })

  it('群消息 → 角色用 read_file 真实读文件，回复进群、轨迹/指标/会话都落地', async () => {
    const im = makeIm()
    const persona = createPersona(im, '实测甲', ['read'])
    const group = im.createGroup('原生群-读', [persona.id], ROOT)

    await im.sendUser(group.id, '@实测甲 用 read_file 读 package.json，只回答 name 字段的值')
    const reply = lastPersonaMessage(group)
    expect(reply).toContain('dsh-im')

    const trace = group.traces?.at(-1)
    expect(trace?.personaId).toBe(persona.id)
    const readStep = trace?.steps.find((step) => step.name === 'read_file')
    expect(readStep?.ok).toBe(true)

    const native = nativeMetrics(group.id).filter((entry) => entry.purpose === 'native')
    expect(native.length).toBeGreaterThanOrEqual(1)
    expect(native.every((entry) => entry.ok === true)).toBe(true)
    capability.nativeOk = native.every((entry) => entry.ok === true)

    const sessions = await nativeDebugSessions()
    const session = sessions.find((item) => item.sessionKey === `${persona.id}:${group.id}`)
    expect(session).toBeTruthy()
    expect(session?.roles).toContain('assistant')
    expect(session?.lastText).toBeTruthy()
    capability.read = readStep?.ok === true
    capability.session = { roles: session?.roles ?? [], hasText: Boolean(session?.lastText) }
  }, 180_000)

  it('群消息 → 角色写群目录 + run_check，文件落在群目录、轨迹和指标都有', async () => {
    const im = makeIm()
    const persona = createPersona(im, '实测乙', ['write', 'check'])
    const group = im.createGroup('原生群-写测', [persona.id], ROOT)

    await im.sendUser(
      group.id,
      '@实测乙 先用 write_file 在群目录写 e2e-native.txt 内容 "native-ok"；再用 run_check、target=typecheck；一句话汇报结果。',
    )
    const trace = group.traces?.at(-1)
    const writeStep = trace?.steps.find((step) => step.name === 'write_file')
    const checkStep = trace?.steps.find((step) => step.name === 'run_check')
    expect(writeStep?.ok).toBe(true)
    expect(checkStep?.ok).toBe(true)
    const written = readFileSync(join(ROOT, '.dsh-im', 'groups', group.id, 'e2e-native.txt'), 'utf8')
    expect(written).toBe('native-ok')
    capability.write = writeStep?.ok === true
    capability.runCheck = checkStep?.ok === true
    capability.fileLanded = written === 'native-ok'

    const native = nativeMetrics(group.id).filter((entry) => entry.purpose === 'native')
    expect(native.some((entry) => entry.ok === true)).toBe(true)
  }, 240_000)

  it('未授权宿主工具在群角色里被拒，回复如实说明', async () => {
    const im = makeIm()
    const persona = createPersona(im, '实测丙', ['read'])
    const group = im.createGroup('原生群-拒绝', [persona.id], ROOT)

    await im.sendUser(group.id, '@实测丙 直接调用 team_task_list 工具（参数 {}），把工具返回原样贴出来。')
    const reply = lastPersonaMessage(group)
    const trace = group.traces?.at(-1)
    const denied = trace?.steps.find((step) => step.name === 'team_task_list')
    if (denied) expect(denied.ok).toBe(false)
    expect(/没有授予|不能使用|无法|拒绝/.test(reply)).toBe(true)
    capability.deniedTool = (denied ? denied.ok === false : true) && /没有授予|不能使用|无法|拒绝/.test(reply)
    capability.deniedReply = reply.slice(0, 120)
  }, 180_000)

  it('DM 小窗不再自我否认私聊能力：回复里没有“只能在群里/发不出去”', async () => {
    const im = makeIm()
    const persona = createPersona(im, '实测丁', ['read'])
    const group = im.createGroup('原生群-私聊', [persona.id], ROOT)

    await im.sendUser(group.id, '@实测丁 私聊我一下')
    const dm = im.state.threads.find((thread) => thread.kind === 'dm' && thread.memberIds[0] === persona.id)
    expect(dm).toBeTruthy()
    const reply = lastPersonaMessage(dm!)
    capability.dmReply = reply.slice(0, 160)
    expect(reply.trim().length).toBeGreaterThan(0)
    // 旧缺陷原话：“淇淇只能在群里跟你说话呀，私聊我这边是发不出去的哦”
    const denial = /只能在群里|发不出去|没有私聊|不能私聊|私聊不了/
    expect(denial.test(reply)).toBe(false)
    capability.dmPrivateChat = !denial.test(reply)
  }, 180_000)
})
