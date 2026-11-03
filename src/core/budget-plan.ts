/**
 * 预算计划（L3 · 先影子，不切实际裁剪）。
 *
 * 废除「24000 字符」这个常量，改成 **token 档位**；换算用校准系数，没有系数时用内容先验。
 * 第一批只计算 `wouldBe*`（影子）：不改窗口、不改 prompt，先看缓存命中率/延迟会怎样。
 *
 * 成本护栏（价目表/日账本/日帽/成本估算）2026-11-02 经用户裁决不做（native 通道无 usage，
 * DSH 原生无用量账本，估算数会冒充真实用量）：本文件只管 token 档位与字符预算，不涉及金额。
 *
 * 口径：
 * - 档位 economy 30k / standard 80k / deep 200k tokens；hard cap = `min(档位, 上下文×maxShare)`；
 * - `windowChars = tokenBudget × ratio × 0.8`（0.8 是安全余量），夹在 [400, 1_000_000]；
 * - 窗口条数动态：下限 8、上限 60（真正切换时再按 token 预算裁剪）；
 * - 粘滞窗口：只有 `mode='on'` 时才按「只增不减」处理；影子模式只报 wouldBe。
 */
import { RATIO_MAX, RATIO_MIN } from './calibration-samples.ts'

export type BudgetTier = 'economy' | 'standard' | 'deep'

export interface BudgetTierSpec {
  /** 档位的 token 预算。 */
  tokens: number
  /** 占上下文窗口的最大比例（防 1M 模型被灌太满）。 */
  maxShare: number
}

export const BUDGET_TIERS: Record<BudgetTier, BudgetTierSpec> = {
  economy: { tokens: 50_000, maxShare: 0.1 },
  standard: { tokens: 150_000, maxShare: 0.25 },
  deep: { tokens: 320_000, maxShare: 0.4 },
}

export const DEFAULT_BUDGET_TIER: BudgetTier = 'standard'
export const DEFAULT_RATIO = 1.6
export const BUDGET_SAFETY = 0.8
export const WINDOW_KEEP_MIN = 8
export const WINDOW_KEEP_MAX = 60

export function resolveTier(raw: unknown): BudgetTier {
  return raw === 'economy' || raw === 'standard' || raw === 'deep' ? raw : DEFAULT_BUDGET_TIER
}

export interface BudgetPlan {
  tier: BudgetTier
  contextWindow?: number
  tokenBudget: number
  /** 被什么夹住：档位本身 / 上下文比例。 */
  clampedBy: 'tier' | 'context-share'
  ratio: number
  ratioSource: 'calibrated' | 'prior' | 'default'
  windowChars: number
  windowKeepMin: number
  windowKeepMax: number
  /** 影子模式：上面都是 wouldBe，没有真正改裁剪。 */
  shadow: boolean
  notes: string[]
}

export interface BudgetPlanInput {
  contextWindow?: number
  /** 校准/先验给出的 chars/token。 */
  ratio?: number
  ratioSource?: BudgetPlan['ratioSource']
  tier?: unknown
  /** 影子（默认）或真正生效。 */
  mode?: 'shadow' | 'on'
  /** 粘滞窗口：真正生效时，窗口只增不减。 */
  currentWindowChars?: number
}

export function planBudget(input: BudgetPlanInput = {}): BudgetPlan {
  const tier = resolveTier(input.tier)
  const spec = BUDGET_TIERS[tier]
  const notes: string[] = []
  const contextWindow = typeof input.contextWindow === 'number' && input.contextWindow > 0 ? input.contextWindow : undefined
  let tokenBudget = spec.tokens
  let clampedBy: BudgetPlan['clampedBy'] = 'tier'
  if (contextWindow !== undefined) {
    const shareCap = Math.floor(contextWindow * spec.maxShare)
    if (shareCap < tokenBudget) {
      tokenBudget = shareCap
      clampedBy = 'context-share'
    }
  }
  const typeRatio = typeof input.ratio === 'number' && Number.isFinite(input.ratio) ? input.ratio : undefined
  const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, typeRatio ?? DEFAULT_RATIO))
  const ratioSource: BudgetPlan['ratioSource'] = typeRatio === undefined ? 'default' : input.ratioSource ?? 'calibrated'
  let windowChars = Math.floor(tokenBudget * ratio * BUDGET_SAFETY)
  if (input.mode === 'on' && typeof input.currentWindowChars === 'number' && input.currentWindowChars > windowChars) {
    // 粘滞：窗口只增不减，避免每轮改前缀导致 prompt 缓存全失效。
    windowChars = input.currentWindowChars
    notes.push('sticky-window(keep-current)')
  }
  windowChars = Math.min(1_000_000, Math.max(400, windowChars))
  if (input.mode !== 'on') notes.push('shadow(not-applied)')
  return {
    tier,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    tokenBudget,
    clampedBy,
    ratio: Math.round(ratio * 1000) / 1000,
    ratioSource,
    windowChars,
    windowKeepMin: WINDOW_KEEP_MIN,
    windowKeepMax: WINDOW_KEEP_MAX,
    shadow: input.mode !== 'on',
    notes,
  }
}
