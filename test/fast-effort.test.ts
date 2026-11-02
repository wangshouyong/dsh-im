import { describe, expect, it } from 'vitest'
import { completeDshChat, resolveFastReasoningEffort, type LlmService } from '../src/host/dsh-llm.ts'

function fakeLlm(options: { efforts?: string[]; capture?: Record<string, unknown>[] }): LlmService {
  return {
    async resolveModelInfo() {
      return { reasoning: { efforts: (options.efforts ?? []).map((id) => ({ id })) } }
    },
    stream(opts: Record<string, unknown>) {
      options.capture?.push(opts)
      return (async function* () {
        yield { type: 'text-delta', text: '{"ok":true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const base = {
  provider: 'p',
  model: 'm',
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hello' }],
}

describe('后台用途使用最低推理档', () => {
  it('优先选 advertised 里的 low/minimal', async () => {
    const llm = fakeLlm({ efforts: ['medium', 'low', 'high'] })
    expect(await resolveFastReasoningEffort(llm, 'p', 'm')).toBe('low')
  })

  it('没有 low 时退回 advertised 第一个；没有能力信息则不传', async () => {
    expect(await resolveFastReasoningEffort(fakeLlm({ efforts: ['medium', 'high'] }), 'p', 'm_medium')).toBe('medium')
    expect(await resolveFastReasoningEffort(fakeLlm({}), 'p', 'm_none')).toBeUndefined()
    expect(await resolveFastReasoningEffort(undefined, 'p', 'm_undef')).toBeUndefined()
  })

  it('extract/curate 把 reasoningEffort 传给 llm.stream；reply 不传', async () => {
    const extractCalls: Record<string, unknown>[] = []
    await completeDshChat({
      llm: fakeLlm({ efforts: ['low', 'high'], capture: extractCalls }),
      ...base,
      purpose: 'extract',
    })
    expect(extractCalls[0]?.reasoningEffort).toBe('low')

    const replyCalls: Record<string, unknown>[] = []
    await completeDshChat({
      llm: fakeLlm({ efforts: ['low', 'high'], capture: replyCalls }),
      ...base,
      purpose: 'reply',
    })
    expect(replyCalls[0]?.reasoningEffort).toBeUndefined()
  })
})
