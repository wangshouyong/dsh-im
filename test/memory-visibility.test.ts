/**
 * 记忆可见性谓词（Phase 0）回归 —— 「memory 默认授予」的裁决依据。
 *
 * 规则表 `MEMORY_VISIBILITY_RULES` 是文档的单一来源；这里逐条把拒绝路径打出来，
 * 再单独验 search/expand 同权（分权就等于绕开可见性）。
 */
import { describe, expect, it } from 'vitest'
import {
  MEMORY_VISIBILITY_RULES,
  canAccessMemory,
  checkMemoryAccess,
  normalizeRootKey,
  type MemoryRecordRef,
  type MemoryViewer,
} from '../src/core/memory-visibility.ts'

const ROOT = 'D:\\work\\team'
const VIEWER: MemoryViewer = {
  personaId: 'p1',
  projectRoot: ROOT,
  threadId: 't1',
  threadKind: 'group',
  memberIds: ['p1', 'p2'],
}
const RECORD: MemoryRecordRef = { projectRoot: ROOT, threadId: 't1', kind: 'user' }

describe('记忆可见性：拒绝路径', () => {
  it('同群普通消息放行', () => {
    expect(checkMemoryAccess(RECORD, VIEWER)).toEqual({ allow: true })
  })

  it('系统事件不是可引用记忆', () => {
    expect(checkMemoryAccess({ ...RECORD, kind: 'system' }, VIEWER)).toEqual({ allow: false, reason: 'system-event' })
  })

  it('跨根拒绝（数据根按工作区分开存）', () => {
    expect(checkMemoryAccess({ ...RECORD, projectRoot: 'D:\\other\\repo' }, VIEWER)).toEqual({ allow: false, reason: 'cross-root' })
  })

  it('跨线程拒绝（私聊不能读群、群不能读别的群）', () => {
    expect(checkMemoryAccess({ ...RECORD, threadId: 't2' }, VIEWER)).toEqual({ allow: false, reason: 'cross-thread' })
    expect(checkMemoryAccess({ ...RECORD, threadId: 't2' }, { ...VIEWER, threadKind: 'dm' })).toEqual({ allow: false, reason: 'cross-thread' })
  })

  it('禁言角色不检索', () => {
    expect(checkMemoryAccess(RECORD, { ...VIEWER, muted: true })).toEqual({ allow: false, reason: 'muted' })
  })

  it('非成员拒绝（离开群的人）', () => {
    expect(checkMemoryAccess(RECORD, { ...VIEWER, memberIds: ['p2'] })).toEqual({ allow: false, reason: 'not-member' })
  })

  it('大小写/分隔符不同的同一个根视为同根（Windows 口径）', () => {
    expect(canAccessMemory({ ...RECORD, projectRoot: 'd:/WORK/Team/' }, VIEWER)).toBe(true)
    expect(normalizeRootKey('D:\\work\\team\\')).toBe('d:/work/team')
  })
})

describe('记忆可见性：search 与 expand 同权', () => {
  const cases: { name: string; record: MemoryRecordRef; viewer: MemoryViewer }[] = [
    { name: '正常', record: RECORD, viewer: VIEWER },
    { name: '系统事件', record: { ...RECORD, kind: 'system' }, viewer: VIEWER },
    { name: '跨根', record: { ...RECORD, projectRoot: 'D:\\x' }, viewer: VIEWER },
    { name: '跨线程', record: { ...RECORD, threadId: 't9' }, viewer: VIEWER },
    { name: '禁言', record: RECORD, viewer: { ...VIEWER, muted: true } },
    { name: '非成员', record: RECORD, viewer: { ...VIEWER, memberIds: [] } },
  ]
  for (const item of cases) {
    it(`${item.name}：search 与 expand 结论一致`, () => {
      expect(checkMemoryAccess(item.record, item.viewer, 'search')).toEqual(
        checkMemoryAccess(item.record, item.viewer, 'expand'),
      )
    })
  }
})

describe('可见性规则表', () => {
  it('规则 id 唯一、拒绝原因都在 MemoryDenyReason 里、有同权条款', () => {
    const ids = MEMORY_VISIBILITY_RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
    const allowedReasons = new Set(['cross-root', 'cross-thread', 'not-member', 'muted', 'system-event', '-'])
    for (const rule of MEMORY_VISIBILITY_RULES) expect(allowedReasons.has(rule.denyReason)).toBe(true)
    expect(MEMORY_VISIBILITY_RULES.some((rule) => rule.id === 'search-expand-parity')).toBe(true)
    expect(MEMORY_VISIBILITY_RULES.some((rule) => rule.id === 'untrusted-wrap')).toBe(true)
  })
})
