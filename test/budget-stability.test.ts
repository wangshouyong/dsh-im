/**
 * A-1 热区预算恒定 + 预算变更显式事件。
 *
 * 锁死的口径：
 * 1. 同一群 × 同一档位 × 同一 ratio：`windowChars` **完全相等**（0 偏差，不是 ±2%）；
 * 2. 消息条数 / 时间 / 轮次变化不产生 `budgetChanged`（同输入两次构建必须无事件）；
 * 3. 只有成员进出 / 模型窗口变化 / 档位变化 / 显式 ratio 变化才产生
 *    `budgetChanged{from,to,reason}`，并且写进 transport 回执（host 会落 receipts/metrics）。
 */
import { describe, expect, it } from 'vitest'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import {
  budgetChangeOf,
  budgetViewOf,
  groupContextBudget,
  groupEntriesForThread,
} from '../src/core/context-budget.ts'
import type { BudgetChangedEvent, ContextBudgetReceipt } from '../src/core/context-budget.ts'
import type { Message, Persona, SpeakRequest, Thread, ThreadMember } from '../src/core/types.ts'

function member(personaId: string, activity: ThreadMember['activity'] = 'review'): ThreadMember {
  return { personaId, activity, completedRound: false, passedRound: false }
}

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

function messages(count: number, suffix: string): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${suffix}-${index}`,
    threadId: 't-budget',
    seq: index + 1,
    kind: index === count - 1 ? ('user' as const) : index % 2 === 0 ? ('user' as const) : ('persona' as const),
    authorName: index % 2 === 0 ? '你' : '架构师',
    text: `第 ${index + 1} 条（${suffix}）：接口和排期先按上一版走，灰度口径继续对齐。`,
    createdAt: index,
  }))
}

function thread(members: ThreadMember[], rows: Message[]): Thread {
  return {
    id: 't-budget',
    kind: 'group',
    title: '预算稳定性',
    topic: '',
    shortSummary: '',
    memberIds: members.map((item) => item.personaId),
    members,
    projectRoot: '.',
    messages: rows,
    unread: 0,
    roundMode: 'idle',
    createdAt: 0,
    updatedAt: 0,
  }
}

function request(target: Thread, speakerPersona = persona('p-sm', '产品经理', 'mock-256k')): SpeakRequest {
  return {
    persona: speakerPersona,
    thread: target,
    focus: '',
    visibleMessages: target.messages,
    identity: '',
    userGlobal: [],
    threadMemory: [],
    catalog: [],
  }
}

interface Captured {
  budget?: ContextBudgetReceipt
  budgetChanged?: BudgetChangedEvent
  prompt: string
}

function capture() {
  const rows: Captured[] = []
  const transport: ModelTransport = {
    async complete(input) {
      rows.push({
        ...(input.budget ? { budget: input.budget } : {}),
        ...(input.budgetChanged ? { budgetChanged: input.budgetChanged } : {}),
        prompt: input.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n'),
      })
      return '回复'
    },
  }
  return { rows, transport }
}

const windows: Record<string, number> = { 'p-sm': 256_000, 'p-big': 1_000_000 }

describe('A-1 热区预算恒定', () => {
  it('同群同档位同 ratio：多轮 windowChars 完全相等（0 偏差），且不产生 budgetChanged', async () => {
    const { rows, transport } = capture()
    const speaker = new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      modelForPersona: (id) => (id === 'p-sm' ? 'mock-256k' : 'mock-1m'),
      budgetTier: 'standard',
    })
    const target = thread([member('p-sm'), member('p-big')], messages(30, 'a'))
    await speaker.complete(request(target))
    // 第 2/3 轮：消息更多、内容略变，但预算输入没变 → 预算必须完全一致。
    target.messages = messages(34, 'b')
    await speaker.complete(request(target))
    target.messages = messages(38, 'c')
    await speaker.complete(request(target))
    const budgets = rows.map((row) => row.budget as ContextBudgetReceipt)
    expect(budgets).toHaveLength(3)
    expect(new Set(budgets.map((budget) => budget.windowChars)).size).toBe(1)
    expect(new Set(budgets.map((budget) => budget.summaryChars)).size).toBe(1)
    expect(new Set(budgets.map((budget) => budget.signature)).size).toBe(1)
    expect(budgets[0].tokens).toBe(64_000)
    expect(budgets[0].groupMinModel).toMatchObject({ personaId: 'p-sm', model: 'mock-256k', contextWindow: 256_000 })
    expect(rows[0].budgetChanged).toBeUndefined()
    expect(rows[1].budgetChanged).toBeUndefined()
    expect(rows[2].budgetChanged).toBeUndefined()
  })

  it('同输入重复构建不产生事件（纯函数级）', () => {
    const entries = groupEntriesForThread(
      { members: [member('p-sm'), member('p-big')] },
      { contextWindowForPersona: (id) => windows[id] },
    )
    const group = groupContextBudget(entries, { tier: 'standard', ratio: 1.6 })
    expect(group).toBeDefined()
    const receipt = budgetViewOf(group as NonNullable<typeof group>, { tier: 'standard', signature: 'same' })
    const changed = budgetChangeOf({
      previous: receipt,
      next: receipt,
      previousInputs: { entries, tier: 'standard', ratio: 1.6 },
      nextInputs: { entries, tier: 'standard', ratio: 1.6 },
    })
    expect(changed).toBeUndefined()
  })
})

describe('A-1 预算变更 → 显式 budgetChanged 事件', () => {
  it('成员进出：reason=members，from/to 带完整预算快照', async () => {
    const { rows, transport } = capture()
    const speaker = new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: 'standard',
    })
    const target = thread([member('p-sm'), member('p-big')], messages(20, 'a'))
    await speaker.complete(request(target))
    target.members = [member('p-big')]
    target.memberIds = ['p-big']
    await speaker.complete(request(target))
    const changed = rows[1].budgetChanged as BudgetChangedEvent
    expect(changed).toBeDefined()
    expect(changed.reason).toBe('members')
    expect(changed.from.windowChars).not.toBe(changed.to.windowChars)
    expect(changed.to.windowChars).toBe(rows[1].budget?.windowChars)
  })

  it('模型窗口变化：reason=model；成员集合不变', async () => {
    const { rows, transport } = capture()
    let windowOfSmall = 256_000
    const speaker = new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => (id === 'p-sm' ? windowOfSmall : windows[id]),
      budgetTier: 'standard',
    })
    const target = thread([member('p-sm'), member('p-big')], messages(20, 'a'))
    await speaker.complete(request(target))
    windowOfSmall = 128_000
    await speaker.complete(request(target))
    const changed = rows[1].budgetChanged as BudgetChangedEvent
    expect(changed?.reason).toBe('model')
    expect(changed?.to.windowChars).not.toBe(changed?.from.windowChars)
  })

  it('档位变化：reason=tier', async () => {
    const { rows, transport } = capture()
    const options = { contextWindowForPersona: (id: string) => windows[id], budgetTier: 'standard' }
    const speaker = new BoundModelSpeaker(transport, options)
    const target = thread([member('p-sm'), member('p-big')], messages(20, 'a'))
    await speaker.complete(request(target))
    options.budgetTier = 'economy'
    await speaker.complete(request(target))
    expect((rows[1].budgetChanged as BudgetChangedEvent).reason).toBe('tier')
    expect(rows[1].budget?.tier).toBe('economy')
  })

  it('显式 ratio 变化：reason=ratio', async () => {
    const { rows, transport } = capture()
    const options = { contextWindowForPersona: (id: string) => windows[id], budgetTier: 'standard', ratio: 1.6 }
    const speaker = new BoundModelSpeaker(transport, options)
    const target = thread([member('p-sm'), member('p-big')], messages(20, 'a'))
    await speaker.complete(request(target))
    options.ratio = 2.4
    await speaker.complete(request(target))
    expect((rows[1].budgetChanged as BudgetChangedEvent).reason).toBe('ratio')
    expect(rows[1].budget?.windowChars).not.toBe(rows[0].budget?.windowChars)
  })

  it('预算变更事件只由显式输入触发（不是每轮都写）', async () => {
    const { rows, transport } = capture()
    const speaker = new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: 'standard',
    })
    const target = thread([member('p-sm'), member('p-big')], messages(20, 'a'))
    for (let turn = 0; turn < 4; turn++) {
      target.messages = messages(20 + turn, `turn-${turn}`)
      await speaker.complete(request(target))
    }
    expect(rows.filter((row) => row.budgetChanged)).toHaveLength(0)
    expect(new Set(rows.map((row) => row.budget?.windowChars)).size).toBe(1)
  })

  it('禁言成员变化不改变预算（禁言不算在场成员，也不产生事件）', async () => {
    const { rows, transport } = capture()
    const speaker = new BoundModelSpeaker(transport, {
      contextWindowForPersona: (id) => windows[id],
      budgetTier: 'standard',
    })
    const target = thread([member('p-sm'), member('p-big', 'muted')], messages(20, 'a'))
    await speaker.complete(request(target))
    target.members = [member('p-sm'), member('p-big', 'muted')]
    await speaker.complete(request(target))
    expect(rows[1].budgetChanged).toBeUndefined()
    // 禁言成员不参与群预算：min 仍是 256k 成员，而不是被 1M 的禁言成员拉高。
    expect(rows[0].budget?.tokens).toBe(64_000)
  })
})

describe('多角色不同上下文窗口的回放（覆盖 A-1）', () => {
  it('同一 fixture、不同成员窗口 → 各自预算不同；同窗口重复跑 → prompt 完全一致', async () => {
    const rowsA = capture()
    const rowsB = capture()
    const small = thread([member('p-sm'), member('p-big')], messages(40, 'x'))
    const big = thread([member('p-sm'), member('p-big')], messages(40, 'x'))
    for (const [captured, windowMap] of [[rowsA, windows], [rowsB, windows]] as const) {
      await new BoundModelSpeaker(captured.transport, {
        contextWindowForPersona: (id) => windowMap[id],
        budgetTier: 'standard',
      }).complete(request(small))
    }
    expect(rowsA.rows[0].prompt).toBe(rowsB.rows[0].prompt)
    expect(rowsA.rows[0].budget?.windowChars).toBe(rowsB.rows[0].budget?.windowChars)

    const bigBudgetCapture = capture()
    await new BoundModelSpeaker(bigBudgetCapture.transport, {
      contextWindowForPersona: () => 1_000_000,
      budgetTier: 'standard',
    }).complete(request(big))
    expect(bigBudgetCapture.rows[0].budget?.tokens).toBe(150_000)
    expect(bigBudgetCapture.rows[0].budget?.windowChars).not.toBe(rowsA.rows[0].budget?.windowChars)
  })
})
