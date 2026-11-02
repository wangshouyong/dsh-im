import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { scopeCss } from '../src/client/scoped-css.ts'

const sample = `
:root { --x: 1; }
html, body, #root { height: 100%; margin: 0; }
body { background: transparent; }
.work { height: 100%; display: flex; }
.hero, .feed { padding: 16px; }
.msg .body { padding: 8px; }
.right-body { overflow: hidden; }
.dsh-im-root { color: red; }
@media (prefers-color-scheme: dark) {
  .work { color: white; }
  .hero { min-height: 50%; }
}
`

describe('插件 CSS 作用域隔离', () => {
  it('移除宿主级 html/body/#root 规则，:root 变量挂到 .dsh-im-root', () => {
    const css = scopeCss(sample)
    expect(css).not.toMatch(/html,\s*body/)
    expect(css).not.toMatch(/^\s*body\s*\{/m)
    expect(css).toContain('.dsh-im-root { --x: 1; }')
  })

  it('所有普通选择器都加上 .dsh-im-root 前缀（含逗号列表）', () => {
    const css = scopeCss(sample)
    expect(css).toContain('.dsh-im-root .work {')
    expect(css).toContain('.dsh-im-root .hero, .dsh-im-root .feed {')
    expect(css).not.toMatch(/(^|\n)\.work\s*\{/)
  })

  it('@media 内部规则也递归加前缀，且不会重复加', () => {
    const css = scopeCss(sample)
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('.dsh-im-root .work { color: white; }')
    expect(css).toContain('.dsh-im-root .hero { min-height: 50%; }')
    expect(css).not.toContain('.dsh-im-root .dsh-im-root')
  })

  it('花括号配平，不破坏 @media 嵌套', () => {
    const css = scopeCss(sample)
    expect((css.match(/\{/g) ?? []).length).toBe((css.match(/\}/g) ?? []).length)
  })

  it('不会把 .msg .body / .right-body 里的 body 当顶层 body 规则删掉', () => {
    const css = scopeCss(sample)
    expect(css).toContain('.dsh-im-root .msg .body {')
    expect(css).toContain('.dsh-im-root .right-body {')
    expect(css).not.toContain('.msg . {')
    expect(css).not.toMatch(/\.dsh-im-root \.right-?\s*\{/)
  })

  it('真实 style.css 全量作用域后仍然配平，且没有裸 .work/.hero 规则', () => {
    const source = fs.readFileSync(new URL('../src/dev/style.css', import.meta.url), 'utf8')
    const css = scopeCss(source)
    expect((css.match(/\{/g) ?? []).length).toBe((css.match(/\}/g) ?? []).length)
    expect(css).not.toMatch(/^\.work\s*\{/m)
    expect(css).not.toMatch(/^\.hero[,\s]*\{/m)
    expect(css).toContain('.dsh-im-root .work {')
    expect(css).toContain('.dsh-im-root .hero {')
    // 关键布局规则必须也被作用域化，否则 DSH 里右栏/任务板会退化成 auto 高度
    expect(css).toContain('.dsh-im-root .right-body {')
    expect(css).toContain('.dsh-im-root .task-board {')
    expect(css).toContain('.dsh-im-root .task-pane {')
    expect(css).toContain('.dsh-im-root .pane-scroll {')
    expect(css).toContain('.dsh-im-root .consensus-pane {')
    expect((css.match(/\.dsh-im-root \.dsh-im-root(?![-\w])/g) ?? []).length).toBe(0)
  })

  it('主按钮样式只作用于 .form 的直接子按钮（避免把关联工作区选择器染成蓝色）', () => {
    const source = fs.readFileSync(new URL('../src/dev/style.css', import.meta.url), 'utf8')
    const css = scopeCss(source)
    expect(css).toContain('.dsh-im-root .form > button {')
    // 回归护栏：` .form button ` 这种后代选择器会把嵌在字段里的按钮（ws-picker-btn 等）也染成主按钮蓝。
    expect(css).not.toMatch(/\.dsh-im-root \.form button[\s,{:]/)
    // 禁用态必须是灰底灰字，不能只靠降低主按钮透明度（会看起来仍像可点）。
    expect(css).toMatch(/\.dsh-im-root \.form > button:disabled \{[^}]*background: var\(--panel\)/)
  })
})
