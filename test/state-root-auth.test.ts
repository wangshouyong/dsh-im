/**
 * 数据根授权（`rootOf` 白名单）回归 —— 2026-11-02 P0「团队数据没了」的除根用例。
 *
 * 旧行为：白名单只有 DSH 工作区注册表。DSH 重建/重装工作区表后，数据还在盘上，
 * 但面板对那个根一律 400（旧客户端又把 400 吞成空数据）。
 * 新行为：白名单 = 当前工作区 + 已注册工作区 + **用过的数据根**（known-roots，且目录必须还在、
 * 且确实是 `.dsh-im` 数据根）。这条用例锁住「注册表里没有、但确实用过的根仍然可读写」，
 * 以及「没见过的根 / 已删除的根仍然 400」——不能把「数据不在」伪装成「空数据」。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createImApi } from '../src/host/im-api.ts'

const EMPTY_STATE = JSON.stringify({ personas: [], threads: [], memories: [] })

async function setup(options: { registered?: string[]; known?: string[]; fallback: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
  const rootsFile = join(dir, 'known-roots.json')
  await writeFile(rootsFile, JSON.stringify({ roots: options.known ?? [] }), 'utf8')
  const api = createImApi({
    projectRoot: () => options.fallback,
    llm: () => undefined,
    workspaces: () => (options.registered ?? []).map((path) => ({ path })),
    rootsFile: () => rootsFile,
  })
  await api.loadKnownRoots()
  return { api, rootsFile, dir }
}

/** 造一个「真的用过的数据根」：目录里有 .dsh-im。 */
async function makeDataRoot(parent: string, name: string): Promise<string> {
  const root = join(parent, name)
  await mkdir(join(root, '.dsh-im'), { recursive: true })
  return root
}

describe('数据根授权：注册表外的历史根可读写（P0 除根）', () => {
  it('known-roots 里的根（不在 DSH 注册表）→ putState/getState 正常', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
    const fallback = join(dir, 'fallback')
    const known = await makeDataRoot(dir, 'history')
    // DSH 重建工作区表后：team 这类根不在注册表里了。
    const { api } = await setup({ fallback, known: [known], registered: [] })

    await api.putState(EMPTY_STATE, known)
    const state = await api.getState(known)
    expect(state).not.toBeNull()
    expect(state?.threads).toEqual([])
    // workspace 路由（客户端用它确认当前根）也要认。
    expect((await api.workspace(known)).path).toBe(known)
  })

  it('当前工作区就算不在注册表里也永远可用（回退根）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
    const fallback = await makeDataRoot(dir, 'current')
    const { api } = await setup({ fallback })
    expect((await api.workspace(fallback)).path).toBe(fallback)
  })

  it('从没见过的根 → 400，不回退、不静默', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
    const fallback = await makeDataRoot(dir, 'current')
    const stranger = await makeDataRoot(dir, 'stranger')
    const { api } = await setup({ fallback })
    await expect(api.workspace(stranger)).rejects.toMatchObject({ status: 400 })
  })

  it('known 里记过、但目录已删除 → 仍 400（不能把「数据不在」伪装成「空数据」）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
    const fallback = await makeDataRoot(dir, 'current')
    const gone = join(dir, 'deleted-root') // 不建目录
    const { api } = await setup({ fallback, known: [gone] })
    await expect(api.workspace(gone)).rejects.toMatchObject({ status: 400 })
  })

  it('目录还在但不是数据根（没有 .dsh-im）→ 400', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
    const fallback = await makeDataRoot(dir, 'current')
    const plain = join(dir, 'plain-folder')
    await mkdir(plain, { recursive: true })
    const { api } = await setup({ fallback, known: [plain] })
    await expect(api.workspace(plain)).rejects.toMatchObject({ status: 400 })
  })

  it('注册表与 known 都为空时，显式根一律 400（生产宿主不静默回退）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
    const fallback = await makeDataRoot(dir, 'current')
    const other = await makeDataRoot(dir, 'other')
    const { api } = await setup({ fallback })
    await expect(api.workspace(other)).rejects.toMatchObject({ status: 400 })
  })

  it('workspace() 之前先预热缓存：老代码里它是同步的，现在必须 await（这条用例守住调用约定）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshim-roots-'))
    const fallback = await makeDataRoot(dir, 'current')
    const { api } = await setup({ fallback })
    await expect(api.workspace()).resolves.toEqual({ path: fallback })
  })
})
