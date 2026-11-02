import { afterEach, describe, expect, it, vi } from 'vitest'
import { logDebug, logInfo, logWarn, setLogSink } from '../src/core/log.ts'

afterEach(() => {
  setLogSink(undefined)
  delete (globalThis as { localStorage?: unknown }).localStorage
  vi.restoreAllMocks()
})

describe('统一日志出口', () => {
  it('宿主接了 sink 后，info/warn/debug 都走 sink，不再打 console', () => {
    const seen: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setLogSink({
      info: (message) => seen.push('info:' + message),
      warn: (message, detail) => seen.push('warn:' + message + (detail === undefined ? '' : '|' + String(detail))),
      debug: (message) => seen.push('debug:' + message),
    })

    logInfo('开面板')
    logWarn('炸了', 'ENOENT')
    logDebug('细节')

    expect(seen).toEqual(['info:开面板', 'warn:炸了|ENOENT', 'debug:细节'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('localStorage 设 off 时 console 完全静默；debug 级别还要求显式打开', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    logWarn('默认会输出')
    expect(warn).toHaveBeenCalledTimes(1)

    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => 'off' }
    logWarn('被静默')
    logInfo('也被静默')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()

    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => 'debug' }
    logDebug('调试可见')
    expect(debug).toHaveBeenCalledTimes(1)
  })
})
