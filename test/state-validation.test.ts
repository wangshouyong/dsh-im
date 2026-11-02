import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseState } from '../src/core/persist.ts'
import { createImApi } from '../src/host/im-api.ts'

describe('state.json 坏数据清洗', () => {
  it('丢弃坏条目、保留好条目、收敛老工具 id', () => {
    const raw = JSON.stringify({
      personas: [
        { id: 'p1', name: '淇淇', toolAllow: ['read', 'shell'] },
        { id: 'p2' },
        null,
        'x',
      ],
      threads: [{ id: 't1', title: '群' }, { id: 't2' }],
      memories: [{ id: 'm1', text: 'x' }, {}],
      wakeExcerpts: {},
    })
    const state = parseState(raw)
    expect(state.personas.map((p) => p.id)).toEqual(['p1'])
    expect(state.personas[0].toolAllow).toEqual(['read'])
    expect(state.threads.map((t) => t.id)).toEqual(['t1'])
    expect(state.memories.map((m) => m.id)).toEqual(['m1'])
  })

  it('round-trip：含 shell 的 state 经 putState 落盘后，读回只有当前能力', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-state-'))
    const llm = {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
      },
    }
    const api = createImApi({ projectRoot: () => root, llm: () => llm })
    const raw = JSON.stringify({
      personas: [{ id: 'p1', name: '淇淇', proactiveDm: true, toolAllow: ['read', 'shell', 'search'] }],
      threads: [],
      memories: [],
      wakeExcerpts: {},
    })
    await api.putState(raw, root)
    const state = await api.getState(root)
    expect(state?.personas[0].toolAllow).toEqual(['read', 'search'])
    expect(state?.personas[0].proactiveDm).toBe(true)
  })
})
