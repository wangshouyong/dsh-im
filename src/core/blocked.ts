import type { BlockedState } from './types.ts'

export interface BlockedAdvice {
  /** 给用户看的一句话建议。 */
  hint: string
  /** 卡片上推荐先点哪个。 */
  primary: 'retry' | 'skip' | 'pause'
}

/**
 * 把宿主的稳定失败码翻成人话，供中断卡展示。
 * 他们不依赖错误文案，只看 code。
 */
export function blockedAdvice(blocked: Pick<BlockedState, 'code'> | undefined): BlockedAdvice {
  switch (blocked?.code) {
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
    case 'AUTH':
      return { hint: '密钥/登录失效：去 DSH 设置里修好这个提供方，再回来点“已修好，重试”。', primary: 'retry' }
    case 'NO_ADAPTER':
      return { hint: '这个提供方已经不存在了：给角色重选一个模型，或本轮先移除它。', primary: 'skip' }
    case 'RATE_LIMIT':
      return { hint: '被限流了：等 30 秒左右点“重试”，或本轮先移除它。', primary: 'retry' }
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return { hint: '额度用完了：需要充值或换提供方，本轮先把它移除。', primary: 'skip' }
    case 'CONTEXT_WINDOW_EXCEEDED':
      return { hint: '上下文超过了这个模型的窗口：换个长上下文模型，或先汇总再继续。', primary: 'pause' }
    default:
      return { hint: '可以直接重试一次；还不行就本轮先把它移除。', primary: 'retry' }
  }
}
