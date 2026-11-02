/**
 * 记忆可见性谓词（Phase 0 · 可寻址记忆层）。
 *
 * 背景：`memory_search` / `memory_expand` 一旦默认授予，角色就多了一条"读全量历史"的通道。
 * 能不能默认授予，取决于这张表能不能被代码和测试同时钉住——所以规则写在这里，
 * 文档 `docs/DESIGN.md` 的可见性谓词表是它的投影，两边必须一致（有单测守门）。
 *
 * 三条硬规则：
 * 1. **同群**：只能访问当前会话自己的事件（跨线程、跨根一律拒绝）；
 * 2. **成员**：非成员 / 已禁言角色不检索（与现有 retrieval 口径一致）；
 * 3. **search 与 expand 同权**：搜索能看到的，展开才能看到；反之亦然。
 *    （不做"搜索能看摘要、展开能看原文"这种分权——那等于绕开可见性。）
 *
 * 敏感内容（PII/密钥）本 Phase 只定**同权**，不做识别；识别与打码是 Phase 1 的独立清单。
 */
import type { ChatEvent } from './events.ts'
import type { ThreadKind } from './types.ts'

export type MemoryAction = 'search' | 'expand'

export type MemoryDenyReason =
  | 'system-event'
  | 'cross-root'
  | 'cross-thread'
  | 'not-member'
  | 'muted'

export interface MemoryViewer {
  personaId: string
  projectRoot: string
  threadId: string
  threadKind: ThreadKind
  /** 该会话当前成员（离开群的人不在里面）。 */
  memberIds: readonly string[]
  /** 禁言角色不检索（与 runtime 的 muted 口径一致）。 */
  muted?: boolean
}

export interface MemoryRecordRef {
  projectRoot: string
  threadId: string
  kind: ChatEvent['kind']
}

export interface MemoryAccessDecision {
  allow: boolean
  reason?: MemoryDenyReason
}

/** 与 im-api / state-roots 同口径：Windows 折叠大小写、统一分隔符。 */
export function normalizeRootKey(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized
}

/**
 * 判定一条记忆能否被某角色访问。
 * `action` 目前不影响结果（search/expand 同权），保留参数是为了 Phase 1 加"展开需二次确认"时不用改签名。
 */
export function checkMemoryAccess(
  record: MemoryRecordRef,
  viewer: MemoryViewer,
  _action: MemoryAction = 'search',
): MemoryAccessDecision {
  // 系统主持消息不是可引用记忆（工具结果/仲裁事件同理）。
  if (record.kind === 'system') return { allow: false, reason: 'system-event' }
  if (normalizeRootKey(record.projectRoot) !== normalizeRootKey(viewer.projectRoot)) {
    return { allow: false, reason: 'cross-root' }
  }
  if (record.threadId !== viewer.threadId) return { allow: false, reason: 'cross-thread' }
  if (viewer.muted) return { allow: false, reason: 'muted' }
  if (!viewer.memberIds.includes(viewer.personaId)) return { allow: false, reason: 'not-member' }
  return { allow: true }
}

export function canAccessMemory(record: MemoryRecordRef, viewer: MemoryViewer, action: MemoryAction = 'search'): boolean {
  return checkMemoryAccess(record, viewer, action).allow
}

/**
 * 可见性规则表（文档/测试的单一来源）。
 * `checkMemoryAccess` 的实现必须与这张表逐条对应——改规则时两边一起改，单测会红。
 */
export interface MemoryVisibilityRule {
  id: string
  appliesTo: 'search' | 'expand' | 'both'
  rule: string
  /** 违反时的拒绝原因；`-` 表示放行。 */
  denyReason: MemoryDenyReason | '-'
}

export const MEMORY_VISIBILITY_RULES: readonly MemoryVisibilityRule[] = [
  { id: 'same-thread', appliesTo: 'both', rule: '只能访问当前会话自己的事件；跨线程一律拒绝', denyReason: 'cross-thread' },
  { id: 'same-root', appliesTo: 'both', rule: '项目根必须一致（数据根按工作区分开存）；跨根一律拒绝', denyReason: 'cross-root' },
  { id: 'member-only', appliesTo: 'both', rule: '请求者必须是该会话当前成员', denyReason: 'not-member' },
  { id: 'muted-no-recall', appliesTo: 'both', rule: '禁言角色不检索（与 runtime 既有口径一致）', denyReason: 'muted' },
  { id: 'no-system', appliesTo: 'both', rule: '系统主持/工具结果不是可引用记忆', denyReason: 'system-event' },
  { id: 'search-expand-parity', appliesTo: 'both', rule: 'search 能看到的 seq，expand 才能展开；两者同权', denyReason: '-' },
  { id: 'untrusted-wrap', appliesTo: 'both', rule: '用户/角色原文一律按不可信输入包裹（指令隔离）', denyReason: '-' },
]
