/**
 * 双层窗口（热区最近窗口 + 冷区章节目录）。
 *
 * 设计口径：
 * - **热区** = 原有 `selectWindow` 的结果（保持既有不变量：最新一条、@我的、被 @ 的、
 *   自身最后发言都在热区）；
 * - **冷区** = 热区之前的消息，压成章节树/目录（`chapter-tree.ts`），只放 `#seq` 句柄；
 * - **跨层 seq 去重**：同一 seq 只能出现一次，热区优先；冷区目录只引用热区外的 seq。
 *   这条不变量是"prompt 里同一条历史不重复占预算"的硬保证。
 *
 * 纯函数、确定性（不依赖时间/随机），可进黄金回放。
 */
import { buildChapterTree, splitSummaryBudget, type ChapterClaim, type ChapterTree } from './chapter-tree.ts'
import { selectWindow, type PromptMessage } from './prompt.ts'

export interface DualWindowInput {
  /** 已分配 seq 的全部可见消息（`assignSeqs` 之后）。 */
  messages: readonly PromptMessage[]
  personaId: string
  personaName: string
  currentId?: string
  summaryUntilSeq?: number
  /** 热区字符预算（context-budget 的 `windowChars`）。 */
  windowChars: number
  /** 群级 summary 总预算（冷区目录从这里分 40%）。 */
  summaryChars: number
  /** 冷区目录占比（默认 40%）；0 = 不建冷区（例如记忆模式 off/shadow 不注入时省算力）。 */
  chapterShare?: number
  /** 单章目标大小（默认 summaryChars/3）。 */
  targetChapterChars?: number
  claims?: ReadonlyMap<number, ChapterClaim>
  keep?: number
  /** 已算好的热区（避免重复 selectWindow；与回执是同一份）。 */
  hot?: PromptMessage[]
  /**
   * 冷区额外排除的 seq：L1 摘要行 / memoryBlock 句柄 / 检索块已经引用过的 seq。
   * 跨层去重是"任何 seq 在最终 prompt 里最多出现一次"的硬保证（热区 + 摘要 + 目录 + 句柄）。
   */
  excludeSeqs?: ReadonlySet<number>
}

export interface DualWindowMeta {
  hotCount: number
  hotChars: number
  coldMessages: number
  coldChapters: number
  coldBullets: number
  directoryChars: number
  chapterChars: number
  /** 跨层去重审计：目录里若仍出现热区 seq 会在这里（正常必须为空）。 */
  dedupedSeqs: number[]
  /** 热区第一条的 seq（冷区严格早于它）。 */
  hotFromSeq: number
}

export interface DualWindow {
  hot: PromptMessage[]
  cold: ChapterTree
  /** 冷区章节目录（已序列化，长度 ≤ chapterChars）。 */
  directory: string
  meta: DualWindowMeta
}

function seqOf(message: PromptMessage): number {
  return typeof message.seq === 'number' && Number.isFinite(message.seq) && message.seq > 0 ? message.seq : 0
}

/**
 * 构建双层窗口。
 *
 * `chapterShare = 0` 时只算热区（冷区返回空树），用于 shadow/off 档：
 * 记忆层不注入时不该为目录付算力（但热区语义与 on 档完全一致）。
 */
export function buildDualWindow(input: DualWindowInput): DualWindow {
  const windowChars = Math.max(200, Math.floor(input.windowChars))
  const hot = input.hot ?? selectWindow({
    messages: input.messages,
    personaId: input.personaId,
    personaName: input.personaName,
    ...(input.currentId ? { currentId: input.currentId } : {}),
    ...(input.summaryUntilSeq === undefined ? {} : { summaryUntilSeq: input.summaryUntilSeq }),
    ...(input.keep === undefined ? {} : { keep: input.keep }),
    charBudget: windowChars,
  })
  const hotSeqs = new Set(hot.map((message) => seqOf(message)).filter((seq) => seq > 0))
  const currentMessage = input.currentId ? input.messages.find((message) => message.id === input.currentId) : undefined
  const currentSeq = currentMessage ? seqOf(currentMessage) : 0
  const hotFromSeq = hot.length
    ? Math.min(...hot.map(seqOf).filter((seq) => seq > 0))
    : (currentSeq > 0 ? currentSeq : Number.POSITIVE_INFINITY)
  const chapterShare = input.chapterShare ?? 0.4
  const hotChars = hot.reduce((sum, message) => sum + message.text.length, 0)
  if (chapterShare <= 0 || !Number.isFinite(chapterShare)) {
    return {
      hot,
      cold: emptyTree(input.summaryChars, chapterShare),
      directory: '',
      meta: {
        hotCount: hot.length,
        hotChars,
        coldMessages: 0,
        coldChapters: 0,
        coldBullets: 0,
        directoryChars: 0,
        chapterChars: 0,
        dedupedSeqs: [],
        hotFromSeq: Number.isFinite(hotFromSeq) ? hotFromSeq : 0,
      },
    }
  }
  // 冷区 = 热区第一条之前、不在热区、非当前、非系统、且没被 L1/句柄块引用过。
  // 这样目录引用的 seq 天然不与热区/摘要/句柄重叠（任何 seq 在最终 prompt 里最多出现一次）。
  const extraExclude = input.excludeSeqs ?? new Set<number>()
  const coldMessages = input.messages.filter((message) => {
    const seq = seqOf(message)
    if (!seq || hotSeqs.has(seq) || extraExclude.has(seq)) return false
    if (input.currentId && message.id === input.currentId) return false
    if (message.kind === 'system') return false
    return seq < hotFromSeq
  })
  const tree = buildChapterTree({
    messages: coldMessages,
    summaryChars: input.summaryChars,
    chapterShare,
    ...(input.targetChapterChars === undefined ? {} : { targetChapterChars: input.targetChapterChars }),
    ...(input.claims === undefined ? {} : { claims: input.claims }),
    excludeSeqs: hotSeqs,
  })
  // 跨层去重（防御性）：`excludeSeqs` 已经让冷区天然不含热区 seq；这里再做一次集合审计，
  // 若仍有交集（输入不合契约）记录下来，交给回执/测试暴露，而不是静默重复。
  const dedupedSeqs: number[] = []
  for (const chapter of tree.chapters) {
    for (const seq of chapter.handles) if (hotSeqs.has(seq)) dedupedSeqs.push(seq)
    for (const bullet of chapter.bullets) if (hotSeqs.has(bullet.seq)) dedupedSeqs.push(bullet.seq)
  }
  if (dedupedSeqs.length) tree.meta.backpressure.push('dual-window: 目录里出现热区 seq（违反跨层去重）')
  return {
    hot,
    cold: tree,
    directory: tree.directory,
    meta: {
      hotCount: hot.length,
      hotChars,
      coldMessages: tree.meta.messageCount,
      coldChapters: tree.meta.chapterCount,
      coldBullets: tree.meta.bulletCount,
      directoryChars: tree.directory.length,
      chapterChars: tree.meta.chapterChars,
      dedupedSeqs: [...new Set(dedupedSeqs)].sort((left, right) => left - right),
      hotFromSeq: Number.isFinite(hotFromSeq) ? hotFromSeq : 0,
    },
  }
}

function emptyTree(summaryChars: number, chapterShare: number): ChapterTree {
  const split = splitSummaryBudget(summaryChars, { chapterShare })
  return {
    chapters: [],
    directory: '',
    meta: {
      version: 'chapter-tree-v1',
      chapterChars: split.chapterChars,
      digestChars: split.digestChars,
      chapterCount: 0,
      bulletCount: 0,
      directoryChars: 0,
      messageCount: 0,
      trimmedBullets: 0,
      droppedChapters: 0,
      backpressure: ['cold-zone-disabled'],
    },
  }
}

/**
 * 最终 prompt 的跨层 seq 去重审计：窗口行 / 目录句柄 / facts / memoryBlock 行里的 `#seq`
 * 各出现一次。返回重复项（空 = 通过），供单测与回执断言。
 *
 * 注意：facts 行与 memoryBlock 行是**语义引用**（不是窗口行原文），这里只检查
 * 「同一个 seq 在多个块里被重复引用」的情况，重复即视为预算浪费/不一致。
 */
export function auditSeqUniqueness(input: {
  windowSeqs: readonly number[]
  directoryHandleSeqs: readonly number[]
  factSeqs?: readonly number[]
  memoryBlockSeqs?: readonly number[]
  l1Seqs?: readonly number[]
  segmentRefs?: readonly number[]
}): { duplicateSeqs: number[]; bySource: Record<string, string[]> } {
  const owners = new Map<number, string[]>()
  const add = (source: string, seqs: readonly number[]) => {
    for (const seq of seqs) {
      if (!Number.isFinite(seq) || seq <= 0) continue
      const list = owners.get(seq) ?? []
      list.push(source)
      owners.set(seq, list)
    }
  }
  add('window', input.windowSeqs)
  add('directory', input.directoryHandleSeqs)
  add('facts', input.factSeqs ?? [])
  add('memoryBlock', input.memoryBlockSeqs ?? [])
  add('l1', input.l1Seqs ?? [])
  add('segments', input.segmentRefs ?? [])
  const duplicateSeqs: number[] = []
  const bySource: Record<string, string[]> = {}
  for (const [seq, sources] of owners) {
    if (sources.length <= 1) continue
    duplicateSeqs.push(seq)
    bySource[String(seq)] = sources
  }
  duplicateSeqs.sort((left, right) => left - right)
  return { duplicateSeqs, bySource }
}

/** 章节目录里的 `#seq` 引用（用于回执/审计，不含正文）。 */
export function directoryRefs(directory: string): number[] {
  const out: number[] = []
  for (const match of directory.matchAll(/#(\d+)/g)) {
    const seq = Number(match[1])
    if (Number.isFinite(seq) && seq > 0) out.push(seq)
  }
  return [...new Set(out)].sort((left, right) => left - right)
}
