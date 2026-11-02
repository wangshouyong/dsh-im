import { createId } from './ids.ts'
import { isInsideThreadDir, normalizePath, threadDir } from './workspace.ts'

export type FenceOp = 'read' | 'write' | 'edit' | 'delete' | 'rename'
export type FenceCode =
  | 'ok'
  | 'existing-source'
  | 'escape'
  | 'rename-escape'
  | 'outside'
  | 'cache-remap'

export interface FenceVerdict {
  allow: boolean
  code: FenceCode
  reason: string
  env?: Record<string, string>
}

export function rememberBaseline(paths: string[]): Set<string> {
  return new Set(paths.map((p) => normalizePath(p)))
}

export function packageCacheEnv(projectRoot: string, threadId: string): Record<string, string> {
  const cache = `${threadDir(projectRoot, threadId)}/.cache`
  return {
    npm_config_cache: `${cache}/npm`,
    PNPM_STORE_DIR: `${cache}/pnpm`,
    PIP_CACHE_DIR: `${cache}/pip`,
    TEMP: `${cache}/tmp`,
    TMP: `${cache}/tmp`,
    TMPDIR: `${cache}/tmp`,
  }
}

export function commandEnv(
  projectRoot: string,
  threadId: string,
  base: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value != null) out[key] = value
  }
  return { ...out, ...packageCacheEnv(projectRoot, threadId) }
}

function isExternalPackageCache(path: string): boolean {
  const p = path.replace(/\\/g, '/').toLowerCase()
  return (
    p.includes('/npm-cache')
    || p.includes('/npm/cache')
    || p.includes('/pnpm-store')
    || p.includes('/pnpm/store')
    || p.includes('/pip/cache')
    || (p.includes('/appdata/') && (p.includes('/npm') || p.includes('/temp') || p.includes('/pnpm')))
  )
}

function inside(root: string, target: string): boolean {
  const base = normalizePath(root)
  const dest = normalizePath(target)
  return dest === base || dest.startsWith(`${base}/`)
}

/**
 * 已有源码只读。新文件只能进 `.dsh-im/<thread>/`。
 * 包管理器缓存改写到该目录下的 `.cache/`。
 * 单次完全权限跑完就收回，讨论态仍然不能改已有源码。
 */
export class PathFence {
  private token: string | null = null

  constructor(
    private readonly projectRoot: string,
    private readonly threadId: string,
    private readonly baseline: ReadonlySet<string> = new Set(),
  ) {}

  get mode(): 'workspace-write' | 'danger-full-access' {
    return this.token ? 'danger-full-access' : 'workspace-write'
  }

  approveOnce(): string {
    if (this.token) throw new Error('已有未收回的完全权限')
    this.token = createId('fa')
    return this.token
  }

  release(token: string): void {
    if (token !== this.token) throw new Error('完全权限令牌无效')
    this.token = null
  }

  runOnce<T>(fn: () => T): T {
    const token = this.approveOnce()
    try {
      return fn()
    } finally {
      this.release(token)
    }
  }

  decide(input: { op: FenceOp; target: string; from?: string }): FenceVerdict {
    const target = normalizePath(input.target)
    if (input.op === 'read') {
      if (inside(this.projectRoot, target) || isInsideThreadDir(this.projectRoot, this.threadId, target)) {
        return ok('可读关联项目')
      }
      return block('escape', '只能读关联项目里的文件')
    }
    if (input.op === 'rename') {
      return this.decideRename(target, input.from)
    }
    const inProject = inside(this.projectRoot, target)
    if (!inProject && isExternalPackageCache(target)) {
      return {
        allow: false,
        code: 'cache-remap',
        reason: '包管理器缓存改写到本线程 .cache 后重试，不为它打开完全权限',
        env: packageCacheEnv(this.projectRoot, this.threadId),
      }
    }
    if (this.baseline.has(target)) return this.denySource()
    if (isInsideThreadDir(this.projectRoot, this.threadId, target)) return ok('可写本线程目录')
    if (input.op === 'delete') return block('outside', '不能删关联项目里已有的文件')
    return block('outside', '新文件只能写在 .dsh-im 本线程目录')
  }

  private decideRename(target: string, fromRaw: string | undefined): FenceVerdict {
    if (!fromRaw) return block('rename-escape', '改名必须带原来的路径')
    const from = normalizePath(fromRaw)
    if (this.baseline.has(from) || !isInsideThreadDir(this.projectRoot, this.threadId, from)) {
      return this.denySource('rename-escape')
    }
    if (!isInsideThreadDir(this.projectRoot, this.threadId, target)) {
      return block('escape', '不能把文件移出本线程目录')
    }
    return ok('可在本线程目录内改名')
  }

  private denySource(code: FenceCode = 'existing-source'): FenceVerdict {
    if (this.mode === 'danger-full-access') {
      return block(code, '讨论态的单次完全权限也不能改已有源码，跑完即收回')
    }
    return block(code, '已有源码不能改、不能删、不能改名后再按原名新建')
  }
}

function ok(reason: string): FenceVerdict {
  return { allow: true, code: 'ok', reason }
}

function block(code: FenceCode, reason: string): FenceVerdict {
  return { allow: false, code, reason }
}
