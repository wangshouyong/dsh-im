/**
 * 校准样本落盘（L1）：`<root>/.dsh-im/calibration-samples.jsonl`，只追加、滚动保留最近 N 条。
 *
 * 为什么不塞 metrics.jsonl：指标文件会被撑爆，而且"成本观测"和"校准样本"混在一起后就无法离线复算。
 * 坏行跳过；读取时按 schema 过滤；写串行 + 原子写。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CALIBRATION_SAMPLE_SCHEMA,
  MAX_CALIBRATION_SAMPLES,
  type CalibrationSampleRecord,
} from '../core/calibration-samples.ts'
import { logWarn } from '../core/log.ts'

export function calibrationSamplesPath(root: string): string {
  return join(root, '.dsh-im', 'calibration-samples.jsonl')
}

const chains = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  chains.set(key, next.then(() => undefined, () => undefined))
  return next
}

export async function readCalibrationSamples(root: string, limit = MAX_CALIBRATION_SAMPLES): Promise<CalibrationSampleRecord[]> {
  let raw: string
  try {
    raw = await readFile(calibrationSamplesPath(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: CalibrationSampleRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as CalibrationSampleRecord
      if (parsed?.schema !== CALIBRATION_SAMPLE_SCHEMA) continue
      if (typeof parsed.provider !== 'string' || typeof parsed.promptChars !== 'number') continue
      out.push(parsed)
    } catch {
      continue
    }
  }
  return limit > 0 ? out.slice(-limit) : out
}

/** 追加一条样本；滚动裁剪用「读-改-写 + rename」（文件小，500 条约几百 KB）。 */
export function appendCalibrationSample(root: string, sample: CalibrationSampleRecord): Promise<void> {
  const path = calibrationSamplesPath(root)
  return enqueue(path, async () => {
    try {
      await mkdir(dirname(path), { recursive: true })
      const existing = await readCalibrationSamples(root, 0)
      existing.push(sample)
      const kept = existing.slice(-MAX_CALIBRATION_SAMPLES)
      const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
      await writeFile(tmp, kept.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
      await rename(tmp, path)
    } catch (error) {
      logWarn('[dsh-im] 写校准样本失败（忽略）', { root, reason: String((error as Error)?.message ?? error) })
    }
  })
}
