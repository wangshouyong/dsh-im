/**
 * 测试隔离守门（2026-11-02 发现的真实数据污染）。
 *
 * 事故：单测走 `createImApi` 默认路径时，会用**用户真实 home** 的
 * `~/.dsh-im/known-roots.json` 记录数据根，实测往里写了 18 条 `%TEMP%\dshim-state-*` 垃圾。
 * 后果不只是脏：`rootOf` 白名单会把那些一次性目录也当成"用过的数据根"授权出去。
 *
 * 这里锁两件事：
 * 1. 测试进程的 roots 文件必须在临时目录（setup 生效）；
 * 2. `recordKnownRoot` 真的写到了那个临时文件，而不是 home。
 */
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultRootsFile, readKnownRoots, recordKnownRoot } from '../src/host/state-roots.ts'

describe('测试隔离：数据根记忆文件', () => {
  it('roots 文件被重定向到临时目录（不会写用户 home）', () => {
    const file = defaultRootsFile()
    expect(file.startsWith(tmpdir())).toBe(true)
    expect(file).toContain('dsh-im-test-roots-')
  })

  it('recordKnownRoot 写到隔离文件，readKnownRoots 能读回', async () => {
    const file = defaultRootsFile()
    await recordKnownRoot('D:/tmp/isolated-root-a', file)
    await recordKnownRoot('D:/tmp/isolated-root-b', file)
    const roots = await readKnownRoots(file)
    expect(roots.slice(0, 2)).toEqual(['D:/tmp/isolated-root-b', 'D:/tmp/isolated-root-a'])
    // 文件确实落在临时目录
    const raw = await readFile(join(file), 'utf8')
    expect(raw).toContain('isolated-root-a')
  })
})
