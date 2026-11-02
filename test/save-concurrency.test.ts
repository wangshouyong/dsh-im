/**
 * 并发落盘回归（2026-11-02 修复的守门用例）。
 *
 * 实机事故：并发 `saveState` 把同一批 `pendingMetrics` 追加多遍（`t_cf330bb5` 135 行里 72 行重复），
 * 根因是客户端 200ms 防抖 + `void persist()` 无互斥、host 侧 `saveState` 也不串行。
 * 这组用例锁住三件事：
 *   1. 同一批指标无论被提交几次，聚合结果都不重复（幂等 id 兜底）；
 *   2. 同一文件的行不会交错（写串行）；
 *   3. 同一根的两次落盘按调用顺序生效，且没有半截 state.json / 残留临时文件。
 */
import { appendFile, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { summarizeMetrics, metricFingerprint } from '../src/core/metrics.ts'
import { appendMetrics, metricsPath, readMetrics } from '../src/host/metrics-store.ts'
import { loadState, saveState } from '../src/core/workspace-node.ts'
import { setLogSink } from '../src/core/log.ts'
import type { MetricEntry, SpeakResult, Speaker } from '../src/core/types.ts'

class ScriptedSpeaker implements Speaker {
  constructor(private readonly replies: SpeakResult[]) {}
  async complete(): Promise<SpeakResult> {
    return this.replies.shift() ?? { text: '默认回复' }
  }
}

async function seedGroup(root: string) {
  const im = new ImService(new ScriptedSpeaker([{ text: '产品观点' }, { text: '测试观点' }]))
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
  await im.sendUser(group.id, '开始评审')
  return { im, group }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('并发 saveState：指标不重复、行不交错、落盘有序', () => {
  it('同一批 pendingMetrics 被两份快照并发提交 → 每个 id 只落一次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-concurrent-'))
    const { im, group } = await seedGroup(root)
    const pending = group.pendingMetrics ?? []
    expect(pending.length).toBeGreaterThan(0)
    // 每一条在创建时就应该带稳定指纹（不是落盘时才补）。
    expect(pending.every((entry) => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true)

    // 模拟两个并发 PUT：两份独立快照，各自带着同一批 pendingMetrics。
    const first = clone(im.snapshot())
    const second = clone(im.snapshot())
    expect(second.threads[0].pendingMetrics?.length).toBe(pending.length)

    await Promise.all([saveState(root, first), saveState(root, second)])

    const raw = (await readFile(metricsPath(root, group.id), 'utf8')).split(/\r?\n/).filter(Boolean)
    expect(raw.length).toBeGreaterThan(0)
    // 行本身不重复（写侧幂等），退一步也保证「按 id 聚合不重复」。
    expect(new Set(raw).size).toBe(raw.length)
    const uniqueIds = new Set(raw.map((line) => (JSON.parse(line) as MetricEntry).id))
    expect(uniqueIds.size).toBe(raw.length)
  })

  it('文件里已经混进历史重复行时，readMetrics / summarizeMetrics 按指纹去重', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-concurrent-'))
    const duplicated: MetricEntry = { at: 100, kind: 'floor_round', value: 2, fields: { speak: 2 } }
    const line = JSON.stringify(duplicated)
    await mkdir(dirname(metricsPath(root, 't-legacy')), { recursive: true })
    // 老数据没有 id：同一行写三遍（正是实机里 135 行/72 重复的形态）。
    await appendFile(metricsPath(root, 't-legacy'), `${line}\n${line}\n${line}\n`, 'utf8')
    expect(metricFingerprint(duplicated)).toMatch(/^m_[0-9a-f]{16}$/)

    const metrics = await readMetrics(root, 't-legacy')
    expect(metrics).toHaveLength(1)
    expect(summarizeMetrics(metrics).byKind.floor_round).toBe(1)
  })

  it('并发 appendMetrics 不产生半行：每行都是完整 JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-concurrent-'))
    const batches = Array.from({ length: 20 }, (_, index): MetricEntry[] => [
      { at: 1000 + index, kind: 'stale', value: index, fields: { action: 'annotate', note: `第${index}批` } },
      { at: 2000 + index, kind: 'summary', fields: { l1Chars: index } },
    ])
    await Promise.all(batches.map((batch) => appendMetrics(root, 't-race', batch)))
    const raw = (await readFile(metricsPath(root, 't-race'), 'utf8')).split(/\r?\n/).filter(Boolean)
    expect(raw).toHaveLength(40)
    for (const line of raw) expect(() => JSON.parse(line)).not.toThrow()
    expect((await readMetrics(root, 't-race')).length).toBe(40)
  })

  it('同一根的两次落盘按调用顺序生效：旧快照不会覆盖新快照', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-concurrent-'))
    const { im } = await seedGroup(root)
    const older = clone(im.snapshot())
    const newer = clone(im.snapshot())
    newer.threads[0].title = '新标题'
    newer.threads[0].messages.push({
      id: 'm-newer',
      threadId: newer.threads[0].id,
      kind: 'system',
      authorName: '系统',
      text: '后写的内容不能丢',
      createdAt: Date.now(),
    })
    // 先发起旧的、再发起新的：串行队列保证后者最后落盘。
    const firstSave = saveState(root, older)
    const secondSave = saveState(root, newer)
    await Promise.all([firstSave, secondSave])

    const saved = await loadState(root)
    expect(saved?.threads[0].title).toBe('新标题')
    expect(saved?.threads[0].messages.some((message) => message.id === 'm-newer')).toBe(true)
    // 原子写的临时文件不能留在数据目录里。
    const leftovers = (await readdir(join(root, '.dsh-im'))).filter((name) => name.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('派生数据落盘失败不再静默：返回 warnings，聊天记录照常保存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-concurrent-'))
    const { im } = await seedGroup(root)
    const state = clone(im.snapshot())
    // 非法 threadId 会让 event-store 的 groupDir 断言抛错，正好模拟「事件日志写不进去」。
    const broken = clone(state.threads[0])
    broken.id = '../evil'
    broken.messages = []
    broken.pendingMetrics = undefined
    state.threads.push(broken)

    const warnings: string[] = []
    setLogSink({ info: () => undefined, warn: (message) => warnings.push(message), debug: () => undefined })
    try {
      const result = await saveState(root, state)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('派生数据落盘失败')
      expect(warnings.length).toBeGreaterThan(0)
      expect(await loadState(root)).not.toBeNull()
    } finally {
      setLogSink(undefined)
    }
  })
})

describe('指标指纹', () => {
  it('同内容同 id、字段顺序不同也同 id；内容不同则不同 id', () => {
    const base = { kind: 'llm_call', at: 1700000000000, value: 120 }
    const a = metricFingerprint({ ...base, fields: { ok: true, purpose: 'reply' } })
    const b = metricFingerprint({ ...base, fields: { purpose: 'reply', ok: true } })
    const c = metricFingerprint({ ...base, value: 121, fields: { ok: true, purpose: 'reply' } })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('写入时补 id，重复提交只落一次', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-concurrent-'))
    const entry: MetricEntry = { at: 42, kind: 'extraction', value: 1, fields: { source: 'rule' } }
    expect(await appendMetrics(root, 't1', [entry])).toBe(1)
    // 同一条再提交两次：写侧按 id 直接跳过（不产生新行）。
    expect(await appendMetrics(root, 't1', [entry])).toBe(0)
    expect(await appendMetrics(root, 't1', [{ ...entry }])).toBe(0)
    const raw = (await readFile(metricsPath(root, 't1'), 'utf8')).split(/\r?\n/).filter(Boolean)
    expect(raw).toHaveLength(1)
    expect((JSON.parse(raw[0]) as MetricEntry).id).toBe(metricFingerprint(entry))
  })
})
