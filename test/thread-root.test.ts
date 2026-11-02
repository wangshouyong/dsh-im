import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { browseFolders, createWorkspaceViaRegistry, workspaceOptions } from '../src/host/index.ts'
import type { Speaker } from '../src/core/types.ts'

const speaker: Speaker = {
  async complete() {
    return { text: '收到' }
  },
}

describe('群的关联项目（角色读/搜/run_check 的根目录）', () => {
  it('可以改到 team，并留一条系统记录', async () => {
    const im = new ImService(speaker)
    const p = im.createPersona({
      name: '敏敏',
      avatar: '敏',
      personality: '稳',
      duties: ['评审'],
      model: 'mock',
      proactiveDm: false,
      defaultActivity: 'high',
    })
    const root = await mkdtemp(join(tmpdir(), 'dshim-root-'))
    const group = im.createGroup('评审', [p.id], root)
    expect(group.projectRoot).toBe(root)

    im.setThreadProjectRoot(group.id, 'D:\\work\\team')
    expect(group.projectRoot).toBe('D:\\work\\team')
    expect(group.messages.at(-1)?.text).toContain('关联项目已改为')
  })

  it('空目录直接拒绝，不会把项目根清掉', async () => {
    const im = new ImService(speaker)
    const p = im.createPersona({
      name: '淇淇',
      avatar: '淇',
      personality: '直接',
      duties: ['协作'],
      model: 'mock',
      proactiveDm: false,
      defaultActivity: 'high',
    })
    const group = im.createGroup('群', [p.id], '/tmp/ws')
    expect(() => im.setThreadProjectRoot(group.id, '   ')).toThrow(/不能为空/)
    expect(group.projectRoot).toBe('/tmp/ws')
  })

  it('关联工作区下拉的数据来自 DSH 原生工作区列表（标题 + 路径）', () => {
    const options = workspaceOptions({
      workspaceRegistry: {
        list: () => [
          { id: 'w1', title: 'team', path: 'D:/work/team' },
          { id: 'w2', path: 'D:/work/other' },
          { id: 'w3', title: '没有路径' },
        ],
      },
    } as unknown as Parameters<typeof workspaceOptions>[0])
    expect(options).toEqual([
      { title: 'team', path: 'D:/work/team' },
      { title: 'D:/work/other', path: 'D:/work/other' },
    ])
  })

  it('添加工作区：文件夹浏览器只列目录、带上级路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-browse-'))
    await mkdir(join(root, 'b-dir'))
    await mkdir(join(root, 'a-dir'))
    await writeFile(join(root, 'file.txt'), 'x', 'utf8')
    const listing = await browseFolders(root)
    expect(listing.path).toBe(root)
    expect(listing.parent).toBe(dirname(root))
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a-dir', 'b-dir'])
    expect(listing.entries.every((entry) => entry.path.startsWith(root))).toBe(true)
  })

  it('添加工作区要保留 this：DSH create 内部会用到 this.enqueueOperation', async () => {
    const registry = {
      ops: [] as string[],
      enqueueOperation(value: string) { this.ops.push(value) },
      async create(path: string, title?: string) {
        this.enqueueOperation(path)
        return { path, title }
      },
    }
    const created = await createWorkspaceViaRegistry(registry, 'D:/work/team', '演示')
    expect(created).toMatchObject({ path: 'D:/work/team', title: '演示' })
    expect(registry.ops).toEqual(['D:/work/team'])
  })
})
