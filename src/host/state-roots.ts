/**
 * 数据根发现与体检（只读）。
 *
 * 背景：`state.json` 是按「DSH 工作区根」放在 `<root>/.dsh-im/state.json` 的。
 * 一旦面板的数据根指向了一个 DSH 没注册的目录，宿主会 400，而旧客户端把 400
 * 吞成「空数据」——用户看到的就是「专家团队数据没了」。这个模块让面板能：
 *  1) 列出当前根 / 已注册工作区 / 以前用过的根，各自有没有数据、多少角色/会话；
 *  2) 在加载失败时给出「哪个根里还有数据」，而不是一片空白。
 *
 * 这里只做 stat + JSON 计数，不触发任何共识/摘要副作用。
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-atomic.ts'

export interface StateRootInfo {
  /** 数据根绝对路径（就是 `<root>/.dsh-im/state.json` 的上一级）。 */
  path: string
  title?: string
  /** 是否在 DSH 工作区注册表里（未注册的根，宿主会拒绝读写）。 */
  registered: boolean
  /** state.json 是否存在且能解析。 */
  hasState: boolean
  personas: number
  threads: number
  messages: number
  /** 最近一条会话的 updatedAt；没有会话时退回 state.json 的 mtime。 */
  updatedAt?: number
  /** 读取/解析失败原因（存在但坏掉、权限不足等）。 */
  error?: string
}

export interface StateRootIo {
  readFile?: (file: string) => Promise<string>
  mtime?: (file: string) => Promise<number>
}

/** 根去重键：Windows 大小写不敏感，其它平台保留大小写。 */
export function rootKey(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function stateFileOf(root: string): string {
  return join(root, '.dsh-im', 'state.json')
}

/** 每个数据根体检一次（只读、不写入、不触发共识副作用）。 */
export async function describeStateRoot(
  root: string,
  options: { title?: string; registered?: boolean; io?: StateRootIo } = {},
): Promise<StateRootInfo> {
  const io = options.io ?? {}
  const file = stateFileOf(root)
  const base: StateRootInfo = {
    path: root,
    registered: Boolean(options.registered),
    hasState: false,
    personas: 0,
    threads: 0,
    messages: 0,
    ...(options.title ? { title: options.title } : {}),
  }
  const readFileOf = io.readFile ?? ((target: string) => readFile(target, 'utf8'))
  const mtimeOf = io.mtime ?? (async (target: string) => (await stat(target)).mtimeMs)
  try {
    const text = await readFileOf(file)
    const parsed = JSON.parse(text) as {
      personas?: unknown[]
      threads?: { messages?: unknown[]; updatedAt?: number }[]
      memories?: unknown[]
    }
    const threads = Array.isArray(parsed.threads) ? parsed.threads : []
    const updatedAt = threads.reduce((max, thread) => Math.max(max, Number(thread?.updatedAt) || 0), 0)
    let mtime = 0
    try {
      mtime = await mtimeOf(file)
    } catch {
      mtime = 0
    }
    return {
      ...base,
      hasState: true,
      personas: Array.isArray(parsed.personas) ? parsed.personas.length : 0,
      threads: threads.length,
      messages: threads.reduce((sum, thread) => sum + (Array.isArray(thread?.messages) ? thread.messages.length : 0), 0),
      updatedAt: updatedAt || mtime || undefined,
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return base
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 候选数据根 = 已注册工作区 + 以前用过且被记住的根 + 当前根（即使未注册）。
 * 当前根排第一；其余按「有没有数据 → 最近更新 → 是否注册」排序。
 */
export async function listStateRoots(options: {
  workspaces?: { path?: string; title?: string }[]
  current?: string
  knownRoots?: string[]
  io?: StateRootIo
}): Promise<StateRootInfo[]> {
  const current = options.current?.trim()
  const entries = new Map<string, { path: string; title?: string; registered: boolean }>()
  const add = (path: string, title: string | undefined, registered: boolean) => {
    if (!path || !path.trim()) return
    const key = rootKey(path)
    const existing = entries.get(key)
    // 注册信息优先（同一个根既是注册工作区又是历史根时，保留标题）。
    if (!existing) {
      entries.set(key, { path, registered, ...(title ? { title } : {}) })
      return
    }
    if (registered && !existing.registered) existing.registered = true
    if (!existing.title && title) existing.title = title
  }
  for (const workspace of options.workspaces ?? []) {
    if (workspace?.path) add(workspace.path, workspace.title?.trim() || undefined, true)
  }
  for (const path of options.knownRoots ?? []) add(path, undefined, false)
  if (current) add(current, undefined, false)

  const infos = await Promise.all(
    [...entries.values()].map((entry) => describeStateRoot(entry.path, {
      title: entry.title,
      registered: entry.registered,
      io: options.io,
    })),
  )
  const currentKey = current ? rootKey(current) : ''
  return infos.sort((a, b) => {
    const aCurrent = rootKey(a.path) === currentKey ? 1 : 0
    const bCurrent = rootKey(b.path) === currentKey ? 1 : 0
    if (aCurrent !== bCurrent) return bCurrent - aCurrent
    if (a.hasState !== b.hasState) return a.hasState ? -1 : 1
    if ((a.updatedAt ?? 0) !== (b.updatedAt ?? 0)) return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    if (a.registered !== b.registered) return a.registered ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

/**
 * 记住用过的数据根。必须放在不随工作区变化的位置：
 * 否则切工作区后连「以前用过哪个根」都查不到，只能继续空着。
 */
export function defaultRootsFile(): string {
  const override = process.env.DSH_IM_ROOTS_FILE?.trim()
  if (override) return override
  return join(homedir(), '.dsh-im', 'known-roots.json')
}

const MAX_KNOWN_ROOTS = 50

export async function readKnownRoots(file = defaultRootsFile()): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { roots?: unknown }
    if (!Array.isArray(parsed.roots)) return []
    return parsed.roots.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  } catch {
    return []
  }
}

/** 记住用过的根是 read-modify-write 的小文件：并发写会互相覆盖（丢掉刚记的根），必须串行 + 原子写。 */
const rootFileChains = new Map<string, Promise<unknown>>()

function enqueueRootFile<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = rootFileChains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  rootFileChains.set(key, next.then(() => undefined, () => undefined))
  return next
}

/** 记录一次成功读写的根；失败绝不打断主流程（只是让「找回数据」变方便）。 */
export function recordKnownRoot(root: string, file = defaultRootsFile()): Promise<void> {
  const target = root?.trim()
  if (!target) return Promise.resolve()
  return enqueueRootFile(file, async () => {
    try {
      const roots = await readKnownRoots(file)
      const key = rootKey(target)
      const next = [target, ...roots.filter((entry) => rootKey(entry) !== key)].slice(0, MAX_KNOWN_ROOTS)
      await writeFileAtomic(file, JSON.stringify({ roots: next }, null, 2))
    } catch {
      // 忘记记录不是错误：主流程（读写 state）已经成功。
    }
  })
}
