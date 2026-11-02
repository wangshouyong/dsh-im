/**
 * 校准样本（L1 · 计量正确性）。
 *
 * 原则：**先证明数据可信，再谈校准**。这里只做两件事：
 * 1. 把一次调用的「原始 usage + 我们自己的 prompt 口径（chars/构成/工具轮次/通道）」落成一条样本；
 * 2. 用可离线复算的判据给样本定 valid / invalidReason。
 *
 * 关键口径（2026-11-02 与用户对齐）：
 * - `totalTokens = input + output`（±1）；`reasoningTokens` 是 **output 的子集**，不是可加项；
 * - 只校准 `ctx.llm` 通道、`toolCalls = 0`、`purpose = reply` 的样本；
 * - `cachedTokens > 0` 不判废，但 `cacheSemantics` 未知（不知道 input 是否含缓存）→ 判废；
 * - `charsPerToken = promptChars / inputTokens`，方向写死，不再出现 token/char；
 * - promptChars 用 **code point** 计数（`[...text].length`），并拆 system/messages。
 */
import { stableHash } from './receipt.ts'

export const CALIBRATION_SAMPLE_SCHEMA = 1
/** 样本文件滚动上限（离线复算用，不参与运行时判断）。 */
export const MAX_CALIBRATION_SAMPLES = 500
/** chars/token 合理区间：中文~1.5–2、代码/日志~3.5–4.5、base64~1.3；只做兜底，不当内容判断。 */
export const RATIO_MIN = 0.6
export const RATIO_MAX = 6

export type InvalidReason =
  | 'usage_missing'
  | 'multi_round'
  | 'transport_native'
  | 'has_tools'
  | 'empty_prompt'
  | 'token_mismatch'
  | 'cache_semantics_unknown'

export type CacheSemantics = 'included' | 'excluded' | 'unknown'

export interface RawUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
}

/** prompt 的内容构成（按 code point 计数，四类互斥且和为 promptChars）。 */
export interface Composition {
  cjkChars: number
  codeLikeChars: number
  asciiProseChars: number
  otherChars: number
}

export interface CalibrationSampleRecord {
  schema: number
  at: number
  provider: string
  model: string
  purpose: string
  transport: 'ctx.llm' | 'native'
  toolCalls: number
  toolCount: number
  systemChars: number
  messageChars: number
  promptChars: number
  composition: Composition
  promptHash: string
  cacheSemantics: CacheSemantics
  usage: RawUsage
  valid: boolean
  invalidReason?: InvalidReason
}

/**
 * 各 provider 的 `inputTokens` 是否含缓存 token。
 * OpenAI 兼容的 `prompt_tokens` 通常**含** cached；Anthropic 的 `input_tokens` 通常**不含** cache_read。
 * 未知一律 `unknown` → 样本判废（宁可没样本，不要脏样本）。
 */
const CACHE_SEMANTICS_BY_PROVIDER: Record<string, CacheSemantics> = {
  'deepseek-account': 'included',
  'deepseek-official': 'included',
  magpie: 'included',
  anthropic: 'excluded',
  openai: 'included',
}

export function cacheSemanticsFor(provider: string): CacheSemantics {
  const key = provider.trim().toLowerCase()
  return CACHE_SEMANTICS_BY_PROVIDER[key] ?? CACHE_SEMANTICS_BY_PROVIDER[key.split(/[-_]/)[0]] ?? 'unknown'
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/
const CODE_LINE = [
  /^\s{2,}\S/,
  /[{};]\s*$/,
  /\b(const|let|var|function|return|class|import|export|if|for|while|await|async)\b/,
  /=>|==={0,1}|!==?|&&|\|\|/,
  /^\s*(diff --git|@@|\+\+\+|---)/,
  /^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/,
  /\b(expect|assert|test|describe|it)\(/,
  /^\s*[-*]\s*\[/,
]

function isCodeLine(line: string): boolean {
  return CODE_LINE.some((pattern) => pattern.test(line))
}

/** 确定性内容构成：逐行先判"代码行"（整行算代码），否则逐字符分类。 */
export function classifyComposition(text: string): Composition {
  const composition: Composition = { cjkChars: 0, codeLikeChars: 0, asciiProseChars: 0, otherChars: 0 }
  for (const line of text.split('\n')) {
    if (isCodeLine(line)) {
      composition.codeLikeChars += [...line].length
      continue
    }
    for (const char of line) {
      if (CJK.test(char)) composition.cjkChars += 1
      else if (/[A-Za-z0-9 .,;:!?'"()[\]{}<>/\\|@#$%^&*_+=~`-]/.test(char)) composition.asciiProseChars += 1
      else composition.otherChars += 1
    }
    // 换行符本身不计入（与 promptChars 的 join 口径一致）
  }
  return composition
}

export interface BuildSampleInput {
  at: number
  provider: string
  model: string
  purpose: string
  transport: 'ctx.llm' | 'native'
  systemText: string
  messageText: string
  toolCalls: number
  toolCount: number
  usage: RawUsage
  cacheSemantics?: CacheSemantics
}

/** 由一次调用的观察值构造样本（不判断 valid；判断在 validateSample）。 */
export function buildSample(input: BuildSampleInput): CalibrationSampleRecord {
  const systemText = input.systemText ?? ''
  const messageText = input.messageText ?? ''
  const promptText = `${systemText}\n${messageText}`
  const sample: CalibrationSampleRecord = {
    schema: CALIBRATION_SAMPLE_SCHEMA,
    at: input.at,
    provider: input.provider,
    model: input.model,
    purpose: input.purpose,
    transport: input.transport,
    toolCalls: Math.max(0, Math.floor(input.toolCalls)),
    toolCount: Math.max(0, Math.floor(input.toolCount)),
    systemChars: [...systemText].length,
    messageChars: [...messageText].length,
    promptChars: [...promptText].length,
    composition: classifyComposition(promptText),
    promptHash: stableHash(`${input.provider}|${input.model}|${systemText}|${messageText}`).split(':').at(-1) ?? '',
    cacheSemantics: input.cacheSemantics ?? cacheSemanticsFor(input.provider),
    usage: { ...input.usage },
    valid: false,
  }
  const reason = validateSample(sample, { skipRatioRange: true })
  sample.valid = reason === undefined
  if (reason) sample.invalidReason = reason
  return sample
}

/** 判据：返回 undefined = 有效；否则返回第一个不满足的原因（顺序即优先级）。 */
export function validateSample(
  sample: Pick<CalibrationSampleRecord, 'transport' | 'toolCalls' | 'toolCount' | 'promptChars' | 'cacheSemantics' | 'usage'>,
  options: { skipRatioRange?: boolean } = {},
): InvalidReason | undefined {
  if (sample.promptChars <= 0) return 'empty_prompt'
  if (sample.transport === 'native') return 'transport_native'
  if (sample.toolCalls > 0) return 'multi_round'
  // 带工具的样本只做成本观测：工具 schema 的 token 无法从 promptChars 反映，ratio 会系统性偏低。
  if (sample.toolCount > 0) return 'has_tools'
  if (sample.cacheSemantics === 'unknown') return 'cache_semantics_unknown'
  const { inputTokens, outputTokens, totalTokens, reasoningTokens } = sample.usage
  if (typeof inputTokens !== 'number' || typeof totalTokens !== 'number' || inputTokens <= 0) return 'usage_missing'
  // total = input + output（±1）；reasoning 是 output 的子集，不能加成第三项。
  const output = typeof outputTokens === 'number' ? outputTokens : 0
  if (Math.abs(totalTokens - (inputTokens + output)) > 1) return 'token_mismatch'
  if (typeof reasoningTokens === 'number' && typeof outputTokens === 'number' && reasoningTokens > outputTokens + 1) return 'token_mismatch'
  if (!options.skipRatioRange) {
    const ratio = promptCharsOf(sample) / inputTokens
    if (!Number.isFinite(ratio) || ratio < RATIO_MIN || ratio > RATIO_MAX) return 'token_mismatch'
  }
  return undefined
}

function promptCharsOf(sample: { promptChars: number }): number {
  return sample.promptChars
}

/** 内容先验：四类占比归一后的加权平均（不是简单相加，避免占比和≠1 时偏大）。 */
export const PRIOR_WEIGHTS = { cjk: 1.8, code: 3.8, prose: 3.0, other: 2.5 } as const

export function priorRatio(composition: Composition): number {
  const total = composition.cjkChars + composition.codeLikeChars + composition.asciiProseChars + composition.otherChars
  if (total <= 0) return 2.5
  const ratio = (composition.cjkChars * PRIOR_WEIGHTS.cjk
    + composition.codeLikeChars * PRIOR_WEIGHTS.code
    + composition.asciiProseChars * PRIOR_WEIGHTS.prose
    + composition.otherChars * PRIOR_WEIGHTS.other) / total
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, Math.round(ratio * 1000) / 1000))
}

/** 单条样本的 chars/token（方向写死：promptChars / inputTokens）。 */
export function sampleRatio(sample: Pick<CalibrationSampleRecord, 'promptChars' | 'usage'>): number | undefined {
  const tokens = sample.usage.inputTokens
  if (typeof tokens !== 'number' || tokens <= 0 || sample.promptChars <= 0) return undefined
  return sample.promptChars / tokens
}

/** 桶键：tokenizer 由 provider+model 决定，再按 purpose 分（只校准 reply 是调用方的职责）。 */
export function bucketKey(sample: Pick<CalibrationSampleRecord, 'provider' | 'model' | 'purpose'>): string {
  return `${sample.provider}::${sample.model}::${sample.purpose}`
}

/** 同一 prompt 在窗口内只算一次（重试/重放会重复采样）。 */
export function dedupeSamples(samples: readonly CalibrationSampleRecord[]): CalibrationSampleRecord[] {
  const seen = new Set<string>()
  const out: CalibrationSampleRecord[] = []
  for (const sample of samples) {
    const key = `${bucketKey(sample)}|${sample.promptHash}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(sample)
  }
  return out
}
