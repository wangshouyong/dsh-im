/** 共享小工具：活跃度常量 / 来源跳转 / 窄窗断点 / 成员 chips / 时间格式 / @ 高亮。纯展示与 DOM 小工具。 */
import { useEffect, useState } from 'react'
import { activityLabel } from '../../core/floor.ts'
import type { Activity, Thread } from '../../core/types.ts'

export const ACTIVITIES: Activity[] = ['review', 'high', 'mention-only', 'muted']

/** 点“来源”：滚到原消息并闪一下。provenance 断掉（旧数据）时由调用方隐藏入口。 */
export function jumpToSourceMessage(seq: number): void {
  const target = document.getElementById('msg-' + seq)
  if (!target) return
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  try {
    target.animate(
      [
        { background: 'rgba(255, 214, 102, 0.35)', boxShadow: '0 0 0 2px rgba(255,196,0,0.8)' },
        { background: 'transparent', boxShadow: '0 0 0 0 rgba(255,196,0,0)' },
      ],
      { duration: 1600, easing: 'ease-out' },
    )
  } catch {
    // 老浏览器不支持 animate：只滚动
  }
}

export function useNarrow(maxWidth = 1080): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < maxWidth)
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth < maxWidth)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [maxWidth])
  return narrow
}

export function memberChips(thread: Thread, m: Thread['members'][0]): { text: string; kind: string }[] {
  const chips: { text: string; kind: string }[] = []
  chips.push({ text: activityLabel(m.activity), kind: m.activity === 'muted' ? 'warn' : '' })
  if (m.activity === 'muted') chips.push({ text: '按窗口回复', kind: '' })
  const live = thread.roundMode === 'review' || Boolean(thread.speakingPersonaId)
  if (live && thread.speakingPersonaId === m.personaId) chips.push({ text: '当前发言', kind: 'on' })
  else if (live && m.passedRound) chips.push({ text: '已弃权', kind: '' })
  else if (live && m.completedRound) chips.push({ text: '已发言', kind: '' })
  return chips
}

export function fmt(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 把消息里的 @某某 渲染成高亮，便于在长文里看出点了谁。 */
export function MentionText({ text }: { text: string }) {
  const parts = text.split(/(@[\w\u4e00-\u9fa5·-]+)/g)
  return (
    <>
      {parts.map((part, index) => (
        part.startsWith('@')
          ? <span key={index} className="mention-hl">{part}</span>
          : <span key={index}>{part}</span>
      ))}
    </>
  )

}
