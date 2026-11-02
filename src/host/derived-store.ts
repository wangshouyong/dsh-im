/**
 * 由消息/仲裁记录推导出来的事件（facts / floor_decision）落盘与物化投影。
 *
 * 过渡期事实来自确定性规则抽取（`core/facts.ts`）；同一事实的 factId 由内容 hash 派生，
 * 所以重复保存不会重复写事件（幂等）。以后接 LLM 抽取时只新增 supersede/retract 事件，
 * 这里不用改。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { factEventsFromMessages, projectFacts, SOURCE_PRIORITY } from '../core/facts.ts'
import { appendEvent, type ChatEvent, type EventInput, type FloorDecisionPayload } from '../core/events.ts'
import type { Fact, FloorDecision, Message, PendingFactOp } from '../core/types.ts'
import { eventsPath, groupDir, readEvents } from './event-store.ts'

export function factsPath(root: string, threadId: string): string {
  return join(groupDir(root, threadId), 'facts.json')
}

export interface FactsFile {
  version: string
  facts: Fact[]
  updatedAt: number
}

/** 每个 factId 最后一条事件（判断“已被归档”/“已是最新声明”）。 */
function lastFactEvents(events: readonly ChatEvent[]): Map<string, ChatEvent> {
  const last = new Map<string, ChatEvent>()
  for (const event of events) {
    if (event.kind !== 'fact' || !event.fact) continue
    const previous = last.get(event.fact.factId)
    if (!previous || event.seq > previous.seq) last.set(event.fact.factId, event)
  }
  return last
}

/**
 * 消息 → fact 事件（只追加不投影）。
 *
 * 幂等规则：
 * - 同一 factId 已经是同样或更高优先级的有效事实 → 不重复写；
 * - 同一个 factId 已被**更新**的事实撤回（retract 事件比声明消息更晚）→ 不复活；
 *   用户再说一次（新消息 seq 更大）会重新产生 assert。
 */
export async function appendDerivedFactEvents(
  root: string,
  threadId: string,
  messages: readonly Message[],
): Promise<number> {
  const existing = await readEvents(root, threadId)
  const projection = projectFacts(existing)
  const activeById = new Map(projection.active.map((fact) => [fact.factId, fact]))
  const lastById = lastFactEvents(existing)
  let events = existing
  const lines: string[] = []
  for (const item of factEventsFromMessages(messages)) {
    const factId = item.fact.factId
    const last = lastById.get(factId)
    // 撤回发生在这条声明之后：说明事实已被用户归档，不要重新拉起来（新消息声明会更晚，能恢复）。
    if (
      last?.fact?.op === 'retract'
      && SOURCE_PRIORITY[last.fact.source] >= SOURCE_PRIORITY[item.fact.source]
      && last.at > item.at
    ) {
      continue
    }
    const active = activeById.get(factId)
    if (active && SOURCE_PRIORITY[active.source] >= SOURCE_PRIORITY[item.fact.source]) continue
    const event = appendEvent(events, {
      at: item.at,
      kind: 'fact',
      actorName: item.fact.owner ?? '群',
      text: item.text,
      producer: 'plugin',
      fact: item.fact,
    })
    events = [...events, event]
    lines.push(JSON.stringify(event))
  }
  if (lines.length === 0) return 0
  await mkdir(groupDir(root, threadId), { recursive: true })
  await appendFile(eventsPath(root, threadId), lines.join('\n') + '\n', 'utf8')
  return lines.length
}

/** 事件流 → facts.json 物化投影（唯一写 projections 的地方）。 */
export async function projectAndWriteFacts(root: string, threadId: string): Promise<FactsFile> {
  const events = await readEvents(root, threadId)
  const projection = projectFacts(events)
  const file: FactsFile = { version: projection.version, facts: projection.active, updatedAt: Date.now() }
  await mkdir(groupDir(root, threadId), { recursive: true })
  await writeFile(factsPath(root, threadId), JSON.stringify(file, null, 2), 'utf8')
  return file
}

/** 消息 → fact 事件 + 投影（独立入口，测试/工具用）。 */
export async function syncThreadFacts(
  root: string,
  threadId: string,
  messages: readonly Message[],
): Promise<FactsFile> {
  await appendDerivedFactEvents(root, threadId, messages)
  return projectAndWriteFacts(root, threadId)
}

export async function readFacts(root: string, threadId: string): Promise<FactsFile | null> {
  try {
    const parsed = JSON.parse(await readFile(factsPath(root, threadId), 'utf8')) as FactsFile
    return Array.isArray(parsed.facts) ? parsed : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function decisionKey(decision: FloorDecision): string {
  return [decision.personaId, decision.action, decision.reason, decision.at].join('|')
}

/**
 * 客户端产生的事实操作（异步抽取 / 任务板归档）→ `fact` 事件（幂等）。
 *
 * 保存后 state.json 就不需要再带这些操作（重新投影即可）。
 */
export async function syncPendingFactOps(
  root: string,
  threadId: string,
  ops: readonly PendingFactOp[],
): Promise<number> {
  if (ops.length === 0) return 0
  const existing = await readEvents(root, threadId)
  // 幂等键带 at：同一次用户操作重复保存不会重复写；但同一事实被再次归档（新时间）会真的生效。
  const seen = new Set(
    existing
      .filter((event) => event.kind === 'fact' && event.fact)
      .map((event) => [event.fact?.op, event.fact?.factId, event.text, event.at].join('|')),
  )
  const lastById = lastFactEvents(existing)
  let events = existing
  const lines: string[] = []
  for (const op of ops) {
    const key = [op.op, op.factId, op.text, op.at].join('|')
    if (seen.has(key)) continue
    // 断言/替换：如果该事实已被同等或更高优先级来源归档，就不要复活它。
    if (op.op !== 'retract') {
      const last = lastById.get(op.factId)
      if (last?.fact?.op === 'retract' && SOURCE_PRIORITY[last.fact.source] >= SOURCE_PRIORITY[op.source]) continue
      const active = last?.fact?.op !== 'retract' ? projectFacts(events).active.find((fact) => fact.factId === op.factId) : undefined
      if (active && SOURCE_PRIORITY[active.source] >= SOURCE_PRIORITY[op.source]) continue
    }
    const input: EventInput = {
      at: op.at,
      kind: 'fact',
      actorName: op.owner ?? '群',
      text: op.text,
      producer: 'plugin',
      fact: {
        op: op.op,
        factId: op.factId,
        factKind: op.kind,
        source: op.source,
        confidence: op.source === 'user' ? 1 : op.source === 'persona' ? 0.8 : 0.5,
        ...(op.owner === undefined ? {} : { owner: op.owner }),
        ...(op.supersedes === undefined ? {} : { supersedes: op.supersedes }),
        ...(op.sourceMessageId === undefined ? {} : { sourceMessageId: op.sourceMessageId }),
        ...(op.sourceMessageSeq === undefined ? {} : { sourceMessageSeq: op.sourceMessageSeq }),
      },
    }
    seen.add(key)
    const event = appendEvent(events, input)
    events = [...events, event]
    lastById.set(op.factId, event)
    lines.push(JSON.stringify(event))
  }
  if (lines.length === 0) return 0
  await mkdir(groupDir(root, threadId), { recursive: true })
  await appendFile(eventsPath(root, threadId), lines.join('\n') + '\n', 'utf8')
  return lines.length
}

/**
 * 本轮仲裁决策 → `floor_decision` 事件（幂等）。
 *
 * `thread.floorDecisions` 每轮会被清空，但事件日志保留全部历史，可按 seq 回放。
 */
export async function syncThreadFloorDecisions(
  root: string,
  threadId: string,
  decisions: readonly FloorDecision[],
): Promise<number> {
  if (decisions.length === 0) return 0
  const existing = await readEvents(root, threadId)
  const seen = new Set(
    existing
      .filter((event) => event.kind === 'floor_decision' && event.floorDecision)
      .map((event) => [event.floorDecision?.personaId, event.floorDecision?.action, event.text, event.at].join('|')),
  )
  let events = existing
  const lines: string[] = []
  for (const decision of decisions) {
    const key = decisionKey(decision)
    if (seen.has(key)) continue
    seen.add(key)
    const payload: FloorDecisionPayload = { personaId: decision.personaId, action: decision.action }
    const event = appendEvent(events, {
      at: decision.at,
      kind: 'floor_decision',
      actorName: decision.personaId || '系统主持',
      text: decision.reason,
      producer: 'plugin',
      floorDecision: payload,
    })
    events = [...events, event]
    lines.push(JSON.stringify(event))
  }
  if (!lines.length) return 0
  await mkdir(groupDir(root, threadId), { recursive: true })
  await appendFile(eventsPath(root, threadId), lines.join('\n') + '\n', 'utf8')
  return lines.length
}

/** 读回某个群的全部仲裁决策（回放/调试用）。 */
export async function readFloorDecisions(root: string, threadId: string): Promise<ChatEvent[]> {
  return (await readEvents(root, threadId)).filter((event) => event.kind === 'floor_decision')
}
