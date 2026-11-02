import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import { buildThreadDigest } from '../src/core/summary.ts'
import type { Message, SpeakRequest, Thread } from '../src/core/types.ts'
import { createImApi } from '../src/host/im-api.ts'
import { readReceipts } from '../src/host/receipt-store.ts'

function thread(summaryUntilSeq?: number): Thread {
  return {
    id: 't1',
    kind: 'group',
    title: '方案评审',
    topic: '方案评审',
    shortSummary: '',
    memberIds: ['p1'],
    members: [{ personaId: 'p1', activity: 'review', completedRound: false, passedRound: false }],
    projectRoot: '.',
    messages: [],
    unread: 0,
    roundMode: 'review',
    createdAt: 0,
    updatedAt: 0,
    ...(summaryUntilSeq === undefined ? {} : { summaryUntilSeq }),
  }
}

function message(id: string, kind: Message['kind'], authorName: string, text: string): Message {
  return { id, threadId: 't1', kind, authorName, text, createdAt: 0 }
}

function speakRequest(visibleMessages: Message[], summaryUntilSeq?: number): SpeakRequest {
  return {
    persona: {
      id: 'p1',
      name: '产品经理',
      avatar: '产',
      personality: '',
      duties: ['需求'],
      origin: 'mine',
      model: 'deepseek-chat',
      proactiveDm: false,
      defaultActivity: 'review',
    },
    thread: thread(summaryUntilSeq),
    focus: '需求',
    visibleMessages,
    identity: '',
    userGlobal: [],
    threadMemory: [],
    catalog: [],
  }
}

describe('回执窗口接线', () => {
  it('BoundModelSpeaker 把 personaId / windowSeqs / summaryUntil / factsVersion 交给 transport', async () => {
    const seen: Parameters<ModelTransport['complete']>[0][] = []
    const prompts: string[] = []
    const speaker = new BoundModelSpeaker({
      async complete(input) {
        seen.push(input)
        prompts.push(input.messages.map((message) => message.content).join('\n'))
        return '回复'
      },
    })
    await speaker.complete(speakRequest([
      message('m1', 'user', '你', '记住：周三上线灰度'),
      message('m2', 'persona', '架构师', '结构风险'),
      message('m3', 'persona', '测试', '可测性'),
      message('m4', 'user', '你', '第二句'),
    ], 1))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ personaId: 'p1', summaryUntil: 1 })
    // 摘要覆盖到 #1；当前消息（m4）单独呈现，窗口里只剩 m2、m3（序号 2、3）。
    expect(seen[0].windowSeqs).toEqual([2, 3])
    expect(seen[0].factsVersion).toMatch(/^facts-v1:/)
    // 没有摘要投影时，事实（用户决定）也要进 prompt。
    expect(prompts[0]).toContain('[群事实/决定]')
    expect(prompts[0]).toContain('周三上线灰度')
  })

  it('有工具的角色 prompt 带工具纪律（没有 shell、不要反复读同一路径）', async () => {
    const seen: Parameters<ModelTransport['complete']>[0][] = []
    const speaker = new BoundModelSpeaker({
      async complete(input) {
        seen.push(input)
        return '回复'
      },
    })
    const request = speakRequest([message('m1', 'user', '你', '看看项目结构')])
    request.persona.toolAllow = ['read', 'search']
    await speaker.complete(request)
    expect(seen[0].system).toContain('工具纪律')
    expect(seen[0].system).toContain('没有 shell')
    expect(seen[0].system).toContain('不要反复读')

    // 没有工具的角色不写这段，避免无谓的 prompt 噪音
    const plain = speakRequest([message('m1', 'user', '你', '在吗')])
    await speaker.complete(plain)
    expect(seen[1].system).not.toContain('工具纪律')
  })

  it('长会话载入后：摘要边界裁窗口，事实仍在 prompt 里', async () => {
    const longThread = thread()
    for (let index = 1; index <= 26; index++) {
      const kind: Message['kind'] = index === 1 ? 'user' : index % 4 === 0 ? 'user' : 'persona'
      const authorName = kind === 'user' ? '你' : '架构师'
      const text = index === 1 ? '记住：周三上线灰度' : `第 ${index} 条讨论`
      longThread.messages.push(message('m' + index, kind, authorName, text))
    }
    const digest = buildThreadDigest(longThread)
    longThread.summaryState = digest
    longThread.summaryUntilSeq = digest.untilSeq
    expect(digest.untilSeq).toBe(6)

    const seen: Parameters<ModelTransport['complete']>[0][] = []
    const prompts: string[] = []
    const speaker = new BoundModelSpeaker({
      async complete(input) {
        seen.push(input)
        prompts.push(input.messages.map((entry) => entry.content).join('\n'))
        return '回复'
      },
    })
    await speaker.complete({ ...speakRequest(longThread.messages), thread: longThread })
    expect(seen[0].summaryUntil).toBe(6)
    expect(seen[0].windowSeqs?.length ?? 0).toBeLessThanOrEqual(20)
    expect((seen[0].windowSeqs ?? []).every((seq) => seq > 6)).toBe(true)
    expect(prompts[0]).toContain('[更早消息摘要]')
    expect(prompts[0]).toContain('[群事实/决定]')
    expect(prompts[0]).toContain('周三上线灰度')
  })

  it('/complete 把窗口序号与角色写进 intent（含坏值过滤）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-receipt-'))
    const api = createImApi({
      projectRoot: () => root,
      llm: () => ({
        listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek 账号' }],
        async listModels() {
          return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
        },
        async *stream() {
          yield { type: 'text-delta', text: '来自宿主模型' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    })
    const { text } = await api.complete({
      model: 'deepseek-account::deepseek-flash',
      system: '你是产品经理',
      messages: [{ role: 'user', content: '你好' }],
      threadId: 't1',
      personaId: 'p1',
      windowSeqs: [3, Number.NaN, 4, 5],
      summaryUntil: 2,
      factsVersion: 'facts-v1:deadbeef',
    })
    expect(text).toBe('来自宿主模型')
    const receipts = await readReceipts(root, 't1')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].intent).toMatchObject({
      personaId: 'p1',
      windowSeqs: [3, 4, 5],
      summaryUntil: 2,
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    })
    expect(receipts[0].intent.versions.factsVersion).toBe('facts-v1:deadbeef')
    expect(receipts[0].outcome?.finish).toBe('stop')
  })
})
