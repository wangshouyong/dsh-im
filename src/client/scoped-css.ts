/**
 * 插件 CSS 是全局注入的，而宿主 DSH 页面也有 .work/.head/.hero/.tabs 这类通用 class。
 * 必须把所有规则收进 `.dsh-im-root` 作用域，否则会污染宿主布局
 * （只在新群空态这类特定组合下暴露成“上方一片空白”）。
 */
export function scopeCss(source: string): string {
  const cleaned = source
    // 先去掉注释：否则注释会混进 selectors，作用域后规则不可预测。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/html,\s*body,\s*#root\s*\{[^}]*\}/g, '')
    // 只删“顶层 body {…}”。不能用 \bbody：那会把 .msg .body / .right-body
    // 这些类名里的 body 也删掉（DSH 里右栏和消息气泡样式全失效的原因）。
    .replace(/(^|\n)\s*body\s*\{[^}]*\}/g, '$1')
    .replace(/:root\s*\{/g, '.dsh-im-root {')
  const scopeList = (selectorText: string): string => selectorText
    .split(',')
    .map((part) => {
      const selector = part.trim()
      if (!selector) return selector
      if (selector === '.dsh-im-root' || selector.startsWith('.dsh-im-root ') || selector.startsWith('.dsh-im-root:') || selector.startsWith('.dsh-im-root.')) return selector
      if (selector.startsWith('@')) return selector
      return `.dsh-im-root ${selector}`
    })
    .join(', ')

  const render = (text: string): string => {
    let out = ''
    let cursor = 0
    while (cursor < text.length) {
      const open = text.indexOf('{', cursor)
      if (open < 0) {
        out += text.slice(cursor)
        break
      }
      const rawSelector = text.slice(cursor, open).trim()
      let depth = 0
      let close = open
      for (let index = open; index < text.length; index++) {
        if (text[index] === '{') depth++
        else if (text[index] === '}') {
          depth--
          if (depth === 0) { close = index; break }
        }
      }
      const body = text.slice(open + 1, close)
      if (rawSelector.startsWith('@media') || rawSelector.startsWith('@supports') || rawSelector.startsWith('@container')) {
        out += `${rawSelector} {\n${render(body)}\n}`
      } else {
        out += `${scopeList(rawSelector)} {${body}}`
      }
      cursor = close + 1
    }
    return out
  }
  return render(cleaned)
}
