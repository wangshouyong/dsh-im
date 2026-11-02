import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { completeDshChat, type LlmService } from '../src/host/dsh-llm.ts'
import { createImApi } from '../src/host/im-api.ts'
import { ImService } from '../src/core/im.ts'
import type { Speaker, TurnStepTrace } from '../src/core/types.ts'

function llmWithOneTool(): LlmService {
  let call = 0
  return {
    stream() {
      call += 1
      const index = call
      async function* chunks() {
        if (index === 1) {
          yield { type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'text-delta', text: '看完了，有个问题' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return chunks()
    },
  }
}

describe('成员执行轨迹（trace）', () => {
  it('completeDshChat 逐步回调：工具步骤 + 最终回复步骤', async () => {
    const steps: TurnStepTrace[] = []
    const text = await completeDshChat({
      llm: llmWithOneTool(),
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      system: '你是架构师',
      messages: [{ role: 'user', content: '看下 a.ts' }],
      toolAllow: ['read'],
      onTool: async () => 'const a = 1',
      onStep: (step) => steps.push(step),
    })
    expect(text).toContain('看完了')
    expect(steps.map((step) => step.kind)).toEqual(['tool', 'reply'])
    expect(steps[0]).toMatchObject({ name: 'read_file', ok: true })
    expect(steps[0].args).toContain('a.ts')
    expect(steps[0].result).toContain('const a = 1')
    expect(steps[1].result).toContain('看完了')
  })

  it('/complete 把 trace 带回客户端', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-trace-'))
    const api = createImApi({ projectRoot: () => root, llm: () => llmWithOneTool() })
    const result = await api.complete({
      model: 'deepseek-account::deepseek-flash',
      system: '你是架构师',
      messages: [{ role: 'user', content: '看下 a.ts' }],
      toolAllow: ['read'],
      threadId: 't1',
      personaId: 'p1',
    })
    expect(result.text).toContain('看完了')
    expect(result.trace?.map((step) => step.kind)).toEqual(['tool', 'reply'])
    expect(result.trace?.[0].step).toBe(1)
    expect(result.trace?.[1].step).toBe(2)
  })

  it('ImService 把 trace 存到 thread.traces，并带上 persona/messageId', async () => {
    const steps: TurnStepTrace[] = [
      { step: 1, kind: 'tool', name: 'read_file', args: 'a.ts', result: 'ok', ok: true, ms: 12, at: 1000 },
      { step: 2, kind: 'reply', result: '收到', ok: true, ms: 30, at: 1030 },
    ]
    const speaker: Speaker = {
      async complete() {
        return { text: '收到', trace: steps }
      },
    }
    const im = new ImService(speaker)
    const persona = im.createPersona({
      name: '架构师',
      avatar: '架',
      personality: '',
      duties: ['结构'],
      model: 'mock',
      proactiveDm: false,
      defaultActivity: 'high',
    })
    const group = im.createGroup('群', [persona.id], 'D:/ws')
    await im.sendUser(group.id, '看下 a.ts')
    const trace = group.traces?.at(-1)
    expect(trace).toMatchObject({ personaId: persona.id, personaName: '架构师' })
    expect(trace?.messageId).toBe(group.messages.filter((message) => message.kind === 'persona').at(-1)?.id)
    expect(trace?.steps.map((step) => step.kind)).toEqual(['tool', 'reply'])
    expect(trace?.ms).toBe(30)
  })
})
