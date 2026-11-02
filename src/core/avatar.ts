export function generateAvatar(name: string): string {
  const label = (name.trim().slice(0, 1) || '?').toUpperCase()
  const hue = hash(name) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<rect width="128" height="128" rx="64" fill="hsl(${hue} 62% 48%)"/>
<text x="64" y="84" text-anchor="middle" fill="#fff" font-size="58" font-family="Segoe UI, PingFang SC, Microsoft YaHei, sans-serif">${escapeXml(label)}</text>
</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function hash(text: string): number {
  let n = 0
  for (const ch of text) n = (n * 31 + ch.codePointAt(0)!) >>> 0
  return n
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]!))
}
