/**
 * 会议共识状态（consensus）构建器。
 *
 * 职责边界：
 * - 输入是**已抽取的事实**（带事件序号与来源消息引用）和**评审过的聚类草稿**；
 * - 只做契约校验、物化、版本与渲染，不调模型、不发明内容；
 * - 用户条目只能进 A/C，角色条目只能进 B/D；
 * - 能力/环境自述必须归 D，从结构上阻止自证循环；
 * - 草稿必须覆盖全部事实，零丢失；
 * - 输出版本由内容 hash 派生，幂等可回放。
 */
import { isTransientClaim } from './facts.ts'
import { stableHash } from './receipt.ts'

// 能力自述的判定在 facts 层（摘要 L2 / 角色状态 / 共识共用同一条规则），这里保留 re-export 兼容旧引用。
export { isTransientClaim } from './facts.ts'

export type ConsensusLane = 'A' | 'B' | 'C' | 'D'
export const CONSENSUS_LANES: readonly ConsensusLane[] = ['A', 'B', 'C', 'D']

/** 条目业务分类（比 lane 细一层；curator 必须从这套里选）。 */
export type ConsensusKind =
  | '约束'
  | '变更'
  | '决定'
  | '验收'
  | '判定'
  | '分工'
  | '承诺'
  | '约定'
  | '立场'
  | '任务'
  | '能力自述'
  | '事实'

export const CONSENSUS_KINDS: readonly ConsensusKind[] = [
  '约束', '变更', '决定', '验收', '判定', '分工', '承诺', '约定', '立场', '任务', '能力自述', '事实',
]

const KIND_ALIASES: Record<string, ConsensusKind> = {
  约束: '约束', constraint: '约束',
  变更: '变更', change: '变更',
  决定: '决定', decision: '决定', 决策: '决定',
  验收: '验收', acceptance: '验收',
  判定: '判定', verdict: '判定',
  分工: '分工', division: '分工',
  承诺: '承诺', commitment: '承诺',
  约定: '约定', agreement: '约定',
  立场: '立场', stance: '立场',
  任务: '任务', task: '任务', todo: '任务',
  能力自述: '能力自述', capability: '能力自述',
  事实: '事实', fact: '事实',
}

/** 把中英文别名收敛到唯一分类；未知返回 undefined（由调用方报错，不做静默降级）。 */
export function normalizeConsensusKind(value: string | undefined): ConsensusKind | undefined {
  const key = (value ?? '').trim()
  if (!key) return undefined
  return KIND_ALIASES[key] ?? KIND_ALIASES[key.toLowerCase()]
}

/**
 * 条目生命周期：
 * - candidate 待确认（角色提出、用户未拍板；进入「待确认」块，不冒充指令）
 * - active 当前有效
 * - applied 已落实的变更记录（A 栏历史）
 * - done 已完成任务
 * - resolved 已解决的历史结论（B 栏证据）
 * - superseded 被更新结论取代（必须指向 supersededByKey）
 * - expired 过期/一次性内容
 * - archived 环境·能力自述（D 栏，永不进 prompt）
 */
export type ConsensusStatus =
  | 'candidate'
  | 'active'
  | 'applied'
  | 'done'
  | 'resolved'
  | 'superseded'
  | 'expired'
  | 'archived'

export const CONSENSUS_STATUSES: readonly ConsensusStatus[] = [
  'candidate', 'active', 'applied', 'done', 'resolved', 'superseded', 'expired', 'archived',
]

export const CONSENSUS_STATUS_LABEL: Record<ConsensusStatus, string> = {
  candidate: '待确认',
  active: '有效',
  applied: '已落实',
  done: '已完成',
  resolved: '已解决',
  superseded: '已被取代',
  expired: '已过期',
  archived: '已归档',
}

/** 当前权威层（会进 prompt 主体）；candidate 单独进「待确认」块。 */
export const AUTHORITATIVE_STATUSES: readonly ConsensusStatus[] = ['active', 'applied', 'done']

const ALLOWED_STATUSES: Record<ConsensusLane, readonly ConsensusStatus[]> = {
  A: ['active', 'applied', 'candidate'],
  B: ['active', 'candidate', 'resolved', 'superseded', 'expired'],
  C: ['active', 'done', 'candidate'],
  D: ['archived'],
}

export const CONSENSUS_SCHEMA = 'consensus-v1'
export const CONSENSUS_MAX_TEXT = 160
export const DEFAULT_PROMPT_BUDGET = 1800
export const ECHO_MARKERS: readonly string[] = [
  '[当前消息]',
  '[最近群聊]',
  '[本轮群聊摘要]',
  '[你之前的发言要点]',
  '收到：',
  '开发预览',
]

export interface ConsensusFact {
  factId: string
  eventSeq: number
  kind: string
  owner: string
  text: string
  sourceMessageId?: string | null
  sourceMessageSeq?: number | null
}

export interface ConsensusDraftCluster {
  key: string
  lane: ConsensusLane
  kind: string
  factIds: string[]
  text: string
  /** 生命周期状态；缺省按 lane 默认（A/B/C=active，D=archived）。 */
  status?: ConsensusStatus
  /** status=superseded 时必填：取代它的簇 key（必须在本草稿里且不是自己）。 */
  supersededByKey?: string
}

export interface ConsensusDraftDerived {
  key: string
  lane: 'C'
  kind: string
  fromKey: string
  factIds: string[]
  text: string
}

export interface ConsensusDraft {
  clusters: ConsensusDraftCluster[]
  derived?: ConsensusDraftDerived[]
}

export type ConsensusMode = 'legacy' | 'new'

export interface ConsensusBuildOptions {
  mode: ConsensusMode
  /** 同一工作区的真实消息 id 集合；new 模式下用于校验 sourceMessageId 没写错。 */
  knownMessageIds?: readonly string[]
}

export interface ConsensusRef {
  factId: string
  factEventSeq: number
  sourceMessageId: string | null
  sourceMessageSeq: number | null
}

export interface ConsensusCluster {
  key: string
  lane: ConsensusLane
  kind: ConsensusKind
  text: string
  factIds: string[]
  refs: ConsensusRef[]
  status: ConsensusStatus
  /** status=superseded 时指向取代它的簇。 */
  supersededByKey?: string
  chars: number
}

export interface ConsensusDerived {
  key: string
  lane: 'C'
  kind: ConsensusKind
  text: string
  fromKey: string
  factIds: string[]
  refs: ConsensusRef[]
}

export interface ConsensusState {
  schema: typeof CONSENSUS_SCHEMA
  version: string
  builtAt: number
  mode: ConsensusMode
  clusters: ConsensusCluster[]
  derived: ConsensusDerived[]
  metrics: {
    facts: number
    clusters: number
    derived: number
    lanes: Record<ConsensusLane, number>
    statusCounts: Record<ConsensusStatus, number>
    archivedFacts: number
    mergedFacts: number
  }
  provenance: {
    expected: number
    resolved: number
    missingFactIds: string[]
  }
}

export interface ConsensusBuildResult {
  ok: boolean
  errors: string[]
  state?: ConsensusState
}

function isUserOwner(owner: string): boolean {
  return owner === '用户' || owner === '你'
}

function containsEcho(text: string): boolean {
  return ECHO_MARKERS.some((marker) => text.includes(marker))
}

function refsOf(factIds: readonly string[], factById: Map<string, ConsensusFact>): ConsensusRef[] {
  return factIds.map((factId) => {
    const fact = factById.get(factId) as ConsensusFact
    return {
      factId,
      factEventSeq: fact.eventSeq,
      sourceMessageId: fact.sourceMessageId ?? null,
      sourceMessageSeq: fact.sourceMessageSeq ?? null,
    }
  })
}

/** 去掉正文里自己套的“名字：”前缀（模型改写常把发言人名字写进正文）。 */
function stripOwnerPrefix(text: string, owner: string): string {
  const name = owner.trim()
  if (!name) return text
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^(?:\\*\\*|【|「|“|")?${escaped}(?:\\*\\*|】|」|”|")?\\s*[：:]\\s*`, 'u')
  let out = text
  for (let layer = 0; layer < 3; layer++) {
    const next = out.replace(pattern, '')
    if (next === out) break
    out = next
  }
  return out.trim()
}

function normalizeClusterText(text: string, factIds: readonly string[], factById: Map<string, ConsensusFact>): string {
  const owners = [...new Set(
    factIds
      .map((factId) => factById.get(factId)?.owner)
      .filter((owner): owner is string => Boolean(owner)),
  )]
  let out = (text ?? '').replace(/\s+/g, ' ').trim()
  for (const owner of owners) out = stripOwnerPrefix(out, owner)
  return out
}

function defaultStatusFor(lane: ConsensusLane): ConsensusStatus {
  return lane === 'D' ? 'archived' : 'active'
}

function resolveDraftStatus(cluster: ConsensusDraftCluster, errors: string[]): ConsensusStatus {
  const fallback = defaultStatusFor(cluster.lane)
  if (cluster.status === undefined) return fallback
  if (!CONSENSUS_STATUSES.includes(cluster.status)) {
    errors.push(`未知 status：${cluster.key} -> ${String(cluster.status)}`)
    return fallback
  }
  if (!ALLOWED_STATUSES[cluster.lane].includes(cluster.status)) {
    errors.push(`status 与 lane 不匹配：${cluster.key}（${cluster.lane} 不允许 ${cluster.status}）`)
    return fallback
  }
  if (cluster.status === 'superseded' && !cluster.supersededByKey?.trim()) {
    errors.push(`superseded 缺 supersededByKey：${cluster.key}`)
  }
  return cluster.status
}

export function buildConsensusState(
  factsInput: readonly ConsensusFact[],
  draft: ConsensusDraft,
  options: ConsensusBuildOptions,
  now: number = Date.now(),
): ConsensusBuildResult {
  const errors: string[] = []
  const facts = [...factsInput]
  const factById = new Map<string, ConsensusFact>()
  for (const fact of facts) {
    if (factById.has(fact.factId)) errors.push(`事实重复：${fact.factId}`)
    factById.set(fact.factId, fact)
    if (!Number.isFinite(fact.eventSeq) || fact.eventSeq <= 0) errors.push(`eventSeq 非法：${fact.factId}`)
    if (!fact.text?.trim()) errors.push(`事实正文为空：${fact.factId}`)
  }
  if (facts.length === 0) errors.push('facts 为空')

  const draftClusters = [...draft.clusters]
  if (draftClusters.length === 0 && (draft.derived?.length ?? 0) === 0) errors.push('草稿没有簇')

  const used = new Map<string, string>()
  const keys = new Set<string>()
  const statusByKey = new Map<string, ConsensusStatus>()
  for (const cluster of draftClusters) {
    const key = cluster.key?.trim() ?? ''
    if (!key) errors.push('簇缺少 key')
    else if (keys.has(key)) errors.push(`簇 key 重复：${key}`)
    else keys.add(key)
    if (!CONSENSUS_LANES.includes(cluster.lane)) errors.push(`lane 非法：${key}`)
    const kind = normalizeConsensusKind(cluster.kind)
    if (!kind) errors.push(`未知 kind：${key}（${String(cluster.kind)}）`)
    statusByKey.set(key, resolveDraftStatus(cluster, errors))
    const text = normalizeClusterText(cluster.text ?? '', cluster.factIds ?? [], factById)
    if (!text) errors.push(`簇正文为空：${key}`)
    else if (text.length > CONSENSUS_MAX_TEXT) errors.push(`簇正文超长：${key}（${text.length} > ${CONSENSUS_MAX_TEXT}）`)
    if (containsEcho(text)) errors.push(`簇正文混入 prompt 回声：${key}`)
    if (!Array.isArray(cluster.factIds) || cluster.factIds.length === 0) {
      errors.push(`簇没有 factIds：${key}`)
      continue
    }
    for (const factId of cluster.factIds) {
      const fact = factById.get(factId)
      if (!fact) {
        errors.push(`未知 factId：${key} -> ${factId}`)
        continue
      }
      const previous = used.get(factId)
      if (previous) errors.push(`事实重复分配：${factId}（${previous} / ${key}）`)
      else used.set(factId, key)
      const allowed: ConsensusLane[] = isUserOwner(fact.owner) ? ['A', 'C'] : ['B', 'D']
      if (!allowed.includes(cluster.lane)) errors.push(`来源错栏：${factId}（${fact.owner}）不能进 ${cluster.lane}`)
      if (!isUserOwner(fact.owner) && cluster.lane !== 'D' && isTransientClaim(fact.text)) {
        errors.push(`能力/环境自述必须归档：${factId}（当前 ${cluster.lane}，应为 D）`)
      }
      if (containsEcho(fact.text)) errors.push(`事实混入 prompt 回声：${factId}`)
      if (options.mode === 'new') {
        if (!fact.sourceMessageId) errors.push(`缺 sourceMessageId：${factId}`)
        else if (options.knownMessageIds && !options.knownMessageIds.includes(fact.sourceMessageId)) {
          errors.push(`sourceMessageId 不存在：${factId}`)
        }
      }
    }
  }
  for (const cluster of draftClusters) {
    const key = cluster.key.trim()
    if (statusByKey.get(key) !== 'superseded') continue
    const target = cluster.supersededByKey?.trim() ?? ''
    if (!target) continue
    if (target === key) errors.push(`supersededByKey 不能指向自己：${key}`)
    else if (!statusByKey.has(target)) errors.push(`supersededByKey 不存在：${key} -> ${target}`)
    else if (statusByKey.get(target) === 'superseded') errors.push(`supersededByKey 指向另一个已取代条目：${key} -> ${target}`)
  }
  for (const fact of facts) {
    if (!used.has(fact.factId)) errors.push(`丢失：${fact.factId}（${fact.text.slice(0, 24)}）`)
  }

  const draftDerived = [...(draft.derived ?? [])]
  const clusterByKey = new Map(draftClusters.map((cluster) => [cluster.key, cluster]))
  for (const item of draftDerived) {
    const key = item.key?.trim() ?? ''
    if (!key) errors.push('派生簇缺少 key')
    else if (keys.has(key)) errors.push(`簇 key 重复：${key}`)
    else keys.add(key)
    if (item.lane !== 'C') errors.push(`派生簇 lane 必须为 C：${key}`)
    const source = clusterByKey.get(item.fromKey)
    if (!source) errors.push(`派生来源不存在：${key} -> ${item.fromKey}`)
    else if (!item.factIds.every((factId) => source.factIds.includes(factId))) {
      errors.push(`派生 factIds 不在来源簇：${key}`)
    }
    if (!normalizeConsensusKind(item.kind)) errors.push(`未知 kind：${key}（${String(item.kind)}）`)
    const text = normalizeClusterText(item.text ?? '', item.factIds ?? [], factById)
    if (!text) errors.push(`派生簇正文为空：${key}`)
    else if (text.length > CONSENSUS_MAX_TEXT) errors.push(`派生簇正文超长：${key}`)
  }

  if (errors.length > 0) return { ok: false, errors }

  const clusters: ConsensusCluster[] = draftClusters.map((cluster) => {
    const key = cluster.key.trim()
    const text = normalizeClusterText(cluster.text, cluster.factIds, factById)
    return {
      key,
      lane: cluster.lane,
      kind: normalizeConsensusKind(cluster.kind) ?? '事实',
      text,
      factIds: [...cluster.factIds],
      refs: refsOf(cluster.factIds, factById),
      status: statusByKey.get(key) ?? defaultStatusFor(cluster.lane),
      ...(cluster.supersededByKey?.trim() ? { supersededByKey: cluster.supersededByKey.trim() } : {}),
      chars: text.length,
    }
  })
  const derived: ConsensusDerived[] = draftDerived.map((item) => ({
    key: item.key.trim(),
    lane: 'C',
    kind: normalizeConsensusKind(item.kind) ?? '事实',
    text: normalizeClusterText(item.text, item.factIds, factById),
    fromKey: item.fromKey,
    factIds: [...item.factIds],
    refs: refsOf(item.factIds, factById),
  }))

  const lanes = CONSENSUS_LANES.reduce((counts, lane) => {
    counts[lane] = clusters.filter((cluster) => cluster.lane === lane).length
    return counts
  }, {} as Record<ConsensusLane, number>)
  const archivedFacts = clusters
    .filter((cluster) => cluster.lane === 'D')
    .reduce((total, cluster) => total + cluster.factIds.length, 0)
  const mergedFacts = clusters.reduce((total, cluster) => total + cluster.factIds.length - 1, 0)
  const statusCounts = CONSENSUS_STATUSES.reduce((counts, status) => {
    counts[status] = clusters.filter((cluster) => cluster.status === status).length
    return counts
  }, {} as Record<ConsensusStatus, number>)
  const missingFactIds = facts.filter((fact) => !fact.sourceMessageId).map((fact) => fact.factId)

  const signature = [
    CONSENSUS_SCHEMA,
    options.mode,
    facts.map((fact) => `${fact.factId}@${fact.eventSeq}`).sort().join('|'),
    clusters
      .map((cluster) => `${cluster.key}:${cluster.lane}:${cluster.kind}:${cluster.status}:${[...cluster.factIds].sort().join(',')}:${cluster.text}`)
      .sort()
      .join('|'),
    derived
      .map((cluster) => `${cluster.key}:${cluster.fromKey}:${[...cluster.factIds].sort().join(',')}:${cluster.text}`)
      .sort()
      .join('|'),
  ].join('#')
  const hash = stableHash(signature).split(':').at(-1) ?? '0'

  return {
    ok: true,
    errors: [],
    state: {
      schema: CONSENSUS_SCHEMA,
      version: `${CONSENSUS_SCHEMA}:${hash}`,
      builtAt: now,
      mode: options.mode,
      clusters,
      derived,
      metrics: {
        facts: facts.length,
        clusters: clusters.length,
        derived: derived.length,
        lanes,
        statusCounts,
        archivedFacts,
        mergedFacts,
      },
      provenance: {
        expected: facts.length,
        resolved: facts.length - missingFactIds.length,
        missingFactIds,
      },
    },
  }
}

export interface ConsensusPromptOptions {
  charBudget?: number
}

export interface ConsensusPromptBlock {
  block: string
  chars: number
  included: string[]
  dropped: number
}

const SECTION_TITLES: Record<'A' | 'B' | 'C' | 'candidate', string> = {
  A: '[用户指令]',
  B: '[群共识（结论，非用户指令）]',
  C: '[任务]',
  candidate: '[待确认（非指令，仅供核对）]',
}

const NOTE_RESERVE = 28

function promptLine(cluster: ConsensusCluster): string {
  const refs = [...new Set(cluster.refs.map((ref) => `#${ref.factEventSeq}`))].join(' ')
  return refs ? `- ${cluster.text}（${refs}）` : `- ${cluster.text}`
}

/**
 * 渲染注入 prompt 的共识块：A（用户指令）优先，其次任务，最后群共识；D 永不注入。
 * 超预算时整行丢弃并显式注明“另有 N 条见任务板/交接单”，不静默截断。
 */
export function renderConsensusPrompt(
  state: ConsensusState,
  options: ConsensusPromptOptions = {},
): ConsensusPromptBlock {
  const budget = Math.max(200, options.charBudget ?? DEFAULT_PROMPT_BUDGET)
  const sections: { lane: 'A' | 'B' | 'C' | 'candidate'; entries: ConsensusCluster[] }[] = [
    { lane: 'A', entries: state.clusters.filter((cluster) => cluster.lane === 'A' && AUTHORITATIVE_STATUSES.includes(cluster.status)) },
    { lane: 'C', entries: state.clusters.filter((cluster) => cluster.lane === 'C' && AUTHORITATIVE_STATUSES.includes(cluster.status)) },
    {
      lane: 'B',
      entries: state.clusters
        .filter((cluster) => cluster.lane === 'B' && AUTHORITATIVE_STATUSES.includes(cluster.status))
        .sort((left, right) => {
          const leftSeq = Math.max(...left.refs.map((ref) => ref.factEventSeq), 0)
          const rightSeq = Math.max(...right.refs.map((ref) => ref.factEventSeq), 0)
          return rightSeq - leftSeq
        }),
    },
    { lane: 'candidate', entries: state.clusters.filter((cluster) => cluster.status === 'candidate') },
  ]
  const lines: string[] = []
  const included: string[] = []
  let dropped = 0
  for (const section of sections) {
    if (section.entries.length === 0) continue
    const title = SECTION_TITLES[section.lane]
    if (lines.join('\n').length + title.length + 1 > budget - NOTE_RESERVE) {
      dropped += section.entries.length
      continue
    }
    lines.push(title)
    for (const entry of section.entries) {
      const line = promptLine(entry)
      const current = lines.join('\n').length
      if (current + line.length + 1 > budget - NOTE_RESERVE) {
        dropped += 1
        continue
      }
      lines.push(line)
      included.push(entry.key)
    }
  }
  const note = dropped > 0 ? `（另有 ${dropped} 条见任务板/交接单）` : ''
  let block = lines.join('\n')
  if (block && note) block += '\n'
  block += note
  return { block, chars: block.length, included, dropped }
}
