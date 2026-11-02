import { describe, expect, it } from 'vitest'
import { blockedAdvice } from '../src/core/blocked.ts'

describe('中断卡的失败码建议', () => {
  it('凭据问题建议修好再重试', () => {
    expect(blockedAdvice({ code: 'MISSING_CREDENTIAL' }).primary).toBe('retry')
    expect(blockedAdvice({ code: 'AUTH' }).hint).toContain('DSH')
  })

  it('提供方消失/额度用完建议本轮移除', () => {
    expect(blockedAdvice({ code: 'NO_ADAPTER' }).primary).toBe('skip')
    expect(blockedAdvice({ code: 'QUOTA' }).primary).toBe('skip')
  })

  it('限流建议重试，上下文超限建议先暂停', () => {
    expect(blockedAdvice({ code: 'RATE_LIMIT' }).primary).toBe('retry')
    expect(blockedAdvice({ code: 'CONTEXT_WINDOW_EXCEEDED' }).primary).toBe('pause')
  })

  it('没有 code 也给默认建议，不抛错', () => {
    expect(blockedAdvice(undefined).primary).toBe('retry')
    expect(blockedAdvice({ code: 'WHATEVER_NEW' }).primary).toBe('retry')
  })
})
