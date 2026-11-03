import { useEffect, useState } from 'react'

/** 面板只有两种配色，值完全由 DSH 的有效主题决定（面板自己没有偏好开关）。 */
export type PanelTheme = 'light' | 'dark'

/**
 * DSH 的 ui-theme 服务把「解析后的主题快照」投影到 document（见 DSH ui-theme 包文档）：
 * - `documentElement[data-ds-theme-source]` = 用户偏好 `light | dark | system`（宿主是否在管主题的标记）
 * - `body[data-ds-dark-theme]` = 当前实际是否为深色（**权威**，由快照的 colorScheme 决定）
 *
 * 所以面板不能自己去问 `prefers-color-scheme`：那只是宿主的一个输入来源。
 * 在浏览器里打开 DSH 时用户偏好与 OS 可以不一致，问系统会「反着来」；
 * 桌面端之所以看起来一致，是 Electron 把偏好转发给了 `nativeTheme.themeSource`。
 */
const SOURCE_ATTR = 'data-ds-theme-source'
const DARK_ATTR = 'data-ds-dark-theme'

/** 最小文档形状：不依赖真实 DOM，node 环境下可单测。 */
export interface ThemeDocument {
  body?: { hasAttribute(name: string): boolean } | null
  documentElement?: { getAttribute(name: string): string | null } | null
  defaultView?: { matchMedia?(query: string): { matches: boolean } } | null
}

/** 当前有效主题：有宿主投影就只认宿主；没有（dev 预览 / 老宿主）才退回系统偏好。 */
export function resolveTheme(doc: ThemeDocument): PanelTheme {
  if (doc.documentElement?.getAttribute(SOURCE_ATTR)) {
    return doc.body?.hasAttribute(DARK_ATTR) ? 'dark' : 'light'
  }
  return doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 最近一次解析结果（portal 浮层不在主根里，需要它把 data-theme 带过去）。 */
let current: PanelTheme | undefined

export function currentPanelTheme(): PanelTheme {
  return current ?? 'light'
}

/**
 * 订阅 DSH 主题变化：偏好切换 / 自定义主题更新 / system 档下系统配色翻转，
 * 宿主都会重新投影 DOM，这里用 MutationObserver 跟随；系统媒体查询只作兜底。
 */
export function watchTheme(apply: (theme: PanelTheme) => void, doc: Document = document): () => void {
  const emit = () => {
    const next = resolveTheme(doc)
    current = next
    apply(next)
  }
  emit()

  const Observer = (doc.defaultView as (Window & typeof globalThis) | null)?.MutationObserver ?? MutationObserver
  let observer: MutationObserver | undefined
  if (Observer && doc.body && doc.documentElement) {
    observer = new Observer(emit)
    observer.observe(doc.body, { attributes: true, attributeFilter: [DARK_ATTR] })
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: [SOURCE_ATTR] })
  }

  const media = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener?.('change', emit)
  return () => {
    observer?.disconnect()
    media?.removeEventListener?.('change', emit)
  }
}

/** 面板根用：解析 → 跟随宿主 → 返回要写到 `.dsh-im-root[data-theme]` 上的值。 */
export function usePanelTheme(): PanelTheme {
  const [theme, setTheme] = useState<PanelTheme>(() => resolveTheme(document))
  useEffect(() => watchTheme(setTheme), [])
  return theme
}
