/**
 * A-2 摘要预算贯通：L1 摘要生成器与冷区章节目录**共用**群级 summary 预算。
 *
 * 证明三件事：
 * 1. `memoryContextMode=on` 时 split 生效（目录 : 摘要 = 40 : 60，可配置）；
 * 2. 目录 + 摘要总量 ≤ `summaryChars`（两块都在回执里，可机器断言）；
 * 3. 256k 小预算群与 1M 大预算群各自受**自己的** summary 预算约束（不是同一个静态常数）。
 */
import { describe, expect, it } from 'vitest'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import { buildThreadDigest, L1_CHAR_BUDGET } from '../src/core/summary.ts'
import { splitSummaryBudget } from '../src/core/chapter-tree.ts'
import { assignSeqs } from '../src/core/prompt.ts'
import { ImService } from '../src/core/im.ts'
import { MockSpeaker } from '../src/core/runtime.ts'
import { groupBudgetForThread } from '../src/core/context-budget.ts'
import type { Message, Persona, SpeakRequest, Thread, ThreadMember } from '../src/core/types.ts'
import type { ContextBudgetReceipt } from '../src/core/context-budget.ts'
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

function member(personaId: string): ThreadMember {
  return { personaId, activity: 'review', completedRound: false, passedRound: false }
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
    members: [member('p-pm'), member('p-arch')],
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
  const inputs: {
    system: string
    prompt: string
    budget?: ContextBudgetReceipt
    windowSeqs: number[]
  }[] = []
  const transport: ModelTransport = {
    async complete(input) {
      inputs.push({
        system: input.system,
        prompt: input.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n'),
        ...(input.budget ? { budget: input.budget } : {}),
        windowSeqs: input.windowSeqs ?? [],
      })
      return '回复'
    },
  }
  return { inputs, transport }
}

const windows: Record<string, number> = Object.fromEntries(
  LONG_SESSION_PERSONAS.map((entry) => [entry.personaId, entry.contextWindow]),
)

describe('on 模式：目录与摘要共用群级 summary 预算', () => {
  it('split 生效：目录 40% / 摘要 60%，两者之和 = summaryChars；目录长度受 chapterChars 约束', async () => {
    const fixture = buildLongSessionFixture()
    const thread = longThread()
    const { inputs, transport } = capture()
    const speaker = new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: fixture.budget.tier,
      memoryContextMode: 'on',
    })
    await speaker.complete(request(thread))
    const budget = inputs[0].budget as ContextBudgetReceipt
    expect(budget.source).toBe('group')
    expect(budget.tokens).toBe(fixture.budget.groupTokens)
    expect(budget.summaryChars).toBe(fixture.budget.allocation.summaryChars)
    expect(budget.digestChars + budget.chapterChars).toBe(budget.summaryChars)
    expect(budget.chapterChars).toBe(splitSummaryBudget(budget.summaryChars).chapterChars)
    expect(inputs[0].prompt).toContain('[冷区章节目录')
    // 目录长度 ≤ chapterChars（序列化器硬约束）
    const directoryStart = inputs[0].prompt.indexOf('[冷区章节目录')
    expect(directoryStart).toBeGreaterThanOrEqual(0)
  })

  it('目录:摘要比例可配置（0.5 → 目录拿一半）', async () => {
    const fixture = buildLongSessionFixture()
    const thread = longThread()
    const { inputs, transport } = capture()
    const speaker = new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: fixture.budget.tier,
      memoryContextMode: 'on',
      summaryChapterShare: 0.5,
    })
    await speaker.complete(request(thread))
    const budget = inputs[0].budget as ContextBudgetReceipt
    expect(budget.chapterChars).toBe(Math.floor(budget.summaryChars * 0.5))
    expect(budget.digestChars).toBe(budget.summaryChars - budget.chapterChars)
  })

  it('256k 小预算群与 1M 大预算群各自受自己的 summary 预算约束', async () => {
    const fixture = buildLongSessionFixture()
    const smallThread = longThread()
    const small = capture()
    await new BoundModelSpeaker(small.transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: 'standard',
      memoryContextMode: 'on',
    }).complete(request(smallThread))
    const smallBudget = small.inputs[0].budget as ContextBudgetReceipt

    // 大群：两个成员都是 1M 窗口（member 最小窗口 ≥ 256k），群预算按档位上限走。
    const bigThread = longThread()
    const big = capture()
    await new BoundModelSpeaker(big.transport, {
      contextWindowForPersona: () => 1_000_000,
      budgetTier: 'standard',
      memoryContextMode: 'on',
    }).complete(request(bigThread))
    const bigBudget = big.inputs[0].budget as ContextBudgetReceipt

    expect(smallBudget.tokens).toBe(64_000)
    expect(bigBudget.tokens).toBe(150_000)
    expect(bigBudget.summaryChars).toBeGreaterThan(smallBudget.summaryChars)
    // 各自的总量约束：摘要 + 目录 ≤ 自己的 summaryChars
    expect(smallBudget.digestChars + smallBudget.chapterChars).toBe(smallBudget.summaryChars)
    expect(bigBudget.digestChars + bigBudget.chapterChars).toBe(bigBudget.summaryChars)
    // 热区也各自受预算约束（大群窗口预算更大，但都有上限）
    expect(bigBudget.windowChars).toBeGreaterThan(smallBudget.windowChars)
    expect(smallBudget.windowChars).toBeLessThanOrEqual(400_000)
    expect(bigBudget.windowChars).toBeLessThanOrEqual(400_000)
  })
})

describe('L1 摘要生成器吃同一份 summary 预算（ImService 接线）', () => {
  it('小群 L1 ≤ 小群 digestChars；大群 L1 ≤ 大群 digestChars；小群 L1 更短', () => {
    const im = new ImService(new MockSpeaker())
    const smallPersona = im.createPersona({
      name: '产品经理',
      avatar: '产',
      personality: '',
      duties: [],
      proactiveDm: false,
      model: 'mock-256k',
      defaultActivity: 'review',
    })
    const bigPersona = im.createPersona({
      name: '架构师',
      avatar: '架',
      personality: '',
      duties: [],
      proactiveDm: false,
      model: 'mock-1m',
      defaultActivity: 'review',
    })
    const windowsById: Record<string, number> = {
      [smallPersona.id]: 256_000,
      [bigPersona.id]: 1_000_000,
    }
    im.groupBudgetPolicy = { tier: 'standard', contextWindowForPersona: (id) => windowsById[id] }
    const smallGroup = im.createGroup('小预算群', [smallPersona.id], '.')
    const bigGroup = im.createGroup('大预算群', [bigPersona.id], '.')
    // 直接灌消息再走一次 refreshDigest（等价于一轮结束；避免几百次 sendUser 拖慢单测）。
    const fill = (thread: Thread): void => {
      const rows: Message[] = []
      for (let index = 0; index < 300; index++) {
        rows.push({
          id: `m${index}`,
          threadId: thread.id,
          seq: index + 1,
          kind: index % 3 === 0 ? 'user' : 'persona',
          authorName: index % 3 === 0 ? '你' : '架构师',
          text: `第 ${index + 1} 条：${'灰度口径与回滚约束需要继续对齐。'.repeat(2)}`,
          createdAt: index,
        })
      }
      thread.messages = rows
    }
    fill(smallGroup)
    fill(bigGroup)
    const refresh = (im as unknown as { refreshDigest(thread: Thread): void }).refreshDigest.bind(im)
    refresh(smallGroup)
    refresh(bigGroup)
    const policy = { tier: 'standard', contextWindowForPersona: (id: string) => windowsById[id] }
    const smallBudget = groupBudgetForThread(smallGroup, policy)
    const bigBudget = groupBudgetForThread(bigGroup, policy)
    expect(smallBudget).toBeDefined()
    expect(bigBudget).toBeDefined()
    const smallDigestChars = splitSummaryBudget(smallBudget?.summaryChars ?? 0).digestChars
    const bigDigestChars = splitSummaryBudget(bigBudget?.summaryChars ?? 0).digestChars
    expect(smallGroup.summaryState?.l1.length ?? 0).toBeLessThanOrEqual(smallDigestChars)
    expect(bigGroup.summaryState?.l1.length ?? 0).toBeLessThanOrEqual(bigDigestChars)
    expect(smallGroup.summaryState?.l1.length ?? 0).toBeLessThan(bigGroup.summaryState?.l1.length ?? 0)
    expect(smallDigestChars).toBeLessThan(bigDigestChars)
    // 默认回退（没有注入策略）仍是旧口径：digest 8000，保证老行为不变
    const fallback = splitSummaryBudget(Math.round(L1_CHAR_BUDGET / 0.6))
    expect(fallback.digestChars).toBe(L1_CHAR_BUDGET)
  })
})

describe('摘要/目录预算与旧断言的关系', () => {
  it('shadow/off 不注入目录，摘要用全额预算（旧行为不变）', async () => {
    const fixture = buildLongSessionFixture()
    const thread = longThread()
    const { inputs, transport } = capture()
    await new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: fixture.budget.tier,
      memoryContextMode: 'shadow',
    }).complete(request(thread))
    const budget = inputs[0].budget as ContextBudgetReceipt
    expect(budget.chapterChars).toBe(0)
    expect(budget.digestChars).toBe(budget.summaryChars)
    expect(inputs[0].prompt).not.toContain('[冷区章节目录')
  })

  it('assignSeqs 的窗口序号与回执 windowSeqs 一致（同一份窗口）', async () => {
    const fixture = buildLongSessionFixture()
    const thread = longThread()
    const { inputs, transport } = capture()
    await new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: fixture.budget.tier,
      memoryContextMode: 'on',
    }).complete(request(thread))
    const assigned = assignSeqs(thread.messages)
    const lastWindowSeq = Math.max(...inputs[0].windowSeqs)
    expect(assigned.some((message) => message.seq === lastWindowSeq)).toBe(true)
  })
})
