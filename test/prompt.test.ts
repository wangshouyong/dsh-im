import { describe, expect, it } from 'vitest'
import { assemblePrompt, assignSeqs, roleSupplement, selectWindow, type PromptMessage } from '../src/core/prompt.ts'

function msg(index: number, kind: PromptMessage['kind'], authorName: string, text: string): PromptMessage {
  return { id: 'm' + index, kind, authorName, text, createdAt: index }
}

describe('群聊 prompt 组装', () => {
  it('老数据按顺序补 seq，已有 seq 保留', () => {
    const seqs = assignSeqs([{ id: 'a' }, { id: 'b', seq: 10 }, { id: 'c' }])
    expect(seqs.map((item) => item.seq)).toEqual([1, 10, 11])
  })

  it('窗口不越过摘要边界', () => {
    const messages = assignSeqs([msg(1, 'user', '你', '旧消息'), msg(2, 'persona', '淇淇', '旧回复'), msg(3, 'user', '你', '新消息')])
    const window = selectWindow({ messages, personaId: 'p1', personaName: '淇淇', summaryUntilSeq: 2 })
    expect(window.map((m) => m.id)).toEqual(['m3'])
  })

  it('活跃群里安静角色也不会被挤掉：保底自己的最近发言与 @它 的消息', () => {
    const noisy: PromptMessage[] = []
    for (let i = 1; i <= 30; i++) noisy.push(msg(i, i % 2 ? 'persona' : 'user', i % 2 ? '产品经理' : '你', '刷屏 ' + i))
    noisy.push(msg(31, 'persona', '测试2', '我上次说：先跑测试'))
    noisy.push(msg(32, 'user', '你', '@测试2 你看下这个 bug'))
    for (let i = 33; i <= 45; i++) noisy.push(msg(i, 'persona', '产品经理', '继续刷 ' + i))
    const messages = assignSeqs(noisy)
    const window = selectWindow({ messages, personaId: 'p2', personaName: '测试2', keep: 10 })
    const texts = window.map((m) => m.text)
    expect(texts).toContain('我上次说：先跑测试')
    expect(texts.some((text) => text.includes('@测试2'))).toBe(true)
  })

  it('自己的发言打 [你之前的发言]，别人不带；渲染带序号和角色名', () => {
    const messages = assignSeqs([
      msg(1, 'user', '张三', '小助手在吗'),
      msg(2, 'persona', '小助手', '在'),
      msg(3, 'persona', '产品经理', '我也在'),
    ])
    const assembled = assemblePrompt({
      messages,
      persona: { id: 'p1', name: '小助手', post: '助理' },
      personaId: 'p1',
      personaName: '小助手',
      threadTitle: '方案群',
      currentId: 'm1',
    })
    expect(assembled.prompt).toContain('[#2][角色 小助手][你之前的发言] 在')
    expect(assembled.prompt).toContain('[#3][角色 产品经理] 我也在')
    expect(assembled.prompt).toContain('[当前消息]')
    expect(assembled.system).toContain('岗位是「助理」')
    expect(assembled.system).toContain('只有标记为【你之前的发言】')
  })

  it('字符预算会挡掉超长历史，摘要 + 角色补充会带上', () => {
    const huge = 'x'.repeat(5000)
    const messages = assignSeqs([
      msg(1, 'persona', '小助手', '我之前的立场：先做只读'),
      msg(2, 'user', '张三', huge),
      msg(3, 'user', '张三', '在吗'),
    ])
    const window = selectWindow({ messages, personaId: 'p1', personaName: '小助手', charBudget: 1000 })
    expect(window.map((m) => m.id)).not.toContain('m2')
    const assembled = assemblePrompt({
      messages,
      persona: { id: 'p1', name: '小助手' },
      personaId: 'p1',
      personaName: '小助手',
      threadTitle: '方案群',
      summary: '主题：只读改造',
    })
    expect(assembled.prompt).toContain('[本轮群聊摘要]')
    expect(assembled.prompt).toContain('[你之前的发言要点]')
    expect(roleSupplement('小助手', messages)[0]).toContain('先做只读')
  })
})
