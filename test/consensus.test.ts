import { describe, expect, it } from 'vitest'
import {
  buildConsensusState,
  renderConsensusPrompt,
  type ConsensusDraft,
  type ConsensusFact,
  type ConsensusLane,
} from '../src/core/consensus.ts'
import { buildCuratorPrompt, parseCuratorOutput } from '../src/core/curator.ts'

function baseFacts(): ConsensusFact[] {
  return [
    { factId: 'f1', eventSeq: 1, kind: 'decision', owner: '用户', text: 'threadId 只允许字母数字', sourceMessageId: 'm1', sourceMessageSeq: 1 },
    { factId: 'f2', eventSeq: 2, kind: 'todo', owner: '用户', text: '敏敏跑 typecheck 并贴数字', sourceMessageId: 'm2', sourceMessageSeq: 2 },
    { factId: 'f3', eventSeq: 3, kind: 'stance', owner: '敏敏', text: '主链路堵上了', sourceMessageId: 'm3', sourceMessageSeq: 3 },
    { factId: 'f4', eventSeq: 4, kind: 'constraint', owner: '淇淇', text: '淇淇没有 run_check，跑不了 tsc', sourceMessageId: 'm4', sourceMessageSeq: 4 },
  ]
}

function baseDraft(): ConsensusDraft {
  return {
    clusters: [
      { key: 'A1', lane: 'A', kind: '约束', factIds: ['f1'], text: 'threadId 只允许字母数字' },
      { key: 'C1', lane: 'C', kind: '任务', factIds: ['f2'], text: '敏敏跑 typecheck 并贴数字' },
      { key: 'B1', lane: 'B', kind: '立场', factIds: ['f3'], text: '主链路堵上了' },
      { key: 'D1', lane: 'D', kind: '能力自述', factIds: ['f4'], text: '淇淇没有 run_check，跑不了 tsc' },
    ],
    derived: [],
  }
}

const messages = ['m1', 'm2', 'm3', 'm4']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('consensus builder · 物化与指标', () => {
  it('4 条事实 → A/B/C/D 四簇，provenance 与版本可用', () => {
    const result = buildConsensusState(baseFacts(), baseDraft(), { mode: 'legacy' })
    expect(result.ok).toBe(true)
    const state = result.state!
    expect(state.schema).toBe('consensus-v1')
    expect(state.version.startsWith('consensus-v1:')).toBe(true)
    expect(state.metrics).toMatchObject({
      facts: 4,
      clusters: 4,
      derived: 0,
      lanes: { A: 1, B: 1, C: 1, D: 1 },
      archivedFacts: 1,
      mergedFacts: 0,
    })
    expect(state.metrics.statusCounts).toEqual({
      candidate: 0, active: 3, applied: 0, done: 0, resolved: 0, superseded: 0, expired: 0, archived: 1,
    })
    expect(state.provenance).toEqual({ expected: 4, resolved: 4, missingFactIds: [] })
    expect(state.clusters.find((cluster) => cluster.key === 'D1')!.status).toBe('archived')
    expect(state.clusters.find((cluster) => cluster.key === 'A1')!.refs[0]).toMatchObject({
      factId: 'f1',
      factEventSeq: 1,
      sourceMessageId: 'm1',
    })
  })

  it('同一输入幂等；内容变化则版本变化', () => {
    const first = buildConsensusState(baseFacts(), baseDraft(), { mode: 'legacy' })
    const second = buildConsensusState(baseFacts(), baseDraft(), { mode: 'legacy' })
    expect(first.state!.version).toBe(second.state!.version)
    const changed = clone(baseDraft())
    changed.clusters[0].text = 'threadId 只允许 [A-Za-z0-9_-]{1,80}'
    const third = buildConsensusState(baseFacts(), changed, { mode: 'legacy' })
    expect(third.state!.version).not.toBe(first.state!.version)
  })

  it('派生任务合法：从 C 簇拆出', () => {
    const draft = clone(baseDraft())
    draft.derived = [{ key: 'C2', lane: 'C', kind: '任务', fromKey: 'C1', factIds: ['f2'], text: '淇淇只看代码，给行号' }]
    const result = buildConsensusState(baseFacts(), draft, { mode: 'legacy' })
    expect(result.ok).toBe(true)
    expect(result.state!.metrics.derived).toBe(1)
    expect(result.state!.derived[0]).toMatchObject({ key: 'C2', fromKey: 'C1', lane: 'C' })
  })
})

describe('consensus builder · 契约拦截', () => {
  it('零丢失：漏掉一条事实必须报错', () => {
    const draft = clone(baseDraft())
    draft.clusters = draft.clusters.filter((cluster) => cluster.key !== 'D1')
    const errors = buildConsensusState(baseFacts(), draft, { mode: 'legacy' }).errors
    expect(errors.some((error) => error.startsWith('丢失：f4'))).toBe(true)
  })

  it('未知 factId / 重复分配必须报错', () => {
    const unknown = clone(baseDraft())
    unknown.clusters[0].factIds = ['f_missing']
    expect(buildConsensusState(baseFacts(), unknown, { mode: 'legacy' }).errors.some((error) => error.startsWith('未知 factId'))).toBe(true)

    const duplicated = clone(baseDraft())
    duplicated.clusters[1].factIds.push('f1')
    expect(buildConsensusState(baseFacts(), duplicated, { mode: 'legacy' }).errors.some((error) => error.startsWith('事实重复分配'))).toBe(true)
  })

  it('来源错栏：用户 fact 只能 A/C，角色 fact 只能 B/D', () => {
    const userInB = clone(baseDraft())
    userInB.clusters[2].factIds = ['f1']
    userInB.clusters[0].factIds = ['f3']
    const errors = buildConsensusState(baseFacts(), userInB, { mode: 'legacy' }).errors
    expect(errors.filter((error) => error.startsWith('来源错栏')).length).toBe(2)
  })

  it('能力/环境自述必须归档到 D，不能进 B', () => {
    const draft = clone(baseDraft())
    draft.clusters[2].factIds = ['f4']
    draft.clusters[3].factIds = []
    const errors = buildConsensusState(baseFacts(), draft, { mode: 'legacy' }).errors
    expect(errors.some((error) => error.startsWith('能力/环境自述必须归档'))).toBe(true)
  })

  it('环境类自述（未安装/检查根/无法执行）也必须归档到 D', () => {
    const facts: ConsensusFact[] = [{
      factId: 'f9',
      eventSeq: 9,
      kind: 'constraint',
      owner: '敏敏',
      text: '当前环境中未安装 vitest，无法运行测试；检查根指向其他工作区',
      sourceMessageId: 'm9',
      sourceMessageSeq: 9,
    }]
    const inB: ConsensusDraft = { clusters: [{ key: 'B1', lane: 'B', kind: '约束', factIds: ['f9'], text: facts[0].text }] }
    expect(buildConsensusState(facts, inB, { mode: 'legacy' }).errors.some((error) => error.startsWith('能力/环境自述必须归档'))).toBe(true)
    const inD: ConsensusDraft = { clusters: [{ key: 'D1', lane: 'D', kind: '能力自述', factIds: ['f9'], text: facts[0].text }] }
    const built = buildConsensusState(facts, inD, { mode: 'legacy' })
    expect(built.ok).toBe(true)
    expect(built.state!.clusters[0].status).toBe('archived')
  })

  it('prompt 回声混进簇正文或事实 → 报错', () => {
    const draft = clone(baseDraft())
    draft.clusters[0].text = '[当前消息] threadId 只允许字母数字'
    const errors = buildConsensusState(baseFacts(), draft, { mode: 'legacy' }).errors
    expect(errors.some((error) => error.includes('混入 prompt 回声'))).toBe(true)
  })

  it('空簇 / 重复 key / 非法 lane / 超长正文 / 空 kind 全部拦截', () => {
    const cases: ConsensusDraft[] = []
    const emptyIds = clone(baseDraft()); emptyIds.clusters[0].factIds = []; cases.push(emptyIds)
    const duplicateKey = clone(baseDraft()); duplicateKey.clusters[1].key = 'A1'; cases.push(duplicateKey)
    const badLane = clone(baseDraft()); badLane.clusters[0].lane = 'E' as unknown as ConsensusLane; cases.push(badLane)
    const longText = clone(baseDraft()); longText.clusters[0].text = 'x'.repeat(161); cases.push(longText)
    const emptyKind = clone(baseDraft()); emptyKind.clusters[0].kind = '   '; cases.push(emptyKind)
    for (const draft of cases) {
      expect(buildConsensusState(baseFacts(), draft, { mode: 'legacy' }).ok).toBe(false)
    }
  })

  it('派生来源不存在 / factIds 不在来源簇 → 报错', () => {
    const missingSource = clone(baseDraft())
    missingSource.derived = [{ key: 'C2', lane: 'C', kind: '任务', fromKey: 'C9', factIds: ['f2'], text: 'x' }]
    expect(buildConsensusState(baseFacts(), missingSource, { mode: 'legacy' }).errors.some((error) => error.startsWith('派生来源不存在'))).toBe(true)

    const notSubset = clone(baseDraft())
    notSubset.derived = [{ key: 'C2', lane: 'C', kind: '任务', fromKey: 'C1', factIds: ['f3'], text: 'x' }]
    expect(buildConsensusState(baseFacts(), notSubset, { mode: 'legacy' }).errors.some((error) => error.startsWith('派生 factIds 不在来源簇'))).toBe(true)
  })

  it('空 facts / 空草稿必须报错', () => {
    expect(buildConsensusState([], { clusters: [], derived: [] }, { mode: 'legacy' }).ok).toBe(false)
    expect(buildConsensusState(baseFacts(), { clusters: [], derived: [] }, { mode: 'legacy' }).ok).toBe(false)
  })
})

describe('consensus builder · provenance 模式', () => {
  it('new 模式要求 sourceMessageId 非空且真实存在', () => {
    const facts = baseFacts()
    expect(buildConsensusState(facts, baseDraft(), { mode: 'new', knownMessageIds: messages }).ok).toBe(true)

    const missing = clone(facts)
    delete missing[0].sourceMessageId
    const missingResult = buildConsensusState(missing, baseDraft(), { mode: 'new', knownMessageIds: messages })
    expect(missingResult.ok).toBe(false)
    expect(missingResult.errors.some((error) => error.startsWith('缺 sourceMessageId：f1'))).toBe(true)

    const unknown = clone(facts)
    unknown[0].sourceMessageId = 'm_unknown'
    const unknownResult = buildConsensusState(unknown, baseDraft(), { mode: 'new', knownMessageIds: messages })
    expect(unknownResult.ok).toBe(false)
    expect(unknownResult.errors.some((error) => error.includes('sourceMessageId 不存在'))).toBe(true)
  })

  it('legacy 允许空，但 provenance 如实记缺口', () => {
    const facts = clone(baseFacts())
    delete facts[0].sourceMessageId
    const result = buildConsensusState(facts, baseDraft(), { mode: 'legacy' })
    expect(result.ok).toBe(true)
    expect(result.state!.provenance).toEqual({ expected: 4, resolved: 3, missingFactIds: ['f1'] })
  })
})

describe('consensus prompt 渲染', () => {
  it('包含 A/C/B、排除 D、带引用、不超预算', () => {
    const state = buildConsensusState(baseFacts(), baseDraft(), { mode: 'legacy' }).state!
    const block = renderConsensusPrompt(state)
    expect(block.block).toContain('[用户指令]')
    expect(block.block).toContain('敏敏跑 typecheck 并贴数字')
    expect(block.block).toContain('[群共识（结论，非用户指令）]')
    expect(block.block).not.toContain('淇淇没有 run_check')
    expect(block.block).toContain('#1')
    expect(block.chars).toBeLessThanOrEqual(1800)
    expect(block.included).toEqual(expect.arrayContaining(['A1', 'C1', 'B1']))
  })

  it('预算不足时整行丢弃并显式注明，不静默截断', () => {
    const facts: ConsensusFact[] = []
    const draft: ConsensusDraft = { clusters: [] }
    for (let index = 0; index < 30; index++) {
      facts.push({
        factId: 'f' + index,
        eventSeq: index + 1,
        kind: 'decision',
        owner: '用户',
        text: '第 ' + index + ' 条用户指令：' + '约束说明'.repeat(8),
        sourceMessageId: 'm' + index,
      })
      draft.clusters.push({ key: 'A' + index, lane: 'A', kind: '决定', factIds: ['f' + index], text: '第 ' + index + ' 条用户指令：' + '约束说明'.repeat(8) })
    }
    const state = buildConsensusState(facts, draft, { mode: 'legacy' }).state!
    const block = renderConsensusPrompt(state, { charBudget: 300 })
    expect(block.chars).toBeLessThanOrEqual(300)
    expect(block.dropped).toBeGreaterThan(0)
    expect(block.block).toContain('另有')
    expect(block.included.length).toBeLessThan(30)
  })
})

describe('curator prompt 与解析', () => {
  it('curator prompt 带 facts 与硬规则', () => {
    const prompt = buildCuratorPrompt({
      threadTitle: '测试群',
      facts: baseFacts().map((fact) => ({ factId: fact.factId, owner: fact.owner, kind: fact.kind, text: fact.text })),
    })
    expect(prompt.system).toContain('只输出 JSON')
    expect(prompt.system).toContain('D 环境或能力自述')
    expect(prompt.system).toContain('80 字')
    expect(prompt.prompt).toContain('f1')
    expect(prompt.prompt).toContain('fact 数量：4')
  })

  it('解析合法 JSON（含代码块）', () => {
    const payload = {
      clusters: [
        { key: 'A1', lane: 'A', kind: '约束', factIds: ['f1'], text: 'threadId 只允许字母数字' },
        { key: 'B1', lane: 'B', kind: '立场', factIds: ['f3'], text: '主链路堵上了' },
      ],
      derived: [{ key: 'C2', lane: 'C', kind: '任务', fromKey: 'B1', factIds: ['f3'], text: '跟进' }],
    }
    const parsed = parseCuratorOutput('```json\n' + JSON.stringify(payload) + '\n```')
    expect(parsed.ok).toBe(true)
    expect(parsed.draft!.clusters).toHaveLength(2)
    expect(parsed.draft!.derived).toHaveLength(1)
  })

  it('坏 JSON / 无非对象输出 → 报错', () => {
    expect(parseCuratorOutput('not json').ok).toBe(false)
    expect(parseCuratorOutput('{oops').ok).toBe(false)
    expect(parseCuratorOutput('[]').ok).toBe(false)
    expect(parseCuratorOutput('{"clusters": "nope"}').ok).toBe(false)
  })

  it('非法 lane / 重复 key / 重复 factId / 超长 text → 报错', () => {
    const badLane = { clusters: [{ key: 'A1', lane: 'E', kind: '约束', factIds: ['f1'], text: 'x' }] }
    expect(parseCuratorOutput(JSON.stringify(badLane)).ok).toBe(false)

    const duplicateKey = {
      clusters: [
        { key: 'A1', lane: 'A', kind: '约束', factIds: ['f1'], text: 'x' },
        { key: 'A1', lane: 'B', kind: '立场', factIds: ['f2'], text: 'y' },
      ],
    }
    expect(parseCuratorOutput(JSON.stringify(duplicateKey)).ok).toBe(false)

    const duplicateFact = {
      clusters: [
        { key: 'A1', lane: 'A', kind: '约束', factIds: ['f1'], text: 'x' },
        { key: 'B1', lane: 'B', kind: '立场', factIds: ['f1'], text: 'y' },
      ],
    }
    expect(parseCuratorOutput(JSON.stringify(duplicateFact)).ok).toBe(false)

    const longText = { clusters: [{ key: 'A1', lane: 'A', kind: '约束', factIds: ['f1'], text: 'x'.repeat(161) }] }
    expect(parseCuratorOutput(JSON.stringify(longText)).ok).toBe(false)
  })

  it('派生簇 lane 非 C → 报错', () => {
    const payload = {
      clusters: [{ key: 'C1', lane: 'C', kind: '任务', factIds: ['f2'], text: '跑检查' }],
      derived: [{ key: 'C2', lane: 'A', kind: '任务', fromKey: 'C1', factIds: ['f2'], text: '拆出' }],
    }
    expect(parseCuratorOutput(JSON.stringify(payload)).ok).toBe(false)
  })

  it('解析 kind 别名与 status；非法 kind/status 报错', () => {
    const payload = {
      clusters: [
        { key: 'A1', lane: 'A', kind: 'decision', status: 'candidate', factIds: ['f1'], text: 'x' },
        { key: 'B1', lane: 'B', kind: 'stance', status: 'superseded', supersededByKey: 'B2', factIds: ['f2'], text: 'y' },
        { key: 'B2', lane: 'B', kind: '立场', status: 'active', factIds: ['f3'], text: 'z' },
      ],
    }
    const parsed = parseCuratorOutput(JSON.stringify(payload))
    expect(parsed.ok).toBe(true)
    expect(parsed.draft!.clusters[0]).toMatchObject({ kind: '决定', status: 'candidate' })
    expect(parsed.draft!.clusters[1]).toMatchObject({ status: 'superseded', supersededByKey: 'B2' })

    expect(parseCuratorOutput(JSON.stringify({
      clusters: [{ key: 'A1', lane: 'A', kind: '乱写', factIds: ['f1'], text: 'x' }],
    })).ok).toBe(false)
    expect(parseCuratorOutput(JSON.stringify({
      clusters: [{ key: 'A1', lane: 'A', kind: '约束', status: 'whatever', factIds: ['f1'], text: 'x' }],
    })).ok).toBe(false)
  })
})

describe('生命周期状态与 kind', () => {
  function factsWithExtra(): ConsensusFact[] {
    return [
      ...baseFacts(),
      { factId: 'f5', eventSeq: 5, kind: 'stance', owner: '敏敏', text: '新结论成立', sourceMessageId: 'm5', sourceMessageSeq: 5 },
      { factId: 'f6', eventSeq: 6, kind: 'stance', owner: '敏敏', text: '旧结论已解决', sourceMessageId: 'm6', sourceMessageSeq: 6 },
    ]
  }

  it('缺省状态按 lane 决定；中英文 kind 归一', () => {
    const draft = clone(baseDraft())
    draft.clusters[0].kind = 'constraint'
    draft.clusters[2].kind = 'stance'
    const result = buildConsensusState(baseFacts(), draft, { mode: 'legacy' })
    expect(result.ok).toBe(true)
    const state = result.state!
    expect(state.clusters.find((cluster) => cluster.key === 'A1')).toMatchObject({ kind: '约束', status: 'active' })
    expect(state.clusters.find((cluster) => cluster.key === 'B1')).toMatchObject({ kind: '立场', status: 'active' })
    expect(state.clusters.find((cluster) => cluster.key === 'C1')).toMatchObject({ kind: '任务', status: 'active' })
    expect(state.clusters.find((cluster) => cluster.key === 'D1')).toMatchObject({ kind: '能力自述', status: 'archived' })
  })

  it('未知 kind / lane 与 status 不匹配 / superseded 缺指针 → 报错', () => {
    const badKind = clone(baseDraft())
    badKind.clusters[0].kind = '乱写'
    expect(buildConsensusState(baseFacts(), badKind, { mode: 'legacy' }).errors.some((error) => error.startsWith('未知 kind'))).toBe(true)

    const badStatus = clone(baseDraft())
    badStatus.clusters[0].status = 'done'
    expect(buildConsensusState(baseFacts(), badStatus, { mode: 'legacy' }).errors.some((error) => error.includes('status 与 lane 不匹配'))).toBe(true)

    const missingPointer = clone(baseDraft())
    missingPointer.clusters[2].status = 'superseded'
    expect(buildConsensusState(baseFacts(), missingPointer, { mode: 'legacy' }).errors.some((error) => error.startsWith('superseded 缺 supersededByKey'))).toBe(true)

    const dangling = clone(baseDraft())
    dangling.clusters[2].status = 'superseded'
    dangling.clusters[2].supersededByKey = 'B9'
    expect(buildConsensusState(baseFacts(), dangling, { mode: 'legacy' }).errors.some((error) => error.startsWith('supersededByKey 不存在'))).toBe(true)

    const selfPointer = clone(baseDraft())
    selfPointer.clusters[2].status = 'superseded'
    selfPointer.clusters[2].supersededByKey = 'B1'
    expect(buildConsensusState(baseFacts(), selfPointer, { mode: 'legacy' }).errors.some((error) => error.startsWith('supersededByKey 不能指向自己'))).toBe(true)
  })

  it('superseded 指向新簇：状态落盘、旧结论/已解决历史结论不进 prompt', () => {
    const facts = factsWithExtra()
    const draft = clone(baseDraft())
    draft.clusters[2].status = 'superseded'
    draft.clusters[2].supersededByKey = 'B2'
    draft.clusters.push(
      { key: 'B2', lane: 'B', kind: '立场', factIds: ['f5'], text: '新结论成立' },
      { key: 'B3', lane: 'B', kind: '立场', factIds: ['f6'], text: '旧结论已解决', status: 'resolved' },
    )
    const result = buildConsensusState(facts, draft, { mode: 'legacy' })
    expect(result.ok).toBe(true)
    const state = result.state!
    expect(state.clusters.find((cluster) => cluster.key === 'B1')!.status).toBe('superseded')
    expect(state.metrics.statusCounts.superseded).toBe(1)
    expect(state.metrics.statusCounts.resolved).toBe(1)
    const block = renderConsensusPrompt(state)
    expect(block.block).not.toContain('主链路堵上了')
    expect(block.block).toContain('新结论成立')
    expect(block.block).not.toContain('旧结论已解决')
  })

  it('candidate 进「待确认」块，不冒充权威结论', () => {
    const facts = factsWithExtra().slice(0, 5)
    const draft = clone(baseDraft())
    draft.clusters[2].status = 'candidate'
    draft.clusters.push({ key: 'B2', lane: 'B', kind: '立场', factIds: ['f5'], text: '新结论成立', status: 'resolved' })
    const result = buildConsensusState(facts, draft, { mode: 'legacy' })
    expect(result.ok).toBe(true)
    const block = renderConsensusPrompt(result.state!)
    expect(block.block).toContain('[待确认（非指令，仅供核对）]')
    expect(block.block).toContain('主链路堵上了')
    expect(block.block).not.toContain('新结论成立')
  })

  it('正文自带的“名字：”前缀会被剥掉', () => {
    const draft = clone(baseDraft())
    draft.clusters[3].text = '淇淇：淇淇没有 run_check，跑不了 tsc'
    const result = buildConsensusState(baseFacts(), draft, { mode: 'legacy' })
    expect(result.ok).toBe(true)
    expect(result.state!.clusters.find((cluster) => cluster.key === 'D1')!.text).toBe('淇淇没有 run_check，跑不了 tsc')
  })
})
