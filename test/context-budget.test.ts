/**
 * 群级上下文预算回归：按最小成员窗口压、确定性分配、余量回流、无窗口回退。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_BLOCK_SHARES,
  MAX_WINDOW_BLOCK_CHARS,
  MIN_MEMORY_BLOCK_CHARS,
  allocateContextBudget,
  groupContextBudget,
  groupContextTokens,
} from '../src/core/context-budget.ts'

const windows = (...values: number[]) => values.map((contextWindow, index) => ({
  personaId: `p${index}`,
  model: `m${index}`,
  contextWindow,
}))

describe('群级预算：按最小上下文压', () => {
  it('混合群取最小成员；1M 群按档位绝对上限', () => {
    const mixed = groupContextTokens(windows(256_000, 1_000_000))
    expect(mixed.clampedBy).toBe('member-window')
    expect(mixed.tokens).toBe(Math.floor(256_000 * 0.25)) // standard 份额 25%
    expect(mixed.smallest?.contextWindow).toBe(256_000)

    const big = groupContextTokens(windows(1_000_000, 1_000_000))
    expect(big.clampedBy).toBe('tier-cap')
    expect(big.tokens).toBe(150_000) // standard 绝对上限

    const unknown = groupContextTokens([])
    expect(unknown.knownWindows).toBe(0)
    expect(groupContextBudget([])).toBeUndefined()
  })

  it('档位可切；deep/economy 的份额与上限不同', () => {
    expect(groupContextTokens(windows(256_000), 'deep').tokens).toBe(Math.floor(256_000 * 0.4))
    expect(groupContextTokens(windows(1_000_000), 'economy').tokens).toBe(50_000)
    expect(groupContextTokens(windows(1_000_000), 'deep').tokens).toBe(320_000)
  })
})

describe('群级预算：四块分配确定性', () => {
  it('同一输入永远同一输出；四块都为正且窗口占比最大', () => {
    const first = allocateContextBudget(64_000)
    const second = allocateContextBudget(64_000)
    expect(first).toEqual(second)
    expect(first.windowChars).toBeGreaterThan(first.summaryChars)
    expect(first.summaryChars).toBeGreaterThan(0)
    expect(first.factsCount).toBeGreaterThanOrEqual(12)
    expect(first.memoryChars).toBeGreaterThanOrEqual(MIN_MEMORY_BLOCK_CHARS)
    expect(first.windowChars).toBeLessThanOrEqual(MAX_WINDOW_BLOCK_CHARS)
    // 各块字符预算（按 ratio 折算回 token）不超过总预算
    const totalTokens = (first.windowChars + first.summaryChars + first.memoryChars) / (first.ratio * 0.8)
    expect(totalTokens).toBeLessThanOrEqual(64_000 + first.memoryChars) // 记忆块有最小地板
    expect(CONTEXT_BLOCK_SHARES.window).toBeGreaterThan(CONTEXT_BLOCK_SHARES.summary)
  })

  it('记忆块吃不满 → 余量回流窗口', () => {
    const huge = allocateContextBudget(1_000_000)
    expect(huge.windowChars).toBe(MAX_WINDOW_BLOCK_CHARS)
    expect(huge.notes).toContain('memory-rollover-to-window')
  })

  it('小预算有保护地板，不会压成 0', () => {
    const tiny = allocateContextBudget(1_000)
    expect(tiny.windowChars).toBeGreaterThanOrEqual(4_000)
    expect(tiny.summaryChars).toBeGreaterThanOrEqual(2_000)
  })

  it('ratio 被夹在 [0.6, 6]', () => {
    expect(allocateContextBudget(64_000, { ratio: 0.1 }).ratio).toBe(0.6)
    expect(allocateContextBudget(64_000, { ratio: 99 }).ratio).toBe(6)
  })

  it('groupContextBudget 把两段拼起来；256k 群 ≈ 5–12 万字符窗口', () => {
    const budget = groupContextBudget(windows(256_000, 500_000))
    expect(budget?.tokens).toBe(64_000)
    expect(budget?.windowChars).toBeGreaterThan(50_000)
    expect(budget?.windowChars).toBeLessThan(250_000)
  })
})
