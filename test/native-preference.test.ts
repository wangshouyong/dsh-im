import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NATIVE_PREF_KEY,
  loadToolGroups,
  nativePreference,
  setNativePreference,
  toolGroupsSnapshot,
} from '../src/client/httpStore.ts'

const original = {
  storage: (globalThis as { localStorage?: unknown }).localStorage,
  fetch: globalThis.fetch,
}

function stubStorage(map: Map<string, string>) {
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

describe('原生会话偏好（P2 默认开）', () => {
  let map: Map<string, string>

  beforeEach(() => {
    map = new Map()
    stubStorage(map)
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = original.storage
    globalThis.fetch = original.fetch
  })

  it('缺省开；显式 0 才关；1 打开', () => {
    expect(nativePreference()).toBe(true)
    setNativePreference(false)
    expect(map.get(NATIVE_PREF_KEY)).toBe('0')
    expect(nativePreference()).toBe(false)
    setNativePreference(true)
    expect(nativePreference()).toBe(true)
  })

  it('隐私模式（localStorage 抛错）也按默认开处理', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(nativePreference()).toBe(true)
  })
})

describe('动态工具目录', () => {
  afterEach(() => {
    globalThis.fetch = original.fetch
  })

  it('宿主返回的来源组会进入快照；失败时退回内置能力目录', async () => {
    expect(toolGroupsSnapshot().capabilities.map((capability) => capability.id)).toEqual(['read', 'search', 'write', 'check', 'memory'])
    expect(toolGroupsSnapshot().groups).toEqual([])

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        capabilities: [{ id: 'read', label: '读文件', tools: ['read_file'] }],
        groups: [{ id: 'mcp:github', label: 'MCP：github', kind: 'mcp', tools: ['mcp__github__x'] }],
      }),
    })) as unknown as typeof fetch
    const catalog = await loadToolGroups()
    expect(catalog.groups.map((group) => group.id)).toEqual(['mcp:github'])
    expect(toolGroupsSnapshot().groups.map((group) => group.id)).toEqual(['mcp:github'])

    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const fallback = await loadToolGroups()
    expect(fallback.groups.map((group) => group.id)).toEqual(['mcp:github'])
  })
})
