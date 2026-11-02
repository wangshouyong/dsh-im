export async function readAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2MB')
  const raw = await file.arrayBuffer()
  const blob = new Blob([raw], { type: file.type })
  const bitmap = await createImageBitmap(blob)
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法处理图片')
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.clip()
  const scale = Math.max(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  return canvas.toDataURL('image/png')
}
