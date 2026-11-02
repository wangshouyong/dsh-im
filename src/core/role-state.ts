/**
 * 角色状态快照（Phase 1）：把 facts 按角色切成一个“结论视图”。
 *
 * 刻意不做信念抽取、不调模型：状态 = facts 投影 + 运行时 waiting_on + last_seq，
 * 所以确定性、可重建、可审计（facts 本身是 fact 事件投影）。
 */
import { isPromptVisibleFact } from './facts.ts'
import type { Fact, RoleState } from './types.ts'

export interface BuildRoleStateInput {
  personaName: string
  /** 当前有效事实（已去重/已应用 supersede·retract）。 */
  facts: readonly Fact[]
  /** 运行时状态机里的等待目标（角色名）。 */
  waitingOn?: string
  /** 该角色看到的最后一条消息 seq。 */
  lastSeq: number
}

const MAX_COMMITMENTS = 6
const MAX_DECISIONS = 4
const MAX_CONSTRAINTS = 3

function ownedBy(facts: readonly Fact[], personaName: string): Fact[] {
  return facts.filter((fact) => fact.owner === personaName)
}

function texts(facts: readonly Fact[], personaName: string, kinds: readonly Fact['kind'][], limit: number): string[] {
  return ownedBy(facts, personaName)
    .filter((fact) => kinds.includes(fact.kind))
    // 能力/环境自述（“我只能群里说话 / 没有 shell”）不进状态快照：否则角色会把
    // 自己的临时说法当成“我坚持的约束”，下一轮继续说服自己。
    .filter((fact) => isPromptVisibleFact(fact))
    .slice(-limit)
    .map((fact) => fact.text)
}

/** facts → 角色状态（纯函数，输入相同输出相同）。 */
export function buildRoleState(input: BuildRoleStateInput): RoleState {
  const positionFacts = ownedBy(input.facts, input.personaName)
    .filter((fact) => fact.kind === 'stance')
    .filter((fact) => isPromptVisibleFact(fact))
  const position = positionFacts.at(-1)?.text
  return {
    personaName: input.personaName,
    commitments: texts(input.facts, input.personaName, ['commitment', 'todo'], MAX_COMMITMENTS),
    decisions: texts(input.facts, input.personaName, ['decision'], MAX_DECISIONS),
    constraints: texts(input.facts, input.personaName, ['constraint'], MAX_CONSTRAINTS),
    ...(position === undefined ? {} : { position }),
    ...(input.waitingOn === undefined || input.waitingOn === '' ? {} : { waitingOn: input.waitingOn }),
    lastSeq: input.lastSeq,
  }
}

/** 状态是否“有内容”（只有 lastSeq 时不必占 prompt）。 */
export function hasRoleStateContent(state: RoleState): boolean {
  return state.commitments.length > 0
    || state.decisions.length > 0
    || state.constraints.length > 0
    || Boolean(state.position)
    || Boolean(state.waitingOn)
}

/** 渲染成 prompt 里的 `[你的状态]` 块；没有内容返回空串。 */
export function renderRoleState(state: RoleState | undefined): string {
  if (!state || !hasRoleStateContent(state)) return ''
  const lines: string[] = ['[你的状态快照 · 结论，不是历史]']
  if (state.commitments.length) lines.push(`- 我承诺/认领过：${state.commitments.join('；')}`)
  if (state.decisions.length) lines.push(`- 我做过的决定：${state.decisions.join('；')}`)
  if (state.constraints.length) lines.push(`- 我坚持的约束：${state.constraints.join('；')}`)
  if (state.position) lines.push(`- 我的立场：${state.position}`)
  if (state.waitingOn) lines.push(`- 我正在等：${state.waitingOn}`)
  if (state.lastSeq > 0) lines.push(`- 我最后看到：#${state.lastSeq}`)
  return lines.join('\n')
}
