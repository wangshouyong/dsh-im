/**
 * L1/L2/L3 三层回归。
 *
 * L1 计量正确性：构成/先验/判据/去重；L2 影子校准：中位数+容差+收缩+门槛；
 * L3 预算：token 档位、粘滞窗口。
 *
 * 注：成本估算 / 日帽降级（`estimateCost` / `degradeForCost`）已按 2026-11-02 用户裁决删除
 * （native 通道无 usage，DSH 原生无用量账本），对应测试用例随之移除；不是改测试迁就实现。
 */
import { describe, expect, it } from 'vitest'
import {
  RATIO_MAX,
  bucketKey,
  buildSample,
  cacheSemanticsFor,
  classifyComposition,
  dedupeSamples,
  priorRatio,
  sampleRatio,
  validateSample,
  type CalibrationSampleRecord,
} from '../src/core/calibration-samples.ts'
import { buildCalibrationReport, decideBucket, median } from '../src/core/calibrator.ts'
import {
  BUDGET_TIERS,
  DEFAULT_RATIO,
  planBudget,
  resolveTier,
} from '../src/core/budget-plan.ts'

const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
function sample(overrides: Partial<CalibrationSampleRecord> = {}): CalibrationSampleRecord {
  return buildSample({
    at: overrides.at ?? 1,
    provider: overrides.provider ?? 'deepseek-official',
    model: overrides.model ?? 'deepseek-flash',
    purpose: overrides.purpose ?? 'reply',
    transport: overrides.transport ?? 'ctx.llm',
    systemText: '你是测试角色',
    messageText: 'x'.repeat(150),
    toolCalls: overrides.toolCalls ?? 0,
    toolCount: overrides.toolCount ?? 0,
    usage: overrides.usage ?? USAGE,
    ...(overrides.cacheSemantics ? { cacheSemantics: overrides.cacheSemantics } : {}),
  })
}

describe('L1 计量正确性', () => {
  it('按内容构成给先验：代码 > 英文散文 > 中文', () => {
    expect(priorRatio(classifyComposition('中文中文中文中文'))).toBeCloseTo(1.8, 1)
    const code = priorRatio(classifyComposition('const x = 1;\n  return x;\nfunction f() {}'))
    const prose = priorRatio(classifyComposition('Hello world this is English prose text'))
    expect(code).toBeGreaterThan(prose)
    expect(prose).toBeGreaterThan(1.8)
  })

  it('ratio 方向写死：promptChars / inputTokens', () => {
    const s = sample()
    expect(sampleRatio(s)).toBeCloseTo(s.promptChars / 100, 6)
  })

  it('判据：native / 多轮 / 带工具 / 空 prompt 一律无效', () => {
    expect(validateSample(sample({ transport: 'native' }))).toBe('transport_native')
    expect(validateSample(sample({ toolCalls: 2 }))).toBe('multi_round')
    expect(validateSample(sample({ toolCount: 2 }))).toBe('has_tools')
    expect(validateSample({ ...sample(), promptChars: 0 })).toBe('empty_prompt')
  })

  it('判据：total = input + output（±1）；reasoning 是 output 子集，不能当第三项', () => {
    expect(validateSample(sample({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 152 } }))).toBe('token_mismatch')
    expect(validateSample(sample({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 19 } }))).toBeUndefined()
    expect(validateSample(sample({ usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, reasoningTokens: 40 } }))).toBe('token_mismatch')
  })

  it('缓存语义未知 → 判废；provider 适配表按前缀命中', () => {
    expect(cacheSemanticsFor('deepseek-official')).toBe('included')
    expect(cacheSemanticsFor('anthropic')).toBe('excluded')
    expect(cacheSemanticsFor('some-unknown')).toBe('unknown')
    expect(validateSample(sample({ cacheSemantics: 'unknown' }))).toBe('cache_semantics_unknown')
  })

  it('同一 prompt 只算一次（重试/重放不重复采样）', () => {
    const samples = [sample(), sample(), sample({ messageText: 'y'.repeat(150) } as never)]
    expect(dedupeSamples(samples)).toHaveLength(1)
  })

  it('桶键 = provider::model::purpose', () => {
    expect(bucketKey(sample())).toBe('deepseek-official::deepseek-flash::reply')
  })
})

describe('L2 影子校准器', () => {
  const validSamples = (count: number, ratio = 2.0): CalibrationSampleRecord[] => (
    Array.from({ length: count }, (_, index) => {
      const chars = Math.round(ratio * 100)
      const base = sample({ at: index, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } })
      return {
        ...base,
        promptChars: chars,
        promptHash: `h${index}`,
        composition: { cjkChars: chars, codeLikeChars: 0, asciiProseChars: 0, otherChars: 0 },
        valid: true,
      }
    })
  )

  it('样本不足 → default（影子不启用）', () => {
    const decision = decideBucket(validSamples(3))
    expect(decision.mode).toBe('default')
    expect(decision.shadowRatio).toBeUndefined()
    expect(decision.reasons.join()).toContain('insufficient')
  })

  it('n≥8 且稳定 → shadow，给出收缩后的 ratio；允许时才 calibrated', () => {
    const records = validSamples(10, 2.0)
    const shadow = decideBucket(records)
    expect(shadow.mode).toBe('shadow')
    expect(shadow.shadowRatio).toBeGreaterThan(0.6)
    expect(shadow.shadowRatio).toBeLessThan(RATIO_MAX)
    expect(decideBucket(records, { allowCalibrated: true }).mode).toBe('calibrated')
  })

  it('invalid 占比 >10% → 不启用', () => {
    const records = [...validSamples(8), sample({ transport: 'native' }), sample({ transport: 'native', at: 2 })]
    expect(decideBucket(records).mode).toBe('default')
  })

  it('离群值被绝对容差剔除（仍在合法区间内）', () => {
    const outlier = validSamples(1, 5.0)[0]
    const records = [...validSamples(8, 2.0), { ...outlier, at: 99, promptHash: 'outlier' }]
    const decision = decideBucket(records)
    expect(decision.keptSamples).toBe(8)
    expect(decision.medianRatio).toBeCloseTo(2.0, 1)
  })

  it('报告按桶分组、排序稳定', () => {
    const report = buildCalibrationReport([...validSamples(8), sample({ purpose: 'extract' })])
    expect(report.totals.samples).toBe(9)
    expect(report.buckets.map((bucket) => bucket.bucket)).toEqual([
      'deepseek-official::deepseek-flash::extract',
      'deepseek-official::deepseek-flash::reply',
    ])
    expect(median([1, 3, 2])).toBe(2)
  })
})

describe('L3 预算（影子）', () => {
  it('档位 token 预算 + 上下文比例夹取', () => {
    expect(BUDGET_TIERS.standard.tokens).toBe(150_000)
    const small = planBudget({ contextWindow: 8000, ratio: 1.5 })
    expect(small.clampedBy).toBe('context-share')
    expect(small.tokenBudget).toBe(2000)
    expect(small.shadow).toBe(true)
    expect(resolveTier('deep')).toBe('deep')
    expect(resolveTier('乱写')).toBe('standard')
  })

  it('没有系数用默认先验 1.6；粘滞窗口只在 on 生效', () => {
    const shadow = planBudget({ contextWindow: 200_000 })
    expect(shadow.ratio).toBe(DEFAULT_RATIO)
    const sticky = planBudget({ contextWindow: 200_000, mode: 'on', currentWindowChars: shadow.windowChars + 5000 })
    expect(sticky.windowChars).toBe(shadow.windowChars + 5000)
    expect(sticky.notes.join()).toContain('sticky-window')
  })
})
