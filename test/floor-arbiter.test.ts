import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { parseState } from '../src/core/persist.ts'
import type { SpeakRequest, SpeakResult, Speaker } from '../src/core/types.ts'

class ScriptedSpeaker implements Speaker {
  readonly requests: SpeakRequest[] = []
  constructor(private readonly replies: SpeakResult[]) {}
  async complete(req: SpeakRequest): Promise<SpeakResult> {
    this.requests.push(req)
    return this.replies.shift() ?? { text: '默认回复' }
  }
}

/** 不会自己结束的 speaker：用来制造“正在生成”的并发窗口。 */
class DeferredSpeaker implements Speaker {
  readonly requests: SpeakRequest[] = []
  private pending: ((result: SpeakResult) => void)[] = []
  complete(req: SpeakRequest): Promise<SpeakResult> {
    this.requests.push(req)
    return new Promise((resolve) => this.pending.push(resolve))
  }
  releaseAll(result: SpeakResult = { text: '回复' }): void {
    for (const resolve of this.pending.splice(0)) resolve(result)
  }
}

function seed(im: ImService, root: string, activity: 'review' | 'high' = 'review') {
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '挑需求缺口',
    duties: ['需求'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: activity,
  })
  const arch = im.createPersona({
    name: '架构师',
    avatar: '架',
    personality: '挑结构风险',
    duties: ['结构'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: activity,
  })
  const qa = im.createPersona({
    name: '测试',
    avatar: '测',
    personality: '挑可测性',
    duties: ['可测性'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: activity,
  })
  const group = im.createGroup('方案评审', [pm.id, arch.id, qa.id], root)
  return { pm, arch, qa, group }
}

function personaReplies(im: ImService, threadId: string): string[] {
  const thread = im.requireThread(threadId)
  return thread.messages.filter((m) => m.kind === 'persona').map((m) => m.authorName)
}

describe('地板仲裁接线', () => {
  it('@某人 时只有他发言，并记录 speak 决策', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-floor-'))
    const speaker = new ScriptedSpeaker([{ text: '我来' }])
    const im = new ImService(speaker)
    const { qa, group } = seed(im, root)
    await im.sendUser(group.id, `@${qa.name} 跑一下 tests/xxx.test.ts`)
    expect(personaReplies(im, group.id)).toEqual([qa.name])
    expect(group.floorDecisions?.at(-1)).toMatchObject({ personaId: qa.id, action: 'speak' })
    expect(group.floorDecisions?.at(-1)?.reason).toContain('被点名')
  })

  it('被点名者正在生成 → 本轮 wait 并停下，不再插一条并发回复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-floor-'))
    const speaker = new DeferredSpeaker()
    const im = new ImService(speaker)
    const { pm, group } = seed(im, root)
    const first = im.sendUser(group.id, `@${pm.name} 先看这个`)
    expect(im.runtimeState(pm.id)?.status).toBe('thinking')

    await im.sendUser(group.id, `@${pm.name} 再看这个`)
    expect(group.floorDecisions?.at(-1)).toMatchObject({ personaId: pm.id, action: 'wait' })
    expect(group.speakingPersonaId).toBeUndefined()
    expect(speaker.requests).toHaveLength(1)
    expect(group.messages.filter((m) => m.kind === 'persona')).toHaveLength(0)

    speaker.releaseAll({ text: '第一条' })
    await first
    expect(personaReplies(im, group.id)).toEqual([pm.name])
    expect(im.runtimeState(pm.id)?.status).toBe('idle')
  })

  it('自由发言时职责命中者先被选中', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-floor-'))
    const speaker = new ScriptedSpeaker([{ text: '测试视角' }, { text: '产品视角' }])
    const im = new ImService(speaker)
    const { pm, qa } = seed(im, root, 'high')
    const group = im.createGroup('日常群', [pm.id, qa.id], root)
    await im.sendUser(group.id, '可测性怎么样，测试一下这个改动')
    expect(speaker.requests[0]?.persona.id).toBe(qa.id)
    expect(group.messages.some((m) => m.text === '测试视角')).toBe(true)
  })

  it('全员资格之外时记 pass 决策，不硬选人', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-floor-'))
    const speaker = new ScriptedSpeaker([])
    const im = new ImService(speaker)
    const { pm, arch, qa, group } = seed(im, root)
    for (const id of [pm.id, arch.id, qa.id]) im.setActivity(group.id, id, 'muted')
    await im.sendUser(group.id, '开始评审', { startReview: true })
    expect(speaker.requests).toHaveLength(0)
    expect(group.floorDecisions?.some((d) => d.action === 'pass')).toBe(true)
  })

  it('开始前体检移除的角色本轮不发言，下一轮恢复参与', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-floor-'))
    const speaker = new ScriptedSpeaker([
      { text: '产品观点' },
      { text: '测试观点' },
      { text: '产品二轮' },
      { text: '架构二轮' },
      { text: '测试二轮' },
    ])
    const im = new ImService(speaker)
    const { pm, arch, qa, group } = seed(im, root)
    await im.sendUser(group.id, '开始评审', { startReview: true, excludePersonaIds: [arch.id] })
    expect(personaReplies(im, group.id)).toEqual([pm.name, qa.name])
    await im.sendUser(group.id, '开始评审', { startReview: true })
    expect(personaReplies(im, group.id)).toContain(arch.name)
  })

  it('仲裁决策随 state.json 落盘（snapshot → parse 不丢）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-floor-'))
    const speaker = new ScriptedSpeaker([{ text: '收到' }])
    const im = new ImService(speaker)
    const { qa, group } = seed(im, root)
    await im.sendUser(group.id, `@${qa.name} 在吗`)
    const raw = JSON.stringify(im.snapshot())
    const parsed = parseState(raw)
    const decisions = parsed.threads.find((t) => t.id === group.id)?.floorDecisions
    expect(decisions?.some((d) => d.action === 'speak' && d.personaId === qa.id)).toBe(true)
  })

  it('角色 PASS 后，下一条用户消息会重新给它发言机会', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-floor-'))
    const speaker = new ScriptedSpeaker([
      { text: 'PASS：本焦点没有增量。', pass: true },
      { text: '这轮有增量' },
    ])
    const im = new ImService(speaker)
    const pm = im.createPersona({
      name: '产品经理',
      avatar: '产',
      personality: '',
      duties: ['需求'],
      proactiveDm: false,
      model: 'mock',
      defaultActivity: 'review',
    })
    const group = im.createGroup('单人群', [pm.id], root)
    await im.sendUser(group.id, '开始评审', { startReview: true })
    expect(group.members.find((m) => m.personaId === pm.id)?.passedRound).toBe(true)
    await im.sendUser(group.id, `@${pm.name} 再说说`)
    expect(group.messages.filter((m) => m.kind === 'persona').map((m) => m.text)).toContain('这轮有增量')
  })
})
