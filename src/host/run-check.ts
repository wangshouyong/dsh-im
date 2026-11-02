import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { assertSafeThreadId } from '../core/workspace.ts'

/** 允许的 target 字符集：路径、无空格、无 shell 元字符。 */
const TARGET_PATTERN = /^[\w@./\\-]+$/
/** target 是这些关键字时走类型检查，而不是 vitest。 */
const TYPECHECK_TARGETS = new Set(['typecheck', 'tsc'])

const TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 8_000

/** 全局并发上限（不锁死，超过就短暂排队）。 */
const MAX_CONCURRENT = 2
const QUEUE_WAIT_MS = 15_000
/** 同一个 target 在同一工作区内的结果复用窗口（群内共享）。 */
const DEDUPE_MS = 10_000

let active = 0
const waiters: (() => void)[] = []
const recent = new Map<string, { at: number; result: unknown }>()

async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('当前已有 ' + MAX_CONCURRENT + ' 个检查在跑，排队超时，稍后再试')), QUEUE_WAIT_MS)
      waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }
  active += 1
  let released = false
  return () => {
    if (released) return
    released = true
    active -= 1
    waiters.shift()?.()
  }
}

export interface CheckRunOutcome {
  exitCode: number | null
  timedOut: boolean
  output: string
  ms: number
}

export interface CheckResult extends CheckRunOutcome {
  command: string
  logPath?: string
  /** 命中群内复用时，原结果的时间戳。 */
  cachedAt?: number
}

export interface CheckSpec {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export type CheckRunner = (spec: CheckSpec) => Promise<CheckRunOutcome>

export interface CheckInput {
  workspaceRoot: string
  threadId: string
  rawTarget?: unknown
}

/** 校验 target：只能是工作区内的相对路径。 */
export function resolveCheckTarget(workspaceRoot: string, raw: unknown): { target?: string } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw !== 'string') return { error: 'target 必须是字符串' }
  const target = raw.trim()
  if (!target) return {}
  if (target.length > 240) return { error: 'target 太长' }
  if (!TARGET_PATTERN.test(target)) {
    return { error: 'target 只能包含字母、数字和 . / \\ @ _ -（不能有空格或 shell 符号）' }
  }
  if (isAbsolute(target)) return { error: 'target 必须是相对工作区的路径' }
  const root = resolve(workspaceRoot)
  const rel = relative(root, resolve(root, target))
  if (rel.startsWith('..') || isAbsolute(rel)) return { error: 'target 不能跑出工作区' }
  return { target }
}

/** 优先用工作区里已安装的 vitest 入口，避免依赖 shell 和 PATH。 */
export function findVitestEntry(workspaceRoot: string): string | undefined {
  for (const rel of ['node_modules/vitest/vitest.mjs', 'node_modules/vitest/dist/cli.js', 'node_modules/.bin/vitest']) {
    const abs = join(workspaceRoot, rel)
    if (existsSync(abs)) return abs
  }
  return undefined
}

/** 工作区里已安装的 TypeScript 入口（用于 typecheck：只编译，不执行）。 */
export function findTypeScriptEntry(workspaceRoot: string): string | undefined {
  for (const rel of ['node_modules/typescript/bin/tsc', 'node_modules/typescript/lib/tsc.js']) {
    const abs = join(workspaceRoot, rel)
    if (existsSync(abs)) return abs
  }
  return undefined
}

export function buildCheckArgv(entry: string, target?: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [entry, 'run', ...(target ? [target] : [])] }
}

/** typecheck 固定命令：node tsc -p tsconfig.json --noEmit --allowImportingTsExtensions（不经 shell、不写产物）。 */
export function buildTypecheckArgv(entry: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [entry, '-p', 'tsconfig.json', '--noEmit', '--allowImportingTsExtensions'],
  }
}

const defaultRunner: CheckRunner = (spec) => new Promise((resolveOutcome) => {
  const started = Date.now()
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    windowsHide: true,
  })
  let output = ''
  let timedOut = false
  const append = (chunk: Buffer) => {
    if (output.length < OUTPUT_LIMIT * 4) output += chunk.toString('utf8')
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, spec.timeoutMs)
  child.on('error', (error) => {
    clearTimeout(timer)
    resolveOutcome({ exitCode: null, timedOut, output: `${output}\n${error.message}`, ms: Date.now() - started })
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    resolveOutcome({ exitCode: code, timedOut, output, ms: Date.now() - started })
  })
})

function tail(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : `…（前面已截断）\n${text.slice(-OUTPUT_LIMIT)}`
}

/**
 * 跑一次检查：`typecheck` 走本地 tsc --noEmit，其余走工作区里已安装的 vitest。
 * 命令固定、不经 shell、超时即杀；讨论需要证据时由“测试角色”调用，不给任意终端能力。
 */
export async function runCheck(input: CheckInput, runner: CheckRunner = defaultRunner): Promise<CheckResult> {
  const parsed = resolveCheckTarget(input.workspaceRoot, input.rawTarget)
  if ('error' in parsed) throw Object.assign(new Error(parsed.error), { status: 400 })
  const mode = parsed.target && TYPECHECK_TARGETS.has(parsed.target) ? 'typecheck' : 'vitest'
  let command: string
  let args: string[]
  if (mode === 'typecheck') {
    const entry = findTypeScriptEntry(input.workspaceRoot)
    if (!entry) {
      throw new Error(
        `工作区里没找到 TypeScript（node_modules/typescript）。当前检查根：${input.workspaceRoot}。`
        + '如果源码在别的目录，请把群标题旁的「项目」改成那个目录（team 里已装好依赖）。',
      )
    }
    ({ command, args } = buildTypecheckArgv(entry))
  } else {
    const entry = findVitestEntry(input.workspaceRoot)
    if (!entry) {
      throw new Error(
        `工作区里没找到 vitest（node_modules/vitest）。当前检查根：${input.workspaceRoot}。`
        + '如果源码在别的目录，请把群标题旁的「项目」改成那个目录（team 里已装好依赖）。',
      )
    }
    ({ command, args } = buildCheckArgv(entry, parsed.target))
  }
  const commandLabel = mode === 'typecheck'
    ? 'npx tsc -p tsconfig.json --noEmit --allowImportingTsExtensions'
    : `npx vitest run${parsed.target ? ` ${parsed.target}` : ''}`
  assertSafeThreadId(input.threadId)
  const cacheDir = join(input.workspaceRoot, '.dsh-im', input.threadId, '.cache')
  await mkdir(cacheDir, { recursive: true }).catch(() => undefined)
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', CI: '1', VITEST_MIN_THREADS: '1', VITEST_MAX_THREADS: '2' }
  const key = input.workspaceRoot + '::' + (parsed.target ?? '*')
  const hit = recent.get(key) as { at: number; result: CheckResult } | undefined
  if (hit && Date.now() - hit.at < DEDUPE_MS) return { ...hit.result, cachedAt: hit.at }

  const release = await acquire()
  try {
    const outcome = await runner({ command, args, cwd: input.workspaceRoot, env, timeoutMs: TIMEOUT_MS })
    const output = tail(outcome.output)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const checkDir = join(cacheDir, 'checks')
    await mkdir(checkDir, { recursive: true }).catch(() => undefined)
    const logPath = join(checkDir, stamp + '-' + input.threadId + '.log')
    await writeFile(logPath, `${commandLabel}\n\n${outcome.output}`, 'utf8').catch(() => undefined)
    const result: CheckResult = {
      ...outcome,
      output,
      command: commandLabel,
      logPath,
    }
    recent.set(key, { at: Date.now(), result })
    return result
  } finally {
    release()
  }
}

/** 给模型看的紧凑结果：先结论，再尾部输出。 */
export function formatCheckResult(result: CheckResult): string {
  const status = result.timedOut
    ? '超时（60s 已杀）'
    : result.exitCode === 0 ? '通过（退出码 0）' : `失败（退出码 ${result.exitCode ?? '未知'}）`
  return [
    `run_check ${status}，耗时 ${Math.round(result.ms / 1000)}s`,
    `命令：${result.command}`,
    result.logPath ? `日志：${result.logPath}` : '',
    result.output.trim() ? `输出（尾部）：\n${result.output.trim()}` : '（没有输出）',
  ].filter(Boolean).join('\n')
}
