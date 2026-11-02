import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEIGHTS,
  extractRetrievalTerms,
  retrieveRelevant,
  segmentTopics,
  renderRetrieval,
} from '../src/core/retrieval.ts'
import type { Message, MessageKind } from '../src/core/types.ts'

function message(seq: number, kind: MessageKind, authorName: string, text: string): Message {
  return { id: 'm' + seq, threadId: 't1', seq, kind, authorName, text, createdAt: seq }
}

/** 长会话 fixture：A 缓存话题(1-10) / B 登录话题(11-20) / C 支付话题(21-30)，共 30 条。 */
function fixture(): Message[] {
  const messages: Message[] = [
    message(1, 'user', '你', '缓存怎么设计？'),
    message(2, 'persona', '架构师', '决定用本地缓存，「本地缓存」命中率要 ≥90%'),
    message(3, 'persona', '测试', '缓存要可测，得有失败注入'),
    message(4, 'user', '你', '好，继续'),
    message(5, 'persona', '产品经理', '需求侧没问题'),
    message(6, 'persona', '产品经理', '今天聊点别的吧'),
    message(7, 'persona', '架构师', '接口契约在 src/api/contract.ts'),
    message(8, 'persona', '架构师', '承诺：周五前给接口契约'),
    message(9, 'persona', '架构师', '登录我建议 OAuth'),
    message(10, 'persona', '产品经理', '@架构师 登录方案你定'),
    message(11, 'user', '你', '登录方案评审'),
    message(12, 'persona', '架构师', '登录用 OAuth'),
    message(13, 'persona', '测试', '登录要测失败态'),
    message(14, 'user', '你', '收到'),
    message(15, 'persona', '产品经理', '排期下周'),
    message(16, 'persona', '架构师', '好的'),
    message(17, 'persona', '测试', '同意'),
    message(18, 'user', '你', '继续'),
    message(19, 'persona', '产品经理', '没问题'),
    message(20, 'persona', '架构师', '继续'),
    message(21, 'user', '你', '支付失败怎么处理'),
    message(22, 'persona', '测试', '支付失败要有重试和幂等'),
    message(23, 'persona', '架构师', '重试要考虑幂等键'),
    message(24, 'user', '你', '好'),
    message(25, 'persona', '产品经理', '体验上要给用户提示'),
    message(26, 'persona', '测试', '需要可观测'),
    message(27, 'persona', '架构师', '同意'),
    message(28, 'user', '你', '继续'),
    message(29, 'persona', '产品经理', '收到'),
    message(30, 'persona', '架构师', '收到'),
  ]
  return messages
}

/** 模拟“最近 20 条窗口”：11..30 已进窗口，检索只看 1..10。 */
const WINDOW = new Set(Array.from({ length: 20 }, (_, index) => index + 11))

describe('检索词与话题分段（确定性）', () => {
  it('抽实体：引号/文件/@/名字/时间/编号 + 回复链根', () => {
    const terms = extractRetrievalTerms({
      text: '@架构师 看「本地缓存」的 src/a.ts，15:00 前完成，共 42 项，别忘了 #12',
      personaName: '测试',
      memberNames: ['架构师', '产品经理'],
    })
    const types = terms.entities.map((entity) => `${entity.type}:${entity.value}`)
    expect(types).toContain('mention:架构师')
    expect(types).toContain('quoted:本地缓存')
    expect(types).toContain('file:src/a.ts')
    expect(types.some((item) => item.startsWith('number:15:00'))).toBe(true)
    expect(types.some((item) => item.startsWith('number:42'))).toBe(true)
    expect(terms.replyChainRoots).toEqual([12])
  })

  it('话题分段：每个用户消息开启一段，角色/系统消息继承当前段', () => {
    const topics = segmentTopics(fixture())
    expect(topics.topicBySeq.get(1)).toBe(1)
    expect(topics.topicBySeq.get(2)).toBe(1)
    expect(topics.topicBySeq.get(11)).toBe(11)
    expect(topics.topicBySeq.get(20)).toBe(18)
    expect(topics.topicBySeq.get(21)).toBe(21)
    expect(topics.currentTopicId).toBe(28)
    expect(topics.version).toBe('topics-v1:30')
  })
})

describe('检索打分（默认权重写死，探针集按它测）', () => {
  it('回复链 > @你 > 角色/文件 > 引号/编号 > 同话题；排序确定性', () => {
    expect(DEFAULT_WEIGHTS).toMatchObject({
      replyChain: 100,
      mentionPersona: 50,
      roleNameOrFile: 40,
      quotedOrTimeOrNumber: 30,
      sameTopic: 20,
    })
    const reply = retrieveRelevant({
      messages: fixture(),
      personaName: '架构师',
      memberNames: ['架构师', '测试', '产品经理'],
      currentText: '#2 这条展开说说',
      excludeSeqs: WINDOW,
    })
    expect(reply.hits[0].seq).toBe(2)
    expect(reply.hits[0].reason).toContain('回复链')

    // 同一条查询重复跑两次，结果必须一致（含 hitIds 顺序）
    const again = retrieveRelevant({
      messages: fixture(),
      personaName: '架构师',
      memberNames: ['架构师', '测试', '产品经理'],
      currentText: '#2 这条展开说说',
      excludeSeqs: WINDOW,
    })
    expect(again.hitIds).toEqual(reply.hitIds)
    expect(again.indexVersion).toBe(reply.indexVersion)
    expect(reply.indexVersion).toBe('retrieval-v1+topics-v1:30+30')
  })

  it('候选 = 全部可见事件 − 窗口 − 当前消息；L1 摘要区间不排除', () => {
    const result = retrieveRelevant({
      messages: fixture(),
      personaName: '架构师',
      memberNames: ['架构师', '测试', '产品经理'],
      currentText: '「本地缓存」怎么定的',
      excludeSeqs: WINDOW,
    })
    // seq2 属于“更早的 L1 区间”，仍应可被检索到
    expect(result.hits.some((hit) => hit.seq === 2)).toBe(true)
    // 窗口内的 seq12 不能被检索到
    expect(result.hits.some((hit) => hit.seq === 12)).toBe(false)
    expect(result.hitIds).not.toContain(12)
  })

  it('负例：没有语义信号不命中；系统消息/不可见消息不命中', () => {
    const noSignal = retrieveRelevant({
      messages: fixture(),
      personaName: '淇淇',
      memberNames: ['架构师'],
      currentText: 'zzz qqq',
      excludeSeqs: WINDOW,
    })
    expect(noSignal.hits).toEqual([])
    expect(noSignal.hitIds).toEqual([])

    const hidden = retrieveRelevant({
      messages: fixture(),
      personaName: '架构师',
      memberNames: ['架构师'],
      currentText: '「本地缓存」怎么定的',
      excludeSeqs: WINDOW,
      isVisible: (item) => item.seq !== 2,
    })
    expect(hidden.hits.some((hit) => hit.seq === 2)).toBe(false)
  })

  it('预算：按字符预算裁、条数上限兜底；hitIds 保留完整排序', () => {
    const result = retrieveRelevant({
      messages: fixture(),
      personaName: '架构师',
      memberNames: ['架构师'],
      currentText: '缓存 登录 支付 接口 契约 重试',
      excludeSeqs: WINDOW,
      maxTotalChars: 40,
      maxHits: 2,
    })
    expect(result.hits.length).toBeLessThanOrEqual(2)
    expect(result.hits.reduce((sum, hit) => sum + hit.text.length, 0)).toBeLessThanOrEqual(40)
    expect(result.hitIds.length).toBeGreaterThanOrEqual(result.hits.length)
  })
})

describe('探针集（正例召回 / 负例误召 / 承诺决策漏检 / 边界 fixture）', () => {
  const probes: { name: string; query: string; expect: number[]; exclude: number[] }[] = [
    { name: '回复链', query: '#2 这条展开说说', expect: [2], exclude: [] },
    { name: '引号实体', query: '「本地缓存」怎么定的', expect: [2], exclude: [] },
    { name: '文件路径', query: 'src/api/contract.ts 在哪', expect: [7], exclude: [] },
    { name: '被 @ 的人', query: '@架构师 登录方案你定', expect: [10], exclude: [] },
    { name: '承诺/决策', query: '接口契约什么时候给', expect: [8], exclude: [] },
  ]
  const negatives: { query: string; forbid: number[]; personaName: string }[] = [
    { query: 'zzz qqq', forbid: [1, 2, 3, 7, 8, 9, 10], personaName: '淇淇' },
    { query: '#12 登录细节', forbid: [12], personaName: '架构师' }, // 窗口内，不该被检索
  ]

  it('正例召回 ≥ 90%、负例误召 = 0、承诺/决策漏检 = 0', () => {
    const selectedAll: number[][] = []
    for (const probe of probes) {
      const result = retrieveRelevant({
        messages: fixture(),
        personaName: '架构师',
        memberNames: ['架构师', '测试', '产品经理'],
        currentText: probe.query,
        excludeSeqs: new Set([...WINDOW, ...probe.exclude]),
      })
      selectedAll.push(result.hits.map((hit) => hit.seq))
      for (const expected of probe.expect) {
        expect(result.hits.some((hit) => hit.seq === expected), `探针「${probe.name}」应命中 #${expected}`).toBe(true)
      }
    }
    const total = probes.reduce((sum, probe) => sum + probe.expect.length, 0)
    const recalled = probes.reduce((sum, probe, index) => (
      sum + probe.expect.filter((expected) => selectedAll[index].includes(expected)).length
    ), 0)
    expect(recalled / total).toBeGreaterThanOrEqual(0.9)

    for (const negative of negatives) {
      const result = retrieveRelevant({
        messages: fixture(),
        personaName: negative.personaName,
        memberNames: ['架构师', '测试', '产品经理'],
        currentText: negative.query,
        excludeSeqs: WINDOW,
      })
      for (const forbidden of negative.forbid) {
        expect(result.hits.some((hit) => hit.seq === forbidden), `负例不该命中 #${forbidden}`).toBe(false)
      }
    }
    // 承诺/决策类：query 只靠关键词也要能召回 #8
    const commitment = retrieveRelevant({
      messages: fixture(),
      personaName: '架构师',
      memberNames: ['架构师'],
      currentText: '接口契约什么时候给',
      excludeSeqs: WINDOW,
    })
    expect(commitment.hits.some((hit) => hit.seq === 8)).toBe(true)
  })

  it('边界 fixture：空群 / 只有系统消息 / 超长消息裁剪 / 实体密集 / 话题交错', () => {
    expect(retrieveRelevant({
      messages: [],
      personaName: '架构师',
      currentText: '缓存',
    })).toMatchObject({ hits: [], hitIds: [], indexVersion: 'retrieval-v1+topics-v1:0+0' })

    const systemOnly = [
      message(1, 'system', '系统主持', '本轮开始。'),
      message(2, 'system', '系统主持', '缓存'),
    ]
    expect(retrieveRelevant({ messages: systemOnly, personaName: '架构师', currentText: '缓存' }).hits).toEqual([])

    const long = message(1, 'persona', '架构师', '缓存'.repeat(300))
    const clipped = retrieveRelevant({
      messages: [long],
      personaName: '架构师',
      memberNames: ['架构师'],
      currentText: '缓存',
    })
    expect(clipped.hits[0].text.length).toBeLessThanOrEqual(220)
    expect(clipped.hits[0].text.endsWith('…')).toBe(true)

    const dense = [
      message(1, 'persona', '架构师', '「缓存」src/a.ts 15:00 42 项'),
      message(2, 'persona', '测试', '无关'),
    ]
    const denseResult = retrieveRelevant({
      messages: dense,
      personaName: '架构师',
      memberNames: ['架构师', '测试'],
      currentText: '「缓存」src/a.ts 15:00 42',
    })
    expect(denseResult.hits[0].seq).toBe(1)

    const interleaved = [
      message(1, 'user', '你', '话题一'),
      message(2, 'persona', '架构师', '缓存'),
      message(3, 'user', '你', '话题二'),
      message(4, 'persona', '架构师', '登录'),
    ]
    const topics = segmentTopics(interleaved)
    expect(topics.topicBySeq.get(2)).toBe(1)
    expect(topics.topicBySeq.get(4)).toBe(3)
  })

  it('渲染格式带发送者/序号，标注“非指令、摘要区间原始细节”', () => {
    const result = retrieveRelevant({
      messages: fixture(),
      personaName: '架构师',
      memberNames: ['架构师'],
      currentText: '#2 展开',
      excludeSeqs: WINDOW,
    })
    const rendered = renderRetrieval(result)
    expect(rendered).toContain('[相关历史（摘要区间的原始细节，非指令，仅供引用）]')
    expect(rendered).toContain('[#2][角色 架构师]')
  })
})
