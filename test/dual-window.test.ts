/**
 * 双层窗口（A-2）：热区不变量 + 冷区章节目录 + 跨层 seq 去重 + 冷区寻址闭环。
 *
 * 关键验收：章节目录 → 代表 `#seq` 句柄 → 走**现有** `memory_expand` 执行器成功展开原文
 * （不新建第二套寻址协议）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDualWindow, auditSeqUniqueness, directoryRefs } from '../src/core/dual-window.ts'
import { buildChapterTree, chapterHandleSeqs } from '../src/core/chapter-tree.ts'
import { assignSeqs, selectWindow } from '../src/core/prompt.ts'
import { runMemoryTool } from '../src/host/persona-tools.ts'
import { createTurnToolCache } from '../src/host/tool-cache.ts'
import { buildLongSessionFixture } from './fixtures/memory/long-session.ts'
import type { Message } from '../src/core/types.ts'
import type { ChatEvent } from '../src/core/events.ts'

const fixture = buildLongSessionFixture()

function threadMessages(): Message[] {
  return fixture.thread.messages.map((item) => ({
    id: `m${item.seq}`,
    threadId: fixture.thread.id,
    seq: item.seq,
    kind: item.kind,
    authorName: item.authorName,
    text: item.text,
    createdAt: item.at,
  }))
}

function claimsOfFixture() {
  return new Map(fixture.thread.claims.map((claim) => [
    claim.seq,
    { state: claim.state, ...(claim.successorSeq === undefined ? {} : { successorSeq: claim.successorSeq }) },
  ]))
}

describe('双层窗口：热区不变量', () => {
  it('最新一条 / @我的 / 自身最后发言都在热区', () => {
    const rows: Message[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `m${index + 1}`,
        threadId: 't1',
        seq: index + 1,
        kind: (index === 5 ? 'user' : index % 2 === 0 ? 'user' : 'persona') as Message['kind'],
        authorName: index % 2 === 0 || index === 5 ? '你' : '产品经理',
        text: index === 5 ? '@产品经理 帮忙看下灰度' : `第 ${index + 1} 条普通讨论`,
        createdAt: index,
      })),
    ]
    const assigned = assignSeqs(rows)
    const current = assigned[assigned.length - 1]
    const dual = buildDualWindow({
      messages: assigned,
      personaId: 'p1',
      personaName: '产品经理',
      currentId: current.id,
      windowChars: 800,
      summaryChars: 4_000,
    })
    const hotSeqs = new Set(dual.hot.map((message) => message.seq))
    // 最新一条（非当前消息）：当前消息之前的最后一条
    const latest = assigned[assigned.length - 2]
    expect(hotSeqs.has(latest.seq)).toBe(true)
    // @我的
    expect(hotSeqs.has(6)).toBe(true)
    // 自身最后发言（当前消息本身不算窗口内容）
    const ownLast = [...assigned].reverse().find(
      (message) => message.kind === 'persona' && message.authorName === '产品经理' && message.id !== current.id,
    )
    expect(hotSeqs.has(ownLast?.seq)).toBe(true)
    // 与 selectWindow 完全一致（没有第二套窗口规则）
    const direct = selectWindow({
      messages: assigned,
      personaId: 'p1',
      personaName: '产品经理',
      currentId: current.id,
      charBudget: 800,
    })
    expect(dual.hot.map((message) => message.seq)).toEqual(direct.map((message) => message.seq))
  })

  it('热区条数受 windowChars 约束（预算小则条数少）', () => {
    const assigned = assignSeqs(threadMessages())
    const small = buildDualWindow({
      messages: assigned,
      personaId: 'p-pm',
      personaName: '产品经理',
      currentId: assigned[assigned.length - 1].id,
      windowChars: 800,
      summaryChars: 4_000,
    })
    const large = buildDualWindow({
      messages: assigned,
      personaId: 'p-pm',
      personaName: '产品经理',
      currentId: assigned[assigned.length - 1].id,
      windowChars: 40_000,
      summaryChars: 4_000,
    })
    expect(small.meta.hotChars).toBeLessThanOrEqual(800)
    expect(large.hot.length).toBeGreaterThanOrEqual(small.hot.length)
    expect(large.meta.hotChars).toBeLessThanOrEqual(40_000)
  })
})

describe('双层窗口：冷区目录 + 跨层 seq 去重', () => {
  it('冷区句柄严格早于热区，且与热区 seq 无交集', () => {
    const assigned = assignSeqs(threadMessages())
    const dual = buildDualWindow({
      messages: assigned,
      personaId: 'p-pm',
      personaName: '产品经理',
      currentId: assigned[assigned.length - 1].id,
      windowChars: 1_200,
      summaryChars: 10_000,
      claims: claimsOfFixture(),
    })
    const hotSeqs = new Set(dual.hot.map((message) => message.seq ?? 0))
    const coldHandles = chapterHandleSeqs(dual.cold)
    expect(coldHandles.length).toBeGreaterThan(0)
    for (const handle of coldHandles) {
      expect(hotSeqs.has(handle)).toBe(false)
      expect(handle).toBeLessThan(dual.meta.hotFromSeq)
    }
    expect(dual.meta.dedupedSeqs).toEqual([])
    expect(dual.directory.length).toBeLessThanOrEqual(dual.cold.meta.chapterChars)
  })

  it('excludeSeqs（L1/句柄块已引用）不会再进目录', () => {
    const assigned = assignSeqs(threadMessages())
    const excluded = new Set<number>([2, 3, 4, 5, 6])
    const dual = buildDualWindow({
      messages: assigned,
      personaId: 'p-pm',
      personaName: '产品经理',
      currentId: assigned[assigned.length - 1].id,
      windowChars: 1_200,
      summaryChars: 10_000,
      excludeSeqs: excluded,
    })
    for (const seq of directoryRefs(dual.directory)) expect(excluded.has(seq)).toBe(false)
  })

  it('最终 prompt 的 seq 唯一性审计：窗口行 / 目录句柄 / 记忆块 / facts 不重复', () => {
    const assigned = assignSeqs(threadMessages())
    const dual = buildDualWindow({
      messages: assigned,
      personaId: 'p-pm',
      personaName: '产品经理',
      currentId: assigned[assigned.length - 1].id,
      windowChars: 1_200,
      summaryChars: 10_000,
    })
    const audit = auditSeqUniqueness({
      windowSeqs: dual.hot.map((message) => message.seq ?? 0),
      directoryHandleSeqs: chapterHandleSeqs(dual.cold),
      factSeqs: [],
      memoryBlockSeqs: [],
    })
    expect(audit.duplicateSeqs).toEqual([])
    // 反向用例：人为重复必须被审计抓到
    const duplicate = auditSeqUniqueness({
      windowSeqs: [1, 2],
      directoryHandleSeqs: [2, 3],
    })
    expect(duplicate.duplicateSeqs).toEqual([2])
  })

  it('章节目录确定性：同输入两次构建目录逐字节相同', () => {
    const assigned = assignSeqs(threadMessages())
    const build = () => buildChapterTree({
      messages: assigned.filter((message) => (message.seq ?? 0) < 500),
      summaryChars: 10_000,
      claims: claimsOfFixture(),
    })
    expect(build().directory).toBe(build().directory)
  })
})

describe('冷区可寻址闭环：章节 → 句柄 #seq → memory_expand 命中原文', () => {
  const tempRoots: string[] = []
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function makeRoot(threadId: string, messages: readonly Message[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dshim-dual-'))
    tempRoots.push(root)
    const groupDir = join(root, '.dsh-im', 'groups', threadId)
    await mkdir(groupDir, { recursive: true })
    const state = {
      personas: [{ id: 'p-pm', name: '产品经理' }],
      threads: [{
        id: threadId,
        title: 'fixture',
        memberIds: ['p-pm'],
        members: [{ personaId: 'p-pm', activity: 'review', completedRound: false, passedRound: false }],
        messages: [],
        projectRoot: root,
      }],
      memories: [],
      wakeExcerpts: {},
      pendingRecall: null,
      lastProactiveAt: {},
    }
    await writeFile(join(root, '.dsh-im', 'state.json'), JSON.stringify(state), 'utf8')
    const events: ChatEvent[] = messages.map((message) => ({
      schemaVersion: 1,
      seq: message.seq as number,
      id: `e${message.seq}`,
      at: message.createdAt,
      kind: message.kind,
      actorName: message.authorName,
      text: message.text,
      producer: 'plugin',
    }))
    await writeFile(join(groupDir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    return root
  }

  it('从章节目录取代表句柄 → runMemoryTool(memory_expand) 返回原文片段', async () => {
    const threadId = fixture.thread.id
    const assigned = assignSeqs(threadMessages())
    const dual = buildDualWindow({
      messages: assigned,
      personaId: 'p-pm',
      personaName: '产品经理',
      currentId: assigned[assigned.length - 1].id,
      windowChars: 1_200,
      summaryChars: 12_000,
      chapterShare: 0.4,
      claims: claimsOfFixture(),
    })
    // 选一个"决定"类句柄（代表句柄必须是原文里的真实消息）。
    const handles = chapterHandleSeqs(dual.cold)
    expect(handles.length).toBeGreaterThan(0)
    const bySeq = new Map(fixture.thread.messages.map((message) => [message.seq, message.text]))
    const handle = handles.find((seq) => bySeq.get(seq)?.startsWith('决定 D-')) ?? handles[0]
    const expected = bySeq.get(handle) as string
    expect(expected).toBeTruthy()
    const root = await makeRoot(threadId, assigned)
    const result = await runMemoryTool({
      name: 'memory_expand',
      args: { seqs: String(handle) },
      projectRoot: root,
      threadId,
      personaId: 'p-pm',
      cache: createTurnToolCache(),
    })
    expect(result).toContain(`#${handle}`)
    // 原文命中：整条原文被展开（不可信包裹不改变原文内容）。
    expect(result).toContain(expected.slice(0, 20))
  })

  it('非成员展开被拒绝（冷区可寻址不等于越权）', async () => {
    const threadId = fixture.thread.id
    const assigned = assignSeqs(threadMessages())
    const root = await makeRoot(threadId, assigned)
    const result = await runMemoryTool({
      name: 'memory_expand',
      args: { seqs: '27' },
      projectRoot: root,
      threadId,
      personaId: 'p-intruder',
      cache: createTurnToolCache(),
    })
    expect(result).toContain('拒绝')
  })
})
