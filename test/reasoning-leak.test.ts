import { describe, expect, it } from 'vitest'
import { lastAssistantText } from '../src/host/agent-session.ts'

function message(role: string, content: unknown) {
  return { id: 'm_' + Math.random().toString(36).slice(2), role, content } as never
}

describe('原生会话正文提取 · 不把思维链当回复', () => {
  it('reasoning + text 混合时只取 text', () => {
    const messages = [
      message('user', [{ type: 'text', text: '在吗' }]),
      message('assistant', [
        { type: 'reasoning', text: 'The user says 在吗。I should reply briefly. Let me think...' },
        { type: 'text', text: '在的～有什么要我做的？' },
      ]),
    ]
    expect(lastAssistantText(messages)).toBe('在的～有什么要我做的？')
  })

  it('只有 reasoning block 时视为空回复（不落库）', () => {
    const messages = [
      message('assistant', [{ type: 'reasoning', text: 'Let me think about this...' }]),
    ]
    expect(lastAssistantText(messages)).toBe('')
  })

  it('多个 text block 拼接；字符串 content 仍兼容', () => {
    const messages = [
      message('assistant', [
        { type: 'text', text: '第一句。' },
        { type: 'text', text: '第二句。' },
      ]),
    ]
    expect(lastAssistantText(messages)).toBe('第一句。第二句。')
    expect(lastAssistantText([message('assistant', '纯文本回复')])).toBe('纯文本回复')
  })

  it('最后一条 assistant 只有 reasoning 时，回退到上一条有正文的 assistant', () => {
    const messages = [
      message('assistant', [{ type: 'text', text: '上一轮正文' }]),
      message('assistant', [{ type: 'reasoning', text: '只有思维链' }]),
    ]
    expect(lastAssistantText(messages)).toBe('上一轮正文')
  })

  it('tool-call / 未知 block 不混入正文', () => {
    const messages = [
      message('assistant', [
        { type: 'reasoning', text: '先查文件' },
        { type: 'tool-call', id: 't1', name: 'read_file', arguments: '{}' },
        { type: 'text', text: '查完了，结论是 X。' },
      ]),
    ]
    expect(lastAssistantText(messages)).toBe('查完了，结论是 X。')
  })
})
