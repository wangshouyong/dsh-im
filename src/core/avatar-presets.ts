import { AVATAR_BRANDS, type AvatarBrand } from './avatar-brands.ts'

/**
 * 预制头像：把各家 AI 品牌标识渲染成 128×128 的圆形头像。
 *
 * - 图形数据来自 `avatar-brands.ts`（脚本生成，来源见 `scripts/gen-avatar-brands.mjs`）；
 * - 商标归各自权利人所有，这里只作为本地角色头像的可选图案，**不代表任何关联或背书**；
 * - 全部内联成 `data:image/svg+xml`，运行时零网络请求，和其它头像一样直接进 `state.json`。
 */
export interface AvatarPreset {
  /** 稳定 id（品牌 slug），用于识别当前选中的是哪一个 */
  id: string
  /** 界面里显示 / 悬停提示的名字 */
  label: string
  /** 可直接塞进 `<img src>` 的 data URL */
  dataUrl: string
}

/** 画布边长（viewBox 单位）。 */
const CANVAS = 40
/** 品牌图形原始 viewBox 边长。 */
const GLYPH = 24
/** 图形占画布的比例：留出圆形内边距，避免贴边被裁。 */
const GLYPH_RATIO = 0.66
/** 单色图标（OpenAI / Grok / Ollama）统一染成近黑，白底上才看得清。 */
const INK = '#111827'
/** 圆底填充：极淡的灰蓝，白底面板上也有边界（纯色细线图标不至于糊在白色背景里）。 */
const PLATE = '#f4f6fa'
/** 圆底描边：再压一圈边界，浅色 logo 也能看清头像边界。 */
const RING = '#e3e7ee'

const SCALE = (CANVAS * GLYPH_RATIO) / GLYPH
const OFFSET = (CANVAS - GLYPH * SCALE) / 2

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 把一个品牌图形包成圆形头像的 SVG data URL。 */
export function presetAvatarUrl(brand: AvatarBrand): string {
  const fillRule = brand.fillRule ? ` fill-rule="${brand.fillRule}"` : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 ${CANVAS} ${CANVAS}"${fillRule}>` +
    `<circle cx="20" cy="20" r="19.5" fill="${PLATE}" stroke="${RING}" stroke-width="1"/>` +
    `<g transform="translate(${round(OFFSET)} ${round(OFFSET)}) scale(${round(SCALE)})" fill="${INK}">${brand.body}</g>` +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export const AVATAR_PRESETS: readonly AvatarPreset[] = AVATAR_BRANDS.map((brand) => ({
  id: brand.id,
  label: brand.label,
  dataUrl: presetAvatarUrl(brand),
}))

/** 当前头像命中哪个预制头像；不是预制头像（自动生成 / 上传图）返回 undefined。 */
export function findAvatarPreset(avatarUrl: string | undefined): AvatarPreset | undefined {
  if (!avatarUrl) return undefined
  return AVATAR_PRESETS.find((preset) => preset.dataUrl === avatarUrl)
}
