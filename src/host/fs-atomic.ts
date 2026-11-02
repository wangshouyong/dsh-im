/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 为什么必须原子：`state.json` / `known-roots.json` 是整份覆盖写的。
 * 直接 `writeFile` 时，进程崩在写一半、或两个并发写交错，都会留下半截 JSON
 * （读侧要么 parseState 抛错、要么读到空文件 → 面板表现为「数据没了」）。
 * rename 在同一目录内是原子的：读到的一定是旧版本或新版本，不会是中间态。
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 全进程唯一的临时后缀（pid + 自增），避免两个并发写撞同一个 .tmp 名字。 */
let seq = 0

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  seq += 1
  const tmp = `${path}.tmp-${process.pid}-${seq}`
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    // 临时文件不能留在工作区里（会被误当成数据文件，也污染 .dsh-im 目录）。
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
