import { describe, expect, it } from 'vitest'
import { stripLegacyReasoning } from '../src/core/text.ts'

const leaked = `The user says "在吗" (are you there?). I'm 敏敏, high-cold 御姐 persona. Just respond briefly. Also earlier user asked me to check uploadAttachment in src/host/im-api.ts and run typecheck. But current turn is just "在吗". I should respond in character, cold, short. Maybe mention private chat isn't possible?

Keep it short, high-cold imperial sister style. Don't use "名字：" prefix. Only output the speech.

I should not call tools. Just answer.

Maybe: "在。私聊窗口开了也没用——我工具清单里没有发私聊的能力，话只能落在这个群。有事直说。"

That's consistent with facts. Keep it concise.在。

私聊窗口开了也没用——我这边工具清单里没有「发私聊」这一项，话只能落在这个群。想说什么直说，工作的事我接着看。`

describe('旧版思维链泄漏 · 只读清洗', () => {
  it('剥掉英文思维链，只留中文正文', () => {
    const cleaned = stripLegacyReasoning(leaked)
    expect(cleaned.startsWith('私聊窗口开了也没用')).toBe(true)
    expect(cleaned).not.toContain('The user says')
    expect(cleaned).toContain('工作的事我接着看')
  })

  it('纯中文回复不动', () => {
    expect(stripLegacyReasoning('在的～有什么要我做的？')).toBe('在的～有什么要我做的？')
  })

  it('纯英文回复不动（角色说英文时不能误伤）', () => {
    const english = 'I checked the file and the uploadAttachment helper is missing. You should add it before running typecheck.'
    expect(stripLegacyReasoning(english)).toBe(english)
  })

  it('短英文前缀 + 中文句子不动（避免误伤中英混排）', () => {
    const mixed = 'OK。已修好，可以继续。'
    expect(stripLegacyReasoning(mixed)).toBe(mixed)
  })

  it('空串/空白安全', () => {
    expect(stripLegacyReasoning('')).toBe('')
    expect(stripLegacyReasoning('   ')).toBe('   ')
  })
})
