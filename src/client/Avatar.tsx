import type { Persona } from '../core/types.ts'

/**
 * 头像。**必须是正圆**：
 * - 宿主 DSH 可能对 `img` / `button` 追加自己的 border-radius 和背景色，`border-radius: 50%`
 *   只写在样式表里会被宿主规则压掉（真机上表现为"四个角露出彩色底 + 图形是圆角方块"）；
 * - 所以这里内联 `borderRadius: '50%'`（内联优先级高于任何类选择器），并且**图片不挂 `.aN` 底色**
 *   （底色只给字母头像用；图片自带圆形底板，挂底色会在圆外四角漏色）。
 */
export function Avatar(props: { persona?: Pick<Persona, 'name' | 'avatar' | 'avatarUrl'>; text?: string; index?: number; size?: 'sm' | 'lg' }) {
  const { persona, text, index = 0, size } = props
  const src = persona?.avatarUrl
  const label = persona?.avatar || persona?.name.slice(0, 1) || text?.slice(0, 1) || '?'
  const cls = `avatar ${size === 'lg' ? 'lg' : ''}`
  if (src) return <img className={cls} style={{ borderRadius: '50%' }} src={src} alt="" />
  return <div className={`${cls} a${index % 5}`} style={{ borderRadius: '50%' }}>{label}</div>
}
