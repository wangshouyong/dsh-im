/**
 * Curator（共识整理器）的提示词与输出解析。
 *
 * 位置：替换现有「每轮一次事实抽取」的那一次调用——同一份 facts 交给模型整理成
 * 三栏聚类草稿（A/B/C/D + derived），再交给 consensus builder 做契约校验与物化。
 * 解析器只做形状校验；事实覆盖、来源错栏、能力自述归档由 builder 强校验。
 */
import {
  CONSENSUS_LANES,
  CONSENSUS_MAX_TEXT,
  CONSENSUS_STATUSES,
  normalizeConsensusKind,
  type ConsensusDraft,
  type ConsensusDraftCluster,
  type ConsensusDraftDerived,
  type ConsensusKind,
  type ConsensusLane,
  type ConsensusStatus,
} from './consensus.ts'

export interface CuratorFact {
  factId: string
  owner: string
  kind: string
  text: string
}

export interface CuratorPrompt {
  system: string
  prompt: string
}

export function buildCuratorPrompt(input: {
  threadTitle: string
  facts: readonly CuratorFact[]
}): CuratorPrompt {
  const system = [
    '你是群聊共识整理器（curator）。只整理给出的 facts，不新增事实，不改写事实含义。',
    '每条 fact 必须且只能放进一个簇；lane 含义：A 用户指令/验收，B 群共识（决定/立场/承诺/约束），C 任务，D 环境或能力自述。',
    '硬规则：用户 fact 只能进 A 或 C；角色 fact 只能进 B 或 D；角色陈述自己“没有 shell / 跑不了 / 只能在群里”等能力或环境限制时必须进 D；同一内容合并进同一簇。',
    'kind 必须从这套里选一个：约束、变更、决定、验收、判定、分工、承诺、约定、立场、任务、能力自述、事实。',
    'status 可选，缺省 A/B/C=active、D=archived。取值：candidate（待确认）/ active（当前有效）/ applied（已落实的变更记录）/ done（已完成任务）/ resolved（已解决的历史结论）/ superseded（被更新结论取代，必须给 supersededByKey 指向新簇）/ expired（过期或一次性）/ archived（环境能力自述）。',
    'lane 与 status 约束：A 只允许 active/applied/candidate；B 只允许 active/candidate/resolved/superseded/expired；C 只允许 active/done/candidate；D 只允许 archived。',
    '簇正文单行、不超过 80 字，不要以“角色名：”开头，不得包含 [当前消息]、[最近群聊]、[本轮群聊摘要]、收到：、开发预览 这类 prompt 回声。',
    'derived 只能从 C 簇拆出，lane 固定为 C，factIds 必须是来源簇 factIds 的子集。',
    '只输出 JSON 对象，不要解释、不要 Markdown 代码块：',
    '{"clusters":[{"key":"A1","lane":"A","kind":"约束","status":"active","factIds":["f_..."],"text":"一句话"},{"key":"B1","lane":"B","kind":"立场","status":"superseded","supersededByKey":"B2","factIds":["f_..."],"text":"旧结论"}],"derived":[{"key":"C2","lane":"C","kind":"任务","fromKey":"C1","factIds":["f_..."],"text":"一句话"}]}',
  ].join('\n')
  const lines = input.facts.map((fact) => `- ${fact.factId} | ${fact.owner} | ${fact.kind} | ${fact.text}`)
  const prompt = [
    `群名：${input.threadTitle}`,
    `fact 数量：${input.facts.length}`,
    'facts：',
    ...lines,
    '',
    `输出要求：clusters 覆盖全部 ${input.facts.length} 条 factId；没有内容可派生时 derived 输出空数组。`,
  ].join('\n')
  return { system, prompt }
}

export interface CuratorParseResult {
  ok: boolean
  errors: string[]
  draft?: ConsensusDraft
}

function extractJson(raw: string): string | undefined {
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  return text.slice(start, end + 1)
}

function readText(record: Record<string, unknown>, label: string, errors: string[]): string {
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (!text) {
    errors.push(`${label} 缺 text`)
    return ''
  }
  if (text.length > CONSENSUS_MAX_TEXT) {
    errors.push(`${label} text 超长：${text.length} > ${CONSENSUS_MAX_TEXT}`)
  }
  return text
}

function readFactIds(record: Record<string, unknown>, label: string, errors: string[]): string[] {
  const value = record.factIds
  if (!Array.isArray(value)) {
    errors.push(`${label} factIds 必须是数组`)
    return []
  }
  const factIds = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  if (factIds.length === 0) errors.push(`${label} factIds 为空`)
  return factIds
}

function readLane(record: Record<string, unknown>, label: string, errors: string[]): ConsensusLane {
  const lane = typeof record.lane === 'string' ? record.lane.trim().toUpperCase() : ''
  if (!CONSENSUS_LANES.includes(lane as ConsensusLane)) {
    errors.push(`${label} lane 非法：${String(record.lane)}`)
    return 'A'
  }
  return lane as ConsensusLane
}

function readKind(record: Record<string, unknown>, label: string, errors: string[]): ConsensusKind {
  const raw = typeof record.kind === 'string' ? record.kind.trim() : ''
  if (!raw) {
    errors.push(`${label} 缺 kind`)
    return '事实'
  }
  const kind = normalizeConsensusKind(raw)
  if (!kind) {
    errors.push(`${label} kind 未知：${raw}`)
    return '事实'
  }
  return kind
}

function readStatus(record: Record<string, unknown>, label: string, errors: string[]): ConsensusStatus | undefined {
  if (record.status === undefined || record.status === null) return undefined
  const raw = typeof record.status === 'string' ? record.status.trim() : ''
  if (!CONSENSUS_STATUSES.includes(raw as ConsensusStatus)) {
    errors.push(`${label} status 非法：${String(record.status)}`)
    return undefined
  }
  return raw as ConsensusStatus
}

export function parseCuratorOutput(raw: string): CuratorParseResult {
  const json = extractJson(raw ?? '')
  if (!json) return { ok: false, errors: ['输出里没有 JSON 对象'] }
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (error) {
    return { ok: false, errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['JSON 顶层必须是对象'] }
  }
  const record = data as Record<string, unknown>
  if (!Array.isArray(record.clusters)) return { ok: false, errors: ['clusters 必须是数组'] }

  const errors: string[] = []
  const keys = new Set<string>()
  const seenFactIds = new Set<string>()
  const clusters: ConsensusDraftCluster[] = []
  record.clusters.forEach((item, index) => {
    const label = `clusters[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${label} 不是对象`)
      return
    }
    const cluster = item as Record<string, unknown>
    const key = typeof cluster.key === 'string' ? cluster.key.trim() : ''
    if (!key) errors.push(`${label} 缺 key`)
    else if (keys.has(key)) errors.push(`${label} key 重复：${key}`)
    else keys.add(key)
    const lane = readLane(cluster, label, errors)
    const kind = readKind(cluster, label, errors)
    const status = readStatus(cluster, label, errors)
    const text = readText(cluster, label, errors)
    const factIds = readFactIds(cluster, label, errors)
    const supersededByKey = typeof cluster.supersededByKey === 'string' ? cluster.supersededByKey.trim() : ''
    for (const factId of factIds) {
      if (seenFactIds.has(factId)) errors.push(`${label} factId 重复使用：${factId}`)
      else seenFactIds.add(factId)
    }
    clusters.push({
      key,
      lane,
      kind,
      text,
      factIds,
      ...(status === undefined ? {} : { status }),
      ...(supersededByKey ? { supersededByKey } : {}),
    })
  })

  const derived: ConsensusDraftDerived[] = []
  if (record.derived !== undefined && record.derived !== null) {
    if (!Array.isArray(record.derived)) {
      errors.push('derived 必须是数组')
    } else {
      record.derived.forEach((item, index) => {
        const label = `derived[${index}]`
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`${label} 不是对象`)
          return
        }
        const entry = item as Record<string, unknown>
        const key = typeof entry.key === 'string' ? entry.key.trim() : ''
        if (!key) errors.push(`${label} 缺 key`)
        else if (keys.has(key)) errors.push(`${label} key 重复：${key}`)
        else keys.add(key)
        const lane = readLane(entry, label, errors)
        if (lane !== 'C') errors.push(`${label} lane 必须为 C`)
        const kind = readKind(entry, label, errors)
        const text = readText(entry, label, errors)
        const factIds = readFactIds(entry, label, errors)
        const fromKey = typeof entry.fromKey === 'string' ? entry.fromKey.trim() : ''
        if (!fromKey) errors.push(`${label} 缺 fromKey`)
        derived.push({ key, lane: 'C', kind, text, factIds, fromKey })
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], draft: { clusters, derived } }
}
