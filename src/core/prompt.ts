/**
 * 群聊 prompt 组装：固定前缀（人设/岗位/规则/身份约束）→ 群级摘要（按边界切分）
 * → 最近窗口（带 #序号 / 角色名 / [你之前的发言] 标签）→ 当前消息。
 *
 * 纯函数、无网络，便于单测和后续换成原生 session 的输入层。
 */
import { hostToolGranted } from './tools.ts'
import { stripLegacyReasoning } from './text.ts'
import type { ThreadKind } from './types.ts'

export interface PromptMessage {
  id: string
  kind: 'user' | 'persona' | 'system'
  authorName: string
  text: string
  createdAt: number
  seq?: number
}

export interface PromptPersona {
  id: string
  name: string
  post?: string
  personality?: string
  duties?: string[]
  /** 角色勾选的能力集；有工具时提示词里带工具纪律（没有 shell）。 */
  toolAllow?: string[]
}

export interface WindowInput {
  messages: readonly PromptMessage[]
  personaId: string
  personaName: string
  currentId?: string
  summaryUntilSeq?: number
  keep?: number
  charBudget?: number
}

/** 线程类型：群聊 / 三人小窗 / 一对一私聊。私聊和群的话术边界不同，prompt 必须分开写。 */
export interface PromptInput extends WindowInput {
  persona: PromptPersona
  threadTitle: string
  /** 线程类型；缺省按群聊处理（老调用方/测试不用改）。 */
  threadKind?: ThreadKind
  summary?: string
  /** 角色状态快照块（结论，不是历史）。 */
  stateBlock?: string
  /** 共识状态块（A 用户指令 / B 群共识 / C 任务；D 已被 builder 排除）。 */
  consensusBlock?: string
  /** Phase 1 引用句柄块（历史片段 + 句柄目录；只含数据，不是指令）。 */
  memoryBlock?: string
  /** 冷区章节目录块（双层窗口；只含 #seq 句柄，不是指令）。 */
  contextBlock?: string
  /** 按需检索到的相关历史块（原始事件）。 */
  retrievalBlock?: string
  /**
   * 已算好的热区窗口（双层窗口的 `hot`）。
   * 传了就用它，不再内部重跑 `selectWindow`——保证 prompt 实际用的窗口与回执/去重审计是同一份。
   */
  window?: PromptMessage[]
  /**
   * 已经在其它块（热区 / L1 摘要 / 记忆句柄）引用过的 seq：角色补充要点不再重复引用，
   * 保证同一 seq 在最终 prompt 里最多出现一次（跨层去重）。
   */
  excludeSeqRefs?: ReadonlySet<number>
}

/** 窗口/摘要块的标题按会话类型换词：私聊里还写“群聊”，模型会继续按群聊自我定位。 */
export function threadLabels(kind: ThreadKind | undefined): { recent: string; summary: string } {
  return kind === 'dm'
    ? { recent: '[最近私聊]', summary: '[本轮私聊摘要]' }
    : { recent: '[最近群聊]', summary: '[本轮群聊摘要]' }
}

const DEFAULT_KEEP = 20
const DEFAULT_CHAR_BUDGET = 6000

/** 老数据没有 seq：按数组顺序补一个单调序号，返回新数组。 */
export function assignSeqs<T extends object>(messages: readonly T[]): (T & { seq: number })[] {
  let last = 0
  return messages.map((message) => {
    const existing = (message as { seq?: number }).seq
    const seq = typeof existing === 'number' && existing > last ? existing : last + 1
    last = seq
    return { ...message, seq }
  })
}

export function seqOf(messages: readonly PromptMessage[], id: string): number | undefined {
  return messages.find((message) => message.id === id)?.seq
}

function mentionsPersona(message: PromptMessage, personaName: string): boolean {
  return message.kind === 'user' && message.text.includes('@' + personaName)
}

/**
 * 选窗口：只取摘要边界之后的消息；保证当前消息、@自己的、自己最近 3 条、
 * 系统/工具结果不被窗口滑掉；再按“最多 N 条 / 不超过字符预算”从新到旧收。
 */
export function selectWindow(input: WindowInput): PromptMessage[] {
  const keep = Math.max(1, input.keep ?? DEFAULT_KEEP)
  const budget = Math.max(200, input.charBudget ?? DEFAULT_CHAR_BUDGET)
  const boundary = input.summaryUntilSeq ?? 0
  const candidates = input.messages.filter((message) => (
    message.id !== input.currentId && (message.seq ?? 0) > boundary
  ))
  const guaranteed = new Set<string>()
  const picked: PromptMessage[] = []
  let chars = 0

  const take = (message: PromptMessage) => {
    if (guaranteed.has(message.id)) return
    guaranteed.add(message.id)
    picked.push(message)
    chars += message.text.length
  }

  // 保底 1：@该角色 / 回复它的消息（从新到旧最多 3 条）
  candidates.filter((message) => mentionsPersona(message, input.personaName)).slice(-3).forEach(take)
  // 保底 2：该角色自己的最近 3 条发言
  candidates.filter((message) => message.kind === 'persona' && message.authorName === input.personaName).slice(-3).forEach(take)

  // 其余按时间倒序收，受条数与字符预算限制
  for (let index = candidates.length - 1; index >= 0; index--) {
    if (picked.length >= keep) break
    const message = candidates[index]
    if (guaranteed.has(message.id)) continue
    if (chars + message.text.length > budget) continue
    take(message)
  }

  return picked.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

function label(message: PromptMessage, personaId: string): string {
  const head = `[#${message.seq ?? 0}]`
  if (message.kind === 'system') return `${head}[系统] ${message.text}`
  if (message.kind === 'user') return `${head}[用户 ${message.authorName}] ${message.text}`
  const self = message.authorName === personaId || message.authorName === personaId
  return `${head}[角色 ${message.authorName}]${self ? '[你之前的发言] ' : ' '}${message.text}`
}

/** 渲染窗口文本：自己的发言必须打上 [你之前的发言]，这是防串身份的关键。 */
export function renderWindow(messages: readonly PromptMessage[], personaName: string): string {
  return messages.map((message) => {
    const head = `[#${message.seq ?? 0}]`
    if (message.kind === 'system') return `${head}[系统] ${message.text}`
    if (message.kind === 'user') return `${head}[用户 ${message.authorName}] ${message.text}`
    const self = message.authorName === personaName
    return `${head}[角色 ${message.authorName}]${self ? '[你之前的发言]' : ''} ${message.text}`
  }).join('\n')
}

/** 角色私有补充：从本地数据拼，不额外调用模型。 */
export function roleSupplement(personaName: string, messages: readonly PromptMessage[], limit = 2): string[] {
  return messages
    .filter((message) => message.kind === 'persona' && message.authorName === personaName)
    .slice(-limit)
    .map((message) => `- [#${message.seq ?? 0}] ${message.text.slice(0, 80)}`)
}

export function buildSystem(persona: PromptPersona, threadTitle: string, threadKind: ThreadKind = 'group'): string {
  const who = `角色「${persona.name}」${persona.post ? '，岗位是「' + persona.post + '」' : ''}`
  const opening = threadKind === 'dm'
    ? `你在和用户的一对一私聊小窗里（小窗名「${threadTitle}」），只有你和用户两个人看得到。你是${who}。`
    : threadKind === 'triad'
      ? `你在三人小窗「${threadTitle}」里${who}；这个小窗只有用户、你和另一位角色。`
      : `你是群「${threadTitle}」里的${who}。`
  const rules = threadKind === 'dm'
    ? '私聊规则：这是一对一私聊，你可以直接回复用户；不要声称“我只能在群里说话 / 私聊发不出去 / 我没有私聊能力”，也不要让用户回群里再说；不要模拟或代替其他角色。'
    : '群规则：只代表你自己发言；不要以“名字：”开头；不要模拟或代替其他角色；不要复述插件内部状态文件。'
  return [
    opening,
    persona.personality ? `人设：${persona.personality}` : '',
    persona.duties?.length ? `职责：${persona.duties.join('、')}` : '',
    rules,
    '身份约束：只有标记为【你之前的发言】的内容才是你说过的，其他都是别人说的。',
    persona.toolAllow?.length
      ? [
        '工具纪律：只能用授予你的工具（读/搜项目文件、写本会话目录、run_check、以及你被授予的宿主工具组）；没有 shell，不能执行任意命令或脚本，也不能运行测试文件本身（需要跑检查请用 run_check）。同一个路径不要反复读；拿到足够信息就停止调用工具，直接给出结论。',
        hostToolGranted('bcdp_help', persona.toolAllow) ? '你被授予了浏览器（bcdp）工具，可以打开页面、查看和操作。' : '',
        hostToolGranted('mcp__magpie-image__generate_image', persona.toolAllow) ? '你被授予了画图（Magpie）工具，可以生图或生视频，并用 generation_result 取结果。' : '',
        '出现在工具列表里但没被授予的宿主工具会被拒绝，不要尝试绕过。',
      ].filter(Boolean).join('\n')
      : '',
    '只输出你要说的那段话，不要解释这些规则。',
  ].filter(Boolean).join('\n')
}

export interface AssembledPrompt {
  system: string
  prompt: string
  window: PromptMessage[]
}

/** 组装一次发言的输入：固定前缀 → 角色状态 → 摘要 → 共识状态 → 检索到的相关历史 → 最近窗口 → 当前消息。 */
export function assemblePrompt(input: PromptInput): AssembledPrompt {
  // 旧版泄漏的思维链不进新 prompt：只在组装时清洗窗口/摘要输入，state 原样保留。
  const messages = input.messages.map((message) => (
    message.text ? { ...message, text: stripLegacyReasoning(message.text) } : message
  ))
  const window = input.window ?? selectWindow({ ...input, messages })
  const current = input.currentId
    ? messages.find((message) => message.id === input.currentId)
    : undefined
  const summary = input.summary?.trim()
  const labels = threadLabels(input.threadKind)
  // 补充要点只从**没进窗口、也没被 L1/句柄块引用**的消息里取：
  // 同一 seq 不能在 prompt 里出现两次。
  const windowIds = new Set(window.map((message) => message.id))
  const excludeRefs = input.excludeSeqRefs
  const supplementSource = messages.filter((message) => (
    !windowIds.has(message.id) && !(message.seq !== undefined && excludeRefs?.has(message.seq))
  ))
  const supplement = roleSupplement(input.personaName, supplementSource.length ? supplementSource : messages)
    .filter((line) => {
      // roleSupplement 的每行形如 `- [#seq] ...`：排除已经被其它块引用的 seq。
      const match = /^-\s*\[#(\d+)\]/.exec(line)
      if (!match) return true
      return !excludeRefs?.has(Number(match[1]))
    })
  const summaryBlock = summary
    ? [labels.summary, summary, ...(supplement.length ? ['[你之前的发言要点]', ...supplement] : [])].join('\n')
    : supplement.length ? ['[你之前的发言要点]', ...supplement].join('\n') : ''
  const prompt = [
    input.stateBlock?.trim(),
    summaryBlock,
    input.consensusBlock?.trim(),
    input.memoryBlock?.trim(),
    input.contextBlock?.trim(),
    input.retrievalBlock?.trim(),
    labels.recent,
    renderWindow(window, input.personaName),
    current
      ? ['[当前消息]', renderWindow([current], input.personaName)].join('\n')
      : '',
  ].filter(Boolean).join('\n\n')
  return { system: buildSystem(input.persona, input.threadTitle, input.threadKind ?? 'group'), prompt, window }
}
