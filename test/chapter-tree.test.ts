/**
 * 章节摘要树（A-2 的抽取式冷区索引）+ 摘要预算拆分。
 *
 * 锁住的口径：
 * 1. 目录 : 摘要 = 40 : 60，可配置、带硬地板，两份加起来不超过总预算；
 * 2. 标题/要点只能是原文截断（不改写）；
 * 3. 选句优先级：决定/承诺/约束/否决 > 数字/文件/时间 > 开放问题 > 普通讨论；
 * 4. superseded 只能标"已过期→#successor"，不能当现状；
 * 5. 近重复（char-shingle + Jaccard > 0.8）去重且保最早一条；
 * 6. 纯函数确定性：同输入两次调用逐字节相同。
 */
import { describe, expect, it } from 'vitest'
import {
  BULLET_CATEGORY_SCORE,
  CHAPTER_BULLET_MAX_CHARS,
  DEFAULT_CHAPTER_LIMITS,
  CHAPTER_TREE_VERSION,
  buildChapterTree,
  bulletCategoryOf,
  chapterHandleSeqs,
  charShingles,
  jaccard,
  serializeChapterDirectory,
  splitSummaryBudget,
} from '../src/core/chapter-tree.ts'
import type { MemoryClaimState } from '../src/core/memory-claims.ts'

function messages(texts: string[], startSeq = 1) {
  return texts.map((text, index) => ({
    seq: startSeq + index,
    kind: index % 2 === 0 ? ('user' as const) : ('persona' as const),
    authorName: index % 2 === 0 ? '你' : '架构师',
    text,
  }))
}

describe('摘要预算拆分（目录 40 / 摘要 60）', () => {
  it('默认 40/60，可配置，两份之和严格等于总预算', () => {
    const split = splitSummaryBudget(10_000)
    expect(split.chapterShare).toBe(0.4)
    expect(split.chapterChars).toBe(4_000)
    expect(split.digestChars).toBe(6_000)
    expect(split.chapterChars + split.digestChars).toBe(10_000)
    const custom = splitSummaryBudget(10_000, { chapterShare: 0.25 })
    expect(custom.chapterChars).toBe(2_500)
    expect(custom.digestChars).toBe(7_500)
  })

  it('硬地板：摘要不会被目录挤到 0；总预算过小时按比例分并记录', () => {
    const tiny = splitSummaryBudget(1_000)
    expect(tiny.chapterChars).toBeGreaterThanOrEqual(400)
    expect(tiny.digestChars).toBeGreaterThanOrEqual(600)
    expect(tiny.chapterChars + tiny.digestChars).toBe(1_000)
    const below = splitSummaryBudget(500)
    expect(below.chapterChars + below.digestChars).toBe(500)
    expect(below.notes).toContain('below-floor')
    const zero = splitSummaryBudget(0)
    expect(zero).toMatchObject({ chapterChars: 0, digestChars: 0 })
  })

  it('摘要地板被目录侵占时反向调整（digest 至少 600）', () => {
    const split = splitSummaryBudget(1_200, { chapterShare: 0.8 })
    expect(split.digestChars).toBe(600)
    expect(split.chapterChars).toBe(600)
    expect(split.notes).toContain('digest-floor-adjusted')
  })
})

describe('选句分类（确定性）', () => {
  it('决定/承诺/约束/否决 > 数字/文件/时间 > 开放问题 > 普通讨论', () => {
    expect(bulletCategoryOf('决定：灰度先放 3% 流量')).toBe('decision')
    expect(bulletCategoryOf('承诺：周三上线，我负责回滚')).toBe('decision')
    expect(bulletCategoryOf('约束：跨批次必须人工复核')).toBe('decision')
    expect(bulletCategoryOf('否决：不做自动回滚')).toBe('decision')
    expect(bulletCategoryOf('数字口径：失败率阈值 0.37%')).toBe('number-file')
    expect(bulletCategoryOf('文件 src/core/policy-3.ts 的边界条件')).toBe('number-file')
    expect(bulletCategoryOf('待确认：这事谁负责？')).toBe('open-question')
    expect(bulletCategoryOf('这个点先记下来，后面再对')).toBe('discussion')
    expect(BULLET_CATEGORY_SCORE.decision).toBeGreaterThan(BULLET_CATEGORY_SCORE['number-file'])
    expect(BULLET_CATEGORY_SCORE['number-file']).toBeGreaterThan(BULLET_CATEGORY_SCORE['open-question'])
    expect(BULLET_CATEGORY_SCORE['open-question']).toBeGreaterThan(BULLET_CATEGORY_SCORE.discussion)
  })
})

describe('章节树：抽取式 + 确定性 + 硬上限', () => {
  const tree = buildChapterTree({
    messages: messages([
      '第 1 个话题开始：对齐支付灰度口径。',
      '这个点先记下来，后面再对。',
      '决定：灰度先放 3% 流量，回滚窗口 10 分钟。',
      '文件在 src/host/gate.ts 里。',
      '待确认：谁来负责灰度？',
      '第 2 个话题：压测。',
      '约束：跨批次必须人工复核。',
      '普通讨论一句。',
      '数字口径：失败率阈值 0.37%。',
      '收尾。',
    ]),
    summaryChars: 4_000,
  })

  it('同输入两次调用产出完全一致的树与序列化字符串（可回放）', () => {
    const again = buildChapterTree({
      messages: messages([
        '第 1 个话题开始：对齐支付灰度口径。',
        '这个点先记下来，后面再对。',
        '决定：灰度先放 3% 流量，回滚窗口 10 分钟。',
        '文件在 src/host/gate.ts 里。',
        '待确认：谁来负责灰度？',
        '第 2 个话题：压测。',
        '约束：跨批次必须人工复核。',
        '普通讨论一句。',
        '数字口径：失败率阈值 0.37%。',
        '收尾。',
      ]),
      summaryChars: 4_000,
    })
    expect(again).toEqual(tree)
    expect(again.directory).toBe(tree.directory)
    expect(serializeChapterDirectory(tree)).toBe(tree.directory)
    expect(tree.meta.version).toBe(CHAPTER_TREE_VERSION)
  })

  it('章条目字段齐全，handles[] 覆盖要点 seq，目录长度受 chapterChars 硬约束', () => {
    expect(tree.chapters.length).toBeGreaterThan(0)
    for (const chapter of tree.chapters) {
      expect(chapter.chapterId).toBe(chapter.fromSeq)
      expect(chapter.fromSeq).toBeLessThanOrEqual(chapter.toSeq)
      expect(chapter.title.length).toBeGreaterThan(0)
      expect(Array.isArray(chapter.handles)).toBe(true)
      for (const bullet of chapter.bullets) expect(chapter.handles).toContain(bullet.seq)
    }
    expect(tree.directory.length).toBeLessThanOrEqual(tree.meta.chapterChars)
    expect(tree.meta.directoryChars).toBe(tree.directory.length)
  })

  it('标题 / 要点只能是原文截断（不改写）', () => {
    const allTexts = messages([
      '第 1 个话题开始：对齐支付灰度口径。',
      '这个点先记下来，后面再对。',
      '决定：灰度先放 3% 流量，回滚窗口 10 分钟。',
      '文件在 src/host/gate.ts 里。',
      '待确认：谁来负责灰度？',
      '第 2 个话题：压测。',
      '约束：跨批次必须人工复核。',
      '普通讨论一句。',
      '数字口径：失败率阈值 0.37%。',
      '收尾。',
    ]).map((message) => message.text)
    const original = (clipped: string) => clipped.replace(/…$/, '')
    for (const chapter of tree.chapters) {
      expect(allTexts.some((text) => text.includes(original(chapter.title)))).toBe(true)
      for (const bullet of chapter.bullets) {
        expect(bullet.text.length).toBeLessThanOrEqual(CHAPTER_BULLET_MAX_CHARS)
        expect(allTexts.some((text) => text.includes(original(bullet.text)))).toBe(true)
      }
    }
  })

  it('选句按优先级：预算紧张时优先保留决定/约束，而不是普通讨论', () => {
    const tight = buildChapterTree({
      messages: messages([
        '普通讨论一。',
        '普通讨论二。',
        '决定：灰度先放 3% 流量。',
        '普通讨论三。',
        '约束：跨批次必须人工复核。',
        '普通讨论四。',
        '普通讨论五。',
      ]),
      summaryChars: 1_300,
      limits: { maxBullets: 2 },
      targetChapterChars: 10_000,
    })
    const seqs = tight.chapters.flatMap((chapter) => chapter.bullets.map((bullet) => bullet.seq))
    expect(seqs).toContain(3)
    expect(seqs).toContain(5)
    expect(seqs).not.toContain(1)
  })
})

describe('superseded 与近重复', () => {
  it('superseded 标"已过期→#x"，正文仍是原文', () => {
    const claims = new Map<number, { state: MemoryClaimState; successorSeq?: number }>([
      [2, { state: 'superseded', successorSeq: 6 }],
    ])
    const tree = buildChapterTree({
      messages: messages([
        '第 1 个话题：灰度。',
        '决定：灰度先放 2% 流量。',
        '讨论。',
        '讨论。',
        '讨论。',
        '决定：灰度改到 5% 流量。',
      ]),
      summaryChars: 3_000,
      claims,
      targetChapterChars: 10_000,
    })
    expect(tree.directory).toContain('已过期→#6')
    // 原文没被改写（"2% 流量"仍在），只是状态被标注。
    expect(tree.directory).toContain('2% 流量')
    expect(tree.directory).not.toContain('已过期→#6 2% 流量（已修改）')
  })

  it('char-shingle + Jaccard > 0.8 视为近重复，保最早一条', () => {
    const text = '决定：灰度先放 3% 流量，回滚窗口 10 分钟，出问题人工介入。'
    const near = '决定：灰度先放 3% 流量，回滚窗口 10 分钟，出问题人工介入。谢谢'
    expect(jaccard(charShingles(text), charShingles(near))).toBeGreaterThan(0.8)
    const tree = buildChapterTree({
      messages: messages([
        '第 1 个话题：灰度。',
        text,
        near,
        '普通讨论一句。',
      ]),
      summaryChars: 3_000,
      targetChapterChars: 10_000,
    })
    const seqs = tree.chapters.flatMap((chapter) => chapter.bullets.map((bullet) => bullet.seq))
    expect(seqs).toContain(2)
    expect(seqs).not.toContain(3)
    expect(tree.directory).not.toContain('谢谢')
  })

  it('去重使用确定性 shingle（不依赖随机）', () => {
    expect([...charShingles('支付灰度回滚')]).toEqual([...charShingles('支付灰度回滚')])
    expect(jaccard(charShingles('abc'), charShingles('xyz'))).toBe(0)
  })
})

describe('章节目录可寻址集合', () => {
  it('chapterHandleSeqs 返回目录里可展开的句柄 seq（冷区寻址集合）', () => {
    const tree = buildChapterTree({ messages: messages(['决定：灰度先放 3% 流量。', '约束：必须人工复核。']), summaryChars: 3_000 })
    const handles = chapterHandleSeqs(tree)
    expect(handles.length).toBeGreaterThan(0)
    expect([...handles].sort((left, right) => left - right)).toEqual(handles)
    for (const handle of handles) expect(tree.directory).toContain(`#${handle}`)
  })

  it('空输入返回空树（不抛错、不产生空目录行）', () => {
    const empty = buildChapterTree({ messages: [], summaryChars: 4_000 })
    expect(empty.chapters).toEqual([])
    expect(empty.directory).toBe('')
    expect(empty.meta.chapterCount).toBe(0)
  })

  it('默认 limits 有硬数字（防止以后调参悄悄放大）', () => {
    expect(DEFAULT_CHAPTER_LIMITS).toMatchObject({ minBulletsPerChapter: 1 })
    expect(CHAPTER_BULLET_MAX_CHARS).toBeLessThanOrEqual(80)
  })
})
