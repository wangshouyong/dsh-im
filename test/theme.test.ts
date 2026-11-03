import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveTheme, type ThemeDocument } from '../src/client/theme.ts'

/** 造一份最小文档：模拟 DSH 投影出来的 html/body 标记与系统偏好。 */
function doc(opts: { source?: string; dark?: boolean; osDark?: boolean }): ThemeDocument {
  return {
    documentElement: {
      getAttribute: (name: string) => (name === 'data-ds-theme-source' ? opts.source ?? null : null),
    },
    body: {
      hasAttribute: (name: string) => name === 'data-ds-dark-theme' && Boolean(opts.dark),
    },
    defaultView: { matchMedia: () => ({ matches: Boolean(opts.osDark) }) },
  }
}

describe('面板跟随 DSH 的有效主题（不自己问系统）', () => {
  it('宿主深色 + 系统浅色 → 深色（宿主说了算）', () => {
    expect(resolveTheme(doc({ source: 'dark', dark: true, osDark: false }))).toBe('dark')
  })

  it('宿主浅色 + 系统深色 → 浅色（宿主说了算，面板不能反着来）', () => {
    expect(resolveTheme(doc({ source: 'light', dark: false, osDark: true }))).toBe('light')
  })

  it('偏好 system 时按宿主的实际投影（body 标记）走', () => {
    expect(resolveTheme(doc({ source: 'system', dark: true, osDark: false }))).toBe('dark')
    expect(resolveTheme(doc({ source: 'system', dark: false, osDark: true }))).toBe('light')
  })

  it('没有宿主投影（dev 预览 / 老宿主）才退回系统偏好', () => {
    expect(resolveTheme(doc({ osDark: true }))).toBe('dark')
    expect(resolveTheme(doc({ osDark: false }))).toBe('light')
  })

  it('只有 body 标记、没有宿主偏好标记时仍走系统（宿主还没投影完）', () => {
    expect(resolveTheme(doc({ dark: true, osDark: false }))).toBe('light')
    expect(resolveTheme(doc({ dark: true, osDark: true }))).toBe('dark')
  })
})

describe('样式只按 data-theme 切换，不再用系统媒体查询', () => {
  const css = readFileSync(new URL('../src/dev/style.css', import.meta.url), 'utf8')

  it('深色 token 挂在 .dsh-im-root[data-theme="dark"] 上', () => {
    expect(css).toContain('.dsh-im-root[data-theme="dark"] {')
    expect(css).toContain('color-scheme: dark;')
  })

  it('不再用 @media (prefers-color-scheme: dark) 做主题（那是自己问系统）', () => {
    expect(css).not.toContain('@media (prefers-color-scheme: dark)')
  })
})
