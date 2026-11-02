import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { parseState } from '../src/core/persist.ts'
import type { Speaker } from '../src/core/types.ts'

function setup() {
  const speaker: Speaker = {
    async complete(req) {
      return { text: `我是${req.persona.name}` }
    },
  }
  const im = new ImService(speaker)
  const qq = im.createPersona({
    name: '淇淇',
    avatar: '淇',
    personality: '直接',
    duties: ['协作'],
    model: 'mock',
    proactiveDm: true,
    defaultActivity: 'high',
  })
  const mm = im.createPersona({
    name: '测试2',
    avatar: '敏',
    personality: '稳',
    duties: ['评审'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  return { im, qq, mm }
}

describe('角色改名同步会话标题', () => {
  it('DM 标题跟着角色名走', () => {
    const { im, mm } = setup()
    const dm = im.openDm(mm.id, 'D:/ws')
    expect(dm.title).toBe('测试2')

    im.updatePersona(mm.id, { name: '敏敏' })

    expect(dm.title).toBe('敏敏')
  })

  it('三人小窗的派生标题同步', () => {
    const { im, qq, mm } = setup()
    const triad = im.createTriad([qq.id, mm.id], 'D:/ws')
    expect(triad.title).toBe('淇淇、测试2')

    im.updatePersona(mm.id, { name: '敏敏' })

    expect(triad.title).toBe('淇淇、敏敏')
  })

  it('没有 titleCustom 标记的 DM / 小窗标题按当前角色名重建（手改 title 会被自愈覆盖）', () => {
    const { im, mm } = setup()
    const dm = im.openDm(mm.id, 'D:/ws')
    dm.title = '测试2-手改'
    const triad = im.createTriad([im.createPersona({
      name: '阿蓝', avatar: '蓝', personality: '稳', duties: ['实现'], model: 'mock', proactiveDm: false, defaultActivity: 'review',
    }).id, mm.id], 'D:/ws')
    triad.title = '内部小窗'

    im.updatePersona(mm.id, { name: '敏敏' })

    expect(dm.title).toBe('敏敏')
    expect(triad.title).toBe('阿蓝、敏敏')
  })

  it('群聊标题不因为成员改名而变化', () => {
    const { im, qq, mm } = setup()
    const group = im.createGroup('方案评审', [qq.id, mm.id], 'D:/ws')
    im.updatePersona(mm.id, { name: '敏敏' })
    expect(group.title).toBe('方案评审')
  })

  it('改成同一个名字不触发任何同步（幂等）', () => {
    const { im, mm } = setup()
    const dm = im.openDm(mm.id, 'D:/ws')
    im.updatePersona(mm.id, { name: '测试2' })
    expect(dm.title).toBe('测试2')
  })

  it('旧数据加载时自愈：已过期的小窗标题按当前角色名重建，群标题不动', () => {
    const raw = JSON.stringify({
      personas: [
        { id: 'p1', name: '敏敏', duties: [], personality: '', avatar: '敏', model: 'mock' },
        { id: 'p2', name: '淇淇', duties: [], personality: '', avatar: '淇', model: 'mock' },
      ],
      threads: [
        { id: 't1', kind: 'dm', title: '测试2', memberIds: ['p1'], messages: [] },
        { id: 't2', kind: 'triad', title: '淇淇、测试2', memberIds: ['p2', 'p1'], messages: [] },
        { id: 't3', kind: 'group', title: '方案评审', memberIds: ['p1', 'p2'], messages: [] },
      ],
    })
    const state = parseState(raw)
    expect(state.threads.find((thread) => thread.id === 't1')?.title).toBe('敏敏')
    expect(state.threads.find((thread) => thread.id === 't2')?.title).toBe('淇淇、敏敏')
    expect(state.threads.find((thread) => thread.id === 't3')?.title).toBe('方案评审')
  })
})
