/**
 * 缺陷 2：单轮工具调用失控（真机约 25 次工具 → 逼近 240s 超时）。
 *
 * 锁住的护栏：
 * 1. 单轮工具调用硬上限（默认 12，可配置）——超限不再执行，强制进入作答；
 * 2. 同一 query 重复 search 立即返回"已查过"提示（tool-cache 规范化 + 去重）；
 * 3. trace / 统计里记录 `toolCalls / toolExecuted / toolBudgetExhausted`。
 */
import { describe, expect, it } from 'vitest'
import { completeDshChat, type TurnToolStats } from '../src/host/dsh-llm.ts'
import {
  DEFAULT_TOOL_CALL_LIMIT,
  createToolCallBudget,
  toolCallLimitFromEnv,
} from '../src/host/tool-call-budget.ts'
import { createTurnToolCache, toolCallKey } from '../src/host/tool-cache.ts'
import type { TurnStepTrace } from '../src/core/types.ts'

function toolCallChunk(id: string, name: string, args: unknown) {
  return {
    type: 'block-end',
    block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) },
  }
}

/**
 * 脚本化 llm.stream：`tools` 存在时一直请求工具调用；被强制收尾（tools=undefined）时给文字。
 * 这样能精确验证"到上限后强制作答"。
 */
function scriptedLlm(call: (round: number, withTools: boolean) => { name: string; args: Record<string, unknown> } | null) {
  const rounds: { withTools: boolean }[] = []
  const llm = {
    async *stream(params: { tools?: unknown }) {
      const withTools = Array.isArray(params.tools) && params.tools.length > 0
      rounds.push({ withTools })
      const request = call(rounds.length - 1, withTools)
      if (request && withTools) {
        yield toolCallChunk(`c${rounds.length}`, request.name, request.args)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'text-delta', text: '基于已有信息作答：结论如下。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { llm, rounds }
}

async function runWithStats(input: {
  llm: { stream: unknown }
  maxToolCalls: number
  onTool: (name: string, args: Record<string, unknown>) => Promise<string>
  onStep?: (step: TurnStepTrace) => void
}): Promise<{ text: string; stats: TurnToolStats; steps: TurnStepTrace[] }> {
  const steps: TurnStepTrace[] = []
  let stats: TurnToolStats | undefined
  const text = await completeDshChat({
    llm: input.llm as never,
    provider: 'p',
    model: 'm',
    system: 'sys',
    messages: [{ role: 'user', content: '查一下' }],
    toolAllow: ['memory'],
    maxToolCalls: input.maxToolCalls,
    onTool: input.onTool,
    onStep: (step) => { steps.push(step); input.onStep?.(step) },
    onTurnStats: (value) => { stats = value },
  })
  if (!stats) throw new Error('缺少 onTurnStats 回调')
  return { text, stats, steps }
}

describe('工具调用预算（纯逻辑）', () => {
  it('默认 12；env 可调；非法值回退默认', () => {
    expect(DEFAULT_TOOL_CALL_LIMIT).toBe(12)
    expect(toolCallLimitFromEnv({})).toBe(12)
    expect(toolCallLimitFromEnv({ DSH_IM_MAX_TOOL_CALLS: '5' })).toBe(5)
    expect(toolCallLimitFromEnv({ DSH_IM_MAX_TOOL_CALLS: '0' })).toBe(12)
    expect(toolCallLimitFromEnv({ DSH_IM_MAX_TOOL_CALLS: 'abc' })).toBe(12)
  })

  it('到上限后拒绝执行并给出"直接作答"提示', () => {
    const budget = createToolCallBudget(2)
    expect(budget.tryReserve()).toEqual({ ok: true })
    expect(budget.tryReserve()).toEqual({ ok: true })
    const refused = budget.tryReserve()
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.message).toContain('已达上限（2 次）')
    expect(budget.used()).toBe(2)
    expect(budget.exhaustedMessage()).toContain('已强制停止调用工具')
  })
})

describe('单轮工具调用上限：超限强制作答', () => {
  it('模型一轮内一直要工具：执行次数 ≤ 上限，stats/trace 记录触顶', async () => {
    const { llm } = scriptedLlm((round) => ({ name: 'memory_search', args: { query: `q${round}` } }))
    let executed = 0
    const { text, stats, steps } = await runWithStats({
      llm,
      maxToolCalls: 3,
      onTool: async () => { executed += 1; return '句柄结果' },
    })
    expect(text).toContain('基于已有信息作答')
    expect(executed).toBe(3)
    expect(stats.toolCalls).toBe(3)
    expect(stats.toolExecuted).toBe(3)
    expect(stats.toolCallLimit).toBe(3)
    expect(stats.toolBudgetExhausted).toBe(true)
    // 被拒绝的第 4+ 次调用在 trace 里有明确提示，不是静默丢
    expect(steps.some((step) => step.kind === 'tool' && (step.result ?? '').includes('已达上限'))).toBe(true)
    // 最终 reply 步带统计字段，供回执/metrics 审计
    const reply = steps.filter((step) => step.kind === 'reply').at(-1)
    expect(reply).toMatchObject({ toolCalls: 3, toolBudgetExhausted: true })
  })

  it('未触顶时 exhausted=false，正常返回模型答案', async () => {
    const { llm } = scriptedLlm((round) => (round === 0 ? { name: 'memory_expand', args: { seqs: '1' } } : null))
    const { text, stats, steps } = await runWithStats({
      llm,
      maxToolCalls: 5,
      onTool: async () => '原文',
    })
    expect(text).toContain('基于已有信息作答')
    expect(stats.toolCalls).toBe(1)
    expect(stats.toolExecuted).toBe(1)
    expect(stats.toolBudgetExhausted).toBe(false)
    expect(steps.filter((step) => step.kind === 'tool')).toHaveLength(1)
    expect(stats.toolRounds).toBe(2)
  })
})

describe('重复调用抑制', () => {
  it('同一工具同参第 3 次起熔断（不重复执行），并强制收尾', async () => {
    const { llm } = scriptedLlm(() => ({ name: 'memory_search', args: { query: '同一个查询' } }))
    let executed = 0
    const { stats, steps } = await runWithStats({
      llm,
      maxToolCalls: 10,
      onTool: async () => { executed += 1; return '结果' },
    })
    expect(executed).toBe(2) // 第 1、2 次执行；第 3 次起熔断
    expect(stats.dedupedRepeats).toBeGreaterThanOrEqual(1)
    expect(stats.toolBudgetExhausted).toBe(false)
    expect(steps.some((step) => (step.result ?? '').includes('相同参数已经重复调用'))).toBe(true)
  })

  it('tool-cache：同一 query（含空白/大小写差异）第二次直接返回"已查过"提示', () => {
    const cache = createTurnToolCache()
    expect(cache.lookup('memory_search', { query: '灰度 回滚' })).toBeNull()
    expect(toolCallKey('memory_search', { query: '  灰度   回滚 ' })).toBe(toolCallKey('memory_search', { query: '灰度 回滚' }))
    cache.record('memory_search', { query: '灰度 回滚' }, '[#12] 句柄')
    const hit = cache.lookup('memory_search', { query: '灰度   回滚' })
    expect(hit?.hint).toContain('已查过')
    expect(cache.hits()).toBe(1)
    // memory_expand：seq 顺序/空白不同视为同一请求
    cache.record('memory_expand', { seqs: '12, 30' }, '原文')
    expect(cache.lookup('memory_expand', { seqs: '30,12' })?.hint).toContain('展开过同一批')
  })
})
