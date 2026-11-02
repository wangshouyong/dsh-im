/**
 * 单轮工具调用去重：模型经常反复读同一个文件 / 列同一个目录 / 搜同一个关键词。
 *
 * 做法是“工具结果缓存 + 重复提示”：本轮内同一工具 + 同一（规范化后的）参数再次调用时，
 * 不再执行真实 IO，而是返回一句提示，让模型基于前面已经拿到的结果继续。
 *
 * 只作用于一次 `/complete` 之内；`write_file`/`run_check` 会让结果过期，所以写文件后清空缓存。
 */
import { normalizePath } from '../core/workspace.ts'

export interface TurnToolCacheOptions {
  /** 最多记多少条（防极端情况无界增长）。 */
  maxEntries?: number
  /** Windows 路径不区分大小写；测试里可显式指定。 */
  caseInsensitive?: boolean
}

export interface ToolCallLookup {
  repeated: true
  hint: string
  key: string
}

export interface TurnToolCache {
  /** 第一次返回 null；重复调用返回提示（调用方直接把它当 tool 结果喂回去）。 */
  lookup(name: string, args: Record<string, unknown>): ToolCallLookup | null
  /** 成功的工具结果记入缓存；失败的结果不记（允许模型重试）。 */
  record(name: string, args: Record<string, unknown>, result: string): void
  /** 写文件后调用：结果可能已变化，全部作废。 */
  invalidate(): void
  /** 本轮命中的重复调用次数（给指标用）。 */
  hits(): number
  size(): number
}

const PATH_TOOLS = new Set(['read_file', 'list_dir'])
const TEXT_TOOLS = new Set(['search_files', 'run_check', 'memory_search'])
const SEQS_TOOLS = new Set(['memory_expand'])

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : String(value)
}

/** 工具 + 参数的规范化 key：路径统一成正斜杠/去 ./..，Windows 下忽略大小写。 */
export function toolCallKey(
  name: string,
  args: Record<string, unknown>,
  options: TurnToolCacheOptions = {},
): string {
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
  if (PATH_TOOLS.has(name)) {
    const raw = asText(args.path ?? '.')
    const normalized = normalizePath(raw.replace(/\\/g, '/')) || '.'
    return `${name}|${caseInsensitive ? normalized.toLowerCase() : normalized}`
  }
  if (TEXT_TOOLS.has(name)) {
    const raw = name === 'run_check' ? asText(args.target) : asText(args.query)
    const normalized = raw.replace(/\s+/g, ' ').trim()
    return `${name}|${caseInsensitive ? normalized.toLowerCase() : normalized}`
  }
  if (SEQS_TOOLS.has(name)) {
    // 记忆展开：seqs 去空白、排序后比较（"12, 30" 与 "30,12" 是同一请求）。
    const seqs = (asText(args.seqs ?? args.seq).match(/\d+/g) ?? []).map(Number).filter((seq) => seq > 0)
    const normalized = [...new Set(seqs)].sort((left, right) => left - right).join(',')
    return `${name}|${normalized}`
  }
  // 其它工具：参数按 key 排序做稳定序列化。
  const ordered = Object.keys(args).sort().map((key) => `${key}=${asText(args[key])}`).join('&')
  return `${name}|${caseInsensitive ? ordered.toLowerCase() : ordered}`
}

function hintFor(name: string, args: Record<string, unknown>): string {
  const path = asText(args.path ?? '.')
  if (name === 'read_file') {
    return `本轮已经读过文件「${path}」，内容就在前面的工具结果里，本次不再重复读取。不要整份重读：需要定位某段就用 search_files 搜关键词，或直接基于已有内容作答。`
  }
  if (name === 'list_dir') {
    return `本轮已经列过目录「${path}」，内容就在前面的工具结果里，本次不再重复列目录。请换一个目录，或直接 read_file 读具体文件。`
  }
  if (name === 'search_files') {
    return `本轮已经用同样的关键词搜过，结果就在前面的工具结果里，本次不再重复搜索。请换关键词，或基于已有结果作答。`
  }
  if (name === 'memory_search') {
    return '本轮已经查过同一个记忆检索词，句柄结果就在前面的工具结果里，本次不再重复检索（已查过，换关键词，或直接用 memory_expand / 直接作答）。'
  }
  if (name === 'memory_expand') {
    return '本轮已经展开过同一批 #seq，原文就在前面的工具结果里，本次不再重复展开。请基于已有原文作答。'
  }
  if (name === 'run_check') {
    return '本轮已经用同样的参数跑过检查，结果就在前面的工具结果里，本次不再重复执行。'
  }
  return `本轮已经用相同参数调用过 ${name}，结果就在前面的工具结果里，本次不再重复执行。`
}

export function createTurnToolCache(options: TurnToolCacheOptions = {}): TurnToolCache {
  const maxEntries = Math.max(1, options.maxEntries ?? 200)
  const entries = new Map<string, string>()
  let hitCount = 0
  return {
    lookup(name, args) {
      const key = toolCallKey(name, args, options)
      if (!entries.has(key)) return null
      hitCount += 1
      return { repeated: true, hint: hintFor(name, args), key }
    },
    record(name, args, result) {
      const key = toolCallKey(name, args, options)
      entries.delete(key)
      entries.set(key, result)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
    },
    invalidate() {
      entries.clear()
    },
    hits: () => hitCount,
    size: () => entries.size,
  }
}
