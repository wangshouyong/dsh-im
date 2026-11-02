/**
 * 主动私聊调度（Phase P）：纯函数判定 + 预设参数，ImService 负责真正生成与投递。
 *
 * 设计要点：
 * - 私聊不是模型工具，是运行时能力（角色只需要被叫起来生成一句话，投递/计数/冷却都在这里）；
 * - 频率三档预设（克制/标准/活跃），数值可被 limits 覆盖；
 * - 真正的刹车：未读不追发 + 全局每日上限 + 安静时段 + 评审期间不打扰（结束后还有冷却）。
 */
import type { Persona, ProactiveLevel, Thread } from './types.ts'

export interface ProactivePreset {
  /** 用户静默多久才允许触发。 */
  idleMinutes: number
  /** 同一角色两次主动私聊的最小间隔。 */
  cooldownMinutes: number
  /** 该角色每日上限。 */
  dailyPerPersona: number
}

export const PROACTIVE_PRESETS: Record<ProactiveLevel, ProactivePreset> = {
  low: { idleMinutes: 30, cooldownMinutes: 120, dailyPerPersona: 1 },
  standard: { idleMinutes: 15, cooldownMinutes: 60, dailyPerPersona: 3 },
  high: { idleMinutes: 5, cooldownMinutes: 20, dailyPerPersona: 6 },
}

export interface ProactiveLimits {
  /** 所有角色加起来每日上限。 */
  dailyGlobal: number
  /** 是否启用未读不追发。 */
  skipIfUnread: boolean
  /** 安静时段（本地时间，end 为次日）。 */
  quietHours: { enabled: boolean; start: number; end: number }
  /** 评审结束后多少分钟内不主动私聊。 */
  reviewCooldownMinutes: number
}

export const DEFAULT_PROACTIVE_LIMITS: ProactiveLimits = {
  dailyGlobal: 8,
  skipIfUnread: true,
  quietHours: { enabled: true, start: 23, end: 8 },
  reviewCooldownMinutes: 5,
}

export interface ProactiveEligibilityInput {
  persona: Pick<Persona, 'id' | 'name' | 'proactiveDm' | 'proactiveLevel'>
  now: number
  threads: readonly Thread[]
  /** 运行时状态：thinking/waiting_on 时不打扰。 */
  agentStatus?: string
  preset?: Partial<ProactivePreset>
  limits?: Partial<ProactiveLimits>
}

export interface ProactiveEligibility {
  ok: boolean
  /** 不可触发时的原因码（测试/调试用）。 */
  reason: string
  preset: ProactivePreset
  lastUserAt: number
  lastProactiveAt: number
  personToday: number
  globalToday: number
}

function startOfLocalDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function isQuietHour(now: number, quiet: ProactiveLimits['quietHours']): boolean {
  if (!quiet.enabled) return false
  const hour = new Date(now).getHours()
  if (quiet.start <= quiet.end) return hour >= quiet.start && hour < quiet.end
  // 跨午夜：23 → 8
  return hour >= quiet.start || hour < quiet.end
}

function lastUserActivity(threads: readonly Thread[]): number {
  let last = 0
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.kind === 'user' && message.createdAt > last) last = message.createdAt
    }
  }
  return last
}

function lastReviewEndAt(threads: readonly Thread[]): number {
  let last = 0
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (message.kind !== 'system') continue
      if (!/本轮汇总|全员暂停|本轮已汇总/.test(message.text)) continue
      if (message.createdAt > last) last = message.createdAt
    }
  }
  return last
}

/** 判定某个角色这一轮能不能主动私聊（纯函数；ImService 只负责执行）。 */
export function proactiveEligibility(input: ProactiveEligibilityInput): ProactiveEligibility {
  const level: ProactiveLevel = input.persona.proactiveLevel ?? 'standard'
  const preset: ProactivePreset = { ...PROACTIVE_PRESETS[level], ...input.preset }
  const limits: ProactiveLimits = {
    ...DEFAULT_PROACTIVE_LIMITS,
    ...input.limits,
    quietHours: { ...DEFAULT_PROACTIVE_LIMITS.quietHours, ...input.limits?.quietHours },
  }
  const lastUserAt = lastUserActivity(input.threads)
  const dayStart = startOfLocalDay(input.now)
  let lastProactiveAt = 0
  let personToday = 0
  let globalToday = 0
  for (const thread of input.threads) {
    for (const message of thread.messages) {
      if (!message.proactive) continue
      if (message.createdAt >= dayStart) {
        globalToday += 1
        if (message.authorId === input.persona.id) personToday += 1
      }
      if (message.authorId === input.persona.id && message.createdAt > lastProactiveAt) {
        lastProactiveAt = message.createdAt
      }
    }
  }
  const base = { preset, lastUserAt, lastProactiveAt, personToday, globalToday }
  const deny = (reason: string): ProactiveEligibility => ({ ok: false, reason, ...base })

  if (!input.persona.proactiveDm) return deny('switch-off')
  if (input.agentStatus === 'thinking' || input.agentStatus === 'waiting_on') return deny('busy')
  if (isQuietHour(input.now, limits.quietHours)) return deny('quiet-hours')
  const reviewRunning = input.threads.some((thread) => thread.roundMode === 'review')
  if (reviewRunning) return deny('review-running')
  const reviewEnd = lastReviewEndAt(input.threads)
  if (reviewEnd > 0 && input.now - reviewEnd < limits.reviewCooldownMinutes * 60_000) {
    return deny('review-cooldown')
  }
  if (input.now - lastUserAt < preset.idleMinutes * 60_000) return deny('user-active')
  if (lastProactiveAt > 0 && input.now - lastProactiveAt < preset.cooldownMinutes * 60_000) {
    return deny('cooldown')
  }
  if (personToday >= preset.dailyPerPersona) return deny('daily-persona')
  if (globalToday >= limits.dailyGlobal) return deny('daily-global')
  if (limits.skipIfUnread) {
    const dm = input.threads.find((thread) => (
      thread.kind === 'dm' && thread.memberIds.length === 1 && thread.memberIds[0] === input.persona.id
    ))
    if (dm && dm.unread > 0) return deny('unread')
  }
  return { ok: true, reason: 'ok', ...base }
}
