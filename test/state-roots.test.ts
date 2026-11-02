import { describe, expect, it } from 'vitest'
import {
  defaultRootsFile,
  describeStateRoot,
  listStateRoots,
  readKnownRoots,
  recordKnownRoot,
  rootKey,
  stateFileOf,
} from '../src/host/state-roots.ts'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateOf = (personas: number, threads: { messages: number; updatedAt: number }[]) =>
  JSON.stringify({
    personas: Array.from({ length: personas }, (_, i) => ({ id: `p_${i}`, name: `p${i}` })),
    threads: threads.map((thread, i) => ({
      id: `t_${i}`,
      title: `t${i}`,
      updatedAt: thread.updatedAt,
      messages: Array.from({ length: thread.messages }, () => ({ id: 'm' })),
    })),
    memories: [],
  })

/** 用内存 map 冒充文件系统：不落盘、能精确造 ENOENT / 坏 JSON。 */
function fakeIo(files: Record<string, string>, mtimes: Record<string, number> = {}) {
  const normalize = (path: string) => path.replaceAll('\\', '/')
  return {
    readFile: async (file: string) => {
      const key = Object.keys(files).find((candidate) => normalize(candidate) === normalize(file))
      if (key === undefined) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
      return files[key]
    },
    mtime: async (file: string) => {
      const key = Object.keys(mtimes).find((candidate) => normalize(candidate) === normalize(file))
      if (key === undefined) throw new Error('ENOENT')
      return mtimes[key]
    },
  }
}

describe('数据根体检（state-roots）', () => {
  it('有数据的根：角色/会话/消息计数，updatedAt 取最晚会话', async () => {
    const io = fakeIo({ [stateFileOf('D:\\a')]: stateOf(2, [{ messages: 3, updatedAt: 200 }, { messages: 1, updatedAt: 100 }]) })
    const info = await describeStateRoot('D:\\a', { registered: true, title: 'a', io })
    expect(info).toMatchObject({
      path: 'D:\\a',
      title: 'a',
      registered: true,
      hasState: true,
      personas: 2,
      threads: 2,
      messages: 4,
      updatedAt: 200,
    })
    expect(info.error).toBeUndefined()
  })

  it('没有 state.json：hasState=false 且不算错误', async () => {
    const info = await describeStateRoot('D:\\empty', { io: fakeIo({}) })
    expect(info).toMatchObject({ hasState: false, personas: 0, threads: 0, messages: 0 })
    expect(info.error).toBeUndefined()
  })

  it('state.json 坏掉：记错误原因，不静默当成空团队', async () => {
    const io = fakeIo({ [stateFileOf('D:\\bad')]: '{not json' })
    const info = await describeStateRoot('D:\\bad', { io })
    expect(info.hasState).toBe(false)
    expect(info.error).toMatch(/JSON/i)
  })

  it('无会话时 updatedAt 退回文件 mtime', async () => {
    const file = stateFileOf('D:\\mtime')
    const io = fakeIo({ [file]: stateOf(1, []) }, { [file]: 1234 })
    const info = await describeStateRoot('D:\\mtime', { io })
    expect(info).toMatchObject({ hasState: true, threads: 0, updatedAt: 1234 })
  })

  it('listStateRoots：当前根排第一；注册信息合并；按有无数据/更新时间排序', async () => {
    const io = fakeIo({
      [stateFileOf('D:\\cur')]: stateOf(1, [{ messages: 1, updatedAt: 10 }]),
      [stateFileOf('D:\\work')]: stateOf(2, [{ messages: 5, updatedAt: 900 }]),
      [stateFileOf('D:\\used')]: stateOf(3, [{ messages: 2, updatedAt: 500 }]),
    })
    const infos = await listStateRoots({
      workspaces: [{ path: 'D:\\work', title: 'work' }],
      knownRoots: ['D:\\used', 'D:\\work'],
      current: 'D:\\cur',
      io,
    })
    expect(infos.map((info) => info.path)).toEqual(['D:\\cur', 'D:\\work', 'D:\\used'])
    expect(infos[1]).toMatchObject({ registered: true, title: 'work', hasState: true })
    expect(infos[2]).toMatchObject({ registered: false, personas: 3 })
  })

  it('当前根未注册也要列出来（失败页要能解释 400）', async () => {
    const io = fakeIo({})
    const infos = await listStateRoots({ workspaces: [{ path: 'D:\\work' }], current: 'D:\\team', io })
    expect(infos[0]).toMatchObject({ path: 'D:\\team', registered: false })
  })

  it('rootKey 在 Windows 上折叠大小写，路径去尾斜杠', () => {
    if (process.platform !== 'win32') return
    expect(rootKey('D:\\Work\\Team\\')).toBe(rootKey('d:/work/team'))
  })

  it('记住用过的数据根：最近用的排最前、去重、坏文件当空处理，且永不抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-im-roots-'))
    const file = join(dir, 'known-roots.json')
    await expect(readKnownRoots(file)).resolves.toEqual([])
    await recordKnownRoot('D:\\one', file)
    await recordKnownRoot('D:\\two', file)
    await recordKnownRoot('D:\\one', file)
    const roots = await readKnownRoots(file)
    expect(roots.map((entry) => rootKey(entry))).toEqual([rootKey('D:\\one'), rootKey('D:\\two')])
    // 坏文件：读的时候当空处理；下一次记录会把它整份重写为合法 JSON。
    await writeFile(file, 'not json', 'utf8')
    await expect(readKnownRoots(file)).resolves.toEqual([])
    await recordKnownRoot('', file)
    await expect(readKnownRoots(file)).resolves.toEqual([])
    await recordKnownRoot('D:\\three', file)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ roots: ['D:\\three'] })
  })

  it('默认记忆文件放在用户目录（不随 DSH 工作区变化）', () => {
    const previous = process.env.DSH_IM_ROOTS_FILE
    delete process.env.DSH_IM_ROOTS_FILE
    try {
      expect(defaultRootsFile()).toContain('.dsh-im')
      process.env.DSH_IM_ROOTS_FILE = 'D:\\tmp\\roots.json'
      expect(defaultRootsFile()).toBe('D:\\tmp\\roots.json')
    } finally {
      if (previous === undefined) delete process.env.DSH_IM_ROOTS_FILE
      else process.env.DSH_IM_ROOTS_FILE = previous
    }
  })
})
