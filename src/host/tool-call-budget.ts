/**
 * 单轮工具调用预算（B 修复：真机一轮约 25 次工具把耗时拖到 240s 超时）。
 *
 * 三条纪律：
 * 1. 单轮工具调用有**硬上限**（默认 12，`DSH_IM_MAX_TOOL_CALLS` 可调）；
 * 2. 到上限后不再执行工具，而是把"已到上限，直接作答"作为 tool 结果喂回并强制收尾；
 * 3. 计数/是否触顶要能被 trace 与 metrics 记录（`toolCalls` / `toolBudgetExhausted`）。
 *
 * 纯逻辑、可单测；ctx.llm 工具循环与原生会话工具注册共用这一份预算实现。
 */

/** 默认单轮工具调用上限（含被重复抑制的调用；模型请求一次算一次）。 */
export const DEFAULT_TOOL_CALL_LIMIT = 12

/** 从环境变量读上限；非法/非正数回退默认。 */
export function toolCallLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.DSH_IM_MAX_TOOL_CALLS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TOOL_CALL_LIMIT
}

export interface ToolCallBudget {
  readonly limit: number
  /** 已经"请求"过多少次工具调用（被抑制的也算，防止模型靠换参数绕过预算）。 */
  used(): number
  /** 触顶后不再执行：调用方拿 refused 的 message 当 tool 结果喂回，并强制作答。 */
  tryReserve(): { ok: true } | { ok: false; message: string }
  /** 上限原因文本（trace/metrics 用）。 */
  exhaustedMessage(): string
}

export function createToolCallBudget(limit = DEFAULT_TOOL_CALL_LIMIT): ToolCallBudget {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_TOOL_CALL_LIMIT
  let used = 0
  return {
    limit: max,
    used: () => used,
    tryReserve() {
      if (used >= max) {
        return {
          ok: false,
          message: `本轮工具调用已达上限（${max} 次）。不要再调用任何工具，请直接基于目前已经看到的信息作答。`,
        }
      }
      used += 1
      return { ok: true }
    },
    exhaustedMessage() {
      return `本轮工具调用已达上限（${max} 次），已强制停止调用工具并进入作答。`
    },
  }
}
