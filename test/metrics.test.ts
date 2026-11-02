import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { metricsPath, appendMetrics, readMetrics } from '../src/host/metrics-store.ts'
import { summarizeMetrics } from '../src/core/metrics.ts'
import { createImApi } from '../src/host/im-api.ts'
import { readReceipts } from '../src/host/receipt-store.ts'
import { loadState, saveState } from '../src/core/workspace-node.ts'
import type { SpeakRequest, SpeakResult, Speaker } from '../src/core/types.ts'

class ScriptedSpeaker implements Speaker {
  constructor(private readonly replies: SpeakResult[]) {}
  async complete(): Promise<SpeakResult> {
    return this.replies.shift() ?? { text: '默认回复' }
  }
}

function seed(im: ImService, root: string) {
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '',
    duties: ['需求'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const qa = im.createPersona({
    name: '测试',
    avatar: '测',
    personality: '',
    duties: ['可测性'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const group = im.createGroup('方案评审', [pm.id, qa.id], root)
  return { pm, qa, group }
}

describe('指标（客户端 → metrics.jsonl）', () => {
  it('每轮记录地板/摘要指标，saveState 落盘并清空待写队列', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-metrics-'))
    const im = new ImService(new ScriptedSpeaker([{ text: '产品观点' }, { text: '测试观点' }]))
    const { group } = seed(im, root)
    await im.sendUser(group.id, '开始评审')
    const pending = group.pendingMetrics ?? []
    expect(pending.some((entry) => entry.kind === 'floor_round')).toBe(true)
    expect(pending.some((entry) => entry.kind === 'summary')).toBe(true)
    const floorEntry = pending.find((entry) => entry.kind === 'floor_round')
    expect(floorEntry?.fields).toMatchObject({ speak: 2 })
    expect(floorEntry?.value).toBeGreaterThanOrEqual(2)

    await saveState(root, im.snapshot())
    const saved = await loadState(root)
    expect(saved?.threads[0].pendingMetrics).toBeUndefined()
    const metrics = await readMetrics(root, group.id)
    expect(metrics.map((entry) => entry.kind)).toContain('floor_round')
    expect(metrics.every((entry) => typeof entry.at === 'number')).toBe(true)
    const rollup = summarizeMetrics(metrics)
    expect(rollup.byKind.floor_round).toBe(1)
  })

  it('readMetrics 过滤坏行、按 kind 筛选、按 limit 截尾；appendMetrics 空数组不写文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-metrics-'))
    expect(await appendMetrics(root, 't1', [])).toBe(0)
    await appendMetrics(root, 't1', [
      { at: 1, kind: 'stale', value: 3, fields: { action: 'regenerate' } },
      { at: 2, kind: 'llm_call', value: 120, fields: { ok: true } },
    ])
    await appendFile(metricsPath(root, 't1'), 'not json\n{"bad":true}\n', 'utf8')
    await appendMetrics(root, 't1', [{ at: 3, kind: 'stale', value: 0, fields: { action: 'drop' } }])
    const stale = await readMetrics(root, 't1', { kind: 'stale' })
    expect(stale.map((entry) => entry.at)).toEqual([1, 3])
    const all = await readMetrics(root, 't1', { limit: 2 })
    expect(all.map((entry) => entry.at)).toEqual([2, 3])
    const missing = await readMetrics(root, 'nope')
    expect(missing).toEqual([])
  })
})

describe('模型调用指标（host /complete）', () => {
  function llmService(behavior: 'ok' | 'fail') {
    return {
      listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
      async listModels() {
        return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
      },
      async *stream() {
        if (behavior === 'fail') throw new Error('BOOM：模型挂了')
        yield { type: 'text-delta', text: '来自宿主模型' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }

  it('成功：记 llm_call（ok/耗时/窗口数/用途），outcome 照常写', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-metrics-'))
    const api = createImApi({ projectRoot: () => root, llm: () => llmService('ok') })
    const { text } = await api.complete({
      model: 'deepseek-account::deepseek-flash',
      system: '你是产品经理',
      messages: [{ role: 'user', content: '你好' }],
      threadId: 't1',
      personaId: 'p1',
      windowSeqs: [1, 2],
      summaryUntil: 0,
      factsVersion: 'facts-v1:abc',
      purpose: 'reply',
    })
    expect(text).toBe('来自宿主模型')
    const metrics = await readMetrics(root, 't1', { kind: 'llm_call' })
    expect(metrics).toHaveLength(1)
    expect(metrics[0].fields).toMatchObject({
      ok: true,
      purpose: 'reply',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      personaId: 'p1',
      windowCount: 2,
      factsVersion: 'facts-v1:abc',
    })
    expect(metrics[0].value).toBeGreaterThanOrEqual(0)
    const receipts = await readReceipts(root, 't1')
    expect(receipts[0].outcome?.finish).toBe('stop')
  })

  it('失败：记 llm_call(ok:false,error)，outcome=error，错误照常抛给客户端', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-metrics-'))
    const api = createImApi({ projectRoot: () => root, llm: () => llmService('fail') })
    await expect(api.complete({
      model: 'deepseek-account::deepseek-flash',
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      threadId: 't1',
      personaId: 'p1',
      purpose: 'extract',
    })).rejects.toThrow(/BOOM/)
    const metrics = await readMetrics(root, 't1', { kind: 'llm_call' })
    expect(metrics[0].fields).toMatchObject({ ok: false, purpose: 'extract' })
    expect(String(metrics[0].fields?.error)).toContain('BOOM')
    const receipts = await readReceipts(root, 't1')
    expect(receipts[0].outcome?.finish).toBe('error')
  })
})
