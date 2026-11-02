/**
 * 宿主给插件 slot 的高度可能是 auto：只写 height:100% 在 DSH 里解析不出来，
 * 右栏会跟着内容长高，内部 overflow 永远不触发（滚动失效）。
 * 用“窗口底部 - 插件顶部”算确定像素高度；小于 0 说明还没挂载好，返回 0 不覆盖。
 */
export function availablePanelHeight(top: number, viewportHeight: number, minHeight = 320): number {
  const available = viewportHeight - Math.max(0, top)
  if (!Number.isFinite(available) || available <= 0) return 0
  return Math.max(minHeight, Math.floor(available))
}
