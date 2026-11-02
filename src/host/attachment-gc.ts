/**
 * 附件垃圾回收（v1，默认 dryRun）：
 * 扫 `groups/<threadId>/attachments/`，把 state 里所有消息 attachments[].path 收成引用集，
 * 未引用且 mtime 早于宽限期（默认 24h）的算孤儿。默认只报告，不删除；
 * 宽限期用于避免把“上传成功但还没发出的草稿附件”当孤儿。
 *
 * 未做：内容 sha256 去重/.index.json、按 workspace id 的 URL 反查；留待后续。
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSafeThreadId } from '../core/workspace.ts'
import { loadState } from '../core/workspace-node.ts'
import { groupDir } from './event-store.ts'

/** 服务端硬下限：宽限期不允许低于 1h（客户端传再小也按 1h）。 */
export const MIN_GC_AGE_MS = 60 * 60 * 1000

export interface GcOptions {
  dryRun?: boolean
  minAgeMs?: number
  now?: () => number
  /** 测试注入：默认 node:fs/promises 的 stat。 */
  statFile?: typeof stat
  /** 测试注入：默认 node:fs/promises 的 unlink。 */
  unlinkFile?: typeof unlink
}

export interface GcResult {
  scanned: number
  referenced: number
  orphans: string[]
  freed: number
  /** dryRun 时预计可释放的字节数（freed 只在真删成功后累加）。 */
  wouldFree: number
  /** unlink 失败的个数（删除阶段）。 */
  failed: number
  /** stat 失败的个数（扫描阶段：文件被删/权限不足）。 */
  statFailed: number
  /** 读目录失败的个数（读不了不能当成“很干净”；ENOENT 单列 noDir，不算故障）。 */
  errored: number
  noDir: number
  dryRun: boolean
}

export async function gcAttachments(
  projectRoot: string,
  threadId: string,
  options: GcOptions = {},
): Promise<GcResult> {
  assertSafeThreadId(threadId)
  const dryRun = options.dryRun ?? true
  const minAgeMs = Math.max(MIN_GC_AGE_MS, options.minAgeMs ?? 24 * 60 * 60 * 1000)
  const now = options.now?.() ?? Date.now()
  const state = await loadState(projectRoot).catch(() => null)
  if (!state) {
    throw Object.assign(new Error('GC_ABORT：读不到 state.json，拒绝在“零引用”假设下清理附件'), { code: 'GC_ABORT' })
  }
  const thread = state.threads.find((item) => item.id === threadId)
  if (!thread) {
    throw Object.assign(new Error(`GC_ABORT：本工作区没有群 ${threadId}，拒绝清理附件`), { code: 'GC_ABORT' })
  }
  const referenced = new Set<string>()
  for (const message of thread.messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.path) referenced.add(attachment.path.replaceAll('\\', '/'))
    }
  }
  const dir = join(groupDir(projectRoot, threadId), 'attachments')
  // 递归收集（v1 只有一层，但按日期/子目录存时引用集仍然对得上）。
  const files: { rel: string; full: string }[] = []
  let errored = 0
  let noDir = 0
  async function walk(current: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') noDir += 1
      else errored += 1
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), `${prefix}${entry.name}/`)
      } else if (entry.isFile()) {
        files.push({ rel: `attachments/${prefix}${entry.name}`, full: join(current, entry.name) })
      }
    }
  }
  await walk(dir, '')
  const statFile = options.statFile ?? stat
  const unlinkFile = options.unlinkFile ?? unlink
  let scanned = 0
  let freed = 0
  let wouldFree = 0
  let failed = 0
  let statFailed = 0
  const orphans: string[] = []
  for (const file of files) {
    scanned += 1
    if (referenced.has(file.rel)) continue
    const info = await statFile(file.full).catch(() => null)
    if (!info) {
      statFailed += 1
      continue
    }
    if (now - info.mtimeMs < minAgeMs) continue
    orphans.push(file.rel)
    if (dryRun) {
      wouldFree += info.size
      continue
    }
    try {
      await unlinkFile(file.full)
      freed += info.size
    } catch {
      // 删除失败不计入 freed，单独计数。
      failed += 1
    }
  }
  return { scanned, referenced: referenced.size, orphans, freed, wouldFree, failed, statFailed, errored, noDir, dryRun }
}
