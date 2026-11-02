/** 群聊上下文窗口：只给“本轮汇总摘要 + 最近 N 条”，避免整段历史灌给每个角色。 */
export const GROUP_WINDOW_KEEP = 100

export function groupWindow<T>(messages: readonly T[], summary: string | undefined, keep = GROUP_WINDOW_KEEP): {
  summary?: string
  recent: T[]
} {
  const sliced = messages.slice(Math.max(0, messages.length - Math.max(1, keep)))
  const trimmed = summary?.trim()
  return trimmed ? { summary: trimmed, recent: sliced } : { recent: sliced }
}
