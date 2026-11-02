import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createImApi } from '../src/host/im-api.ts'
import { gcAttachments } from '../src/host/attachment-gc.ts'

async function setup(options: { withState?: boolean; withThread?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dshim-gc-'))
  const dir = join(root, '.dsh-im', 'groups', 't1', 'attachments')
  await mkdir(dir, { recursive: true })
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  for (const name of ['a_ref.png', 'a_orphan.png']) {
    const path = join(dir, name)
    await writeFile(path, name === 'a_ref.png' ? 'ref' : 'orphan')
    await utimes(path, twoDaysAgo, twoDaysAgo)
  }
  if (options.withState !== false) {
    const state = {
      version: 1,
      personas: [],
      threads: options.withThread === false ? [] : [{
        id: 't1',
        kind: 'group',
        title: '群',
        memberIds: [],
        members: [],
        messages: [{
          id: 'm1',
          threadId: 't1',
          kind: 'user',
          authorName: '你',
          text: '看',
          attachments: [{
            id: 'a_ref',
            kind: 'image',
            name: 'a_ref.png',
            mediaType: 'image/png',
            bytes: 3,
            path: 'attachments/a_ref.png',
          }],
          createdAt: 1,
        }],
        createdAt: 1,
        updatedAt: 1,
      }],
      activeThreadId: 't1',
    }
    await mkdir(join(root, '.dsh-im'), { recursive: true })
    await writeFile(join(root, '.dsh-im', 'state.json'), JSON.stringify(state), 'utf8')
  }
  return { root, dir }
}

describe('附件垃圾回收（dryRun 默认 + 服务端下限）', () => {
  it('只报告未引用且超过宽限期的文件，不删除引用/孤儿', async () => {
    const { root, dir } = await setup()
    const result = await gcAttachments(root, 't1', { dryRun: true, minAgeMs: 0 })
    expect(result.orphans.sort()).toEqual(['attachments/a_orphan.png'])
    expect(result.referenced).toBe(1)
    expect(result.scanned).toBe(2)
    expect(result.dryRun).toBe(true)
    expect(result.freed).toBe(0)
    expect(result.wouldFree).toBeGreaterThan(0)
    expect(result.failed).toBe(0)
    expect(result.statFailed).toBe(0)
    await expect(stat(join(dir, 'a_orphan.png'))).resolves.toBeTruthy()
  })

  it('群还没建 attachments/ 时不算故障（noDir，不报 errored）', async () => {
    const { root, dir } = await setup()
    await rm(dir, { recursive: true, force: true })
    const result = await gcAttachments(root, 't1', { dryRun: true })
    expect(result.scanned).toBe(0)
    expect(result.errored).toBe(0)
    expect(result.noDir).toBe(1)
  })

  it('递归处理子目录；子目录里的孤儿也能识别', async () => {
    const { root } = await setup()
    const sub = join(root, '.dsh-im', 'groups', 't1', 'attachments', '2026-10-31')
    await mkdir(sub, { recursive: true })
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const nested = join(sub, 'nested.png')
    await writeFile(nested, 'nested')
    await utimes(nested, old, old)
    const result = await gcAttachments(root, 't1', { dryRun: true })
    expect(result.orphans).toContain('attachments/2026-10-31/nested.png')
  })

  it('state 缺失或群不存在：dryRun=false 直接拒绝，绝不按零引用清空', async () => {
    const missingState = await setup({ withState: false })
    await expect(gcAttachments(missingState.root, 't1', { dryRun: false }))
      .rejects.toMatchObject({ code: 'GC_ABORT' })
    await expect(stat(join(missingState.dir, 'a_orphan.png'))).resolves.toBeTruthy()

    const missingThread = await setup({ withThread: false })
    await expect(gcAttachments(missingThread.root, 't1', { dryRun: false }))
      .rejects.toMatchObject({ code: 'GC_ABORT' })

    const api = createImApi({ projectRoot: () => missingState.root, llm: () => undefined })
    await expect(api.attachmentGc({ threadId: 't1', dryRun: false })).rejects.toMatchObject({ code: 'GC_ABORT' })
  })

  it('多注册工作区：GC 逐根扫描并标 coveredRoots，不再只扫宿主根', async () => {
    const one = await setup()
    const two = await setup()
    const api = createImApi({
      projectRoot: () => one.root,
      llm: () => undefined,
      workspaces: () => [{ path: one.root }, { path: two.root }],
    })
    const result = await api.attachmentGc({ threadId: 't1', dryRun: true })
    expect(result.coveredRoots).toHaveLength(2)
    expect(result.coveredRoots).toContain(result.root)
    expect(result.orphans).toContain('attachments/a_orphan.png')
    expect(result.orphanEntries).toHaveLength(2)
    expect(result.orphanEntries.every((entry) => entry.root && entry.path)).toBe(true)
  })

  it('同一根的大小写/尾斜杠变体只扫一次（Windows 大小写折叠）', async () => {
    const { root } = await setup()
    const variant = process.platform === 'win32' ? root.toUpperCase() : `${root}/`
    const api = createImApi({
      projectRoot: () => root,
      llm: () => undefined,
      workspaces: () => [{ path: root }, { path: variant }],
    })
    const result = await api.attachmentGc({ threadId: 't1', dryRun: true })
    expect(result.coveredRoots).toHaveLength(1)
  })

  it('宿主根没有该群、注册根有时 root 指向真扫的根', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dshim-gc-empty-'))
    const { root } = await setup()
    const api = createImApi({
      projectRoot: () => empty,
      llm: () => undefined,
      workspaces: () => [{ path: empty }, { path: root }],
    })
    const result = await api.attachmentGc({ threadId: 't1', dryRun: true })
    expect(result.coveredRoots).toEqual([root])
    expect(result.root).toBe(root)
    expect(result.coveredRoots).toContain(result.root)
    expect(result.orphanEntries).toHaveLength(1)
    expect(result.orphanEntries.every((entry) => entry.root === result.root)).toBe(true)
    expect(result.scanned).toBe(2)
  })

  it('stat / unlink 失败分别计入 statFailed / failed', async () => {
    const one = await setup()
    const statFail = await gcAttachments(one.root, 't1', {
      dryRun: false,
      statFile: (async () => { throw new Error('stat boom') }) as unknown as typeof stat,
    })
    expect(statFail.statFailed).toBeGreaterThan(0)
    expect(statFail.failed).toBe(0)

    const two = await setup()
    const unlinkFail = await gcAttachments(two.root, 't1', {
      dryRun: false,
      unlinkFile: (async () => { throw new Error('unlink boom') }) as unknown as typeof rm,
    })
    expect(unlinkFail.failed).toBeGreaterThan(0)
    expect(unlinkFail.freed).toBe(0)
    expect(unlinkFail.statFailed).toBe(0)
  })

  it('API 非 dryRun 传 minAgeMs<1h 直接 400；默认宽限期可删老文件', async () => {
    const { root } = await setup()
    const api = createImApi({ projectRoot: () => root, llm: () => undefined })
    await expect(api.attachmentGc({ threadId: 't1', dryRun: false, minAgeMs: 0 }))
      .rejects.toMatchObject({ status: 400 })

    const removed = await api.attachmentGc({ threadId: 't1', dryRun: false })
    expect(removed.orphans).toEqual(['attachments/a_orphan.png'])
    expect(removed.freed).toBeGreaterThan(0)

    const after = await api.attachmentGc({ threadId: 't1' })
    expect(after.scanned).toBe(1)
    expect(after.orphans).toEqual([])
  })

  it('非法 threadId 被拒绝', async () => {
    await expect(gcAttachments(process.cwd(), '../../evil')).rejects.toThrow(/threadId/)
  })
})
