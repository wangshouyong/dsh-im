import { describe, expect, it } from 'vitest'
import { selectWindow } from '../src/core/prompt.ts'
import { buildThreadDigest, digestSummaryText, L1_CHAR_BUDGET } from '../src/core/summary.ts'
import type { Message, Thread } from '../src/core/types.ts'

function threadWith(count: number, extra: { userFact?: boolean } = {}): Thread {
  const messages: Message[] = []
  for (let index = 0; index < count; index++) {
    const kind: Message['kind'] = index % 3 === 0 ? 'user' : 'persona'
    messages.push({
      id: 'm' + index,
      threadId: 't1',
      seq: index + 1,
      kind,
      authorName: kind === 'user' ? '你' : '架构师',
      text: `${kind === 'user' ? '讨论' : '回复'}第 ${index + 1} 条` + 'x'.repeat(index % 5 === 0 ? 40 : 0),
      createdAt: 1000 + index,
    })
  }
  if (extra.userFact) {
    messages.push({
      id: 'fact',
      threadId: 't1',
      seq: messages.length + 1,
      kind: 'user',
      authorName: '你',
      text: '记住：周三上线灰度',
      createdAt: 2000,
    })
  }
  return {
    id: 't1',
    kind: 'group',
    title: '方案评审',
    topic: '方案评审',
    shortSummary: '',
    memberIds: ['p1'],
    members: [],
    projectRoot: '.',
    messages,
    unread: 0,
    roundMode: 'idle',
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('分层摘要投影', () => {
  it('短会话不建摘要边界（窗口保持原样）', () => {
    const digest = buildThreadDigest(threadWith(5))
    expect(digest.untilSeq).toBe(0)
    expect(digest.l1).toBe('')
    expect(digest.l2).toEqual([])
  })

  it('长会话：更早的消息进 L1，窗口只留最近 20 条', () => {
    const thread = threadWith(30)
    const digest = buildThreadDigest(thread)
    expect(digest.untilSeq).toBe(10)
    expect(digest.l1).toContain('[#1]')
    expect(digest.l1).toContain('[#10]')
    expect(digest.l1).not.toContain('[#11]')
    const window = selectWindow({
      messages: thread.messages,
      personaId: 'p1',
      personaName: '架构师',
      summaryUntilSeq: digest.untilSeq,
    })
    expect(window.length).toBe(20)
    expect(window[0].seq).toBe(11)
  })

  it('增量合并：新消息只追加新增的旧消息行，L1 不是每次从头重算', () => {
    const first = buildThreadDigest(threadWith(25))
    const grown = threadWith(30)
    const merged = buildThreadDigest(grown, first)
    expect(first.l1).toContain('[#1]')
    expect(merged.l1).toContain('[#1]')
    expect(merged.l1).toContain('[#5]')
    expect(merged.untilSeq).toBe(10)
    // 相同输入重复构建结果稳定
    expect(buildThreadDigest(grown, first).l1).toBe(merged.l1)
  })

  it('L2 保留事实/决定，且窗口边界之外仍能看到', () => {
    const thread = threadWith(30, { userFact: true })
    const digest = buildThreadDigest(thread)
    expect(digest.l2.some((line) => line.includes('周三上线灰度'))).toBe(true)
    expect(digestSummaryText(digest)).toContain('[群事实/决定]')
    expect(digestSummaryText(digest)).toContain('[更早消息摘要]')
  })

  it('L1 有字符预算：超了从最旧的行开始丢，但事实不丢', () => {
    const thread = threadWith(120, { userFact: true })
    const digest = buildThreadDigest(thread)
    expect(digest.l1.length).toBeLessThanOrEqual(L1_CHAR_BUDGET)
    expect(digest.l2.some((line) => line.includes('周三上线灰度'))).toBe(true)
  })

  it('消息回退（state 回滚）时旧摘要作废重算', () => {
    const long = threadWith(30)
    const digest = buildThreadDigest(long)
    expect(digest.untilSeq).toBe(10)
    const shrunk = threadWith(12)
    expect(buildThreadDigest(shrunk, digest).untilSeq).toBe(0)
  })
})
