/**
 * 校准器（L2 · 影子模式）。
 *
 * 不出数就启用，而是先回答「如果按这桶样本启用，ratio 会是多少、预算会变成多少」。
 * 只有样本量、离散度、invalid 占比、漂移都过关，且调用方显式允许时，才进入 `calibrated`。
 *
 * 统计口径（与用户对齐）：
 * - 按 `provider::model::purpose` 分桶；只对 `purpose=reply` 校准（extract/curate 结构不同）；
 * - 滑动窗口（默认 60 条）+ 中位数，不用累计平均；
 * - 绝对容差 `|x − median| ≤ max(0.5·median, 0.8)`；
 * - n ≥ 8 才谈启用；invalid 占比 >10% 不启用；
 * - 收缩：`prior + (median − prior) × n/(n+K)`，样本越多越信实测；
 * - ratio 夹在 [0.6, 6]。
 */
import {
  RATIO_MAX,
  RATIO_MIN,
  bucketKey,
  priorRatio,
  sampleRatio,
  validateSample,
  type CalibrationSampleRecord,
} from './calibration-samples.ts'

export interface CalibratorConfig {
  windowSize: number
  minSamples: number
  toleranceAbsolute: number
  toleranceRelative: number
  shrinkageK: number
  maxInvalidShare: number
  /** 只有显式打开才允许进入 calibrated；默认 false（影子）。 */
  allowCalibrated: boolean
}

export const DEFAULT_CALIBRATOR_CONFIG: CalibratorConfig = {
  windowSize: 60,
  minSamples: 8,
  toleranceAbsolute: 0.8,
  toleranceRelative: 0.5,
  shrinkageK: 12,
  maxInvalidShare: 0.1,
  allowCalibrated: false,
}

export type CalibrationMode = 'default' | 'shadow' | 'calibrated' | 'fallback'

export interface BucketDecision {
  bucket: string
  /** 窗口内样本数（含去重后）。 */
  samples: number
  validSamples: number
  keptSamples: number
  invalidShare: number
  priorRatio: number
  medianRatio?: number
  shadowRatio?: number
  weight: number
  mode: CalibrationMode
  /** 收缩后是否被 [0.6,6] 夹住。 */
  wouldClamp: boolean
  reasons: string[]
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function clampRatio(value: number): { value: number; clamped: boolean } {
  const clamped = Math.min(RATIO_MAX, Math.max(RATIO_MIN, value))
  return { value: Math.round(clamped * 1000) / 1000, clamped: clamped !== value }
}

/** 对一个桶（同 provider::model::purpose）做影子决策。 */
export function decideBucket(
  records: readonly CalibrationSampleRecord[],
  config: Partial<CalibratorConfig> = {},
): BucketDecision {
  const cfg: CalibratorConfig = { ...DEFAULT_CALIBRATOR_CONFIG, ...config }
  const bucket = records.length ? bucketKey(records[0]) : 'unknown'
  const window = records.slice(-cfg.windowSize)
  const seen = new Set<string>()
  const samples = window.filter((sample) => {
    const key = sample.promptHash
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const reasons: string[] = []
  // 离线复算：不信任落盘时的 valid 字段。
  const valid = samples.filter((sample) => validateSample(sample) === undefined)
  const invalidShare = samples.length ? 1 - valid.length / samples.length : 1
  const prior = priorRatio(
    samples.length
      ? samples[samples.length - 1].composition
      : { cjkChars: 0, codeLikeChars: 0, asciiProseChars: 0, otherChars: 0 },
  )
  const ratios = valid
    .map((sample) => sampleRatio(sample))
    .filter((ratio): ratio is number => ratio !== undefined)
  const base: BucketDecision = {
    bucket,
    samples: samples.length,
    validSamples: valid.length,
    keptSamples: 0,
    invalidShare: Math.round(invalidShare * 1000) / 1000,
    priorRatio: prior,
    weight: 0,
    mode: 'default',
    wouldClamp: false,
    reasons,
  }

  if (samples.length < cfg.minSamples) {
    reasons.push(`insufficient-samples(${samples.length}/${cfg.minSamples})`)
    return base
  }
  if (invalidShare > cfg.maxInvalidShare) {
    reasons.push(`invalid-share(${Math.round(invalidShare * 100)}% > ${Math.round(cfg.maxInvalidShare * 100)}%)`)
    return base
  }
  const center = median(ratios)
  if (center === undefined) {
    reasons.push('no-valid-ratio')
    return base
  }
  const tolerance = Math.max(cfg.toleranceAbsolute, center * cfg.toleranceRelative)
  const kept = ratios.filter((ratio) => Math.abs(ratio - center) <= tolerance)
  if (kept.length < cfg.minSamples) {
    reasons.push(`no-stable-cluster(kept=${kept.length}/${cfg.minSamples})`)
    return { ...base, medianRatio: Math.round(center * 1000) / 1000, keptSamples: kept.length }
  }
  const weight = kept.length / (kept.length + cfg.shrinkageK)
  const shrunk = prior + (center - prior) * weight
  const clamped = clampRatio(shrunk)
  if (clamped.clamped) reasons.push('ratio-clamped')
  const mode: CalibrationMode = cfg.allowCalibrated ? 'calibrated' : 'shadow'
  if (mode === 'shadow') reasons.push('shadow-mode')
  return {
    ...base,
    keptSamples: kept.length,
    medianRatio: Math.round(center * 1000) / 1000,
    shadowRatio: clamped.value,
    weight: Math.round(weight * 1000) / 1000,
    mode,
    wouldClamp: clamped.clamped,
    reasons,
  }
}

export interface CalibrationReport {
  generatedAt: number
  totals: { samples: number; valid: number; invalid: number }
  buckets: BucketDecision[]
}

/** 全量报告：按桶分组后逐桶决策（排序稳定，便于 diff）。 */
export function buildCalibrationReport(
  records: readonly CalibrationSampleRecord[],
  config: Partial<CalibratorConfig> = {},
  now = Date.now(),
): CalibrationReport {
  const buckets = new Map<string, CalibrationSampleRecord[]>()
  for (const record of records) {
    const key = bucketKey(record)
    const list = buckets.get(key) ?? []
    list.push(record)
    buckets.set(key, list)
  }
  const decisions = [...buckets.keys()].sort().map((key) => decideBucket(buckets.get(key) ?? [], config))
  const valid = records.filter((record) => validateSample(record) === undefined).length
  return {
    generatedAt: now,
    totals: { samples: records.length, valid, invalid: records.length - valid },
    buckets: decisions,
  }
}
