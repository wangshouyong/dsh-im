import { describe, expect, it } from 'vitest'
import { generateAvatar } from '../src/core/avatar.ts'
import { AVATAR_BRANDS } from '../src/core/avatar-brands.ts'
import { AVATAR_PRESETS, findAvatarPreset, presetAvatarUrl } from '../src/core/avatar-presets.ts'

const PREFIX = 'data:image/svg+xml;utf8,'

function decodeDataUrl(url: string): string {
  expect(url.startsWith(PREFIX)).toBe(true)
  return decodeURIComponent(url.slice(PREFIX.length))
}

describe('预制头像（AI 品牌标识）', () => {
  it('品牌清单齐全：主流 AI 品牌都在，且 id/名字/图形都不空', () => {
    expect(AVATAR_PRESETS.length).toBe(AVATAR_BRANDS.length)
    expect(AVATAR_PRESETS.length).toBeGreaterThanOrEqual(12)
    for (const brand of AVATAR_BRANDS) {
      expect(brand.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(brand.label.trim()).not.toBe('')
      expect(brand.body).toContain('<')
      expect(brand.body.length).toBeGreaterThan(50)
    }
    // 国内外都要有，避免只有一种来源
    const ids = AVATAR_BRANDS.map((brand) => brand.id)
    for (const required of ['openai', 'claude', 'gemini', 'deepseek', 'qwen', 'kimi']) expect(ids).toContain(required)
  })

  it('id 与显示名都不重复（否则选中态会同时亮两个）', () => {
    expect(new Set(AVATAR_BRANDS.map((brand) => brand.id)).size).toBe(AVATAR_BRANDS.length)
    expect(new Set(AVATAR_BRANDS.map((brand) => brand.label)).size).toBe(AVATAR_BRANDS.length)
  })

  it('每个预置都生成 128×128 的圆形图（淡底 + 描边，深浅色主题下都看得见边界）', () => {
    for (const preset of AVATAR_PRESETS) {
      expect(preset.id).not.toBe('')
      expect(preset.label).not.toBe('')
      const svg = decodeDataUrl(preset.dataUrl)
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 40 40"')).toBe(true)
      expect(svg).toContain('<circle cx="20" cy="20"')
      expect(svg).toMatch(/fill="#[0-9a-f]{6}"/)
      expect(svg).toContain('stroke="#e3e7ee"')
      expect(svg.trim().endsWith('</svg>')).toBe(true)
    }
  })

  it('单色图标都被染深色，不留 currentColor（img 里 currentColor 不可控，可能整块消失）', () => {
    for (const preset of AVATAR_PRESETS) {
      const svg = decodeDataUrl(preset.dataUrl)
      expect(svg).not.toContain('currentColor')
      expect(svg).toContain('fill="#111827"')
    }
  })

  it('不含脚本 / 外链（data 图里不能带可执行内容或网络引用）', () => {
    for (const preset of AVATAR_PRESETS) {
      const svg = decodeDataUrl(preset.dataUrl).toLowerCase()
      expect(svg).not.toContain('<script')
      expect(svg).not.toContain('onload=')
      expect(svg).not.toContain('href="http')
      expect(svg).not.toContain('<image')
      expect(svg).not.toContain('foreignobject')
    }
  })

  it('单个头像的 data URL 不超过 12KB（会随角色写进 state.json，不能把状态文件撑爆）', () => {
    let total = 0
    for (const preset of AVATAR_PRESETS) {
      expect(preset.dataUrl.length).toBeLessThan(12 * 1024)
      total += preset.dataUrl.length
    }
    expect(total).toBeLessThan(120 * 1024)
  })

  it('findAvatarPreset 认得预制头像，不误判自动生成 / 上传的图', () => {
    for (const preset of AVATAR_PRESETS) expect(findAvatarPreset(preset.dataUrl)).toBe(preset)
    expect(findAvatarPreset('')).toBeUndefined()
    expect(findAvatarPreset(undefined)).toBeUndefined()
    expect(findAvatarPreset(generateAvatar('敏敏'))).toBeUndefined()
    expect(findAvatarPreset('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined()
  })

  it('同一品牌重复渲染得到同一个 data URL（纯函数，避免选中态抖动）', () => {
    for (const brand of AVATAR_BRANDS) expect(presetAvatarUrl(brand)).toBe(presetAvatarUrl(brand))
    expect(AVATAR_PRESETS[0].dataUrl).toBe(presetAvatarUrl(AVATAR_BRANDS[0]))
  })
})
