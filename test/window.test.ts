import { describe, expect, it } from 'vitest'
import { groupWindow } from '../src/core/window.ts'

describe('群聊窗口', () => {
  it('带上摘要和最近 N 条，不把整段历史灌进去', () => {
    const all = Array.from({ length: 50 }, (_, i) => i)
    const win = groupWindow(all, '上一轮结论：只改文档', 20)
    expect(win.recent).toHaveLength(20)
    expect(win.recent[0]).toBe(30)
    expect(win.summary).toContain('只改文档')
  })
  it('没有摘要时只给最近消息，消息少时全给', () => {
    expect(groupWindow([1, 2], undefined).summary).toBeUndefined()
    expect(groupWindow([1, 2], undefined).recent).toEqual([1, 2])
  })
})
