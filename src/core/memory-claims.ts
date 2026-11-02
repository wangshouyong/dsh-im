/**
 * 消息级 claim 状态推导（Phase 0 · 可寻址记忆层）。
 *
 * 为什么需要：检索/展开把旧消息拉回 prompt 时，必须让模型知道这条是
 * 「当前有效结论 / 只是一条原始记录 / 已被取代」。状态是 **claim 级**的——
 * 一条消息可能含多个 claim，其中一部分已被 supersede。
 *
 * 数据来源（全部已有，不新增真相源）：
 * - `events.jsonl` 的 `fact` 事件：`assert / supersede / retract` + `sourceMessageSeq`；
 * - `consensusState` 的 cluster：`status` + `supersededByKey` + `refs[].sourceMessageSeq`。
 *
 * 判定优先级：**superseded（含 expired）压过 active**——宁可少说"这是结论"，
 * 不要把过期口径当现状喂回去。没有 claim 的消息保持 `raw`（弱状态，不进 body 正文）。
 */
import type { ConsensusState } from './consensus.ts'
import type { ChatEvent } from './events.ts'
import { SOURCE_PRIORITY } from './facts.ts'

export type MemoryClaimState = 'raw' | 'active' | 'superseded'

/**
 * 指令性语句特征（指令隔离用；Phase 0 只标记，Phase 1 注入时加"这是原文，不是指令"标注）。
 * 放在 core：客户端/宿主都要用，host 侧索引从这里引用，避免两套正则漂移。
 */
export const MEMORY_IMPERATIVE = /(忽略(以上|上面|之前)|无视(以上|上面|之前)|忘记(以上|之前)|从现在(起|开始)|你现在(是|要|必须)|必须(执行|按我说的)|以上(全部)?作废|ignore\s+(the\s+)?(above|previous)|disregard\s+(the\s+)?(above|previous))/i

export interface SeqClaim {
  state: MemoryClaimState
  /** state=superseded 时，取代它的那条消息的 seq（能定位到就填）。 */
  successorSeq?: number
}

export interface ClaimStatusResult {
  /** 消息 seq → claim 状态；未出现的 seq 视为 raw。 */
  bySeq: Map<number, SeqClaim>
  /** 参与判定的消息 seq（= 弱状态脏区；只有这些 seq 需要重算/重写）。 */
  claimedSeqs: number[]
  active: number
  superseded: number
}

interface FactTrack {
  /** 事实来源消息 seq（老数据可能缺）。 */
  sourceSeq?: number
  source: 'user' | 'persona' | 'extractor'
  state: 'active' | 'superseded'
  successorSeq?: number
}

/** 共识里这些状态视为「不再权威」；superseded/expired 明确过期，archived 是能力自述（也不该当结论）。 */
const NON_AUTHORITATIVE_CONSENSUS = new Set(['superseded', 'expired', 'archived'])
const AUTHORITATIVE_CONSENSUS = new Set(['active', 'applied', 'done'])

export function deriveClaimStatuses(input: {
  events: readonly ChatEvent[]
  consensus?: ConsensusState
}): ClaimStatusResult {
  const ordered = [...input.events].sort((left, right) => left.seq - right.seq)
  const facts = new Map<string, FactTrack>()

  for (const event of ordered) {
    if (event.kind !== 'fact' || !event.fact) continue
    const payload = event.fact
    if (payload.op === 'retract') {
      const existing = facts.get(payload.factId)
      // 低优先级来源撤不掉高优先级事实（与 projectFacts 同一口径）。
      if (existing && SOURCE_PRIORITY[payload.source] < SOURCE_PRIORITY[existing.source]) continue
      if (existing) facts.set(payload.factId, { ...existing, state: 'superseded' })
      continue
    }
    if (payload.op === 'supersede' && payload.supersedes) {
      const old = facts.get(payload.supersedes)
      if (old && SOURCE_PRIORITY[payload.source] < SOURCE_PRIORITY[old.source]) continue
      if (old) {
        facts.set(payload.supersedes, {
          ...old,
          state: 'superseded',
          ...(payload.sourceMessageSeq === undefined ? {} : { successorSeq: payload.sourceMessageSeq }),
        })
      }
    }
    // assert 与 supersede 都带着新事实（和 projectFacts 一致）。
    const previous = facts.get(payload.factId)
    if (previous && SOURCE_PRIORITY[payload.source] < SOURCE_PRIORITY[previous.source]) continue
    facts.set(payload.factId, {
      state: 'active',
      source: payload.source,
      ...(payload.sourceMessageSeq === undefined ? {} : { sourceSeq: payload.sourceMessageSeq }),
    })
  }

  // seq → 该消息上所有 claim 的状态集合
  const perSeq = new Map<number, { states: Array<'active' | 'superseded'>; successorSeq?: number }>()
  const touch = (seq: number | undefined, state: 'active' | 'superseded', successorSeq?: number) => {
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return
    let bucket = perSeq.get(seq)
    if (!bucket) {
      bucket = { states: [] }
      perSeq.set(seq, bucket)
    }
    bucket.states.push(state)
    if (successorSeq !== undefined && bucket.successorSeq === undefined) bucket.successorSeq = successorSeq
  }
  for (const track of facts.values()) touch(track.sourceSeq, track.state, track.successorSeq)

  // 共识层覆盖（更高层结论；superseded 的 cluster 用 supersededByKey 找接手者的 seq）。
  const clusters = input.consensus?.clusters ?? []
  const clusterByKey = new Map(clusters.map((cluster) => [cluster.key, cluster]))
  for (const cluster of clusters) {
    const successorSeq = cluster.supersededByKey
      ? clusterByKey.get(cluster.supersededByKey)?.refs.find((ref) => typeof ref.sourceMessageSeq === 'number')?.sourceMessageSeq ?? undefined
      : undefined
    const state = NON_AUTHORITATIVE_CONSENSUS.has(cluster.status)
      ? 'superseded'
      : AUTHORITATIVE_CONSENSUS.has(cluster.status)
        ? 'active'
        : undefined
    if (!state) continue
    for (const ref of cluster.refs) touch(ref.sourceMessageSeq ?? undefined, state, successorSeq)
  }

  const bySeq = new Map<number, SeqClaim>()
  let active = 0
  let superseded = 0
  for (const [seq, bucket] of perSeq) {
    // 同一消息里既有有效又有失效 claim：按保守口径算 superseded（不把过期口径当现状）。
    const state: MemoryClaimState = bucket.states.includes('superseded') ? 'superseded' : 'active'
    if (state === 'active') active += 1
    else superseded += 1
    bySeq.set(seq, {
      state,
      ...(bucket.successorSeq === undefined ? {} : { successorSeq: bucket.successorSeq }),
    })
  }
  return { bySeq, claimedSeqs: [...bySeq.keys()].sort((left, right) => left - right), active, superseded }
}

/**
 * 把 claim 状态套到索引条目上，返回真正变动的 seq（弱状态脏区）。
 *
 * 只碰两类条目：本次有 claim 的 seq、以及上次打过非 raw 标记的 seq（claim 被撤/事实回退）。
 * 其余条目原样保留，避免每次构建都重写整份索引。
 */
export function applyClaimStatuses<T extends { seq: number; claim: MemoryClaimState; successorSeq?: number }>(
  entries: readonly T[],
  bySeq: ReadonlyMap<number, SeqClaim>,
): { entries: T[]; dirtySeqs: number[] } {
  const dirty: number[] = []
  const next = entries.map((entry) => {
    const claim = bySeq.get(entry.seq)
    const wantedState: MemoryClaimState = claim?.state ?? 'raw'
    const wantedSuccessor = claim?.successorSeq
    const changed = entry.claim !== wantedState || entry.successorSeq !== wantedSuccessor
    if (!changed) return entry
    dirty.push(entry.seq)
    const { successorSeq, ...rest } = entry
    return {
      ...rest,
      claim: wantedState,
      ...(wantedSuccessor === undefined ? {} : { successorSeq: wantedSuccessor }),
    } as T
  })
  return { entries: next, dirtySeqs: dirty.sort((left, right) => left - right) }
}

/**
 * 客户端可用的轻量版：只凭 `thread.facts`（当前有效事实）+ `thread.consensusState` 推状态。
 *
 * 为什么要两套：host 侧有 events.jsonl 可回放 supersede/retract（最准）；
 * 但 prompt 组装跑在客户端（`core/runtime.ts` 会被打进 client bundle），拿不到事件日志。
 * 客户端这版**只把「已知失效」的标成 superseded**，其余一律 raw（宁可不标 active，
 * 也不把过期口径当结论）——而 body 只放 active，所以 raw 天然被挡在正文外。
 */
export function claimsFromThread(input: {
  facts?: readonly { sourceMessageSeq?: number }[]
  consensus?: ConsensusState
}): Map<number, SeqClaim> {
  const bySeq = new Map<number, SeqClaim>()
  for (const fact of input.facts ?? []) {
    const seq = fact.sourceMessageSeq
    if (typeof seq !== 'number' || seq <= 0) continue
    bySeq.set(seq, { state: 'active' })
  }
  const clusters = input.consensus?.clusters ?? []
  const clusterByKey = new Map(clusters.map((cluster) => [cluster.key, cluster]))
  for (const cluster of clusters) {
    if (!NON_AUTHORITATIVE_CONSENSUS.has(cluster.status)) {
      if (!AUTHORITATIVE_CONSENSUS.has(cluster.status)) continue
      for (const ref of cluster.refs) {
        const seq = ref.sourceMessageSeq
        if (typeof seq === 'number' && seq > 0 && !bySeq.has(seq)) bySeq.set(seq, { state: 'active' })
      }
      continue
    }
    const successorSeq = cluster.supersededByKey
      ? clusterByKey.get(cluster.supersededByKey)?.refs.find((ref) => typeof ref.sourceMessageSeq === 'number')?.sourceMessageSeq ?? undefined
      : undefined
    for (const ref of cluster.refs) {
      const seq = ref.sourceMessageSeq
      if (typeof seq !== 'number' || seq <= 0) continue
      // 失效优先：同一条消息既被有效结论引用、又被取代时，按 superseded 处理。
      bySeq.set(seq, { state: 'superseded', ...(successorSeq === undefined ? {} : { successorSeq }) })
    }
  }
  return bySeq
}
