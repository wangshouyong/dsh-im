import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { threadDir } from '../src/core/workspace.ts'
import { groupDir } from '../src/host/event-store.ts'
import {
  listWorkspaceDir,
  nodeSink,
  readGroupBuffer,
  readWorkspaceFile,
  searchWorkspace,
  writeGroupFile,
} from '../src/core/workspace-node.ts'

describe('角色读不到 .dsh-im 内部状态', () => {
  it('列目录、读文件、搜索都屏蔽内部状态目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-internal-'))
    await mkdir(join(root, '.dsh-im', 'thread-1'), { recursive: true })
    await writeFile(join(root, '.dsh-im', 'state.json'), JSON.stringify({ secret: 'pass false' }), 'utf8')
    await writeFile(join(root, '.dsh-im', 'thread-1', '本轮汇总.md'), '内部汇总 pass false', 'utf8')
    await writeFile(join(root, 'README.md'), '项目说明 pass false', 'utf8')

    const listed = await listWorkspaceDir(root, 'thread-1', '.')
    expect(listed).not.toContain('.dsh-im/')

    await expect(readWorkspaceFile(root, 'thread-1', '.dsh-im/state.json')).rejects.toThrow(/denied|内部状态/)
    await expect(readWorkspaceFile(root, 'thread-1', './.dsh-im/thread-1/本轮汇总.md')).rejects.toThrow(/denied|内部状态/)

    const hits = await searchWorkspace(root, 'thread-1', 'pass false')
    expect(hits.some((hit) => hit.startsWith('.dsh-im/'))).toBe(false)
    expect(hits.some((hit) => hit.startsWith('README.md'))).toBe(true)
  })

  it('所有拼 threadId 的目录入口都拒绝穿越（含 nodeSink/群文件读写）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-guard-'))
    expect(() => threadDir(root, '../../evil')).toThrow(/threadId/)
    expect(() => groupDir(root, '../../evil')).toThrow(/threadId/)
    await expect(writeGroupFile(root, '../../evil', 'x.txt', 'x')).rejects.toThrow(/threadId/)
    await expect(readGroupBuffer(root, '../../evil', 'attachments/x')).rejects.toThrow(/threadId/)
    await expect(nodeSink.writeThreadFile(root, '../../evil', 'x.txt', 'x')).rejects.toThrow(/threadId/)
  })
})
