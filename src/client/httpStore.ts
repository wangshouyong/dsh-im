import type { ModelOption } from '../host/models.ts'
import type { ModelTransport } from '../core/runtime.ts'
import type { ImState } from '../core/types.ts'
import type { FileSink } from '../core/workspace.ts'
import { parseGrant, toolGroupCatalog, type ToolGroupCatalog } from '../core/tools.ts'
import { logWarn } from '../core/log.ts'

/** 面板拿不到宿主时（dev / 老宿主）退回"只有内置 4 能力"的目录。 */
let cachedToolGroups: ToolGroupCatalog = toolGroupCatalog([])

/** 角色编辑器/成员卡同步读取的最近一次工具目录。 */
export function toolGroupsSnapshot(): ToolGroupCatalog {
  return cachedToolGroups
}

/** 动态工具目录：内置 4 能力 + 宿主来源组（浏览器/MCP server/其他）。刷新即发现新装工具。 */
export async function loadToolGroups(): Promise<ToolGroupCatalog> {
  try {
    const res = await fetch('/api/im/tool-groups')
    if (!res.ok) return cachedToolGroups
    const data = (await res.json().catch(() => ({}))) as Partial<ToolGroupCatalog>
    if (!Array.isArray(data.capabilities) || !Array.isArray(data.groups)) return cachedToolGroups
    cachedToolGroups = { capabilities: data.capabilities, groups: data.groups }
    return cachedToolGroups
  } catch {
    return cachedToolGroups
  }
}

export function httpSink(): FileSink {
  return {
    async writeThreadFile(_projectRoot, threadId, relativePath, content) {
      const res = await fetch('/api/im/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, relativePath, content }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = (await res.json()) as { path: string }
      return data.path
    },
  }
}

export async function loadRemoteModels(): Promise<ModelOption[]> {
  const res = await fetch('/api/im/models')
  const data = (await res.json().catch(() => ({}))) as ModelOption[] | { error?: string }
  if (!res.ok) {
    const error = !Array.isArray(data) && data.error ? data.error : `模型列表 ${res.status}`
    throw new Error(error)
  }
  return Array.isArray(data) ? data : []
}

/** 绝对路径才带上 projectRoot（相对路径交给 host 默认工作区）。 */
function stateQuery(projectRoot?: string): string {
  if (!projectRoot) return ''
  const absolute = /^[A-Za-z]:[\\/]/.test(projectRoot) || projectRoot.startsWith('/')
  return absolute ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
}

export interface WorkspaceOption {
  title: string
  path: string
}

/** DSH 原生工作区列表（“关联工作区”下拉用）。 */
export async function loadWorkspaces(): Promise<WorkspaceOption[]> {
  const res = await fetch('/api/im/workspaces')
  if (!res.ok) return []
  const data = (await res.json()) as unknown
  if (!Array.isArray(data)) return []
  return data
    .filter((item): item is { title?: string; path?: string } => Boolean(item) && typeof item === 'object')
    .filter((item): item is { title?: string; path: string } => typeof item.path === 'string')
    .map((item) => ({ title: item.title?.trim() || item.path, path: item.path }))
}

export interface FsListing {
  path: string
  parent: string
  entries: { name: string; path: string }[]
}

/** 附件预览/下载地址（同源；不把绝对工作区路径塞进 URL）。 */
export function attachmentUrl(threadId: string, _projectRoot: string, path: string): string {
  const query = new URLSearchParams({ threadId, file: path })
  return `/api/im/attachment?${query.toString()}`
}

/** 上传一个附件到本群 attachments/，host 会同时登记到 DSH 附件存储（图片给模型看）。 */
export async function uploadAttachment(input: {
  threadId: string
  projectRoot: string
  file: File
}): Promise<{ attachment: import('../core/types.ts').MessageAttachment }> {
  const { file } = input
  const query = new URLSearchParams({
    threadId: input.threadId,
    projectRoot: input.projectRoot,
    name: file.name || 'attachment',
    ...(file.type ? { mediaType: file.type } : {}),
  })
  const body = await file.arrayBuffer()
  const res = await fetch('/api/im/upload?' + query.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
  const data = (await res.json().catch(() => ({}))) as {
    attachment?: import('../core/types.ts').MessageAttachment
    url?: string
    error?: string
  }
  if (res.status === 404) throw new Error('当前 DSH 宿主还没加载附件上传接口：请重启 DSH 后再试')
  if (!res.ok || !data.attachment) throw new Error(data.error || `上传失败（${res.status}）`)
  return { attachment: data.attachment }
}

/** 文件夹浏览器（只列目录）：给“添加工作区…”选文件夹用。 */
export async function browseFolders(path?: string): Promise<FsListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch('/api/im/fs' + query)
  if (res.status === 404) {
    throw new Error('当前 DSH 宿主还没加载「选择文件夹」接口（/api/im/fs 404）：请重启 DSH 后再试')
  }
  const data = (await res.json().catch(() => ({}))) as Partial<FsListing> & { error?: string }
  if (!res.ok) throw new Error(data.error || `文件夹列表 ${res.status}`)
  return {
    path: data.path ?? '',
    parent: data.parent ?? '',
    entries: Array.isArray(data.entries) ? data.entries : [],
  }
}

/** 在 DSH 里创建工作区（同步进原生工作区列表），返回最新列表 + 新路径。 */
export async function createWorkspace(
  path: string,
  title?: string,
): Promise<{ workspaces: WorkspaceOption[]; path: string }> {
  const res = await fetch('/api/im/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, title }),
  })
  const data = (await res.json().catch(() => ({}))) as { workspaces?: WorkspaceOption[]; path?: string; error?: string }
  if (res.status === 404) throw new Error('当前 DSH 宿主还没加载「添加工作区」接口：请重启 DSH 后再试')
  if (!res.ok) throw new Error(data.error || `创建工作区 ${res.status}`)
  return { workspaces: Array.isArray(data.workspaces) ? data.workspaces : [], path: data.path ?? path }
}

export async function loadRemoteState(projectRoot?: string): Promise<ImState | null> {
  const res = await fetch('/api/im/state' + stateQuery(projectRoot))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(stateErrorMessage('读取', res.status, await res.text()))
  return (await res.json()) as ImState
}

/** 宿主错误统一成「中文 + 状态码 + 服务端原因」，不再吞成一句空话。 */
function stateErrorMessage(action: string, status: number, body: string): string {
  let reason = ''
  try {
    const parsed = JSON.parse(body) as { error?: string }
    reason = parsed.error?.trim() ?? ''
  } catch {
    reason = body.trim().slice(0, 300)
  }
  return `${action}数据根失败（HTTP ${status}）${reason ? '：' + reason : ''}`
}

/** 数据根体检（只读）：当前根 / 已注册工作区 / 以前用过的根，各自有没有数据。 */
export async function loadStateRoots(): Promise<import('../host/state-roots.ts').StateRootInfo[]> {
  try {
    const res = await fetch('/api/im/roots')
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? data as import('../host/state-roots.ts').StateRootInfo[] : []
  } catch {
    return []
  }
}

/** 数据根下拉/失败页用的短标签：角色 N · 会话 M · 最后更新；未注册/读不到要写出来。 */
export function formatStateRoot(info: {
  path: string
  title?: string
  registered: boolean
  hasState: boolean
  personas: number
  threads: number
  updatedAt?: number
  error?: string
}): string {
  const name = info.title?.trim() || info.path
  if (info.error) return `${name} · 读不到（${info.error}）`
  if (!info.hasState) return `${name} · 还没有数据`
  const when = info.updatedAt ? new Date(info.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  const flags = [info.registered ? '已注册' : '未注册'].join(' · ')
  return `${name} · 角色${info.personas} · 会话${info.threads}${when ? ' · ' + when : ''} · ${flags}`
}

export function httpModelTransport(): ModelTransport {
  return {
    async complete(input) {
      const res = await fetch('/api/im/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const data = (await res.json().catch(() => ({}))) as {
        text?: string
        error?: string
        trace?: import('../core/types.ts').TurnStepTrace[]
      }
      if (!res.ok) throw new Error(data.error || `模型接口 ${res.status}`)
      if (!data.text?.trim()) throw new Error('模型返回空内容')
      if (data.trace?.length) input.onTrace?.(data.trace)
      return data.text
    },
  }
}

/** 原生会话传输。面板开关打开且宿主有 ctx.agents 时使用。 */
export interface NativeCompatNotice {
  threadId?: string
  personaId?: string
  text: string
}

const compatListeners = new Set<(notice: NativeCompatNotice) => void>()

export function onNativeCompat(listener: (notice: NativeCompatNotice) => void): () => void {
  compatListeners.add(listener)
  return () => compatListeners.delete(listener)
}

function notifyCompat(notice: NativeCompatNotice): void {
  for (const listener of compatListeners) listener(notice)
}

function compatNoticeText(message: string, toolAllow?: string[]): string {
  const hostGrants = (toolAllow ?? []).filter((entry) => {
    const parsed = parseGrant(entry)
    return parsed?.kind === 'group' || parsed?.kind === 'tool'
  })
  const hostHint = hostGrants.length ? '该角色勾选的宿主工具（浏览器/MCP/扩展）本轮不可用。' : ''
  if (message.includes('还没挂上') || message.includes('本轮应走兼容路径')) {
    return (message.startsWith('本轮走兼容路径') ? message : `本轮走兼容路径：${message}`) + hostHint
  }
  return `本轮走兼容路径：原生会话没有完成，已改用原来的模型调用。${hostHint}`
}

export function httpNativeTransport(): ModelTransport {
  const fallback = httpModelTransport()
  return {
    async complete(input) {
      // 事实抽取/共识整理都是后台结构化调用：不进原生会话。
      // 走原生会话会额外起一轮 agent（实测 curate 7–50s），还会把整理 prompt 写进角色会话记忆。
      if (input.purpose === 'extract' || input.purpose === 'curate') return fallback.complete(input)
      const prompt = input.messages.map((message) => (
        typeof message.content === 'string'
          ? message.content
          : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      )).join('\n\n')
      try {
        const res = await fetch('/api/im/native-complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...input,
            sessionKey: `${input.personaId ?? 'unknown'}:${input.threadId ?? 'im'}`,
            cwd: input.projectRoot,
            prompt,
            // 观测性字段显式转发（不改变 prompt/顺序）：native 回执与 ctx.llm 同结构。
            ...(input.budget ? { budget: input.budget } : {}),
            ...(input.budgetChanged ? { budgetChanged: input.budgetChanged } : {}),
            ...(input.memoryContext ? { memoryContext: input.memoryContext } : {}),
          }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          text?: string
          error?: string
          trace?: import('../core/types.ts').TurnStepTrace[]
          toolStats?: { toolCalls: number; toolExecuted: number; toolBudgetExhausted: boolean; toolCallLimit: number }
        }
        if (!res.ok) throw new Error(data.error || `原生会话接口 ${res.status}`)
        if (!data.text?.trim()) throw new Error('原生会话返回空内容')
        if (data.trace?.length) input.onTrace?.(data.trace)
        notifyCompat({ threadId: input.threadId, personaId: input.personaId, text: '' })
        return data.text
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notifyCompat({
          threadId: input.threadId,
          personaId: input.personaId,
          text: compatNoticeText(message, input.toolAllow),
        })
        logWarn('[dsh-im] 原生 session 失败，回退 ctx.llm：', error instanceof Error ? error.message : String(error))
        return fallback.complete(input)
      }
    },
  }
}

/** 面板开关。缺省开（P2：原生默认开）；显式存 '0' 才关；宿主不支持时自动回退 ctx.llm。 */
export const NATIVE_PREF_KEY = 'dsh-im:native'

export function nativePreference(): boolean {
  try {
    return localStorage.getItem(NATIVE_PREF_KEY) !== '0'
  } catch {
    return true
  }
}

export function setNativePreference(on: boolean): void {
  localStorage.setItem(NATIVE_PREF_KEY, on ? '1' : '0')
}

export async function loadNativeStatus(): Promise<{ available: boolean; enabled: boolean; reason?: string }> {
  const pref = nativePreference()
  try {
    const res = await fetch('/api/im/native-status')
    if (!res.ok) return { available: false, enabled: false, reason: `native-status ${res.status}` }
    const data = (await res.json()) as { enabled?: boolean; reason?: string }
    const available = Boolean(data.enabled)
    return {
      available,
      enabled: available && pref,
      ...(data.reason ? { reason: data.reason } : {}),
    }
  } catch (error) {
    return { available: false, enabled: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function saveRemoteState(state: ImState, projectRoot?: string): Promise<void> {
  const res = await fetch('/api/im/state' + stateQuery(projectRoot), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!res.ok) throw new Error(await res.text())
  // 聊天记录已保存、派生数据（事件/facts/摘要/指标）有失败时，宿主会回 warnings；不能当全成功。
  const data = (await res.json().catch(() => null)) as { warnings?: unknown } | null
  if (Array.isArray(data?.warnings) && data.warnings.length > 0) {
    logWarn('[dsh-im] 落盘有部分失败（聊天记录已保存）', data.warnings.join('；'))
  }
}