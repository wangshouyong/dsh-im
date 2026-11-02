/**
 * B-1 同轮多跳展开。
 *
 * 验收（硬门）：
 * - hop1 问题 → 章节目录 → 代表句柄 → expand；hop2 从展开原文里识别新的 #seq 再 expand；
 * - ≤2 跳/轮、每跳 ≤600 字、总展开 ≤ 预算 15%；触顶不静默丢（显式 `[缺口]`）；
 * - 回执/指标记录 `hops / expandChars / hopBudgetUsed`；预算缺失标 `budgetSource=fallback`；
 * - `memory_expand` 新参数可选、向后兼容（传 seqs 的旧调用不破）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MULTI_HOP_HOP_CHARS,
  MULTI_HOP_MAX_HOPS,
  multiHopBudget,
  multiHopDirectoryChars,
  planMultiHop,
  questionTerms,
  runMultiHop,
} from '../src/core/multi-hop.ts'
import { buildChapterTree } from '../src/core/chapter-tree.ts'
import { toolsForAllow } from '../src/core/tool-schema.ts'
import { runMemoryTool } from '../src/host/persona-tools.ts'
import { createTurnToolCache } from '../src/host/tool-cache.ts'
import { buildLongSessionFixture } from './fixtures/memory/long-session.ts'

const fixture = buildLongSessionFixture()
const textBySeq = new Map(fixture.thread.messages.map((message) => [message.seq, message.text]))
const claims = new Map(fixture.thread.claims.map((claim) => [claim.seq, {
  state: claim.state,
  ...(claim.successorSeq === undefined ? {} : { successorSeq: claim.successorSeq }),
}]))

function directoryFrom(messages: { seq: number; kind: 'user' | 'persona' | 'system'; authorName: string; text: string }[], summaryChars = 10_000) {
  return buildChapterTree({ messages, summaryChars, claims })
}

describe('多跳预算（≤2 跳 / 每跳 ≤600 字 / 总展开 ≤15%）', () => {
  it('有预算：total = min(2×600, 15%×budget)，source=budget', () => {
    const budget = multiHopBudget(72_695)
    expect(budget.maxHops).toBe(2)
    expect(budget.hopChars).toBe(MULTI_HOP_HOP_CHARS)
    expect(budget.totalChars).toBe(Math.min(MULTI_HOP_MAX_HOPS * MULTI_HOP_HOP_CHARS, Math.floor(72_695 * 0.15)))
    expect(budget.totalChars).toBe(1_200)
    expect(budget.source).toBe('budget')
    expect(budget.budgetChars).toBe(72_695)
  })

  it('预算很小：总展开跟着缩（仍受 15% 约束）', () => {
    const budget = multiHopBudget(2_000)
    expect(budget.totalChars).toBe(300)
    expect(budget.totalChars).toBeLessThanOrEqual(2_000 * 0.15)
  })

  it('预算缺失：fallback 保守额度 + budgetSource=fallback（不假装有预算）', () => {
    const budget = multiHopBudget(undefined)
    expect(budget.source).toBe('fallback')
    expect(budget.totalChars).toBe(Math.floor(4_000 * 0.15))
    expect(budget.budgetChars).toBeUndefined()
  })

  it('多跳工具内部目录预算 = 15%（夹在 [400,12000]），与展开预算同口径', () => {
    expect(multiHopDirectoryChars(72_695)).toBe(10_904)
    expect(multiHopDirectoryChars(1_000)).toBe(400)
    expect(multiHopDirectoryChars(1_000_000)).toBe(12_000)
    expect(multiHopDirectoryChars(undefined)).toBe(600)
  })
})

describe('hop1 规划：问题 → 章节目录 → 代表句柄', () => {
  const directory = directoryFrom(fixture.thread.messages.filter((message) => message.seq <= 200))

  it('中文 bigram + 英文/数字整词都进检索词，确定性排序', () => {
    const terms = questionTerms('补充 S-1 的「口径详见」按哪条执行？')
    expect(terms).toContain('口径')
    expect(terms).toContain('执行')
    expect(terms).toContain('s-1')
    expect(terms).toEqual([...terms].sort((left, right) => left.localeCompare(right)))
  })

  it('问题命中章节与代表句柄；最多 2 个句柄', () => {
    const plan = planMultiHop('补充 S-1 的口径详见哪条，按哪条执行？', directory)
    expect(plan.chapters.length).toBeGreaterThan(0)
    expect(plan.handles.length).toBeGreaterThan(0)
    expect(plan.handles.length).toBeLessThanOrEqual(2)
    // S-1 补充句（seq 12）是跳板
    expect(plan.handles).toContain(12)
  })

  it('问题里直接写 #seq 且目录里有该句柄时优先用它（复用既有寻址协议）', () => {
    const plan = planMultiHop('#8 这条是什么？', directory)
    expect(plan.handles[0]).toBe(8)
    expect(plan.notes.join('')).toContain('直接引用了目录句柄')
  })

  it('章节目录没命中关键词时返回空句柄 + 说明（不硬编造）', () => {
    const plan = planMultiHop('完全不相关的英文词 zebra spacecraft', directory)
    expect(plan.handles).toEqual([])
    expect(plan.notes.length).toBeGreaterThan(0)
  })
})

describe('runMultiHop：两跳 / 触顶 / 回执 / 确定性', () => {
  const messages = fixture.thread.messages.filter((message) => message.seq <= 200)
  const directory = directoryFrom(messages)
  const resolve = async (seq: number) => textBySeq.get(seq)

  it('hop1 命中跳板 + hop2 从原文 #seq 继续展开；回执字段齐全', async () => {
    const result = await runMultiHop({
      question: '补充 S-1 的口径详见哪条，按哪条执行？',
      directory,
      claims,
      budgetChars: 72_695,
      resolve,
    })
    const seqs = result.expanded.map((item) => item.seq)
    expect(seqs).toContain(12) // 跳板
    expect(seqs).toContain(8) // hop2 目标
    expect(result.receipt.hops).toBe(2)
    expect(result.receipt.maxHops).toBe(2)
    expect(result.receipt.budgetSource).toBe('budget')
    expect(result.receipt.expandChars).toBeGreaterThan(0)
    expect(result.receipt.hopBudgetUsed).toBeGreaterThan(0)
    expect(result.receipt.hopBudgetUsed).toBeLessThanOrEqual(1)
    expect(result.text).toContain('[展开回执]')
    expect(result.text).toContain(`hops=2`)
    expect(result.text).toContain('expandChars=')
    expect(result.text).toContain('hopBudgetUsed=')
    expect(result.text).toContain(`budgetSource=budget`)
    // 每跳展开 ≤600 字
    for (const item of result.expanded) expect(item.chars).toBeLessThanOrEqual(MULTI_HOP_HOP_CHARS)
  })

  it('只命中一跳时 hops=1（不伪造第二跳）', async () => {
    const result = await runMultiHop({
      question: 'D-2 这个决定里灰度先放多少流量？',
      directory,
      claims,
      budgetChars: 72_695,
      resolve,
    })
    expect(result.expanded.length).toBeGreaterThan(0)
    expect(result.receipt.hops).toBe(1)
    expect(result.text).toContain('hops=1')
  })

  it('总预算触顶：不静默丢，输出 [缺口] 并说明未展开的 seq', async () => {
    // 预算压到 300 字：总展开只有 45 字，hop1 第二句柄 / hop2 必然触顶。
    const result = await runMultiHop({
      question: '补充 S-1 的口径详见哪条，按哪条执行？',
      directory,
      claims,
      budgetChars: 300,
      resolve,
    })
    expect(result.receipt.budgetChars).toBe(60)
    expect(result.receipt.expandChars).toBeLessThanOrEqual(60)
    expect(result.gaps.length).toBeGreaterThan(0)
    expect(result.text).toContain('[缺口]')
    expect(result.receipt.gapCount).toBe(result.gaps.length)
  })

  it('resolve 缺失/不存在时不伪造原文，显式记录缺口', async () => {
    const result = await runMultiHop({
      question: '补充 S-1 的口径详见哪条，按哪条执行？',
      directory,
      claims,
      resolve: async () => undefined,
    })
    expect(result.expanded).toEqual([])
    expect(result.gaps.some((gap) => gap.includes('不存在或不可读'))).toBe(true)
    expect(result.text).not.toContain('[历史原文]')
  })

  it('预算缺失：budgetSource=fallback，正文里也标注（不静默）', async () => {
    const result = await runMultiHop({
      question: '补充 S-1 的口径详见哪条，按哪条执行？',
      directory,
      claims,
      resolve,
    })
    expect(result.receipt.budgetSource).toBe('fallback')
    expect(result.text).toContain('budgetSource=fallback')
    expect(result.text).toContain('没有拿到群级预算')
  })

  it('确定性：同一问题/目录/预算两次执行输出逐字相同', async () => {
    const run = () => runMultiHop({
      question: '补充 S-3 的口径详见哪条，按哪条执行？',
      directory,
      claims,
      budgetChars: 72_695,
      resolve,
    })
    const first = await run()
    const second = await run()
    expect(second.text).toBe(first.text)
    expect(second.receipt).toEqual(first.receipt)
  })
})

describe('host 执行接入：memory_expand 支持 question（两条传输共用执行器）', () => {
  const tempRoots: string[] = []
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function makeRoot(): Promise<{ root: string; threadId: string }> {
    const threadId = fixture.thread.id
    const root = await mkdtemp(join(tmpdir(), 'dshim-hop-'))
    tempRoots.push(root)
    const groupDir = join(root, '.dsh-im', 'groups', threadId)
    await mkdir(groupDir, { recursive: true })
    await writeFile(join(root, '.dsh-im', 'state.json'), JSON.stringify({
      personas: [{ id: 'p-pm', name: '产品经理' }],
      threads: [{
        id: threadId,
        title: fixture.thread.title,
        memberIds: ['p-pm'],
        members: [{ personaId: 'p-pm', activity: 'review', completedRound: false, passedRound: false }],
        messages: [],
        projectRoot: root,
      }],
      memories: [],
      wakeExcerpts: {},
      pendingRecall: null,
      lastProactiveAt: {},
    }), 'utf8')
    const lines = fixture.thread.messages.map((message) => JSON.stringify({
      schemaVersion: 1,
      seq: message.seq,
      id: `e${message.seq}`,
      at: message.at,
      kind: message.kind,
      actorName: message.authorName,
      text: message.text,
      producer: 'plugin',
    }))
    await writeFile(join(groupDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')
    return { root, threadId }
  }

  it('传 question → 真实展开原文 + 回执 + metrics 记录 hops/expandChars/hopBudgetUsed', async () => {
    const { root, threadId } = await makeRoot()
    const result = await runMemoryTool({
      name: 'memory_expand',
      args: { question: '补充 S-1 的口径详见哪条，按哪条执行？' },
      projectRoot: root,
      threadId,
      personaId: 'p-pm',
      budgetChars: 72_695,
      cache: createTurnToolCache(),
    })
    expect(result).toContain('[展开回执]')
    expect(result).toContain('hops=2')
    expect(result).toContain('budgetSource=budget')
    // 原文命中（跳板 + 第二跳目标）
    expect(result).toContain('补充 S-1：D-1 的口径详见 #8')
    expect(result).toContain('数字 N-1')
    const metrics = (await readFile(join(root, '.dsh-im', 'groups', threadId, 'metrics.jsonl'), 'utf8')).trim().split('\n')
    const entry = metrics.map((line) => JSON.parse(line)).find((row) => row.kind === 'memory_multihop')
    expect(entry).toBeDefined()
    expect(entry.fields.hops).toBe(2)
    expect(entry.fields.expandChars).toBeGreaterThan(0)
    expect(entry.fields.hopBudgetUsed).toBeGreaterThan(0)
    expect(entry.fields.budgetSource).toBe('budget')
  })

  it('旧调用向后兼容：只传 seqs 仍走原来的按句柄展开', async () => {
    const { root, threadId } = await makeRoot()
    const result = await runMemoryTool({
      name: 'memory_expand',
      args: { seqs: '8,12' },
      projectRoot: root,
      threadId,
      personaId: 'p-pm',
      cache: createTurnToolCache(),
    })
    expect(result).toContain('[历史原文')
    expect(result).toContain('#8')
    expect(result).toContain('#12')
    expect(result).not.toContain('[展开回执]')
  })

  it('没有 budgetChars 时多跳标注 fallback（不静默）', async () => {
    const { root, threadId } = await makeRoot()
    const result = await runMemoryTool({
      name: 'memory_expand',
      args: { question: '补充 S-1 的口径详见哪条，按哪条执行？' },
      projectRoot: root,
      threadId,
      personaId: 'p-pm',
      cache: createTurnToolCache(),
    })
    expect(result).toContain('budgetSource=fallback')
  })
})

describe('tool schema：新参数可选、旧调用不破', () => {
  it('memory_expand 的 seqs 不再是必填（question 与 seqs 二选一）', () => {
    const spec = toolsForAllow(['memory']).find((tool) => tool.name === 'memory_expand')
    expect(spec).toBeDefined()
    const properties = (spec?.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties).sort()).toEqual(['hops', 'question', 'seqs'])
    expect((spec?.parameters as { required?: string[] }).required).toBeUndefined()
    expect(spec?.description).toContain('多跳')
  })
})
