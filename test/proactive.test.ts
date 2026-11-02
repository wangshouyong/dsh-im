import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { PROACTIVE_PRESETS, proactiveEligibility } from '../src/core/proactive.ts'
import type { Persona, Speaker, Thread } from '../src/core/types.ts'

/** 固定“现在”：2026-01-01 10:00 本地时间，避免跨午夜/时区导致用例漂移。 */
const NOW = new Date(2026, 0, 1, 10, 0, 0).getTime()
const MINUTE = 60_000

function failingSpeaker(): Speaker {
  return {
    async complete() {
      throw new Error('boom')
    },
  }
}

async function setup(options: {
  proactiveDm?: boolean
  proactiveLevel?: Persona['proactiveLevel']
  replies?: string[]
  speaker?: Speaker
  idleMinutes?: number
  roundMode?: 'idle' | 'review'
} = {}) {
  const box = { calls: 0 }
  const speaker: Speaker = options.speaker ?? {
    async complete() {
      const replies = options.replies ?? ['收到', '我来跟进一下']
      const text = replies[Math.min(box.calls, replies.length - 1)]
      box.calls += 1
      return { text }
    },
  }
  const im = new ImService(speaker)
  const persona = im.createPersona({
    name: '淇淇',
    avatar: '淇',
    personality: '直接',
    duties: ['协作'],
    model: 'mock',
    proactiveDm: options.proactiveDm ?? true,
    proactiveLevel: options.proactiveLevel ?? 'standard',
    defaultActivity: 'high',
  })
  const root = await mkdtemp(join(tmpdir(), 'dshim-proactive-'))
  const group = im.createGroup('方案评审', [persona.id], root)
  // 用一条真实的用户消息建立“用户最后活跃时间”，再把它挪到过去。
  await im.sendUser(group.id, '开始评审')
  const userMessage = [...group.messages].reverse().find((message) => message.kind === 'user')
  if (userMessage) userMessage.createdAt = NOW - (options.idleMinutes ?? 60) * MINUTE
  group.roundMode = options.roundMode ?? 'idle'
  for (const message of group.messages) {
    if (message.kind === 'system') message.createdAt = NOW - 60 * MINUTE
  }
  return { im, persona, group, root }
}

function proactiveMessages(im: ImService) {
  return im.state.threads.flatMap((thread) => thread.messages).filter((message) => message.proactive)
}

describe('主动私聊调度（预设 + 刹车）', () => {
  it('标准档：用户静默 15 分钟后触发，私聊消息标 proactive、未读 +1', async () => {
    const { im, persona } = await setup()
    const result = await im.tickProactive(NOW)
    expect(result).toMatchObject({ fired: true, personaId: persona.id })
    const dm = im.state.threads.find((thread) => thread.kind === 'dm')
    expect(dm?.unread).toBe(1)
    expect(dm?.messages.at(-1)).toMatchObject({ authorName: '淇淇', proactive: true })
    expect(dm?.messages.at(-1)?.createdAt).toBe(NOW)
    expect(im.state.lastProactiveAt[persona.id]).toBe(NOW)
  })

  it('用户还活跃（静默不足）不触发；档位越高门槛越低', async () => {
    const active = await setup({ idleMinutes: 10 })
    expect(await active.im.tickProactive(NOW)).toMatchObject({ fired: false })

    const standard = await setup({ idleMinutes: 20 })
    expect((await standard.im.tickProactive(NOW)).fired).toBe(true)

    const low = await setup({ idleMinutes: 20, proactiveLevel: 'low' })
    expect(await low.im.tickProactive(NOW)).toMatchObject({ fired: false, reason: 'none-eligible' })

    const high = await setup({ idleMinutes: 20, proactiveLevel: 'high' })
    expect((await high.im.tickProactive(NOW)).fired).toBe(true)
  })

  it('冷却期不重复；过了冷却且当天额度未用完可再来一条', async () => {
    const { im } = await setup()
    expect((await im.tickProactive(NOW)).fired).toBe(true)
    const dm = im.state.threads.find((thread) => thread.kind === 'dm')!
    dm.unread = 0 // 用户已读，否则“未读不追发”会先拦住
    expect((await im.tickProactive(NOW + 10 * MINUTE)).fired).toBe(false)
    expect((await im.tickProactive(NOW + 61 * MINUTE)).fired).toBe(true)
    expect(proactiveMessages(im)).toHaveLength(2)
  })

  it('每角色每日上限（标准档 3 条）、全局每日上限生效', async () => {
    const { im, persona } = await setup()
    for (let step = 0; step < 4; step++) {
      await im.tickProactive(NOW + step * 61 * MINUTE)
      for (const thread of im.state.threads) thread.unread = 0
    }
    expect(proactiveMessages(im).filter((message) => message.authorId === persona.id)).toHaveLength(3)
    const verdict = proactiveEligibility({
      persona: { ...persona, proactiveDm: true },
      now: NOW + 400 * MINUTE,
      threads: im.state.threads,
    })
    expect(verdict.reason).toBe('daily-persona')

    im.proactiveLimits = { ...im.proactiveLimits, dailyGlobal: 1 }
    const second = im.createPersona({
      name: '敏敏',
      avatar: '敏',
      personality: '稳',
      duties: ['评审'],
      model: 'mock',
      proactiveDm: true,
      defaultActivity: 'high',
    })
    const group = im.createGroup('另一个群', [second.id], im.state.threads[0].projectRoot)
    await im.sendUser(group.id, '开始')
    for (const message of group.messages) message.createdAt = NOW - 60 * MINUTE
    ;(im.state.threads.find((thread) => thread.id === group.id) as Thread).roundMode = 'idle'
    expect(await im.tickProactive(NOW + 500 * MINUTE)).toMatchObject({ fired: false, reason: 'none-eligible' })
  })

  it('安静时段、评审进行中、评审刚结束都不打扰', async () => {
    const quiet = await setup()
    const quietNow = new Date(2026, 0, 1, 23, 30, 0).getTime()
    for (const message of quiet.group.messages) message.createdAt = quietNow - 60 * MINUTE
    expect(await quiet.im.tickProactive(quietNow)).toMatchObject({ fired: false })

    const reviewing = await setup({ roundMode: 'review' })
    expect(await reviewing.im.tickProactive(NOW)).toMatchObject({ fired: false })

    const justFinished = await setup()
    const summary = {
      id: 'sum1',
      threadId: justFinished.group.id,
      kind: 'system' as const,
      authorName: '系统主持',
      text: '本轮汇总已写入群工作区',
      createdAt: NOW - 2 * MINUTE,
    }
    justFinished.group.messages.push(summary)
    expect(await justFinished.im.tickProactive(NOW)).toMatchObject({ fired: false })

    const finishedLongAgo = await setup()
    finishedLongAgo.group.messages.push({ ...summary, id: 'sum2', createdAt: NOW - 10 * MINUTE })
    expect((await finishedLongAgo.im.tickProactive(NOW)).fired).toBe(true)
  })

  it('已有未读私聊不追发；开关关闭不触发', async () => {
    const { im } = await setup()
    expect((await im.tickProactive(NOW)).fired).toBe(true)
    const dm = im.state.threads.find((thread) => thread.kind === 'dm')!
    dm.unread = 1
    expect((await im.tickProactive(NOW + 61 * MINUTE)).fired).toBe(false)

    const off = await setup({ proactiveDm: false })
    expect(await off.im.tickProactive(NOW)).toMatchObject({ fired: false })
    expect(proactiveMessages(off.im)).toHaveLength(0)
  })

  it('模型 PASS / 空回复 / 抛错都不落消息、不抛出', async () => {
    const pass = await setup({
      speaker: {
        async complete() {
          return { text: 'PASS：没增量', pass: true }
        },
      },
    })
    expect((await pass.im.tickProactive(NOW)).fired).toBe(false)
    expect(proactiveMessages(pass.im)).toHaveLength(0)

    const empty = await setup({ replies: ['   '] })
    expect((await empty.im.tickProactive(NOW)).fired).toBe(false)

    const failing = await setup()
    ;(failing.im as unknown as { speaker: Speaker }).speaker = failingSpeaker()
    await expect(failing.im.tickProactive(NOW)).resolves.toMatchObject({ fired: false, reason: 'error' })
    expect(proactiveMessages(failing.im)).toHaveLength(0)
  })

  it('预设数值符合约定（克制/标准/活跃）', () => {
    expect(PROACTIVE_PRESETS.low).toMatchObject({ idleMinutes: 30, cooldownMinutes: 120, dailyPerPersona: 1 })
    expect(PROACTIVE_PRESETS.standard).toMatchObject({ idleMinutes: 15, cooldownMinutes: 60, dailyPerPersona: 3 })
    expect(PROACTIVE_PRESETS.high).toMatchObject({ idleMinutes: 5, cooldownMinutes: 20, dailyPerPersona: 6 })
  })
})
