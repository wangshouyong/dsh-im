import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import { summarizeMetrics } from '../src/core/metrics.ts'
import type { SpeakRequest, Thread } from '../src/core/types.ts'

function seed(im: ImService, root: string) {
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '挑需求缺口',
    duties: ['需求'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const qa = im.createPersona({
    name: '测试',
    avatar: '测',
    personality: '挑可测性',
    duties: ['可测性'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const group = im.createGroup('方案评审', [pm.id, qa.id], root)
  return { pm, qa, group }
}

/** 生成期间又插入一条消息的 transport（模拟“并发写方/用户插话”）。 */
function racingTransport(state: { thread?: Thread; calls: number }) {
  const transport: ModelTransport = {
    async complete(input) {
      if (input.purpose === 'extract') return '[]'
      state.calls += 1
      const thread = state.thread
      if (state.calls === 1 && thread) {
        thread.messages.push({
          id: 'm_race',
          threadId: thread.id,
          seq: thread.messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0) + 1,
          kind: 'system',
          authorName: '系统主持',
          text: '生成期间插入的新消息',
          createdAt: Date.now(),
        })
      }
      return state.calls === 1 ? '基于旧版本的回复' : '基于新版本的回复'
    },
  }
  return transport
}

describe('因果一致性（basedOnSeq + stale 三策略）', () => {
  it('regenerate（默认）：基于旧版本的回复重算一次后采用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-causal-'))
    const state: { thread?: Thread; calls: number } = { calls: 0 }
    const speaker = new BoundModelSpeaker(racingTransport(state))
    const im = new ImService(speaker)
    const { pm, group } = seed(im, root)
    state.thread = group
    await im.sendUser(group.id, `@${pm.name} 看下这个方案`)
    expect(state.calls).toBe(2)
    const replies = group.messages.filter((message) => message.kind === 'persona')
    expect(replies.map((message) => message.text)).toEqual(['基于新版本的回复'])
    expect(replies[0].basedOnSeq).toBe(2)
    expect(replies[0].stale).toBeUndefined()
    const rollup = summarizeMetrics(group.pendingMetrics ?? [])
    expect(rollup.stale).toEqual({ regenerate: 1 })
  })

  it('annotate：不重算，保留旧版本回复并打 stale 标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-causal-'))
    const state: { thread?: Thread; calls: number } = { calls: 0 }
    const im = new ImService(new BoundModelSpeaker(racingTransport(state)))
    im.stalePolicy = 'annotate'
    const { pm, group } = seed(im, root)
    state.thread = group
    await im.sendUser(group.id, `@${pm.name} 看下这个方案`)
    expect(state.calls).toBe(1)
    const reply = group.messages.find((message) => message.kind === 'persona')
    expect(reply?.text).toBe('基于旧版本的回复')
    expect(reply?.stale).toBe(true)
    expect(summarizeMetrics(group.pendingMetrics ?? []).stale).toEqual({ annotate: 1 })
  })

  it('drop：丢弃旧版本回复并留系统提示（不污染聊天记录）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-causal-'))
    const state: { thread?: Thread; calls: number } = { calls: 0 }
    const im = new ImService(new BoundModelSpeaker(racingTransport(state)))
    im.stalePolicy = 'drop'
    const { pm, group } = seed(im, root)
    state.thread = group
    await im.sendUser(group.id, `@${pm.name} 看下这个方案`)
    expect(state.calls).toBe(1)
    expect(group.messages.some((message) => message.kind === 'persona')).toBe(false)
    expect(group.messages.some((message) => message.text.includes('已丢弃'))).toBe(true)
    expect(summarizeMetrics(group.pendingMetrics ?? []).stale).toEqual({ drop: 1 })
  })

  it('用户插话打断：上一轮迟到的回复一律丢弃（不能进新一轮）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-causal-'))
    const pending: { input: Parameters<ModelTransport['complete']>[0]; resolve: (text: string) => void }[] = []
    const speaker = new BoundModelSpeaker({
      complete(input) {
        return new Promise<string>((resolve) => pending.push({ input, resolve }))
      },
    })
    const im = new ImService(speaker)
    const { pm, qa, group } = seed(im, root)

    const first = im.sendUser(group.id, `@${pm.name} 先看这个`)
    const second = im.sendUser(group.id, `@${qa.name} 你看这个`)
    expect(pending.map((call) => call.input.personaId)).toEqual([pm.id, qa.id])

    pending[0].resolve('上一轮的迟到回复')
    await first
    pending[1].resolve('新一轮的回复')
    await second

    const replies = group.messages.filter((message) => message.kind === 'persona')
    expect(replies.map((message) => message.text)).toEqual(['新一轮的回复'])
    expect(replies[0].basedOnSeq).toBeGreaterThan(0)
    expect(summarizeMetrics(group.pendingMetrics ?? []).stale).toEqual({ aborted: 1 })
  })

  it('没有 basedOnSeq 的 speaker（测试/假模型）保持原行为，不做 stale 判定', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-causal-'))
    const im = new ImService({
      async complete(req: SpeakRequest) {
        return { text: `${req.persona.name} 回复` }
      },
    })
    const { pm, group } = seed(im, root)
    await im.sendUser(group.id, `@${pm.name} 在吗`)
    const reply = group.messages.find((message) => message.kind === 'persona')
    expect(reply?.text).toBe('产品经理 回复')
    expect(reply?.stale).toBeUndefined()
    expect((group.pendingMetrics ?? []).some((entry) => entry.kind === 'stale')).toBe(false)
  })
})
