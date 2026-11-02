import { describe, expect, it } from 'vitest'
import { assemblePrompt } from '../src/core/prompt.ts'
import { buildRoleState, renderRoleState } from '../src/core/role-state.ts'
import { buildThreadDigest, digestSummaryText } from '../src/core/summary.ts'
import { isPromptVisibleFact, isTransientClaim } from '../src/core/facts.ts'
import type { Fact, Message, Thread } from '../src/core/types.ts'

function fact(patch: Partial<Fact> & Pick<Fact, 'kind' | 'text'>): Fact {
  return {
    factId: `f_${patch.kind}_${patch.text.length}`,
    owner: '淇淇',
    source: 'extractor',
    confidence: 0.9,
    seq: 3,
    at: 1000,
    ...patch,
  }
}

function thread(kind: Thread['kind'] = 'group', title = '方案评审'): Thread {
  const messages: Message[] = [
    { id: 'm1', threadId: 't1', seq: 1, kind: 'user', authorName: '你', text: '在吗', createdAt: 1000 },
    { id: 'm2', threadId: 't1', seq: 2, kind: 'persona', authorName: '淇淇', text: '我只能在群里说话', createdAt: 1001 },
  ]
  return {
    id: 't1',
    kind,
    title,
    topic: title,
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

const promptInput = {
  messages: thread().messages,
  personaId: 'p1',
  personaName: '淇淇',
  persona: { id: 'p1', name: '淇淇' },
  threadTitle: '方案评审',
}

describe('能力/环境自述不回流（自证循环）', () => {
  it('识别能力自述：只能在群里 / 私聊发不出去 / 没有 shell', () => {
    expect(isTransientClaim('我只能在群里说话，私聊我这边是发不出去的')).toBe(true)
    expect(isTransientClaim('淇淇没有发送消息或开私聊工具，每句话只能落在当前群里')).toBe(true)
    expect(isTransientClaim('我没有 shell，跑不了测试')).toBe(true)
    // 真实约束不能误杀
    expect(isTransientClaim('threadId 只允许 [A-Za-z0-9_-]{1,80}')).toBe(false)
    expect(isTransientClaim('周三上线灰度，先小流量')).toBe(false)
  })

  it('角色自己的能力自述不进 L2（[群事实/决定]）', () => {
    const claim = fact({ kind: 'constraint', text: '我只能在群里说话，私聊我这边是发不出去的' })
    const digest = buildThreadDigest(thread(), undefined, { facts: [claim] })
    expect(digest.l2).toEqual([])
    expect(digestSummaryText(digest)).not.toContain('只能在群里')
  })

  it('角色自己的能力自述不进角色状态快照（[你的状态快照]）', () => {
    const claim = fact({ kind: 'constraint', text: '我只能在群里说话，私聊我这边是发不出去的' })
    const state = buildRoleState({ personaName: '淇淇', facts: [claim], lastSeq: 2 })
    expect(state.constraints).toEqual([])
    expect(renderRoleState(state)).not.toContain('只能在群里')
  })

  it('用户说的限制、真实的约束仍然照常注入', () => {
    const userRule = fact({ kind: 'constraint', owner: '你', text: 'threadId 只允许 [A-Za-z0-9_-]{1,80}' })
    const roleConstraint = fact({ kind: 'constraint', text: '评审必须先跑 typecheck 再给结论' })
    const digest = buildThreadDigest(thread(), undefined, { facts: [userRule, roleConstraint] })
    expect(digest.l2.join('\n')).toContain('threadId 只允许')
    expect(digest.l2.join('\n')).toContain('评审必须先跑 typecheck')
    expect(isPromptVisibleFact(userRule)).toBe(true)
  })
})

describe('私聊小窗的 prompt 不再按群聊写', () => {
  it('DM：system 明确是一对一私聊，窗口/摘要块不叫“群聊”', () => {
    const assembled = assemblePrompt({ ...promptInput, threadKind: 'dm', threadTitle: '淇淇', summary: '之前聊过上线' })
    expect(assembled.system).toContain('一对一私聊小窗')
    expect(assembled.system).toContain('不要声称“我只能在群里说话')
    expect(assembled.system).not.toContain('你是群「')
    expect(assembled.prompt).toContain('[最近私聊]')
    expect(assembled.prompt).toContain('[本轮私聊摘要]')
    expect(assembled.prompt).not.toContain('[最近群聊]')
  })

  it('群聊：保持原来的“群”语义（老调用方不传 threadKind 也不变）', () => {
    const assembled = assemblePrompt({ ...promptInput, summary: '之前聊过上线' })
    expect(assembled.system).toContain('你是群「方案评审」里的角色')
    expect(assembled.system).toContain('群规则')
    expect(assembled.prompt).toContain('[最近群聊]')
    expect(assembled.prompt).toContain('[本轮群聊摘要]')
  })

  it('三人小窗：不说“群”，也不冒充 DM', () => {
    const assembled = assemblePrompt({ ...promptInput, threadKind: 'triad', threadTitle: '淇淇、敏敏' })
    expect(assembled.system).toContain('三人小窗')
    expect(assembled.system).not.toContain('你是群「')
    expect(assembled.system).not.toContain('一对一私聊')
  })
})
