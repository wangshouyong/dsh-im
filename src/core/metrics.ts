/**
 * 指标（`metrics.jsonl`）：只追加的小 JSON 行，用来回答“这轮花了多少、错在哪、旧版本回复多不多”。
 *
 * 客户端在网络侧只拿得到回复；这里记录的是客户端能观察到的事件（仲裁/过期/抽取），
 * 模型调用本身的耗时与成败由 host 的 `/complete` 记录（同一个文件）。
 *
 * 2026-11-02 修复：指标行带稳定指纹 `id`，写入/读取两侧都按 id 去重。
 * 背景是并发 `saveState` 会把同一批 `pendingMetrics` 追加多遍（实机 135 行里 72 行重复）。
 * 只靠“写入串行”不够——两个并发 PUT 各带一份快照，串行只保证不交错、不保证不重复；
 * 所以正确性放在幂等键上：行重复不影响任何聚合结果。
 */
import type { MetricEntry } from './types.ts'
import { stableHash } from './receipt.ts'

/** 客户端攒指标的上限：超过就丢最旧的，避免 state.json 无界增长。 */
export const METRIC_MAX_PENDING = 200

/**
 * 同一条指标的稳定指纹。
 *
 * 输入只取「指标内容」：kind / at / value / fields（fields 按 key 排序后规范化），
 * 与写入路径、进程、顺序都无关 —— 客户端攒的和 host 直写的同一条指标会算出同一个 id。
 *
 * 用两个不同盐的 FNV-1a 拼成 16 位十六进制，把 32 位单哈希的碰撞概率（几千条量级下约千分之几）
 * 压到可以忽略；指标去重不能接受“两条不同指标被误合并”。
 */
export function metricFingerprint(entry: Pick<MetricEntry, 'kind' | 'at' | 'value' | 'fields'>): string {
  const fields = entry.fields ?? {}
  const canonicalFields = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${JSON.stringify(fields[key])}`)
    .join(',')
  const base = `${entry.kind}|${entry.at}|${entry.value ?? ''}|${canonicalFields}`
  return `m_${hashHex(base)}${hashHex(`dsh-im:metric:${base}`)}`
}

/** `stableHash` 返回 `fnv1a32-v1:xxxxxxxx`；id 里只要十六进制主体。 */
function hashHex(text: string): string {
  const value = stableHash(text)
  const colon = value.lastIndexOf(':')
  return colon >= 0 ? value.slice(colon + 1) : value
}

/** 给没有 id 的条目补上指纹；已有的保持不动（同一条目在客户端/宿主之间往返后 id 不变）。 */
export function withMetricId(entry: MetricEntry): MetricEntry {
  if (entry.id) return entry
  return { ...entry, id: metricFingerprint(entry) }
}

/**
 * 按 id 去重（老数据没有 id 时按内容指纹补算）。
 * 读取路径必须过这一层：并发写留下的重复行在文件里是既成事实，聚合前要去掉。
 */
export function dedupeMetrics(entries: readonly MetricEntry[]): MetricEntry[] {
  const seen = new Set<string>()
  const out: MetricEntry[] = []
  for (const entry of entries) {
    const id = entry.id ?? metricFingerprint(entry)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(entry)
  }
  return out
}

export function appendMetric(list: MetricEntry[] | undefined, entry: MetricEntry): MetricEntry[] {
  const next = [...(list ?? []), withMetricId(entry)]
  return next.length > METRIC_MAX_PENDING ? next.slice(-METRIC_MAX_PENDING) : next
}

export interface MetricRollup {
  total: number
  byKind: Record<string, number>
  /** 旧版本回复（按最终动作统计）。 */
  stale: Record<string, number>
  llmCalls: number
  llmErrors: number
  avgLlmMs: number
}

/**
 * 聚合指标：监控/测试用；不改原始数据。
 *
 * 这里**不去重**：入参是内存里的 `pendingMetrics`（每条都是新发生的事件），
 * 两条内容完全相同的条目就是两次真实事件，不能合并。文件里的重复行在
 * `readMetrics`（文件边界）就已经去掉了，聚合拿到的一定是唯一事件。
 */
export function summarizeMetrics(entries: readonly MetricEntry[]): MetricRollup {
  const byKind: Record<string, number> = {}
  const stale: Record<string, number> = {}
  let llmCalls = 0
  let llmErrors = 0
  let llmMs = 0
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    if (entry.kind === 'stale') {
      const action = String(entry.fields?.action ?? 'unknown')
      stale[action] = (stale[action] ?? 0) + 1
    }
    if (entry.kind === 'llm_call') {
      llmCalls += 1
      if (entry.fields?.ok === false) llmErrors += 1
      if (typeof entry.value === 'number') llmMs += entry.value
    }
  }
  return {
    total: entries.length,
    byKind,
    stale,
    llmCalls,
    llmErrors,
    avgLlmMs: llmCalls ? Math.round(llmMs / llmCalls) : 0,
  }
}
