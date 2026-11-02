/**
 * 缺陷 1 + 缺陷 3：预算回执在 `ctx.llm` 与 native 两条路径都要落盘/透传。
 *
 * 缺陷 1：`/api/im/complete` 直调时请求里没有 `budget`，旧逻辑让多跳执行器退化为
 *         `budgetSource=fallback / budgetChars=600`。修复后 host 从 state + 成员模型窗口推导群级预算，
 *         执行器拿到真实 `budgetChars`；推导不到才 fallback（执行器显式标注）。
 * 缺陷 3：`/api/im/native-complete` 把 runtime 传来的 budget/budgetChanged/memoryContext 写进
 *         `receipts.jsonl`（与 ctx.llm 同结构）、`budgetChars` 透传到工具执行器、budgetChanged 落 metric；
 *         老客户端不带字段时回执不含 budget 但请求正常成功。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImApi } from '../src/host/im-api.ts'
import type { NativeFrame } from '../src/core/types.ts'
import { buildLongSessionFixture } from './fixtures/memory/long-session.ts'

const fixture = buildLongSessionFixture()
const THREAD_ID = fixture.thread.id
const PERSONA_ID = 'p-pm'
const MODEL = 'deepseek-official::deepseek-flash'

function toolCallChunk(id: string, name: string, args: unknown) {
  return { type: 'block-end', block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
}

/** 脚本化 llm：第 1 轮请求一次 memory_expand(question)，之后直接给文字。 */
function scriptedLlm(options: { contextWindow?: number; thinkCalls?: number } = {}) {
  let rounds = 0
  const streamCalls: unknown[] = []
  const llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'flash' }],
    resolveModelInfo: async () => (options.contextWindow === undefined
      ? undefined
      : { context: { contextWindow: options.contextWindow } }),
    async *stream(params: unknown) {
      streamCalls.push(params)
      rounds += 1
      const willCallTool = rounds <= (options.thinkCalls ?? 1)
      if (willCallTool) {
        const question = '补充 S-1 的口径详见哪条，按哪条执行？'
        yield toolCallChunk(`c${rounds}`, 'memory_expand', { question })
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'text-delta', text: '找到了：口径按 #8 执行。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { llm, streamCalls }
}

interface TempRoot { root: string }

async function makeRoot(options: { personaModel?: string | null } = {}): Promise<TempRoot> {
  const root = await mkdtemp(join(tmpdir(), 'dshim-receipt-'))
  const groupDir = join(root, '.dsh-im', 'groups', THREAD_ID)
  await mkdir(groupDir, { recursive: true })
  const personas = options.personaModel === null
    ? [{ id: PERSONA_ID, name: '产品经理' }]
    : [{ id: PERSONA_ID, name: '产品经理', model: options.personaModel ?? MODEL }]
  await writeFile(join(root, '.dsh-im', 'state.json'), JSON.stringify({
    personas,
    threads: [{
      id: THREAD_ID,
      title: fixture.thread.title,
      kind: 'group',
      memberIds: [PERSONA_ID],
      members: [{ personaId: PERSONA_ID, activity: 'review', completedRound: false, passedRound: false }],
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
  return { root }
}

async function readJsonLines(path: string): Promise<{ intent?: Record<string, unknown>; outcome?: Record<string, unknown> }[]> {
  const raw = await readFile(path, 'utf8').catch(() => '')
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function makeApi(root: string, llm: unknown, native?: unknown) {
  return createImApi({
    projectRoot: () => root,
    llm: () => llm as never,
    ...(native ? { native: () => native as never } : {}),
    rootsFile: () => join(root, 'known-roots.json'),
  })
}

const tempRoots: string[] = []
afterEach(async () => {
  // 校准样本是 fire-and-forget 异步写，可能在测试结束后才落盘：先让事件循环排空，再删除。
  await new Promise((resolve) => setTimeout(resolve, 30))
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

async function rootFor(options: { personaModel?: string | null } = {}): Promise<string> {
  const { root } = await makeRoot(options)
  tempRoots.push(root)
  return root
}

describe('缺陷 1：/api/im/complete 直调（不带 budget）也能拿到群级预算', () => {
  it('host 从 state + 模型窗口推导预算 → 多跳回执 budgetSource=budget，且写进回执/指标', async () => {
    const root = await rootFor()
    const { llm } = scriptedLlm({ contextWindow: 256_000 })
    const api = makeApi(root, llm)
    const result = await api.complete({
      model: MODEL,
      threadId: THREAD_ID,
      personaId: PERSONA_ID,
      projectRoot: root,
      toolAllow: ['memory'],
      purpose: 'reply',
      messages: [{ role: 'user', content: '不给 seq，先搜再展开：补充 S-1 的口径按哪条执行？' }],
    })
    expect(result.text).toContain('找到了')
    const trace = result.trace ?? []
    const toolStep = trace.find((step) => step.kind === 'tool' && step.name === 'memory_expand')
    expect(toolStep?.result ?? '').toContain('[展开回执]')
    expect(toolStep?.result ?? '').toContain('budgetSource=budget')
    expect(toolStep?.result ?? '').not.toContain('budgetSource=fallback')
    // 回执：intent 带推导出的 budget 快照（source=group、窗口 256k 群 = 64000 tokens）
    const receipts = await readJsonLines(join(root, '.dsh-im', 'groups', THREAD_ID, 'receipts.jsonl'))
    const intent = receipts.map((row) => row.intent).filter(Boolean).at(-1) as Record<string, unknown>
    const budget = intent.budget as Record<string, unknown>
    expect(budget?.source).toBe('group')
    expect(budget?.tokens).toBe(64_000)
    expect(budget?.windowChars).toBeGreaterThan(0)
    // 指标：memory_multihop 真实记录了 budgetSource=budget
    const metrics = await readJsonLines(join(root, '.dsh-im', 'groups', THREAD_ID, 'metrics.jsonl'))
    const multihop = metrics.filter((row) => (row as { kind?: string }).kind === 'memory_multihop').at(-1) as {
      fields?: Record<string, unknown>
    }
    expect(multihop?.fields?.budgetSource).toBe('budget')
    expect(Number(multihop?.fields?.hops)).toBeGreaterThanOrEqual(1)
    // 缺陷 2 观测：trace 最终 reply 步与 llm_call 指标都带 toolCalls / toolBudgetExhausted
    const replyStep = trace.filter((step) => step.kind === 'reply').at(-1)
    expect(replyStep?.toolCalls).toBe(1)
    expect(replyStep?.toolBudgetExhausted).toBe(false)
    const llmCall = metrics.filter((row) => (row as { kind?: string }).kind === 'llm_call').at(-1) as {
      fields?: Record<string, unknown>
    }
    expect(llmCall?.fields?.toolCalls).toBe(1)
    expect(llmCall?.fields?.toolExecuted).toBe(1)
    expect(llmCall?.fields?.toolCallLimit).toBe(12)
    expect(llmCall?.fields?.toolBudgetExhausted).toBe(false)
  })

  it('推导不到（没有模型窗口）时 fallback 保留显式标注（不静默）', async () => {
    const root = await rootFor()
    const { llm } = scriptedLlm({ contextWindow: undefined })
    const api = makeApi(root, llm)
    const result = await api.complete({
      model: MODEL,
      threadId: THREAD_ID,
      personaId: PERSONA_ID,
      projectRoot: root,
      toolAllow: ['memory'],
      purpose: 'reply',
      messages: [{ role: 'user', content: '查一下补充 S-1 的口径' }],
    })
    const toolStep = (result.trace ?? []).find((step) => step.kind === 'tool' && step.name === 'memory_expand')
    expect(toolStep?.result ?? '').toContain('budgetSource=fallback')
    expect(toolStep?.result ?? '').toContain('没有拿到群级预算')
  })

  it('请求显式带 budget 时优先用它（客户端路径不受影响）', async () => {
    const root = await rootFor()
    const { llm } = scriptedLlm({ contextWindow: 256_000 })
    const api = makeApi(root, llm)
    const result = await api.complete({
      model: MODEL,
      threadId: THREAD_ID,
      personaId: PERSONA_ID,
      projectRoot: root,
      toolAllow: ['memory'],
      purpose: 'reply',
      messages: [{ role: 'user', content: '查一下补充 S-1 的口径' }],
      budget: {
        version: 'context-budget-v1',
        source: 'group',
        tier: 'standard',
        tokens: 64_000,
        ratio: 1.6,
        windowChars: 72_695,
        summaryChars: 20_174,
        digestChars: 12_105,
        chapterChars: 8_069,
        memoryChars: 8_000,
        factsCount: 60,
        signature: 'explicit',
      },
    })
    const toolStep = (result.trace ?? []).find((step) => step.kind === 'tool' && step.name === 'memory_expand')
    expect(toolStep?.result ?? '').toContain('budgetSource=budget')
    const receipts = await readJsonLines(join(root, '.dsh-im', 'groups', THREAD_ID, 'receipts.jsonl'))
    const intent = receipts.map((row) => row.intent).filter(Boolean).at(-1) as { budget?: { windowChars: number } }
    expect(intent.budget?.windowChars).toBe(72_695)
  })
})

describe('缺陷 3：native-complete 回执/预算透传', () => {
  function fakeNative(captured: { input?: Record<string, unknown> }) {
    return {
      status: () => ({ enabled: true }),
      async complete(input: Record<string, unknown>) {
        captured.input = input
        return {
          text: '原生回复',
          trace: [{
            step: 1,
            kind: 'reply' as const,
            name: 'tool-budget',
            result: 'toolCalls=3 toolExecuted=2 toolCallLimit=12 toolBudgetExhausted=false',
            ok: true,
            at: Date.now(),
            toolCalls: 3,
            toolExecuted: 2,
            toolBudgetExhausted: false,
          }],
          toolStats: { toolCalls: 3, toolExecuted: 2, toolBudgetExhausted: false, toolCallLimit: 12 },
        }
      },
    }
  }

  const budget = {
    version: 'context-budget-v1',
    source: 'group' as const,
    tier: 'standard' as const,
    tokens: 64_000,
    ratio: 1.6,
    windowChars: 72_695,
    summaryChars: 20_174,
    digestChars: 12_105,
    chapterChars: 8_069,
    memoryChars: 8_000,
    factsCount: 60,
    signature: 'native-test',
  }
  const memoryContext = {
    version: 'memory-handles-v1',
    mode: 'on' as const,
    snippetSeqs: [],
    handleSeqs: [4],
    conclusionSeqs: [],
    segmentIds: [],
    segmentRefs: [4, 6],
    snippetChars: 0,
    directoryChars: 20,
    totalChars: 20,
    backpressure: [],
    coldZone: { chapterIds: [1], handleSeqs: [4, 6], chars: 20 },
  }

  it('带 budget/budgetChanged/memoryContext：回执同结构落盘、budgetChars 透传、budgetChanged 落 metric', async () => {
    const root = await rootFor()
    const captured: { input?: Record<string, unknown> } = {}
    const api = makeApi(root, scriptedLlm({ contextWindow: 256_000 }).llm, fakeNative(captured))
    const budgetChanged = {
      from: { tokens: 50_000, tier: 'economy' as const, windowChars: 40_000, summaryChars: 10_000 },
      to: { tokens: 64_000, tier: 'standard' as const, windowChars: 72_695, summaryChars: 20_174 },
      reason: 'tier' as const,
    }
    const result = await api.nativeComplete({
      sessionKey: `${PERSONA_ID}:${THREAD_ID}`,
      personaId: PERSONA_ID,
      model: MODEL,
      system: 'sys',
      prompt: 'p',
      projectRoot: root,
      threadId: THREAD_ID,
      windowSeqs: [1, 2],
      budget,
      budgetChanged,
      memoryContext,
      frame: { windowLines: [], currentLine: { seq: 3, kind: 'user', authorName: '你', text: '问题' } } as NativeFrame,
    })
    expect(result.text).toBe('原生回复')
    expect(result.toolStats?.toolCalls).toBe(3)
    // budgetChars 透传到工具执行器（agent-session 拿到 memoryBudgetChars）
    expect(captured.input?.memoryBudgetChars).toBe(72_695)
    // 回执：与 ctx.llm 同结构，含 budget/budgetChanged/memoryContext（coldZone/segmentRefs）
    const receipts = await readJsonLines(join(root, '.dsh-im', 'groups', THREAD_ID, 'receipts.jsonl'))
    const intent = receipts.map((row) => row.intent).filter(Boolean).at(-1) as Record<string, unknown>
    expect((intent.budget as { windowChars?: number })?.windowChars).toBe(72_695)
    expect((intent.budgetChanged as { reason?: string })?.reason).toBe('tier')
    expect((intent.memoryContext as { coldZone?: unknown })?.coldZone).toBeDefined()
    expect((intent.memoryContext as { segmentRefs?: number[] })?.segmentRefs).toEqual([4, 6])
    // budgetChanged → metric
    const metrics = await readJsonLines(join(root, '.dsh-im', 'groups', THREAD_ID, 'metrics.jsonl'))
    const changed = metrics.filter((row) => (row as { kind?: string }).kind === 'budget_changed').at(-1) as {
      fields?: Record<string, unknown>
    }
    expect(changed?.fields?.reason).toBe('tier')
    expect(changed?.fields?.transport).toBe('native')
    // llm_call metric 带工具统计
    const llmCall = metrics.filter((row) => (row as { kind?: string }).kind === 'llm_call').at(-1) as {
      fields?: Record<string, unknown>
    }
    expect(llmCall?.fields?.toolCalls).toBe(3)
    expect(llmCall?.fields?.toolBudgetExhausted).toBe(false)
  })

  it('老客户端不带字段：请求正常成功，回执不含 budget（照旧、不报错）', async () => {
    const root = await rootFor()
    const captured: { input?: Record<string, unknown> } = {}
    const api = makeApi(root, scriptedLlm({ contextWindow: 256_000 }).llm, fakeNative(captured))
    const result = await api.nativeComplete({
      sessionKey: `${PERSONA_ID}:${THREAD_ID}`,
      personaId: PERSONA_ID,
      model: MODEL,
      system: 'sys',
      prompt: 'p',
      projectRoot: root,
      threadId: THREAD_ID,
    })
    expect(result.text).toBe('原生回复')
    expect(captured.input?.memoryBudgetChars).toBeUndefined()
    const receipts = await readJsonLines(join(root, '.dsh-im', 'groups', THREAD_ID, 'receipts.jsonl'))
    const intent = receipts.map((row) => row.intent).filter(Boolean).at(-1) as Record<string, unknown>
    expect(intent.budget).toBeUndefined()
    expect(intent.budgetChanged).toBeUndefined()
    expect(intent.memoryContext).toBeUndefined()
  })
})
