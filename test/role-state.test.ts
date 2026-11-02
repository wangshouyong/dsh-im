import { describe, expect, it } from 'vitest'
import { buildRoleState, hasRoleStateContent, renderRoleState } from '../src/core/role-state.ts'
import type { Fact } from '../src/core/types.ts'

function fact(partial: Partial<Fact> & { kind: Fact['kind']; text: string }): Fact {
  return {
    factId: 'f_' + partial.text,
    source: 'persona',
    confidence: 0.8,
    seq: 1,
    at: 1,
    ...partial,
  }
}

const facts: Fact[] = [
  fact({ kind: 'commitment', text: '周五前给接口契约', owner: '架构师' }),
  fact({ kind: 'todo', text: '补回归用例', owner: '架构师' }),
  fact({ kind: 'decision', text: '先做只读改造', owner: '架构师' }),
  fact({ kind: 'constraint', text: '不改已有源码', owner: '架构师' }),
  fact({ kind: 'stance', text: '缓存要本地化', owner: '架构师' }),
  fact({ kind: 'stance', text: '缓存必须可回滚', owner: '架构师' }),
  fact({ kind: 'decision', text: '周三上线灰度', owner: '你', source: 'user' }),
  fact({ kind: 'commitment', text: '我负责登录', owner: '测试' }),
]

describe('角色状态快照（facts 投影视图）', () => {
  it('只投影“属于我”的显式事实：承诺/待办/决定/约束/最新立场', () => {
    const state = buildRoleState({ personaName: '架构师', facts, lastSeq: 42, waitingOn: '产品经理' })
    expect(state.commitments).toEqual(['周五前给接口契约', '补回归用例'])
    expect(state.decisions).toEqual(['先做只读改造'])
    expect(state.constraints).toEqual(['不改已有源码'])
    expect(state.position).toBe('缓存必须可回滚')
    expect(state.waitingOn).toBe('产品经理')
    expect(state.lastSeq).toBe(42)
    // 用户决定/其它角色的事实不混进“我的状态”
    const blob = JSON.stringify(state)
    expect(blob).not.toContain('周三上线灰度')
    expect(blob).not.toContain('我负责登录')
  })

  it('空状态不占 prompt；有内容时按固定顺序渲染', () => {
    const empty = buildRoleState({ personaName: '淇淇', facts: [], lastSeq: 3 })
    expect(hasRoleStateContent(empty)).toBe(false)
    expect(renderRoleState(empty)).toBe('')

    const rendered = renderRoleState(buildRoleState({
      personaName: '架构师',
      facts,
      lastSeq: 42,
      waitingOn: '产品经理',
    }))
    expect(rendered).toContain('[你的状态快照 · 结论，不是历史]')
    expect(rendered.indexOf('我承诺/认领过')).toBeLessThan(rendered.indexOf('我做过的决定'))
    expect(rendered.indexOf('我的立场')).toBeLessThan(rendered.indexOf('我正在等'))
    expect(rendered).toContain('我最后看到：#42')
  })

  it('确定性：同样输入 → 完全相同的状态和渲染', () => {
    const build = () => buildRoleState({ personaName: '架构师', facts, lastSeq: 42 })
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()))
    expect(renderRoleState(build())).toBe(renderRoleState(build()))
  })

  it('截断上限：承诺最多 6 条、决定 4 条、约束 3 条（取最近的）', () => {
    const many: Fact[] = []
    for (let index = 0; index < 10; index++) {
      many.push(fact({ kind: 'commitment', text: `承诺${index}`, owner: 'A' }))
      many.push(fact({ kind: 'decision', text: `决定${index}`, owner: 'A' }))
      many.push(fact({ kind: 'constraint', text: `约束${index}`, owner: 'A' }))
    }
    const state = buildRoleState({ personaName: 'A', facts: many, lastSeq: 10 })
    expect(state.commitments).toHaveLength(6)
    expect(state.commitments.at(-1)).toBe('承诺9')
    expect(state.decisions).toHaveLength(4)
    expect(state.constraints).toHaveLength(3)
  })
})
