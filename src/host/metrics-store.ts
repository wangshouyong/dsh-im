/**
 * 指标落盘：`.dsh-im/groups/<threadId>/metrics.jsonl`，只追加、坏行跳过。
 *
 * 客户端攒的指标（stale/floor/extraction/summary）先放 `thread.pendingMetrics`，
 * 由 saveState 批量写入；模型调用指标由 host 的 `/complete` 直接写。
 *
 * 2026-11-02 修复（并发重复追加）：
 * 1. **写串行**：同一文件的 append 走一条链，避免两个 appendFile 交错出半行；
 * 2. **写幂等**：进程内记住已写过的指标 id，同一批 pendingMetrics 被并发 saveState
 *    重复提交时只落一次（重启后靠读侧去重兜底）；
 * 3. **读去重**：`readMetrics` 按 id 去重，老数据按内容指纹补算。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MetricEntry } from '../core/types.ts'
import { dedupeMetrics, withMetricId } from '../core/metrics.ts'
import { groupDir } from './event-store.ts'

export function metricsPath(root: string, threadId: string): string {
  return join(groupDir(root, threadId), 'metrics.jsonl')
}

/** 队列键：Windows 大小写不敏感、路径分隔符混用，归一化后才能命中同一把锁。 */
function queueKey(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 追加写队列：一个文件一条链，前一步失败也要继续（否则一次坏写入会永久卡死后续指标）。 */
const writeChains = new Map<string, Promise<unknown>>()

function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  writeChains.set(key, next.then(() => undefined, () => undefined))
  return next
}

/** 进程内已落盘的指标 id（按文件分桶）；上限只防内存无界，裁剪只可能让极旧条目被重写一次。 */
const MAX_TRACKED_IDS = 4000
const writtenIds = new Map<string, Set<string>>()

function idsFor(key: string): Set<string> {
  let set = writtenIds.get(key)
  if (!set) {
    set = new Set()
    writtenIds.set(key, set)
  }
  return set
}

function rememberIds(set: Set<string>, ids: readonly string[]): void {
  for (const id of ids) set.add(id)
  if (set.size <= MAX_TRACKED_IDS) return
  // 重建：保留靠后的一半（Set 保留插入顺序，靠后的是最近的）。
  const keep = [...set].slice(-Math.floor(MAX_TRACKED_IDS / 2))
  set.clear()
  for (const id of keep) set.add(id)
}

export async function appendMetrics(
  root: string,
  threadId: string,
  entries: readonly MetricEntry[],
): Promise<number> {
  if (entries.length === 0) return 0
  const path = metricsPath(root, threadId)
  const key = queueKey(path)
  // 先补 id（同步、纯函数），再排队——入参对象不被改写，调用方状态不受影响。
  const normalized = entries.map(withMetricId)
  return enqueueWrite(key, async () => {
    const seen = idsFor(key)
    const fresh = normalized.filter((entry) => !seen.has(entry.id as string))
    if (fresh.length === 0) return 0
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, fresh.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
    rememberIds(seen, fresh.map((entry) => entry.id as string))
    return fresh.length
  })
}

export async function readMetrics(
  root: string,
  threadId: string,
  options: { limit?: number; kind?: string } = {},
): Promise<MetricEntry[]> {
  let raw: string
  try {
    raw = await readFile(metricsPath(root, threadId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed: MetricEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed) as MetricEntry
      if (typeof entry?.kind !== 'string' || typeof entry?.at !== 'number') continue
      if (options.kind && entry.kind !== options.kind) continue
      parsed.push(entry)
    } catch {
      continue
    }
  }
  // 去重后再截尾：先 limit 会把重复行算进窗口，导致最近 N 条里掺着重复。
  const unique = dedupeMetrics(parsed)
  const limit = options.limit ?? 500
  return limit > 0 ? unique.slice(-limit) : unique
}
