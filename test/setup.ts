/**
 * vitest 全局 setup（所有测试文件生效）。
 *
 * 唯一职责：**把「用过的数据根」记忆文件指到临时目录**。
 *
 * 背景（2026-11-02 实测发现）：`createImApi` 不传 `rootsFile` 时默认用
 * `~/.dsh-im/known-roots.json`。单测里大量 `putState/getState` 走的是默认路径，
 * 于是测试把 `%TEMP%\dshim-state-*` 这种一次性目录写进了**用户真实 home**，
 * 污染了「数据根」下拉（实测 21 条里 18 条是测试垃圾）。
 * 这一层从根上断掉：测试进程里 `DSH_IM_ROOTS_FILE` 永远指向临时文件。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_IM_ROOTS_FILE) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-im-test-roots-'))
  process.env.DSH_IM_ROOTS_FILE = join(dir, 'known-roots.json')
}
