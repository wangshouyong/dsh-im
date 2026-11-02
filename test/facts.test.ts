import { describe, expect, it } from 'vitest'
import {
  buildFactExtractionPrompt,
  factIdFor,
  factEventsFromMessages,
  factInputsFromCandidates,
  factsFromMessages,
  formatFact,
  parseFactCandidates,
  projectFacts,
  projectFactsFromList,
} from '../src/core/facts.ts'
import { appendEvent, type ChatEvent } from '../src/core/events.ts'
import type { FactKind, Message } from '../src/core/types.ts'

function factEvent(events: ChatEvent[], input: {
  text: string
  factKind: string
  source: 'user' | 'persona' | 'extractor'
  op?: 'assert' | 'supersede' | 'retract'
  supersedes?: string
  factId?: string
}): ChatEvent {
  return appendEvent(events, {
    at: 1000 + events.length,
    kind: 'fact',
    actorName: input.source,
    text: input.text,
    producer: 'plugin',
    fact: {
      op: input.op ?? 'assert',
      factId: input.factId ?? factIdFor(input.factKind as FactKind, input.text),
      factKind: input.factKind,
      source: input.source,
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    },
  })
}

function message(seq: number, kind: Message['kind'], authorName: string, text: string): Message {
  return {
    id: 'm' + seq,
    threadId: 't1',
    seq,
    kind,
    authorName,
    text,
    createdAt: 1000 + seq,
  }
}

describe('事实抽取', () => {
  it('factId 由分类 + 规范化正文派生，重复抽取幂等', () => {
    expect(factIdFor('decision', '周三上线')).toBe(factIdFor('decision', '  周三上线  '))
    expect(factIdFor('decision', '周三上线')).not.toBe(factIdFor('todo', '周三上线'))
  })

  it('用户显式记忆/待办、角色承诺/约束会抽成事实', () => {
    const messages: Message[] = [
      message(1, 'user', '你', '记住：周三上线灰度\n待办：补回归用例'),
      message(2, 'persona', '架构师', '承诺：周五前给出接口契约\n约束：不改已有源码'),
      message(3, 'persona', '测试', '普通聊天，不该产出事实'),
    ]
    const facts = factsFromMessages(messages).active
    expect(facts.map((fact) => `${fact.kind}:${fact.text}`).sort()).toEqual([
      'commitment:周五前给出接口契约',
      'constraint:不改已有源码',
      'decision:周三上线灰度',
      'todo:补回归用例',
    ].sort())
    expect(facts.find((fact) => fact.text === '周三上线灰度')?.source).toBe('user')
    expect(facts.find((fact) => fact.text === '周五前给出接口契约')?.owner).toBe('架构师')
    expect(facts.every((fact) => fact.seq > 0)).toBe(true)
    expect(formatFact(facts[0])).toMatch(/^- \[/)
  })

  it('FACT: 显式标记任何来源都收', () => {
    const facts = factsFromMessages([message(1, 'persona', '淇淇', 'FACT: 缓存命中率要 ≥ 90%')]).active
    expect(facts.map((fact) => fact.kind)).toEqual(['fact'])
    expect(factEventsFromMessages([message(1, 'user', '你', '不做事实')])).toEqual([])
  })

  it('@某人 打头时事实标记仍然生效（用户消息常见写法）', () => {
    const facts = factsFromMessages([
      message(1, 'user', '你', '@产品经理 记住：周三上线灰度'),
      message(2, 'persona', '架构师', '@产品经理 承诺：周五前给接口契约'),
    ]).active
    expect(facts.map((fact) => fact.text).sort()).toEqual(['周三上线灰度', '周五前给接口契约'].sort())
  })
})

describe('事实投影（assert / supersede / retract + 优先级）', () => {
  it('相同 factId 重复 assert 只留一条', () => {
    let events: ChatEvent[] = []
    events = [...events, factEvent(events, { text: '周三上线', factKind: 'decision', source: 'user' })]
    events = [...events, factEvent(events, { text: '周三上线', factKind: 'decision', source: 'user' })]
    const projection = projectFacts(events)
    expect(projection.active).toHaveLength(1)
    expect(projection.version).toBe(projectFactsFromList(projection.active).version)
  })

  it('supersede 替换旧事实，retract 撤下事实', () => {
    let events: ChatEvent[] = []
    const oldId = factIdFor('decision', '周三上线')
    events = [...events, factEvent(events, { text: '周三上线', factKind: 'decision', source: 'user', factId: oldId })]
    events = [...events, factEvent(events, {
      text: '周四上线', factKind: 'decision', source: 'user', op: 'supersede', supersedes: oldId,
    })]
    let projection = projectFacts(events)
    expect(projection.active.map((fact) => fact.text)).toEqual(['周四上线'])

    const newId = projection.active[0].factId
    events = [...events, factEvent(events, { text: '周四上线', factKind: 'decision', source: 'user', op: 'retract', factId: newId })]
    projection = projectFacts(events)
    expect(projection.active).toHaveLength(0)
  })

  it('低优先级来源不能覆盖用户事实（用户 > 角色 > 抽取）', () => {
    let events: ChatEvent[] = []
    const userId = factIdFor('decision', '周三上线')
    events = [...events, factEvent(events, { text: '周三上线', factKind: 'decision', source: 'user', factId: userId })]
    // 抽取器想替换用户事实 → 应被拒绝
    events = [...events, factEvent(events, {
      text: '周五上线', factKind: 'decision', source: 'extractor', op: 'supersede', supersedes: userId,
    })]
    // 角色显式声明同样不能覆盖用户
    events = [...events, factEvent(events, {
      text: '周六上线', factKind: 'decision', source: 'persona', op: 'supersede', supersedes: userId,
    })]
    let projection = projectFacts(events)
    expect(projection.active.map((fact) => fact.text)).toEqual(['周三上线'])
    expect(projection.active[0].source).toBe('user')
    // 但抽取器可以替换抽取器自己
    const extractorId = factIdFor('todo', '补回归用例')
    events = [...events, factEvent(events, { text: '补回归用例', factKind: 'todo', source: 'extractor', factId: extractorId })]
    events = [...events, factEvent(events, {
      text: '补全回归用例', factKind: 'todo', source: 'persona', op: 'supersede', supersedes: extractorId,
    })]
    projection = projectFacts(events)
    expect(projection.active.some((fact) => fact.text === '补全回归用例')).toBe(true)
  })

  it('抽取器不能撤掉用户事实，但用户可以归档', () => {
    let events: ChatEvent[] = []
    const userId = factIdFor('decision', '周三上线')
    events = [...events, factEvent(events, { text: '周三上线', factKind: 'decision', source: 'user', factId: userId })]
    events = [...events, factEvent(events, { text: '周三上线', factKind: 'decision', source: 'extractor', op: 'retract', factId: userId })]
    expect(projectFacts(events).active).toHaveLength(1)
    events = [...events, factEvent(events, { text: '周三上线', factKind: 'decision', source: 'user', op: 'retract', factId: userId })]
    expect(projectFacts(events).active).toHaveLength(0)
  })
})

describe('LLM 事实抽取（解析 / prompt）', () => {
  it('容错解析 JSON：代码块/前后废话/中文分类/坏条目过滤/去重/上限 8 条', () => {
    const raw = [
      '```json',
      JSON.stringify([
        { kind: '决定', text: '周三上线灰度' },
        { kind: 'todo', text: '补回归用例', owner: '测试' },
        { kind: 'decision', text: '周三上线灰度' },
        { kind: '乱写', text: '不该进' },
        { kind: '待办', text: ' ' },
        { kind: 'commitment', text: '周五前给契约' },
      ]),
      '```',
      '以上。',
    ].join('\n')
    const candidates = parseFactCandidates(raw)
    expect(candidates.map((candidate) => `${candidate.kind}:${candidate.text}`)).toEqual([
      'decision:周三上线灰度',
      'todo:补回归用例',
      'commitment:周五前给契约',
    ])
    expect(candidates[1].owner).toBe('测试')
    expect(parseFactCandidates('没有 JSON')).toEqual([])
    const many = parseFactCandidates(JSON.stringify(
      Array.from({ length: 20 }, (_, index) => ({ kind: 'todo', text: '待办 ' + index })),
    ))
    expect(many).toHaveLength(8)
  })

  it('抽取 prompt 只带最近 12 条非系统消息，结果来源固定 extractor', () => {
    const messages = Array.from({ length: 15 }, (_, index) => ({
      kind: index % 3 === 0 ? 'user' : 'persona',
      authorName: index % 3 === 0 ? '你' : '架构师',
      text: '消息 ' + index,
    }))
    messages.push({ kind: 'system', authorName: '系统主持', text: '本轮开始。' })
    const { system, prompt } = buildFactExtractionPrompt({ threadTitle: '方案评审', messages })
    expect(system).toContain('事实抽取器')
    expect(prompt).toContain('群名：方案评审')
    expect(prompt).not.toContain('本轮开始')
    expect(prompt).not.toContain('消息 0')
    const inputs = factInputsFromCandidates(parseFactCandidates('[{"kind":"todo","text":"补回归用例"}]'), 5000)
    expect(inputs[0].fact.source).toBe('extractor')
    expect(inputs[0].fact.op).toBe('assert')
    expect(inputs[0].at).toBe(5000)
    expect(inputs[0].fact.factId).toBe(factIdFor('todo', '补回归用例'))
  })
})
