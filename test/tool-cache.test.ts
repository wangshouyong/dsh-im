import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTurnToolCache, toolCallKey } from '../src/host/tool-cache.ts'
import { createImApi } from '../src/host/im-api.ts'
import { readMetrics } from '../src/host/metrics-store.ts'
import type { LlmService } from '../src/host/dsh-llm.ts'

describe('单轮工具去重（同文件读取）', () => {
  it('同一文件不同写法归一化：./、反斜杠、Windows 大小写都算同一个', () => {
    const options = { caseInsensitive: true }
    expect(toolCallKey('read_file', { path: 'src/a.ts' }, options))
      .toBe(toolCallKey('read_file', { path: './src/a.ts' }, options))
    expect(toolCallKey('read_file', { path: 'src/a.ts' }, options))
      .toBe(toolCallKey('read_file', { path: 'src\\a.ts' }, options))
    expect(toolCallKey('read_file', { path: 'src/A.ts' }, options))
      .toBe(toolCallKey('read_file', { path: 'src/a.ts' }, options))
    expect(toolCallKey('read_file', { path: 'src/a.ts' }, options))
      .not.toBe(toolCallKey('read_file', { path: 'src/b.ts' }, options))
    // 大小写敏感平台上是两个 key
    expect(toolCallKey('read_file', { path: 'src/A.ts' }, { caseInsensitive: false }))
      .not.toBe(toolCallKey('read_file', { path: 'src/a.ts' }, { caseInsensitive: false }))
  })

  it('第一次放行、第二次给“已读过”提示；不同文件不误伤；写文件后作废', () => {
    const cache = createTurnToolCache()
    expect(cache.lookup('read_file', { path: 'src/a.ts' })).toBeNull()
    cache.record('read_file', { path: 'src/a.ts' }, '文件内容')
    const repeated = cache.lookup('read_file', { path: './src/a.ts' })
    expect(repeated?.repeated).toBe(true)
    expect(repeated?.hint).toContain('已经读过')
    expect(repeated?.hint).toContain('search_files')
    expect(cache.lookup('read_file', { path: 'src/b.ts' })).toBeNull()
    expect(cache.hits()).toBe(1)
    cache.invalidate()
    expect(cache.lookup('read_file', { path: 'src/a.ts' })).toBeNull()
    expect(cache.size()).toBe(0)
  })

  it('目录/搜索/检查各有自己的提示；失败结果不缓存（允许重试）', () => {
    const cache = createTurnToolCache()
    cache.record('list_dir', { path: '.' }, 'a.ts\nb.ts')
    expect(cache.lookup('list_dir', { path: './' })?.hint).toContain('列过目录')
    cache.record('search_files', { query: 'shell' }, 'hits')
    expect(cache.lookup('search_files', { query: '  shell ' })?.hint).toContain('搜过')
    cache.record('run_check', { target: 'test/x.test.ts' }, 'ok')
    expect(cache.lookup('run_check', { target: 'test/x.test.ts' })?.hint).toContain('跑过检查')
    // 失败不 record → 第二次仍是第一次
    expect(cache.lookup('read_file', { path: 'missing.ts' })).toBeNull()
  })

  it('条目上限：超过上限丢最旧的', () => {
    const cache = createTurnToolCache({ maxEntries: 2 })
    cache.record('read_file', { path: 'a.ts' }, 'a')
    cache.record('read_file', { path: 'b.ts' }, 'b')
    cache.record('read_file', { path: 'c.ts' }, 'c')
    expect(cache.size()).toBe(2)
    expect(cache.lookup('read_file', { path: 'a.ts' })).toBeNull()
    expect(cache.lookup('read_file', { path: 'c.ts' })?.repeated).toBe(true)
  })
})

describe('去重接进 /complete（真实 IM 调用路径）', () => {
  it('模型重复读同一文件：第二次不再读盘，指标里记 dedupedCalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-dedup-'))
    await writeFile(join(root, 'a.ts'), 'export const a = 1\n', 'utf8')
    let index = 0
    const llm: LlmService = {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
      },
      stream() {
        index += 1
        const callIndex = index
        async function* chunks() {
          if (callIndex === 1) {
            yield { type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          if (callIndex === 2) {
            yield { type: 'block-end', block: { type: 'tool-call', id: 'c2', name: 'read_file', arguments: '{"path":"./a.ts"}' } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          yield { type: 'text-delta', text: '看完文件了：有个缺陷' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
        return chunks()
      },
    }
    const api = createImApi({ projectRoot: () => root, llm: () => llm })
    const { text } = await api.complete({
      model: 'deepseek-account::deepseek-flash',
      system: '你是架构师',
      messages: [{ role: 'user', content: '看下 a.ts' }],
      toolAllow: ['read'],
      threadId: 't1',
      personaId: 'p1',
    })
    expect(text).toContain('有个缺陷')
    const metrics = await readMetrics(root, 't1', { kind: 'llm_call' })
    expect(metrics[0].fields).toMatchObject({ ok: true, dedupedCalls: 1 })
  })
})
