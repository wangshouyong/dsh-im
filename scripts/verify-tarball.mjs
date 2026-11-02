#!/usr/bin/env node
/**
 * 打包内容验证（分发门禁）——防止「克隆下来装不上」。
 *
 * 事故背景：`dist` / `lib` 在 `.gitignore` 里，`package.json` 也没有 `prepare`，
 * 于是干净 clone 跑 `npm pack` 只会得到 4 个文件（LICENSE / README / cordis.patch.yml / package.json），
 * **一个代码文件都没有**，但本地因为早就 build 过，`npm pack` 看起来是 107 个文件。
 * 这个脚本断言 tarball 里真的带上了运行时需要的产物：
 *   - `dist/host/index.js`（`main` / host 入口）
 *   - `dist/core/*.js`（领域层）
 *   - `lib/client.js`（客户端工厂，`exports["./client"]`）
 *   - `cordis.patch.yml`（DSH 插件补丁声明）
 *
 * 用法：`node scripts/verify-tarball.mjs`（先 `npm run build`；CI 里也这么跑）
 */
import { spawnSync } from 'node:child_process'

const REQUIRED = ['dist/host/index.js', 'lib/client.js', 'cordis.patch.yml']
const REQUIRED_PREFIXES = ['dist/core/', 'dist/host/']

const PACK_ARGS = ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=error']

/**
 * npm pack --json 的 stdout 不一定干净：npm 的 warn/notice、子进程日志都可能混在前面
 * （CI 上第一次就因此 `JSON.parse` 失败，门禁误红）。这里从第一个能成功解析的 `[` 开始切。
 */
function parsePackJson(text) {
  const source = String(text ?? '')
  for (let start = source.indexOf('['); start >= 0; start = source.indexOf('[', start + 1)) {
    try {
      const parsed = JSON.parse(source.slice(start))
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // 继续试下一个 `[`
    }
  }
  return null
}

// 优先用正在跑的 npm 自己的 CLI（`npm run` 会注入 npm_execpath），避免 shell 拼接参数；
// 直接 `node scripts/verify-tarball.mjs` 时退回一条完整命令字符串（不再把 args 交给 shell）。
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
  console.error((pack.stderr || '').slice(0, 1000))
  process.exit(1)
}
const entry = parsed[0]

const files = (entry.files ?? []).map((file) => file.path)
const missing = REQUIRED.filter((path) => !files.includes(path))
for (const prefix of REQUIRED_PREFIXES) {
  if (!files.some((path) => path.startsWith(prefix))) missing.push(`${prefix}*`)
}

console.log(`tarball: ${entry.filename}  文件 ${entry.entryCount ?? files.length} 个  ${Math.round((entry.size ?? 0) / 1024)} kB`)
if (missing.length > 0) {
  console.error(`打包内容缺运行时产物：${missing.join('、')}`)
  console.error('原因通常是「没 build」或「没有 prepare 脚本」——干净 clone 会装不上。')
  console.error(`当前内容：${files.slice(0, 20).join(', ')}${files.length > 20 ? ' …' : ''}`)
  process.exit(1)
}
console.log('打包内容校验通过：host/core 产物 + client bundle + cordis 补丁都在。')
