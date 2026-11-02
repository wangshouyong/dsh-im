export function createId(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** 光标前如果正在输入 @，返回 @ 的位置和已输入的筛选字。 */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, Math.max(0, caret))
  const match = upto.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match || match.index === undefined) return null
  const start = match[0].startsWith('@') ? match.index : match.index + 1
  return { start, query: match[1] }
}

export function mentionIds(text: string, personas: { id: string; name: string }[]): string[] {
  const ids: string[] = []
  for (const p of personas) {
    if (text.includes(`@${p.name}`) || text.includes(`@${p.id}`)) ids.push(p.id)
  }
  if (/@全体|@all/i.test(text)) {
    for (const p of personas) {
      if (!ids.includes(p.id)) ids.push(p.id)
    }
  }
  return ids
}

export function wantsReview(text: string): boolean {
  return /开始评审/.test(text)
}
