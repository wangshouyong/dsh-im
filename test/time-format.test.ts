import { describe, expect, it } from 'vitest'
import { dayGap, formatDayLabel, formatListStamp, formatStamp, isSameDay } from '../src/core/time.ts'

/** 固定“现在”：2026-11-02 17:30（本地时区），避免测试依赖当天日期。 */
const NOW = new Date(2026, 10, 2, 17, 30, 0).getTime()
const at = (y: number, m: number, d: number, hh: number, mm: number) => new Date(y, m - 1, d, hh, mm, 0).getTime()

describe('时间展示：按本地自然日分级', () => {
  it('今天只显示时刻', () => {
    expect(formatStamp(at(2026, 11, 2, 17, 8), NOW)).toBe('17:08')
    expect(formatStamp(at(2026, 11, 2, 0, 0), NOW)).toBe('00:00')
    expect(formatStamp(at(2026, 11, 2, 23, 59), NOW)).toBe('23:59')
  })

  it('昨天补“昨天”（跨零点后仍算昨天，不是 24 小时窗口）', () => {
    expect(formatStamp(at(2026, 11, 1, 23, 55), NOW)).toBe('昨天 23:55')
    expect(formatStamp(at(2026, 11, 1, 0, 5), NOW)).toBe('昨天 00:05')
  })

  it('今年更早显示月日，跨年补年份', () => {
    expect(formatStamp(at(2026, 3, 5, 9, 7), NOW)).toBe('3月5日 09:07')
    expect(formatStamp(at(2025, 12, 31, 20, 15), NOW)).toBe('2025年12月31日 20:15')
  })

  it('未来时间（时钟偏差）不显示“明天”，按日期格式兜底', () => {
    expect(formatStamp(at(2026, 11, 3, 9, 0), NOW)).toBe('11月3日 09:00')
  })

  it('会话列表用紧凑格式（窄栏只给日期）', () => {
    expect(formatListStamp(at(2026, 11, 2, 17, 8), NOW)).toBe('17:08')
    expect(formatListStamp(at(2026, 11, 1, 23, 55), NOW)).toBe('昨天')
    expect(formatListStamp(at(2026, 3, 5, 9, 7), NOW)).toBe('3月5日')
    expect(formatListStamp(at(2025, 3, 5, 9, 7), NOW)).toBe('2025/3/5')
  })

  it('分隔条文案：今天 / 昨天 / 月日 / 年月日', () => {
    expect(formatDayLabel(at(2026, 11, 2, 8, 0), NOW)).toBe('今天')
    expect(formatDayLabel(at(2026, 11, 1, 23, 55), NOW)).toBe('昨天')
    expect(formatDayLabel(at(2026, 3, 5, 9, 7), NOW)).toBe('3月5日')
    expect(formatDayLabel(at(2025, 3, 5, 9, 7), NOW)).toBe('2025年3月5日')
  })

  it('isSameDay 只看日历日，dayGap 区分今天/昨天/前天', () => {
    expect(isSameDay(at(2026, 11, 2, 0, 1), at(2026, 11, 2, 23, 59))).toBe(true)
    expect(isSameDay(at(2026, 11, 1, 23, 59), at(2026, 11, 2, 0, 1))).toBe(false)
    expect(dayGap(at(2026, 11, 2, 0, 1), NOW)).toBe(0)
    expect(dayGap(at(2026, 11, 1, 23, 59), NOW)).toBe(1)
    expect(dayGap(at(2026, 10, 31, 12, 0), NOW)).toBe(2)
  })

  it('非法时间戳返回空串，不会把 NaN 显示到界面上', () => {
    expect(formatStamp(Number.NaN, NOW)).toBe('')
    expect(formatListStamp(Number.POSITIVE_INFINITY, NOW)).toBe('')
    expect(formatDayLabel(Number.NaN, NOW)).toBe('')
    expect(isSameDay(Number.NaN, NOW)).toBe(false)
    expect(dayGap(Number.NaN, NOW)).toBeUndefined()
  })
})
