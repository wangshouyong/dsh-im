import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PathFence } from './fence.ts'
import { parseState, stateRelPath } from './persist.ts'
import type { ImState } from './types.ts'
import { assertSafeThreadId, isInsideThreadDir, normalizePath, threadDir, type FileSink } from './workspace.ts'
export { assertSafeThreadId } from './workspace.ts'
import { syncThreadEvents } from '../host/event-store.ts'
import {
  appendDerivedFactEvents,
  projectAndWriteFacts,
  syncPendingFactOps,
  syncThreadFloorDecisions,
} from '../host/derived-store.ts'
import { buildThreadDigest } from './summary.ts'
import { appendMetrics } from '../host/metrics-store.ts'
import { writeFileAtomic } from '../host/fs-atomic.ts'
import { logWarn } from './log.ts'

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', '.vite', '.dsh-im'])
const MAX_READ = 80_000
const MAX_LIST = 200
const MAX_SEARCH_FILES = 80
const MAX_HITS = 20

/** 插件内部状态目录：角色不得读取（state.json、其它群的记录都在里面）。 */
const INTERNAL_DIR = '.dsh-im'

function assertNotInternal(root: string, abs: string, threadId: string): void {
  assertSafeThreadId(threadId)
  const relPath = relative(resolve(root), resolve(abs)).replaceAll(sep, '/')
  if (relPath !== INTERNAL_DIR && !relPath.startsWith(`${INTERNAL_DIR}/`)) return
  // 许读本群的群工作区；其余 .dsh-im 一律拒绝。
  const own = `${INTERNAL_DIR}/groups/${threadId}`
  if (relPath === own || relPath.startsWith(`${own}/`)) return
  throw new Error('denied: .dsh-im 是插件内部状态，角色不能读取；需要资料请用工作区里的项目文件。')
}

export const nodeSink: FileSink = {
  async writeThreadFile(projectRoot, threadId, relativePath, content) {
    const dest = resolve(threadDir(projectRoot, threadId), relativePath)
    if (!isInsideThreadDir(projectRoot, threadId, dest)) {
      throw new Error('write denied: path escapes .dsh-im thread directory')
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content, 'utf8')
    return dest
  },
}

export function stateFile(projectRoot: string): string {
  return join(resolve(projectRoot), '.dsh-im', stateRelPath())
}

export async function loadState(projectRoot: string): Promise<ImState | null> {
  try {
    return parseState(await readFile(stateFile(projectRoot), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export interface SaveStateResult {
  path: string
  /** 派生数据（事件 / facts / 摘要 / 指标）落盘失败、但聊天记录仍已保存的原因；空数组＝全成功。 */
  warnings: string[]
}

const saveChains = new Map<string, Promise<unknown>>()

/** 队列键：同一个数据根的不同写法（大小写 / 分隔符）必须命中同一把锁。 */
function saveQueueKey(root: string): string {
  const normalized = resolve(root).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 落盘 state.json 并双写派生数据。
 *
 * 同一数据根上的调用**串行**（`saveChains`）：并发 PUT 各带一份完整快照，
 * 不排队时旧快照可能在新快照之后落盘（把最后几条消息写回去），派生事件也会互相覆盖。
 * 串行只保证顺序，重复批次的清净由 `metrics-store` 的幂等 id 负责。
 */
export function saveState(projectRoot: string, state: ImState): Promise<SaveStateResult> {
  const key = saveQueueKey(projectRoot)
  const previous = saveChains.get(key) ?? Promise.resolve()
  // 前一个失败了也要继续跑下一个：一次失败不能把该根永久卡住。
  const next = previous.then(
    () => saveStateInner(projectRoot, state),
    () => saveStateInner(projectRoot, state),
  )
  saveChains.set(key, next.then(() => undefined, () => undefined))
  return next
}

async function saveStateInner(projectRoot: string, state: ImState): Promise<SaveStateResult> {
  const dest = stateFile(projectRoot)
  const warnings: string[] = []
  // 过渡期双写：先补事件日志并回填每条消息的持久 seq，再写 state.json。
  // 事件日志失败不阻塞主写盘（读仍以 state 为准），但必须留下可见的告警，不能静默吞。
  await Promise.all(state.threads.map(async (thread) => {
    try {
      const synced = await syncThreadEvents(projectRoot, thread.id, thread.messages)
      if (synced.seqs.length === thread.messages.length) {
        thread.messages.forEach((message, index) => { message.seq = synced.seqs[index] })
      }
      // 顺序很重要：先由消息派生 assert（seq 更早），再落客户端操作（retract/supersede），
      // 最后统一投影；反过来的话 retract 会拿到更小的 seq，重载后事实会复活。
      await appendDerivedFactEvents(projectRoot, thread.id, thread.messages)
      await syncPendingFactOps(projectRoot, thread.id, thread.pendingFactOps ?? [])
      const facts = await projectAndWriteFacts(projectRoot, thread.id)
      thread.facts = facts.facts
      thread.factsVersion = facts.version
      thread.factsUntilSeq = thread.messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0)
      thread.pendingFactOps = undefined
      thread.extractedFacts = undefined
      thread.retractedFactIds = undefined
      await syncThreadFloorDecisions(projectRoot, thread.id, thread.floorDecisions ?? [])
      await appendMetrics(projectRoot, thread.id, thread.pendingMetrics ?? [])
      thread.pendingMetrics = undefined
      const digest = buildThreadDigest(thread, thread.summaryState, { facts: facts.facts })
      thread.summaryState = digest
      thread.summaryUntilSeq = digest.untilSeq
    } catch (error) {
      // 以前这里 catch {} 全吞：事件/facts/摘要/指标写失败时用户以为存好了（掩盖失败）。
      const reason = error instanceof Error ? error.message : String(error)
      const message = `群 ${thread.id} 的派生数据落盘失败（聊天记录仍会保存）：${reason}`
      warnings.push(message)
      logWarn('[dsh-im] saveState 派生数据落盘失败', { threadId: thread.id, reason })
    }
  }))
  // 原子写：半截 JSON 会让下次加载直接报错，表现成「数据没了」。
  await writeFileAtomic(dest, JSON.stringify(state, null, 2))
  return { path: dest, warnings }
}

function resolveInside(projectRoot: string, threadId: string, rel: string): string {
  const root = resolve(projectRoot)
  const dest = resolve(root, rel || '.')
  const fence = new PathFence(normalizePath(root.replace(/\\/g, '/')), threadId)
  assertNotInternal(root, dest, threadId)
  const verdict = fence.decide({ op: 'read', target: dest.replace(/\\/g, '/') })
  if (!verdict.allow) throw new Error(verdict.reason)
  return dest
}

/** 写本群的群工作区：<workspace>/.dsh-im/groups/<threadId>/。 */
export async function writeGroupFile(
  projectRoot: string,
  threadId: string,
  relPath: string,
  content: string,
): Promise<string> {
  assertSafeThreadId(threadId)
  if (!relPath?.trim()) throw new Error('path required')
  if (typeof content !== 'string') throw new Error('content required')
  const root = resolve(projectRoot)
  const dir = join(root, INTERNAL_DIR, 'groups', threadId)
  const dest = resolve(dir, relPath)
  const rel = relative(dir, dest).replaceAll(sep, '/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('denied: 只能写在本群工作区目录内')
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, content, 'utf8')
  return dest
}

/** 写本群工作区的二进制文件（附件用）；路径规则与 writeGroupFile 一致。 */
export async function writeGroupBuffer(
  projectRoot: string,
  threadId: string,
  relPath: string,
  data: Uint8Array,
): Promise<string> {
  assertSafeThreadId(threadId)
  if (!relPath?.trim()) throw new Error('path required')
  const root = resolve(projectRoot)
  const dir = join(root, INTERNAL_DIR, 'groups', threadId)
  const dest = resolve(dir, relPath)
  const rel = relative(dir, dest).replaceAll(sep, '/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('denied: 只能写在本群工作区目录内')
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, data)
  return dest
}

/** 读本群工作区的二进制附件。 */
export async function readGroupBuffer(
  projectRoot: string,
  threadId: string,
  relPath: string,
): Promise<Buffer> {
  assertSafeThreadId(threadId)
  if (!relPath?.trim()) throw new Error('path required')
  const root = resolve(projectRoot)
  const dir = join(root, INTERNAL_DIR, 'groups', threadId)
  const dest = resolve(dir, relPath)
  const rel = relative(dir, dest).replaceAll(sep, '/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('denied: 只能读本群工作区目录内的附件')
  }
  return readFile(dest)
}

export async function listWorkspaceDir(
  projectRoot: string,
  threadId: string,
  rel = '.',
): Promise<string[]> {
  const dest = resolveInside(projectRoot, threadId, rel)
  const entries = await readdir(dest, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue
    out.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
    if (out.length >= MAX_LIST) break
  }
  return out.sort()
}

export async function readWorkspaceFile(
  projectRoot: string,
  threadId: string,
  rel: string,
): Promise<string> {
  if (!rel?.trim()) throw new Error('path required')
  const dest = resolveInside(projectRoot, threadId, rel)
  const info = await stat(dest)
  if (!info.isFile()) throw new Error('不是文件')
  const raw = await readFile(dest)
  const text = raw.subarray(0, MAX_READ).toString('utf8')
  return raw.length > MAX_READ ? `${text}\n…(截断，原文件 ${raw.length} 字节)` : text
}

export async function searchWorkspace(
  projectRoot: string,
  threadId: string,
  query: string,
): Promise<string[]> {
  const needle = query.trim()
  if (!needle) throw new Error('query required')
  const root = resolve(projectRoot)
  const hits: string[] = []
  let files = 0
  async function walk(dir: string): Promise<void> {
    if (hits.length >= MAX_HITS || files >= MAX_SEARCH_FILES) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (hits.length >= MAX_HITS || files >= MAX_SEARCH_FILES) return
      if (SKIP_DIR.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      files += 1
      const fence = new PathFence(normalizePath(root.replace(/\\/g, '/')), threadId)
      if (!fence.decide({ op: 'read', target: full.replace(/\\/g, '/') }).allow) continue
      const body = (await readFile(full)).subarray(0, MAX_READ).toString('utf8')
      const line = body.split(/\r?\n/).find((row) => row.includes(needle))
      if (line) hits.push(`${relative(root, full).replaceAll(sep, '/')}: ${line.trim().slice(0, 160)}`)
    }
  }
  await walk(root)
  return hits
}
