import { describe, expect, it } from 'vitest'
import { assignSeqs, selectWindow } from '../src/core/prompt.ts'
import {
  canonicalJson,
  createIntent,
  stableHash,
  verifyReceipt,
} from '../src/core/receipt.ts'

const messages = assignSeqs([
  { id: 'm1', kind: 'user' as const, authorName: '你', text: '在吗', createdAt: 1 },
  { id: 'm2', kind: 'persona' as const, authorName: '淇淇', text: '在', createdAt: 2 },
  { id: 'm3', kind: 'user' as const, authorName: '你', text: '@测试2 看下 bug', createdAt: 3 },
  { id: 'm4', kind: 'persona' as const, authorName: '测试2', text: '我看看', createdAt: 4 },
])

describe('两阶段回执', () => {
  it('规范化 JSON 与 hash 可复现：键序、NFC 都不影响结果', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
    const composed = 'caf\u00e9'
    const decomposed = 'cafe\u0301'
    expect(stableHash(composed)).toBe(stableHash(decomposed))
    expect(stableHash('x')).not.toBe(stableHash('y'))
  })

  it('intent 记录窗口、版本与两个 hash', () => {
    const window = selectWindow({ messages, personaId: 'p2', personaName: '测试2' })
    const intent = createIntent({
      turnId: 'turn-1',
      personaId: 'p2',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      windowSeqs: window.map((message) => message.seq ?? 0),
      systemPrompt: '你是测试2',
      prompt: '窗口内容',
      at: 1000,
    })
    expect(intent.windowSeqs.length).toBeGreaterThan(0)
    expect(intent.versions.promptTemplate).toContain('im-prompt')
    expect(intent.systemPromptHash).toBe(stableHash('你是测试2'))
    expect(intent.promptHash).toBe(stableHash('窗口内容'))
    expect(intent.untrusted).toBe(false)
  })

  it('回放自检：窗口一致 → ok；窗口变化 → 指出第几条不同', () => {
    const window = selectWindow({ messages, personaId: 'p2', personaName: '测试2' })
    const seqs = window.map((message) => message.seq ?? 0)
    const intent = createIntent({
      turnId: 't',
      personaId: 'p2',
      provider: 'x',
      model: 'y',
      windowSeqs: seqs,
      systemPrompt: 's',
      prompt: 'p',
      at: 1,
    })
    expect(verifyReceipt(intent, seqs).ok).toBe(true)

    const changed = [...seqs]
    changed[0] = 999
    const result = verifyReceipt(intent, changed)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('第 1 条')
    expect(verifyReceipt(intent, [...seqs, 5]).reason).toContain('窗口长度')
  })
})
