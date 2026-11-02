/**
 * 时间展示口径（纯函数，`now` 可注入，便于单测）。
 *
 * 聊天里只显示「23:55」会分不清是哪一天：同一个会话跨天后，昨天 23:55 和今天 17:08
 * 看起来像同一天的两个时间点（真机截图就踩过这个坑）。所以统一按**本地自然日**分级：
 *   今天 → `17:08`；昨天 → `昨天 23:55`；今年更早 → `3月5日 17:08`；跨年 → `2025年3月5日 17:08`。
 * 会话列表更窄，用紧凑版：`17:08` / `昨天` / `3月5日` / `2025/3/5`。
 * 聊天流里跨天处另有分隔条（`formatDayLabel`）：`今天` / `昨天` / `3月5日` / `2025年3月5日`。
 */

const DAY_MS = 24 * 60 * 60 * 1000

function toDate(ts: number): Date | undefined {
  if (!Number.isFinite(ts)) return undefined
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function monthDay(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** 同一天（同一本地日历日）。非法时间戳一律 false。 */
export function isSameDay(a: number, b: number): boolean {
  const left = toDate(a)
  const right = toDate(b)
  if (!left || !right) return false
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

/**
 * 相隔几个自然日：0=今天，1=昨天，-1=明天。
 * 用本地零点相减再四舍五入，跨夏令时（23/25 小时的那天）也不会算错一天。
 */
export function dayGap(ts: number, now = Date.now()): number | undefined {
  const date = toDate(ts)
  const base = toDate(now)
  if (!date || !base) return undefined
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOfDay(base) - startOfDay(date)) / DAY_MS)
}

/** 气泡上方/消息头的时间：今天只给时刻，更早补日期。 */
export function formatStamp(ts: number, now = Date.now()): string {
  const date = toDate(ts)
  if (!date) return ''
  const gap = dayGap(ts, now) ?? 0
  if (gap === 0) return clock(date)
  if (gap === 1) return `昨天 ${clock(date)}`
  if (date.getFullYear() === new Date(now).getFullYear()) return `${monthDay(date)} ${clock(date)}`
  return `${date.getFullYear()}年${monthDay(date)} ${clock(date)}`
}

/** 会话列表用：窄栏放不下「昨天 23:55」，只给日期（今天仍给时刻）。 */
export function formatListStamp(ts: number, now = Date.now()): string {
  const date = toDate(ts)
  if (!date) return ''
  const gap = dayGap(ts, now) ?? 0
  if (gap === 0) return clock(date)
  if (gap === 1) return '昨天'
  if (date.getFullYear() === new Date(now).getFullYear()) return monthDay(date)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/** 聊天流里的日期分隔条文案。 */
export function formatDayLabel(ts: number, now = Date.now()): string {
  const date = toDate(ts)
  if (!date) return ''
  const gap = dayGap(ts, now) ?? 0
  if (gap === 0) return '今天'
  if (gap === 1) return '昨天'
  if (date.getFullYear() === new Date(now).getFullYear()) return monthDay(date)
  return `${date.getFullYear()}年${monthDay(date)}`
}
