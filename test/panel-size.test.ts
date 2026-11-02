import { describe, expect, it } from 'vitest'
import { availablePanelHeight } from '../src/client/panel-size.ts'

describe('插件面板高度测量', () => {
  it('按窗口底部减插件顶部', () => {
    expect(availablePanelHeight(95, 1020)).toBe(925)
    expect(availablePanelHeight(0, 1020)).toBe(1020)
  })

  it('顶部为负（宿主内部偏移）按 0 算', () => {
    expect(availablePanelHeight(-20, 1020)).toBe(1020)
  })

  it('还没挂载/不可见时返回 0，不写死高度', () => {
    expect(availablePanelHeight(1020, 1020)).toBe(0)
    expect(availablePanelHeight(1200, 1020)).toBe(0)
    expect(availablePanelHeight(Number.NaN, 1020)).toBe(0)
  })

  it('极小面板保底 minHeight', () => {
    expect(availablePanelHeight(1000, 1020)).toBe(320)
  })
})
