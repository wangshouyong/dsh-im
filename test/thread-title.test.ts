import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { parseState } from '../src/core/persist.ts'
import type { Speaker } from '../src/core/types.ts'

const speaker: Speaker = {
  async complete() {
    return { text: '收到' }
  },
}

function setup() {
  const im = new ImService(speaker)
  const qq = im.createPersona({
    name: '淇淇',
    avatar: '淇',
    personality: '直接',
    duties: ['协作'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'high',
  })
  const mm = im.createPersona({
    name: '敏敏',
    avatar: '敏',
    personality: '稳',
    duties: ['评审'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  const aa = im.createPersona({
    name: '阿蓝',
    avatar: '蓝',
    personality: '稳',
    duties: ['实现'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  return { im, qq, mm, aa }
}

describe('群名：建群时可填、建群后可改', () => {
  it('建群用用户填的名字，前后空白去掉（标题同时是话题初值）', () => {
    const { im, qq, mm } = setup()
    const group = im.createGroup('  方案评审组  ', [qq.id, mm.id], 'D:/ws')
    expect(group.title).toBe('方案评审组')
    expect(group.topic).toBe('方案评审组')
  })

  it('群名留空退回「新群」，不会出现空标题', () => {
    const { im, qq } = setup()
    expect(im.createGroup('', [qq.id], 'D:/ws').title).toBe('新群')
    expect(im.createGroup('   ', [qq.id], 'D:/ws').title).toBe('新群')
    expect(im.createGroup('新群', [qq.id], 'D:/ws').title).toBe('新群')
  })

  it('建群后可以改群名（前后空白去掉）', () => {
    const { im, qq, mm } = setup()
    const group = im.createGroup('新群', [qq.id, mm.id], 'D:/ws')
    im.setThreadTitle(group.id, '  方案评审组  ')
    expect(group.title).toBe('方案评审组')
  })

  it('空白名称直接拒绝，标题保持原样', () => {
    const { im, qq } = setup()
    const group = im.createGroup('方案评审组', [qq.id], 'D:/ws')
    expect(() => im.setThreadTitle(group.id, '   ')).toThrow(/名称不能为空/)
    expect(group.title).toBe('方案评审组')
  })

  it('改成同名是幂等操作；不存在的会话直接报错', () => {
    const { im, qq } = setup()
    const group = im.createGroup('方案评审组', [qq.id], 'D:/ws')
    expect(im.setThreadTitle(group.id, '方案评审组')).toBe(group)
    expect(() => im.setThreadTitle('t_missing', 'x')).toThrow()
  })
})

describe('三人小窗：默认派生标题，点标题改名后锁定', () => {
  it('私聊标题不允许手改（跟着角色名走）', () => {
    const { im, mm } = setup()
    const dm = im.openDm(mm.id, 'D:/ws')
    expect(() => im.setThreadTitle(dm.id, '随便改')).toThrow(/私聊标题/)
    expect(dm.title).toBe('敏敏')
  })

  it('没改过名的小窗仍随角色改名重建', () => {
    const { im, qq, mm } = setup()
    const triad = im.createTriad([qq.id, mm.id], 'D:/ws')
    expect(triad.title).toBe('淇淇、敏敏')
    expect(triad.titleCustom).toBeUndefined()

    im.updatePersona(mm.id, { name: '敏敏2' })

    expect(triad.title).toBe('淇淇、敏敏2')
  })

  it('小窗改名后 titleCustom 置 true，角色改名不再覆盖用户起的名字', () => {
    const { im, qq, mm } = setup()
    const triad = im.createTriad([qq.id, mm.id], 'D:/ws')
    im.setThreadTitle(triad.id, '薪资沟通')

    expect(triad.title).toBe('薪资沟通')
    expect(triad.titleCustom).toBe(true)

    im.updatePersona(mm.id, { name: '敏敏2' })

    expect(triad.title).toBe('薪资沟通')
  })

  it('改过的名字能落盘读回（旧数据自愈不会冲掉 titleCustom 的小窗）', () => {
    const { im, qq, mm, aa } = setup()
    const named = im.createTriad([qq.id, mm.id], 'D:/ws')
    im.setThreadTitle(named.id, '薪资沟通')
    const plain = im.createTriad([qq.id, aa.id], 'D:/ws')
    plain.title = '过期的旧标题'

    const raw = JSON.stringify({ personas: im.state.personas, threads: im.state.threads })
    const reopened = parseState(raw)

    expect(reopened.threads.find((thread) => thread.id === named.id)?.title).toBe('薪资沟通')
    expect(reopened.threads.find((thread) => thread.id === named.id)?.titleCustom).toBe(true)
    // 没有标记的旧小窗继续按当前角色名自愈
    expect(reopened.threads.find((thread) => thread.id === plain.id)?.title).toBe('淇淇、阿蓝')
  })
})

describe('群名与角色改名互不影响', () => {
  it('群标题不因成员改名变化，改过的群名也不会被旧数据自愈覆盖', () => {
    const { im, qq, mm } = setup()
    const group = im.createGroup('新群', [qq.id, mm.id], 'D:/ws')
    im.setThreadTitle(group.id, '接口评审')
    im.updatePersona(mm.id, { name: '敏敏2' })

    expect(group.title).toBe('接口评审')
    const raw = JSON.stringify({ personas: im.state.personas, threads: im.state.threads })
    expect(parseState(raw).threads.find((thread) => thread.id === group.id)?.title).toBe('接口评审')
  })
})
