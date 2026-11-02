/**
 * A-4 native 注入：章节目录 + L1 摘要按 `NativeFrame.memoryBlock` 的模式
 * 追加到**本轮用户文本**（新字段 `contextBlock`），不写 system 前缀。
 *
 * 为什么要单测：native 增量帧默认只吃 windowLines + currentLine + factsL2；
 * 如果摘要/目录误写进 system，会毁掉 prompt 缓存（system 前缀必须稳定）。
 */
import { describe, expect, it } from 'vitest'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import { buildThreadDigest } from '../src/core/summary.ts'
import { NativeAgentSessions } from '../src/host/agent-session.ts'
import type { NativeFrame } from '../src/core/types.ts'
import type { Message, Persona, SpeakRequest, Thread } from '../src/core/types.ts'
import { buildLongSessionFixture, LONG_SESSION_PERSONAS } from './fixtures/memory/long-session.ts'

function persona(id: string, name: string, model: string): Persona {
  return {
    id,
    name,
    avatar: name.slice(0, 1),
    personality: '',
    duties: [],
    origin: 'mine',
    model,
    proactiveDm: false,
    defaultActivity: 'review',
  }
}

function longThread(): Thread {
  const fixture = buildLongSessionFixture()
  const messages: Message[] = fixture.thread.messages.map((item) => ({
    id: `m${item.seq}`,
    threadId: fixture.thread.id,
    seq: item.seq,
    kind: item.kind,
    authorName: item.authorName,
    text: item.text,
    createdAt: item.at,
  }))
  const thread: Thread = {
    id: fixture.thread.id,
    kind: 'group',
    title: fixture.thread.title,
    topic: '',
    shortSummary: '',
    memberIds: ['p-pm', 'p-arch'],
    members: LONG_SESSION_PERSONAS.map((item) => ({
      personaId: item.personaId,
      activity: 'review',
      completedRound: false,
      passedRound: false,
    })),
    projectRoot: '.',
    messages,
    unread: 0,
    roundMode: 'idle',
    createdAt: 0,
    updatedAt: 0,
  }
  const digest = buildThreadDigest(thread, undefined, { charBudget: fixture.budget.summarySplit.digestChars })
  thread.summaryState = digest
  thread.summaryUntilSeq = digest.untilSeq
  return thread
}

const windows: Record<string, number> = Object.fromEntries(
  LONG_SESSION_PERSONAS.map((entry) => [entry.personaId, entry.contextWindow]),
)

function request(thread: Thread): SpeakRequest {
  return {
    persona: persona('p-pm', '产品经理', 'mock-256k'),
    thread,
    focus: '',
    visibleMessages: thread.messages,
    identity: '',
    userGlobal: [],
    threadMemory: [],
    catalog: [],
  }
}

function capture() {
  const rows: { system: string; frame?: NativeFrame; prompt: string }[] = []
  const transport: ModelTransport = {
    async complete(input) {
      rows.push({
        system: input.system,
        ...(input.nativeFrame ? { frame: input.nativeFrame } : {}),
        prompt: input.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n'),
      })
      return '回复'
    },
  }
  return { rows, transport }
}

describe('native contextBlock：只追加到本轮用户文本，不动 system 前缀', () => {
  it('on 档：frame.contextBlock 含 L1 摘要 + 冷区目录；system 与 shadow 完全一致', async () => {
    const onCapture = capture()
    await new BoundModelSpeaker(onCapture.transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: 'standard',
      memoryContextMode: 'on',
    }).complete(request(longThread()))
    const shadowCapture = capture()
    await new BoundModelSpeaker(shadowCapture.transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: 'standard',
      memoryContextMode: 'shadow',
    }).complete(request(longThread()))

    const onRow = onCapture.rows[0]
    const shadowRow = shadowCapture.rows[0]
    expect(onRow.frame?.contextBlock).toBeDefined()
    expect(onRow.frame?.contextBlock).toContain('[更早消息摘要]')
    expect(onRow.frame?.contextBlock).toContain('[冷区章节目录')
    expect(onRow.frame?.memoryBlock).toBeDefined()
    // system 前缀不因记忆层开关而变（prompt 缓存的关键）
    expect(onRow.system).toBe(shadowRow.system)
    expect(onRow.system).not.toContain('[冷区章节目录')
    expect(onRow.system).not.toContain('[更早消息摘要]')
    // shadow 不注入 contextBlock（省算力且行为与旧版一致）
    expect(shadowRow.frame?.contextBlock).toBeUndefined()
  })

  it('agent-session.feedText：contextBlock 追加在用户文本里（增量轮，window 行不重复）', () => {
    const sessions = new NativeAgentSessions({ agents: () => undefined })
    const feed = (sessions as unknown as {
      feedText(entry: { lastDeliveredSeq: number; fullFeed: boolean }, input: { frame?: NativeFrame; system?: string }, fresh: boolean): { text: string; lines: number }
    }).feedText.bind(sessions)
    const frame: NativeFrame = {
      windowLines: [{ seq: 10, kind: 'user', authorName: '你', text: '第 10 条' }],
      currentLine: { seq: 11, kind: 'persona', authorName: '产品经理', text: '第 11 条' },
      memoryBlock: '[相关历史目录]',
      contextBlock: '[更早消息摘要]\n[冷区章节目录]',
    }
    const fed = feed({ lastDeliveredSeq: 9, fullFeed: false }, { frame }, false)
    expect(fed.text).toContain('[#10]')
    expect(fed.text).toContain('[#11]')
    expect(fed.text).toContain('[更早消息摘要]')
    expect(fed.text).toContain('[冷区章节目录]')
    // 已投喂过的行不重复（增量语义不变）
    const again = feed({ lastDeliveredSeq: 11, fullFeed: false }, { frame }, false)
    expect(again.text).not.toContain('[#10]')
    expect(again.text).toContain('[更早消息摘要]')
  })

  it('禁言角色不注入 contextBlock（与检索/记忆层同一可见性口径）', async () => {
    const thread = longThread()
    thread.members = thread.members.map((member) => (
      member.personaId === 'p-pm' ? { ...member, activity: 'muted' as const } : member
    ))
    const { rows, transport } = capture()
    await new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: 'standard',
      memoryContextMode: 'on',
    }).complete(request(thread))
    expect(rows[0].frame?.contextBlock).toBeUndefined()
  })
})
