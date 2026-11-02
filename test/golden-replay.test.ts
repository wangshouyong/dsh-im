/**
 * 黄金回放（A-3）。
 *
 * 三层快照：
 * 1. 旧剧本的语义投影（外置 `replay-golden.json`，人工审 diff）；
 * 2. 长会话 + 固化预算的 prompt 回放（外置 `long-session-golden.json`）：
 *    同一 fixture + 同一预算输入 → 相同 `promptHash`（忽略时间戳等易变字段）；
 * 3. 多角色不同上下文窗口的 replay（覆盖 A-1）：同窗口重复跑 prompt 逐字节一致，不同窗口预算不同。
 *
 * **重录只能显式**：`npm run golden:update -- --allow-update`（脚本会设 `DSH_IM_UPDATE_GOLDEN=1`）。
 * 测试在未放行时发现不一致会直接失败并提示"拒绝隐式更新"。
 */
import { describe, expect, it } from 'vitest'
import { BoundModelSpeaker, type ModelTransport } from '../src/core/runtime.ts'
import { buildThreadDigest } from '../src/core/summary.ts'
import { canonicalJson, stableHash } from '../src/core/receipt.ts'
import type { ContextBudgetReceipt } from '../src/core/context-budget.ts'
import { auditSeqUniqueness } from '../src/core/dual-window.ts'
import type { MemoryContextReceipt } from '../src/core/memory-context.ts'
import type { Message, Persona, SpeakRequest, Thread, ThreadMember } from '../src/core/types.ts'
import { buildLongSessionFixture, LONG_SESSION_PERSONAS } from './fixtures/memory/long-session.ts'
import {
  LONG_SESSION_GOLDEN_PATH,
  REPLAY_GOLDEN_PATH,
  assertGoldenUpdateAllowed,
  buildReplayDigest,
  goldenDiffSummary,
  readGoldenFile,
  readGoldenFileOrThrow,
  replayDigestOf,
  runReplayScenario,
  writeGoldenFile,
} from './fixtures/golden/replay-scenario.ts'

const UPDATE = process.env.DSH_IM_UPDATE_GOLDEN === '1'

describe('黄金回放：语义投影（脚本化 speaker + 冻结时钟）', () => {
  it('同一脚本重复跑产出同一份语义快照（去掉随机 id/时间）', async () => {
    const first = runReplayScenario()
    await first.im.sendUser(first.group.id, '开始评审')
    await first.im.sendUser(first.group.id, '@产品经理 记住：周三上线灰度')
    const second = runReplayScenario()
    await second.im.sendUser(second.group.id, '开始评审')
    await second.im.sendUser(second.group.id, '@产品经理 记住：周三上线灰度')
    const a = replayDigestOf(first.im, first.threadId)
    const b = replayDigestOf(second.im, second.threadId)
    expect(a).toEqual(b)
    const seqs = a.messages.map((message) => message.seq as number)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    for (const message of a.messages) {
      if (message.kind === 'persona') expect(message.basedOnSeq ?? 0).toBeLessThanOrEqual(message.seq as number)
    }
    expect(a.facts.map((fact) => fact.text)).toContain('周三上线灰度')
    expect(a.summary?.l2.join('\n')).toContain('周三上线灰度')
    expect(a.decisions.some((decision) => decision.action === 'speak')).toBe(true)
  })

  it('快照与黄金文件一致（未显式放行时拒绝隐式更新）', async () => {
    const digest = await buildReplayDigest()
    if (UPDATE) {
      const previous = readGoldenFile(REPLAY_GOLDEN_PATH)
      const diff = goldenDiffSummary(previous, digest)
      writeGoldenFile(REPLAY_GOLDEN_PATH, digest)
      // 重录必须能说明"改了什么"：把 diff 摘要打到 stderr（审阅/写提交说明用）。
      console.error(`[golden] replay-golden 重录：${diff}`)
      return
    }
    expect(digest).toEqual(readGoldenFileOrThrow(REPLAY_GOLDEN_PATH))
  })

  it('拒绝隐式更新：未放行时 assertGoldenUpdateAllowed 必须抛错并说明改法', () => {
    expect(() => assertGoldenUpdateAllowed(false)).toThrow(/拒绝隐式更新/)
    expect(() => assertGoldenUpdateAllowed(false)).toThrow(/golden:update/)
    expect(() => assertGoldenUpdateAllowed(true)).not.toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * 长会话 + 固化预算的 prompt 回放（A-3）
 * ------------------------------------------------------------------ */

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

function replayRequest(thread: Thread): SpeakRequest {
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

interface LongReplay {
  promptHash: string
  systemPromptHash: string
  budget: ContextBudgetReceipt
  memoryContext: MemoryContextReceipt
  windowSeqs: number[]
  summaryUntil: number
}

function captureTransport() {
  const rows: {
    system: string
    prompt: string
    budget?: ContextBudgetReceipt
    memoryContext?: MemoryContextReceipt
    windowSeqs: number[]
    summaryUntil?: number
  }[] = []
  const transport: ModelTransport = {
    async complete(input) {
      rows.push({
        system: input.system,
        prompt: input.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n'),
        ...(input.budget ? { budget: input.budget } : {}),
        ...(input.memoryContext ? { memoryContext: input.memoryContext } : {}),
        windowSeqs: input.windowSeqs ?? [],
        ...(input.summaryUntil === undefined ? {} : { summaryUntil: input.summaryUntil }),
      })
      return '回复'
    },
  }
  return { rows, transport }
}

const LONG_SESSION_WINDOWS: Record<string, number> = Object.fromEntries(
  LONG_SESSION_PERSONAS.map((entry) => [entry.personaId, entry.contextWindow]),
)

async function buildLongReplay(options: {
  contextWindowForPersona?: (personaId: string) => number | undefined
  budgetTier?: string
} = {}): Promise<{ replay: LongReplay; system: string; prompt: string; budget: ContextBudgetReceipt; memoryContext: MemoryContextReceipt }> {
  const thread = longThread()
  const { rows, transport } = captureTransport()
  const personaModels: Record<string, string> = Object.fromEntries(
    LONG_SESSION_PERSONAS.map((entry) => [entry.personaId, entry.model]),
  )
  await new BoundModelSpeaker(transport, {
    contextWindowForPersona: options.contextWindowForPersona ?? ((id) => LONG_SESSION_WINDOWS[id]),
    modelForPersona: (id) => personaModels[id],
    budgetTier: options.budgetTier ?? 'standard',
    memoryContextMode: 'on',
  }).complete(replayRequest(thread))
  const row = rows[0]
  if (!row.budget || !row.memoryContext) throw new Error('回放缺少 budget/memoryContext 回执')
  const replay: LongReplay = {
    promptHash: stableHash(canonicalJson({
      system: row.system,
      prompt: row.prompt,
      budget: row.budget,
      memoryContext: row.memoryContext,
      windowSeqs: row.windowSeqs,
      summaryUntil: row.summaryUntil ?? 0,
    })),
    systemPromptHash: stableHash(row.system),
    budget: row.budget,
    memoryContext: row.memoryContext,
    windowSeqs: row.windowSeqs,
    summaryUntil: row.summaryUntil ?? 0,
  }
  return { replay, system: row.system, prompt: row.prompt, budget: row.budget, memoryContext: row.memoryContext }
}

describe('黄金回放：长会话 + 固化预算（A-3）', () => {
  it('同一 fixture + 同一预算输入 → 两次回放 promptHash 相同，且预算等于 fixture 固化值', async () => {
    const fixture = buildLongSessionFixture()
    const first = await buildLongReplay()
    const second = await buildLongReplay()
    expect(first.replay.promptHash).toBe(second.replay.promptHash)
    expect(first.replay.systemPromptHash).toBe(second.replay.systemPromptHash)
    expect(first.replay.windowSeqs).toEqual(second.replay.windowSeqs)
    // 预算输入固化：任何公式漂移都会在这里失败（需要显式改 fixture 并说明）。
    expect(first.budget.tier).toBe(fixture.budget.tier)
    expect(first.budget.tokens).toBe(fixture.budget.groupTokens)
    expect(first.budget.windowChars).toBe(fixture.budget.allocation.windowChars)
    expect(first.budget.summaryChars).toBe(fixture.budget.allocation.summaryChars)
    expect(first.budget.digestChars).toBe(fixture.budget.summarySplit.digestChars)
    expect(first.budget.chapterChars).toBe(fixture.budget.summarySplit.chapterChars)
    expect(first.budget.groupMinModel).toEqual(fixture.budget.groupMinModel)
  })

  it('最终 prompt 的结构化引用里任何 seq 最多出现一次（窗口 / L1 / 目录 / 记忆块 / 段范围交叉）', async () => {
    const { replay, memoryContext } = await buildLongReplay()
    const fixture = buildLongSessionFixture()
    const thread = longThread()
    const l1Seqs = (thread.summaryState?.l1 ?? '')
      .matchAll(/#(\d+)/g)
    const l1 = [...l1Seqs].map((match) => Number(match[1]))
    const audit = auditSeqUniqueness({
      windowSeqs: replay.windowSeqs,
      directoryHandleSeqs: (memoryContext.coldZone as NonNullable<MemoryContextReceipt['coldZone']>).handleSeqs,
      memoryBlockSeqs: [
        ...memoryContext.snippetSeqs,
        ...memoryContext.handleSeqs,
        ...memoryContext.conclusionSeqs,
      ],
      segmentRefs: memoryContext.segmentRefs,
      l1Seqs: l1,
    })
    expect(audit.duplicateSeqs).toEqual([])
    // 防回退：fixture 的 L1/目录/窗口都非空，审计不是"空集通过"。
    expect(l1.length).toBeGreaterThan(0)
    expect(replay.windowSeqs.length).toBeGreaterThan(0)
    expect(fixture.thread.messages.length).toBe(600)
  })

  it('冷区章节目录进入 prompt，且目录句柄都早于热区窗口', async () => {
    const { prompt, memoryContext } = await buildLongReplay()
    expect(prompt).toContain('[冷区章节目录')
    expect(memoryContext.coldZone).toBeDefined()
    const coldZone = memoryContext.coldZone as NonNullable<MemoryContextReceipt['coldZone']>
    expect(coldZone.chapterIds.length).toBeGreaterThan(0)
    expect(coldZone.handleSeqs.length).toBeGreaterThan(0)
    const windowSeqs = (await buildLongReplay()).replay.windowSeqs
    const hotSeqs = new Set(windowSeqs)
    for (const seq of coldZone.handleSeqs) expect(hotSeqs.has(seq)).toBe(false)
    expect(coldZone.chars).toBeLessThanOrEqual((await buildLongReplay()).budget.chapterChars)
  })

  it('快照与 long-session-golden.json 一致（未显式放行时拒绝隐式更新）', async () => {
    const { replay } = await buildLongReplay()
    if (UPDATE) {
      const previous = readGoldenFile(LONG_SESSION_GOLDEN_PATH)
      const diff = goldenDiffSummary(previous, replay)
      writeGoldenFile(LONG_SESSION_GOLDEN_PATH, replay)
      console.error(`[golden] long-session-golden 重录：${diff}`)
      return
    }
    expect(replay).toEqual(readGoldenFileOrThrow(LONG_SESSION_GOLDEN_PATH))
  })
})

describe('多角色不同上下文窗口的回放（覆盖 A-1）', () => {
  it('同一会话：小窗口群与大窗口群各自 stable，且预算不同', async () => {
    const small = await buildLongReplay()
    const smallAgain = await buildLongReplay()
    expect(small.replay.promptHash).toBe(smallAgain.replay.promptHash)
    const big = await buildLongReplay({ contextWindowForPersona: () => 1_000_000 })
    const bigAgain = await buildLongReplay({ contextWindowForPersona: () => 1_000_000 })
    expect(big.replay.promptHash).toBe(bigAgain.replay.promptHash)
    expect(small.budget.tokens).toBe(64_000)
    expect(big.budget.tokens).toBe(150_000)
    expect(big.budget.windowChars).toBeGreaterThan(small.budget.windowChars)
    expect(big.replay.promptHash).not.toBe(small.replay.promptHash)
  })

  it('同一群同档位下重复回放：热区 token 预算完全相等（0 偏差，±2% 的更严格版）', async () => {
    const first = await buildLongReplay()
    const second = await buildLongReplay()
    expect(second.budget.windowChars).toBe(first.budget.windowChars)
    expect(second.budget.tokens).toBe(first.budget.tokens)
  })
})
