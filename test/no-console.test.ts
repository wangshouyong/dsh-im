import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../src', import.meta.url).pathname.replace(/^\//, '')
const ALLOWED = new Set(['core/log.ts'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * 产品代码不允许直接调 console.*：统一走 core/log.ts。
 * 这是「83 处 console」的防回归闸门——新增直调会在这里红。
 */
describe('console 收口', () => {
  it('src 下除 core/log.ts 外没有 console.* 直调', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      const rel = relative(join(ROOT, '..'), file).replace(/\\/g, '/')
      if (ALLOWED.has(rel)) continue
      const text = readFileSync(file, 'utf8')
      if (/\bconsole\.(log|warn|error|info|debug|trace)\s*\(/.test(text)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
