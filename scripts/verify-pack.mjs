#!/usr/bin/env node
/**
 * 发布包内容校验（`prepublishOnly` 的一环）。
 *
 * 与 `verify-tarball.mjs` 的区别：
 * - verify-tarball 只断言运行时产物在不在（防「干净 clone 打出来是 4 个文件」回归）；
 * - verify-pack 还检查「发布包里不该有的东西」以及 `dsh-plugin.json` 与 `package.json` 的一致性，
 *   避免发出去一个装不上、或版本号对不上的包。
 *
 * 用法：`npm run verify:pack`（需先 build；本脚本用 `--ignore-scripts` 打包，不会递归触发 prepack）
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'dsh-plugin.json',
  'dist/host/index.js',
  'lib/client.js',
]
const REQUIRED_PREFIXES = ['dist/core/', 'dist/host/']
/** 发布包里不应出现开发材料 */
const FORBIDDEN_PREFIXES = ['src/', 'test/', 'tools/', 'docs/', '.github/']

const PACK_ARGS = ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error']

function parsePackJson(text) {
  const source = String(text ?? '')
  for (let start = source.indexOf('['); start >= 0; start = source.indexOf('[', start + 1)) {
    try {
      const parsed = JSON.parse(source.slice(start))
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // 继续试下一个 `[`（npm 的 warn/日志可能混在 JSON 前面）
    }
  }
  return null
}

const npmExecPath = process.env.npm_execpath
const pack = npmExecPath
  ? spawnSync(process.execPath, [npmExecPath, ...PACK_ARGS], { encoding: 'utf8' })
  : spawnSync(`npm ${PACK_ARGS.join(' ')}`, { encoding: 'utf8', shell: true })

if (pack.status !== 0) {
  console.error('npm pack 失败：')
  console.error((pack.stdout || '') + (pack.stderr || ''))
  process.exit(1)
}

const parsed = parsePackJson(pack.stdout)
if (!parsed) {
  console.error('解析 npm pack 输出失败（stdout 里找不到可解析的 JSON 数组）：')
  console.error((pack.stdout || '').slice(0, 2000))
  process.exit(1)
}

const entry = parsed[0]
const files = (entry.files ?? []).map((f) => f.path)
const problems = []

for (const path of REQUIRED) {
  if (!files.includes(path)) problems.push(`缺少必需文件：${path}`)
}
for (const prefix of REQUIRED_PREFIXES) {
  if (!files.some((p) => p.startsWith(prefix))) problems.push(`缺少产物目录：${prefix}*`)
}
for (const prefix of FORBIDDEN_PREFIXES) {
  const hit = files.filter((p) => p.startsWith(prefix))
  if (hit.length) problems.push(`发布包混入开发材料：${prefix}*（${hit.slice(0, 3).join(', ')} …）`)
}

// manifest 与 package.json 一致性
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
  // 包名允许带 npm scope（@scope/dsh-im），插件身份仍是裸名 dsh-im
  const bareName = String(pkg.name).includes('/') ? String(pkg.name).split('/').pop() : String(pkg.name)
  if (manifest.id !== bareName) problems.push(`dsh-plugin.json id(${manifest.id}) 与包名裸名(${bareName}) 不一致`)
  if (manifest.name !== bareName) problems.push(`dsh-plugin.json name(${manifest.name}) 与包名裸名(${bareName}) 不一致`)
  if (manifest.version !== pkg.version) problems.push(`版本号不一致：manifest ${manifest.version} / package ${pkg.version}`)
  if (!manifest.facets?.host?.entry) problems.push('dsh-plugin.json 缺少 facets.host.entry')
  if (pkg.private === true) problems.push('package.json 仍是 private:true，不能发布')
} catch (error) {
  problems.push(`读取 package.json / dsh-plugin.json 失败：${error.message}`)
}

console.log(
  `tarball: ${entry.filename}  文件 ${entry.entryCount ?? files.length} 个  ${Math.round((entry.size ?? 0) / 1024)} kB`,
)
if (problems.length > 0) {
  console.error('发布包校验失败：')
  for (const p of problems) console.error(' - ' + p)
  process.exit(1)
}
console.log('发布包校验通过：运行时产物齐全、无开发材料混入、manifest 与 package 版本一致。')
