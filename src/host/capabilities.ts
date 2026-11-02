/**
 * 宿主能力探测（Phase 0 · 可寻址记忆层的前置裁决项）。
 *
 * 背景：`tokenizer 预算` / `usage 回执校准` / `embedding 排序` 这三件事都被写进过路线图，
 * 但它们的**前提都是宿主真的暴露了对应能力**。`LlmService` 现在只有
 * `listProviders / listModels / stream / resolveModelInfo`（`host/dsh-llm.ts`），
 * 所以必须先探测、再决定 Phase 1 用「字符预算 + 保守系数」还是「真实 token 预算」。
 *
 * 探测分两类：
 * 1. **形状探测**（同步、零成本）：服务对象上有没有 `tokenize / embed / ...`；
 * 2. **观测探测**（需要一次真实流式调用）：`stream` 的 chunk 里有没有 usage 字段。
 *    观测结果由调用方（`/api/im/llm-probe`）通过 `observations` 传进来，本模块不主动发请求。
 */
export type CapabilityState = 'available' | 'absent' | 'unknown'

export interface HostCapabilityReport {
  schema: 1
  /** 模型目录可列（listModels）。 */
  models: CapabilityState
  /** 流式调用可用（stream）。 */
  stream: CapabilityState
  /** 上下文窗口可查（resolveModelInfo → context.contextWindow）。 */
  contextWindow: CapabilityState
  /** 宿主是否有 tokenizer（决定能不能做真实 token 预算）。 */
  tokenizer: CapabilityState
  /** 宿主是否有 embedding（决定 Phase 3 能不能做语义重排）。 */
  embeddings: CapabilityState
  /** 流里是否带 usage（决定能不能做字符→token 比例校准）。 */
  usage: CapabilityState
  /** 命中的方法名 / 字段路径，便于人工复核。 */
  evidence: Record<string, string[]>
  /** 一句话结论，给面板/日志用。 */
  summary: string
}

export interface CapabilityObservations {
  /** 真实流式调用中观察到的 usage 字段路径（如 `usage.promptTokens`）。 */
  usageKeys?: readonly string[]
}

const TOKENIZER_KEYS = ['tokenize', 'tokenizer', 'countTokens', 'tokenCount', 'encode', 'encodeTokens'] as const
const EMBEDDING_KEYS = ['embed', 'embedding', 'embeddings', 'embedMany', 'embedText', 'embedBatch'] as const
const USAGE_FIELDS = ['promptTokens', 'completionTokens', 'totalTokens', 'inputTokens', 'outputTokens', 'input_tokens', 'output_tokens'] as const

function hits(target: unknown, keys: readonly string[]): string[] {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return []
  return keys.filter((key) => typeof (target as Record<string, unknown>)[key] === 'function')
}

/**
 * 从流式 chunk 里收集 usage 字段路径（含 `reason.usage` 这类嵌套位置）。
 * 纯函数：不改 chunk，只报告"这条流里出现了哪些用量字段"。
 */
export function usageKeysInChunk(chunk: unknown, prefix = ''): string[] {
  if (!chunk || typeof chunk !== 'object') return []
  const found: string[] = []
  const record = chunk as Record<string, unknown>
  for (const field of USAGE_FIELDS) {
    const value = record[field]
    if (value !== undefined && value !== null && typeof value !== 'function') found.push(prefix ? `${prefix}.${field}` : field)
  }
  for (const nested of ['reason', 'usage', 'meta', 'stats']) {
    const value = record[nested]
    if (value && typeof value === 'object') found.push(...usageKeysInChunk(value, prefix ? `${prefix}.${nested}` : nested))
  }
  return [...new Set(found)]
}

export function detectHostCapabilities(llm: unknown, observations: CapabilityObservations = {}): HostCapabilityReport {
  const evidence: Record<string, string[]> = {}
  const tokenizer = hits(llm, TOKENIZER_KEYS)
  const embeddings = hits(llm, EMBEDDING_KEYS)
  if (tokenizer.length) evidence.tokenizer = tokenizer
  if (embeddings.length) evidence.embeddings = embeddings
  const usageKeys = [...new Set(observations.usageKeys ?? [])]
  if (usageKeys.length) evidence.usage = usageKeys

  const state = (value: unknown): CapabilityState => (typeof value === 'function' ? 'available' : 'absent')
  const report: HostCapabilityReport = {
    schema: 1,
    models: state((llm as { listModels?: unknown } | undefined)?.listModels),
    stream: state((llm as { stream?: unknown } | undefined)?.stream),
    contextWindow: state((llm as { resolveModelInfo?: unknown } | undefined)?.resolveModelInfo),
    tokenizer: tokenizer.length ? 'available' : 'absent',
    embeddings: embeddings.length ? 'available' : 'absent',
    // usage 只能靠真实调用观测：没观测过就是 unknown（不是 absent）。
    usage: usageKeys.length ? 'available' : 'unknown',
    evidence,
    summary: '',
  }
  report.summary = [
    `models=${report.models}`,
    `stream=${report.stream}`,
    `contextWindow=${report.contextWindow}`,
    `tokenizer=${report.tokenizer}`,
    `usage=${report.usage}`,
    `embeddings=${report.embeddings}`,
  ].join(' / ')
  return report
}

/** 面板/日志用：把报告压成一行，避免把 evidence 全打出去。 */
export function summarizeCapabilities(report: HostCapabilityReport): string {
  return report.summary
}
