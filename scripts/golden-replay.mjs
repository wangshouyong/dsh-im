#!/usr/bin/env node
/**
 * 黄金快照**显式重录**（A-3）。
 *
 * 为什么不允许隐式更新：golden 是行为契约，测试发现不一致时自动改快照等于"改基线让其通过"。
 * 这里要求调用方显式传 `--allow-update`，并把重录 diff 打到终端，必须人工审阅后写进提交说明。
 *
 * 用法：
 *   npm run golden:update -- --allow-update
 *
 * 流程：spawn vitest（带 DSH_IM_UPDATE_GOLDEN=1）→ 打印 `git diff --stat` 与完整 diff 摘要。
 */
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
if (!args.includes('--allow-update')) {
  console.error('拒绝隐式更新 golden：必须显式传 --allow-update（例：npm run golden:update -- --allow-update）。')
  console.error('这是硬门：golden 变化必须人工审 diff 并写进提交说明，不允许测试自己改快照。')
  process.exit(2)
}

const env = { ...process.env, DSH_IM_UPDATE_GOLDEN: '1' }
const npmExecPath = process.env.npm_execpath
const result = npmExecPath
  ? spawnSync(process.execPath, [npmExecPath, 'exec', '--', 'vitest', 'run', 'test/golden-replay.test.ts'], { stdio: 'inherit', env })
  : spawnSync('npx', ['vitest', 'run', 'test/golden-replay.test.ts'], { stdio: 'inherit', env, shell: true })
if (result.status !== 0) {
  console.error('golden 重录失败（vitest 非 0 退出）。')
  process.exit(result.status ?? 1)
}

// 重录后把 diff 打出来（--stat + 前 200 行 patch），这是"人工审 diff"的入口。
const git = (gitArgs) => spawnSync('git', gitArgs, { encoding: 'utf8' })
const stat = git(['diff', '--stat', '--', 'test/fixtures/golden'])
if (stat.stdout?.trim()) {
  console.log('\n[golden] 变更摘要：')
  console.log(stat.stdout.trim())
  const patch = git(['--no-pager', 'diff', '--', 'test/fixtures/golden'])
  const lines = (patch.stdout ?? '').split('\n')
  console.log('\n[golden] diff（前 200 行，完整内容用 git diff 看）：')
  console.log(lines.slice(0, 200).join('\n'))
  console.log('\n[golden] 重录完成：请把上面的 diff 摘要写进提交说明，并确认不是"放宽标准"。')
} else {
  console.log('\n[golden] 无变化（快照与当前行为一致）。')
}
