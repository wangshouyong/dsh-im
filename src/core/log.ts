/**
 * 统一日志出口：业务代码不直接调 `console.*`。
 *
 * - 浏览器里默认输出到 console；`localStorage['dsh-im:log'] = 'off'` 可静默，
 *   `= 'debug'` 打开调试输出。
 * - 宿主可以把 DSH 的 logger 通过 `setLogSink()` 接进来，日志跟着宿主走（不再走 console）。
 * - 本文件是纯函数式小工具：不 import node 模块，客户端/宿主都能用。
 */
export interface LogSink {
  info: (message: string) => void
  warn: (message: string, detail?: unknown) => void
  debug: (message: string, detail?: unknown) => void
}

export type LogLevel = 'off' | 'warn' | 'debug'

/** 单条日志的级别（info 总是输出；debug 需要显式打开）。 */
type LogCall = 'info' | 'warn' | 'debug'

const LEVEL_KEY = 'dsh-im:log'

/** 当前日志级别；宿主/Node 环境没有 localStorage 时按 warn。 */
export function logLevel(): LogLevel {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LEVEL_KEY)
    return raw === 'off' || raw === 'debug' ? raw : 'warn'
  } catch {
    return 'warn'
  }
}

let sink: LogSink | undefined

/** 注销时传 undefined 恢复 console 输出。 */
export function setLogSink(next: LogSink | undefined): void {
  sink = next
}

function detailText(detail: unknown): string {
  if (detail === undefined || detail === null) return ''
  if (detail instanceof Error) return ` ${detail.message}`
  try {
    return ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  } catch {
    return ` ${String(detail)}`
  }
}

function emit(call: LogCall, message: string, detail?: unknown): void {
  if (sink) {
    if (call === 'info') sink.info(message)
    else if (call === 'warn') sink.warn(message, detail)
    else sink.debug(message, detail)
    return
  }
  const configured = logLevel()
  if (configured === 'off') return
  if (call === 'debug' && configured !== 'debug') return
  const target = call === 'info' ? console.info : call === 'warn' ? console.warn : console.debug
  try {
    if (detail === undefined) target.call(console, message)
    else target.call(console, message + detailText(detail))
  } catch {
    // 宿主 console 被替换/不可用时静默，日志本身不能影响主流程。
  }
}

export function logInfo(message: string, detail?: unknown): void {
  emit('info', message, detail)
}

export function logWarn(message: string, detail?: unknown): void {
  emit('warn', message, detail)
}

export function logDebug(message: string, detail?: unknown): void {
  emit('debug', message, detail)
}
