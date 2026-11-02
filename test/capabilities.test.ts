/**
 * 宿主能力探测（Phase 0）回归。
 *
 * 目的：tokenizer / usage / embeddings 三个"隐藏前置条件"必须先探测，
 * 否则 Phase 1 会承诺宿主没给的能力（和 embedding 一样的坑）。
 */
import { describe, expect, it } from 'vitest'
import { detectHostCapabilities, summarizeCapabilities, usageKeysInChunk } from '../src/host/capabilities.ts'

const BASE_LLM = {
  listProviders: () => [],
  listModels: async () => [],
  resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }),
  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

describe('宿主能力：形状探测', () => {
  it('只有基础服务时：tokenizer/embeddings 缺失，usage 仍是 unknown（没观测）', () => {
    const report = detectHostCapabilities(BASE_LLM)
    expect(report).toMatchObject({
      models: 'available',
      stream: 'available',
      contextWindow: 'available',
      tokenizer: 'absent',
      embeddings: 'absent',
      usage: 'unknown',
    })
    expect(report.summary).toContain('tokenizer=absent')
    expect(report.evidence.usage).toBeUndefined()
  })

  it('宿主暴露 tokenize / embed 时识别为可用，并留下证据', () => {
    const llm = { ...BASE_LLM, tokenize: () => [1], countTokens: () => 1, embed: async () => [0.1] }
    const report = detectHostCapabilities(llm)
    expect(report.tokenizer).toBe('available')
    expect(report.embeddings).toBe('available')
    expect(report.evidence.tokenizer).toEqual(expect.arrayContaining(['tokenize', 'countTokens']))
    expect(report.evidence.embeddings).toEqual(['embed'])
  })

  it('观测到 usage 字段才算 available；没观测过不能写成 absent', () => {
    const observed = detectHostCapabilities(BASE_LLM, { usageKeys: ['usage.promptTokens'] })
    expect(observed.usage).toBe('available')
    expect(observed.evidence.usage).toEqual(['usage.promptTokens'])
    expect(detectHostCapabilities(BASE_LLM).usage).toBe('unknown')
  })

  it('没有 llm 时全部 absent，不抛错', () => {
    const report = detectHostCapabilities(undefined)
    expect(report.models).toBe('absent')
    expect(report.tokenizer).toBe('absent')
    expect(report.usage).toBe('unknown')
  })

  it('summarizeCapabilities 输出一行结论', () => {
    const text = summarizeCapabilities(detectHostCapabilities(BASE_LLM))
    expect(text).toBe('models=available / stream=available / contextWindow=available / tokenizer=absent / usage=unknown / embeddings=absent')
  })
})

describe('宿主能力：usage 字段扫描', () => {
  it('识别 finish chunk 里的常用用量字段（含嵌套）', () => {
    expect(usageKeysInChunk({ type: 'finish', usage: { promptTokens: 12, completionTokens: 3 } })).toEqual([
      'usage.promptTokens',
      'usage.completionTokens',
    ])
    expect(usageKeysInChunk({ type: 'finish', reason: { kind: 'stop', usage: { totalTokens: 15 } } })).toContain('reason.usage.totalTokens')
    expect(usageKeysInChunk({ type: 'finish', meta: { input_tokens: 1 } })).toEqual(['meta.input_tokens'])
  })

  it('没有用量字段 / 非对象输入 → 空数组（不误判）', () => {
    expect(usageKeysInChunk({ type: 'text-delta', text: 'hi' })).toEqual([])
    expect(usageKeysInChunk(undefined)).toEqual([])
    expect(usageKeysInChunk('x')).toEqual([])
  })
})
