/**
 * 旧版本把 DSH 的 reasoning block 当正文落库（2026-11-02 前），历史消息里可能残留
 * “The user says… / Let me… / Maybe:” 这类整段英文思维链，后面才是真正的中文回复。
 *
 * 这里做**只读清洗**：只处理“开头 ≥80 个英文字符、随后第一段中文正文”的形状，
 * 把前面的思维链剥掉；不改 state、不写盘。新消息不会再产生这种形状。
 */
export function stripLegacyReasoning(text: string): string {
  if (!text) return text
  const trimmed = text.trimStart()
  // 开头就必须是英文，否则不碰（避免误伤纯中文回复）。
  if (!/^[A-Za-z"'“”‘’(\[]/.test(trimmed)) return text
  const lines = text.split('\n')
  let englishLetters = 0
  let asciiWords = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    const letters = (line.match(/[A-Za-z]/g) ?? []).length
    const cjk = (line.match(/[\u4e00-\u9fff]/g) ?? []).length
    const visible = line.replace(/\s/g, '').length
    // 第一段“以中文开头、且中文为主”的行视为正文开始；前面必须已经积累了足够英文。
    // 不能选 “Maybe: 在。…” 这种带英文前缀/引号的思维链草稿行。
    if (
      index > 0
      && visible >= 4
      && /^[\u4e00-\u9fff]/.test(line)
      && cjk / visible >= 0.6
      && englishLetters >= 80
      && asciiWords >= 12
    ) {
      const answer = lines.slice(index).join('\n').trim()
      if (answer.length >= 2) return answer
    }
    englishLetters += letters
    asciiWords += (line.match(/[A-Za-z]{2,}/g) ?? []).length
  }
  return text
}

/** 是否疑似旧版泄漏的思维链（只用于统计/诊断，不改内容）。 */
export function looksLikeLegacyReasoning(text: string): boolean {
  return stripLegacyReasoning(text) !== text
}
