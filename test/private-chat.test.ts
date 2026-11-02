import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import type { Speaker } from '../src/core/types.ts'

function speaker(): { speaker: Speaker; requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    speaker: {
      async complete(req) {
        requests.push(`${req.thread.kind}:${req.persona.name}`)
        return { text: `好的，${req.persona.name}在小窗里说` }
      },
    },
  }
}

function setup() {
  const box = speaker()
  const im = new ImService(box.speaker)
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
    name: '敏敏',
    avatar: '敏',
    personality: '稳',
    duties: ['评审'],
    model: 'mock',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  const group = im.createGroup('方案评审', [qq.id, mm.id], 'D:/ws')
  return { im, group, qq, mm, requests: box.requests }
}

describe('用户明确要求私聊：直接开小窗，不在群里排队', () => {
  it('@淇淇 找我私聊 → 建 DM、双向消息、群里有记录、回调切小窗', async () => {
    const { im, group, qq, requests } = setup()
    const opened: string[] = []
    im.onDmOpened = (threadId) => opened.push(threadId)

    await im.sendUser(group.id, '@淇淇 找我私聊一下')

    const dm = im.state.threads.find((thread) => thread.kind === 'dm' && thread.memberIds[0] === qq.id)
    expect(dm).toBeDefined()
    expect(dm?.messages.some((message) => message.kind === 'user' && message.text.includes('私聊'))).toBe(true)
    expect(dm?.messages.some((message) => message.kind === 'persona' && message.authorName === '淇淇')).toBe(true)
    expect(dm?.unread).toBe(0)
    expect(opened).toEqual([dm?.id])
    // 群里只留请求 + 系统说明，不产生群内角色回复
    expect(group.messages.at(-1)?.kind).toBe('system')
    expect(group.messages.at(-1)?.text).toContain('私聊')
    expect(group.messages.some((message) => message.kind === 'persona')).toBe(false)
    // 只有一次模型调用，且发生在 DM
    expect(requests).toEqual(['dm:淇淇'])
  })

  it('没有私聊意图时照常群聊，不会误开小窗', async () => {
    const { im, group } = setup()
    await im.sendUser(group.id, '@淇淇 你好')
    expect(im.state.threads.filter((thread) => thread.kind === 'dm')).toHaveLength(0)
  })

  it('已经在小窗里说“私聊”不会递归开新窗', async () => {
    const { im, qq } = setup()
    const dm = im.openDm(qq.id, 'D:/ws')
    await im.sendUser(dm.id, '那就私聊吧')
    expect(im.state.threads.filter((thread) => thread.kind === 'dm')).toHaveLength(1)
  })

  it('点到多个人时不开小窗（避免选错对象）', async () => {
    const { im, group } = setup()
    await im.sendUser(group.id, '@淇淇 @敏敏 你们私聊我一下')
    expect(im.state.threads.filter((thread) => thread.kind === 'dm')).toHaveLength(0)
  })
})
