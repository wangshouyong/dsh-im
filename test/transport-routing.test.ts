import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpNativeTransport } from '../src/client/httpStore.ts'

function stubFetch(calls: { url: string; body: any }[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

const base = {
  model: 'deepseek-flash',
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hello' }],
  threadId: 't1',
  personaId: 'p1',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('原生传输的路由：后台结构化调用不能进原生会话', () => {
  it('curate 走 /api/im/complete（普通模型调用），不走 native-complete', async () => {
    const calls: { url: string; body: any }[] = []
    stubFetch(calls)
    const text = await httpNativeTransport().complete({ ...base, purpose: 'curate' })
    expect(text).toBe('ok')
    expect(calls.map((call) => call.url)).toEqual(['/api/im/complete'])
    expect(calls[0].body.purpose).toBe('curate')
  })

  it('extract 走 /api/im/complete', async () => {
    const calls: { url: string; body: any }[] = []
    stubFetch(calls)
    await httpNativeTransport().complete({ ...base, purpose: 'extract' })
    expect(calls.map((call) => call.url)).toEqual(['/api/im/complete'])
  })

  it('reply 仍走原生会话', async () => {
    const calls: { url: string; body: any }[] = []
    stubFetch(calls)
    await httpNativeTransport().complete({ ...base, purpose: 'reply' })
    expect(calls.map((call) => call.url)).toEqual(['/api/im/native-complete'])
    expect(calls[0].body.sessionKey).toBe('p1:t1')
  })
})
