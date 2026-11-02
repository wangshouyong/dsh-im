export interface FileSink {
  writeThreadFile(projectRoot: string, threadId: string, relativePath: string, content: string): Promise<string>
}

/** threadId 会拼进目录：只允许生成器使用的安全字符，挡住 `../` 穿越。 */
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

export function assertSafeThreadId(threadId: string): void {
  // status 让宿主路由把参数错误翻成 400，而不是 500。
  if (!THREAD_ID_PATTERN.test(threadId)) throw Object.assign(new Error('denied: invalid threadId'), { status: 400 })
}

export function threadDir(projectRoot: string, threadId: string): string {
  assertSafeThreadId(threadId)
  return normalizePath(`${projectRoot}/.dsh-im/${threadId}`)
}

export function isInsideThreadDir(projectRoot: string, threadId: string, target: string): boolean {
  const root = threadDir(projectRoot, threadId).replace(/\\/g, '/')
  const resolved = normalizePath(target).replace(/\\/g, '/')
  return resolved === root || resolved.startsWith(`${root}/`)
}

export function summaryRelPath(): string {
  return '本轮汇总.md'
}

export const memorySink = (): FileSink => {
  const files = new Map<string, string>()
  return {
    async writeThreadFile(projectRoot, threadId, relativePath, content) {
      const dest = `${threadDir(projectRoot, threadId)}/${relativePath}`
      if (!isInsideThreadDir(projectRoot, threadId, dest)) {
        throw new Error('write denied: path escapes .dsh-im thread directory')
      }
      files.set(dest, content)
      return dest
    },
  }
}

export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const prefix = path.startsWith('/') ? '/' : ''
  return prefix + parts.join('/')
}
