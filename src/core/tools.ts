/**
 * 角色工具授权模型：来源组 + 单工具。
 *
 * 背景：DSH 的 tools.register 没有 owner/来源元数据，唯一可靠信号是命名约定
 * （MCP 的 mcp__<server>__<tool>）。所以授权不看“内置还是自己装的”，只看
 * “这个工具属于哪个来源组 / 是否被显式授予”。
 *
 * 授权条目（Persona.toolAllow: string[]）：
 * - read/search/write/check：产品内置插件工具能力（read_file/list_dir/search_files/write_file/run_check）
 * - grp:<groupId>：整组授予（含以后新增的工具），例如 grp:mcp:aippt、grp:browser
 * - tool:<toolName>：只授予单个宿主工具
 * - 旧数据兼容：browser → grp:browser，image → grp:image
 *
 * 契约详见 docs/TOOL-GRANTS.md。
 */

/** 主会话继承下来的能力标签。角色只能从这里减，不能往外加。没有“任意终端”。 */
export const INHERITED_TOOLS: { id: string; label: string }[] = [
  { id: 'read', label: '读文件' },
  { id: 'search', label: '搜索' },
  { id: 'write', label: '写群目录' },
  { id: 'check', label: '跑检查（测试）' },
  { id: 'memory', label: '读历史（记忆检索）' },
  { id: 'browser', label: '浏览器（bcdp）' },
  { id: 'image', label: '画图（Magpie）' },
]

/** 产品内置的 4 个能力（插件自己注册的工具，不依赖宿主工具层）。 */
export const CORE_CAPABILITIES = ['read', 'search', 'write', 'check', 'memory'] as const
export type CoreCapability = (typeof CORE_CAPABILITIES)[number]

/** 每个内置能力对应的插件工具（native 与 ctx.llm 两条路径共用同一目录）。 */
export const CORE_CAPABILITY_TOOLS: Record<CoreCapability, readonly string[]> = {
  read: ['read_file'],
  search: ['search_files'],
  write: ['write_file'],
  check: ['run_check'],
  memory: ['memory_search', 'memory_expand'],
}
/** list_dir 由读或搜索任一能力覆盖。 */
export const LIST_DIR_TOOL = 'list_dir'

/** 新建角色默认勾上的能力。浏览器/画图/宿主扩展默认关闭。 */
export function defaultToolAllow(): string[] {
  return [...CORE_CAPABILITIES]
}

export function inheritedToolIds(): string[] {
  return INHERITED_TOOLS.map((t) => t.id)
}

export function toolLabel(id: string): string {
  return INHERITED_TOOLS.find((t) => t.id === id)?.label ?? id
}

/** 插件注册进模型的工具名。 */
export const PLUGIN_TOOL_NAMES = [LIST_DIR_TOOL, 'read_file', 'search_files', 'write_file', 'run_check', 'memory_search', 'memory_expand'] as const

/** 画图工具（Magpie MCP server 产出）。 */
export const IMAGE_TOOL_NAMES = new Set([
  'mcp__magpie-image__generate_image',
  'mcp__magpie-image__generate_video',
  'mcp__magpie-image__generation_result',
])

/** 工具来源组声明：声明优先于 MCP 命名约定。 */
export interface ToolGroupDecl {
  id: string
  label: string
  match?: {
    /** 精确工具名 */
    names?: string[]
    /** 工具名前缀 */
    prefixes?: string[]
    /** MCP server 名（匹配 mcp__<server>__<tool>） */
    mcpServers?: string[]
  }
}

/**
 * 出厂声明。bcdp / magpie 不再享受代码特例，只是这里的两条声明，
 * 用户配置的 toolGroups 会追加在后面（同 id 覆盖）。
 */
export const BUILTIN_TOOL_GROUPS: ToolGroupDecl[] = [
  { id: 'browser', label: '浏览器（bcdp）', match: { prefixes: ['bcdp_'] } },
  { id: 'image', label: '画图（Magpie）', match: { mcpServers: ['magpie-image'] } },
]

/** 未声明来源的宿主工具统一落到这个组，仍可单工具勾选。 */
export const OTHER_TOOL_GROUP = { id: 'ext:other', label: '其他宿主工具（未声明来源）' } as const
/** MCP 约定分组的 id 前缀。 */
export const MCP_GROUP_PREFIX = 'mcp:'

/**
 * 永远不可授予的宿主工具前缀：连接器管理（配置/发布/导入）属于部署操作，
 * 专家角色任何情况下都不能用。它们不进入工具目录（UI 不可见、不可勾），
 * guard 里还有第二道无条件拒绝。
 */
export const NEVER_GRANTABLE_PREFIXES = ['mcp_connector_'] as const

export function isNeverGrantableHostTool(name: string): boolean {
  return NEVER_GRANTABLE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export interface DiscoveredToolGroup {
  id: string
  label: string
  /** builtin=出厂声明，declared=用户配置声明，mcp=命名约定，other=兜底 */
  kind: 'builtin' | 'declared' | 'mcp' | 'other'
  tools: string[]
}

export interface ToolGroupCatalog {
  /** 产品内置能力（插件工具，两条传输都可用）。 */
  capabilities: { id: CoreCapability; label: string; tools: string[] }[]
  /** 宿主工具来源组（只在 native 生效）。 */
  groups: DiscoveredToolGroup[]
}

/** 从 tools.schemas() 的返回值里取工具名（兼容 string / {name} 两种形状）。 */
export function schemaToolNames(listed: unknown): string[] {
  if (!Array.isArray(listed)) return []
  const names: string[] = []
  for (const item of listed) {
    if (typeof item === 'string' && item) names.push(item)
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') names.push((item as { name: string }).name)
  }
  return names
}

/** 解析 mcp__<server>__<tool>。 */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const at = rest.indexOf('__')
  if (at <= 0 || at + 2 >= rest.length) return undefined
  return rest.slice(0, at)
}

function normalizeDecls(declared: readonly ToolGroupDecl[]): ToolGroupDecl[] {
  const merged = new Map<string, ToolGroupDecl>()
  for (const decl of declared) merged.set(decl.id, decl)
  return [...merged.values()]
}

/** 一个工具落在哪个声明组（不看 MCP 约定）。 */
function declaredGroupOf(name: string, declares: readonly ToolGroupDecl[]): ToolGroupDecl | undefined {
  const server = mcpServerOf(name)
  for (const decl of declares) {
    const match = decl.match
    if (!match) continue
    if (match.names?.includes(name)) return decl
    if (match.prefixes?.some((prefix) => prefix.length > 0 && name.startsWith(prefix))) return decl
    if (server !== undefined && match.mcpServers?.includes(server)) return decl
  }
  return undefined
}

/** 工具 → 来源组 id（声明优先 → MCP 约定 → 兜底组）。 */
export function groupIdForTool(name: string, declared: readonly ToolGroupDecl[] = BUILTIN_TOOL_GROUPS): string {
  const decl = declaredGroupOf(name, normalizeDecls(declared))
  if (decl) return decl.id
  const server = mcpServerOf(name)
  if (server !== undefined) return `${MCP_GROUP_PREFIX}${server}`
  return OTHER_TOOL_GROUP.id
}

export function groupLabelFor(groupId: string, declared: readonly ToolGroupDecl[] = BUILTIN_TOOL_GROUPS): string {
  const decl = normalizeDecls(declared).find((item) => item.id === groupId)
  if (decl) return decl.label
  if (groupId.startsWith(MCP_GROUP_PREFIX)) return `MCP：${groupId.slice(MCP_GROUP_PREFIX.length)}`
  if (groupId === OTHER_TOOL_GROUP.id) return OTHER_TOOL_GROUP.label
  return groupId
}

/** 发现宿主工具来源组。names 是宿主 tools.schemas() 的全局视图。 */
export function discoverToolGroups(
  names: readonly string[],
  declared: readonly ToolGroupDecl[] = BUILTIN_TOOL_GROUPS,
): DiscoveredToolGroup[] {
  const declares = normalizeDecls(declared)
  const byId = new Map<string, DiscoveredToolGroup>()
  for (const name of [...new Set(names)].sort()) {
    if ((PLUGIN_TOOL_NAMES as readonly string[]).includes(name)) continue
    // 连接器管理等永远不可授予的宿主工具不进目录：UI 不出现，也不参与授权计算。
    if (isNeverGrantableHostTool(name)) continue
    const decl = declaredGroupOf(name, declares)
    const server = mcpServerOf(name)
    const builtin = decl !== undefined && BUILTIN_TOOL_GROUPS.some((item) => item.id === decl.id)
    const id = decl?.id ?? (server !== undefined ? `${MCP_GROUP_PREFIX}${server}` : OTHER_TOOL_GROUP.id)
    const group = byId.get(id) ?? {
      id,
      label: decl?.label ?? groupLabelFor(id, declares),
      kind: decl === undefined ? (server !== undefined ? 'mcp' : 'other') : builtin ? 'builtin' : 'declared',
      tools: [],
    }
    group.tools.push(name)
    byId.set(id, group)
  }
  return [...byId.values()]
}

/** 产品内置能力 + 宿主来源组的完整目录（客户端角色编辑器 / 状态接口用）。 */
export function toolGroupCatalog(
  hostNames: readonly string[],
  declared: readonly ToolGroupDecl[] = BUILTIN_TOOL_GROUPS,
): ToolGroupCatalog {
  return {
    capabilities: CORE_CAPABILITIES.map((id) => ({
      id,
      label: toolLabel(id),
      tools: [...CORE_CAPABILITY_TOOLS[id]],
    })),
    groups: discoverToolGroups(hostNames, declared),
  }
}

export type GrantKind = 'capability' | 'group' | 'tool'

/** 解析一个授权条目；非法返回 null。 */
export function parseGrant(entry: string): { kind: GrantKind; value: string } | null {
  if (typeof entry !== 'string') return null
  const id = entry.trim()
  if (!id) return null
  if (id === 'browser' || id === 'image') return { kind: 'group', value: id }
  if ((CORE_CAPABILITIES as readonly string[]).includes(id)) return { kind: 'capability', value: id }
  if (id.startsWith('grp:')) {
    const value = id.slice(4).trim()
    return value ? { kind: 'group', value } : null
  }
  if (id.startsWith('tool:')) {
    const value = id.slice(5).trim()
    return /^[A-Za-z0-9_.:-]+$/.test(value) ? { kind: 'tool', value } : null
  }
  return null
}

/**
 * 规整授权条目：旧 id 迁移（browser/image → grp:）、去重、丢掉非法/已下线 id。
 * 传了 toolDeny（旧数据）时按“内置能力全集 − deny”换算成 toolAllow。
 */
export function normalizeToolAllow(ids: unknown, deny?: unknown): string[] | undefined {
  const source = Array.isArray(ids)
    ? ids
    : Array.isArray(deny)
      ? inheritedToolIds().filter((id) => !(deny as unknown[]).includes(id))
      : undefined
  if (source === undefined) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of source) {
    if (typeof raw !== 'string') continue
    const parsed = parseGrant(raw)
    if (!parsed) continue
    const normalized = parsed.kind === 'group' ? `grp:${parsed.value}` : parsed.kind === 'tool' ? `tool:${parsed.value}` : parsed.value
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/** 只保留当前存在的能力 id（老数据里的 `shell` 等会被静默丢弃）。 */
export function legacyKnownToolAllow(ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined
  const known = new Set(inheritedToolIds())
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && known.has(id)))]
}

/** 授权条目集合。 */
export function grantSet(toolAllow?: string[]): Set<string> {
  const set = new Set<string>()
  for (const entry of toolAllow ?? []) {
    const parsed = parseGrant(entry)
    if (!parsed) continue
    if (parsed.kind === 'capability') set.add(`cap:${parsed.value}`)
    else if (parsed.kind === 'group') set.add(`grp:${parsed.value}`)
    else set.add(`tool:${parsed.value}`)
  }
  return set
}

/** 插件工具是否被授予（read/search/write/check）。 */
export function pluginToolGranted(name: string, toolAllow?: string[]): boolean {
  if (toolAllow === undefined) return true
  if (name === LIST_DIR_TOOL) return toolAllow.includes('read') || toolAllow.includes('search')
  const capability = (CORE_CAPABILITIES as readonly string[]).find((id) => CORE_CAPABILITY_TOOLS[id as CoreCapability].includes(name))
  return capability !== undefined && toolAllow.includes(capability)
}

/** 宿主工具是否被授予（单工具或所属组）。 */
export function hostToolGranted(
  name: string,
  toolAllow?: string[],
  declared: readonly ToolGroupDecl[] = BUILTIN_TOOL_GROUPS,
): boolean {
  if (toolAllow === undefined) return false
  if (isNeverGrantableHostTool(name)) return false
  const grants = grantSet(toolAllow)
  if (grants.has(`tool:${name}`)) return true
  return grants.has(`grp:${groupIdForTool(name, declared)}`)
}

/** 当前授权下真正生效的宿主工具（用于可见性收窄与会话重建判定）。 */
export function effectiveHostTools(
  hostNames: readonly string[],
  toolAllow?: string[],
  declared: readonly ToolGroupDecl[] = BUILTIN_TOOL_GROUPS,
): string[] {
  if (toolAllow === undefined) return []
  return [...new Set(hostNames)].filter((name) => hostToolGranted(name, toolAllow, declared)).sort()
}

/** 这个角色勾了、但这次没有注册进 agent 的能力（只统计 4 个插件能力）。 */
export function nativeCapabilityGap(toolAllow?: string[], covered: readonly string[] = []): string[] {
  const caps = new Set(toolAllow ?? [])
  const have = new Set(covered)
  return CORE_CAPABILITIES.filter((id) => caps.has(id) && !have.has(id))
}

/** 勾选对应到要注册的插件工具。list_dir 属于读或搜索。undefined 表示继承全部能力。 */
export function pluginToolsForAllow(toolAllow?: string[]): string[] {
  const allowed = new Set(toolAllow ?? inheritedToolIds())
  const names: string[] = []
  if (allowed.has('read') || allowed.has('search')) names.push(LIST_DIR_TOOL)
  if (allowed.has('read')) names.push('read_file')
  if (allowed.has('search')) names.push('search_files')
  if (allowed.has('write')) names.push('write_file')
  if (allowed.has('check')) names.push('run_check')
  // memory 也是插件能力（两个插件工具），native 与 ctx.llm 两条传输必须同权；
  // 之前漏了这里会让原生会话静默没有记忆工具（真机复验发现）。
  if (allowed.has('memory')) names.push(...CORE_CAPABILITY_TOOLS.memory)
  return names
}

/**
 * 宿主工具执行前的硬拒绝。插件工具交给按能力收窄的那一层；宿主工具只认
 * tool:/grp: 授权；另外永远拒绝连接器管理类工具。
 */
export function personaHostToolDenial(
  name: string,
  toolAllow?: string[],
  declared: readonly ToolGroupDecl[] = BUILTIN_TOOL_GROUPS,
): string | undefined {
  if ((PLUGIN_TOOL_NAMES as readonly string[]).includes(name)) return undefined
  if (!name) return '专家角色不能使用宿主工具 (未命名)'
  if (name.startsWith('mcp_connector_')) return `专家角色不能使用连接器管理工具 ${name}`
  if (hostToolGranted(name, toolAllow, declared)) return undefined
  const group = groupLabelFor(groupIdForTool(name, declared), declared)
  return `专家角色没有授予「${group}」里的工具 ${name}`
}

/** 授权条目的可读标签（成员卡/兼容横幅用）。 */
export function labelForGrant(entry: string, catalog?: ToolGroupCatalog): string {
  const parsed = parseGrant(entry)
  if (!parsed) return entry
  if (parsed.kind === 'capability') return toolLabel(parsed.value)
  if (parsed.kind === 'group') {
    const group = catalog?.groups.find((item) => item.id === parsed.value)
    return group?.label ?? groupLabelFor(parsed.value)
  }
  return `工具 ${parsed.value}`
}

/** 只校验形状，不校验“是否存在”：组/工具可能来自已卸载插件。 */
export function assertKnownTools(ids: string[]): void {
  const bad = ids.filter((id) => parseGrant(id) === null)
  if (bad.length) throw new Error(`不能新增工具：${bad.join('、')}（只支持 read/search/write/check 或 grp:/tool: 授权）`)
}

/** 旧接口：toolAllow/toolDeny → 规整后的 toolAllow。 */
export function resolveToolFilter(input: {
  toolAllow?: string[]
  toolDeny?: string[]
}): { toolAllow?: string[]; toolDeny?: string[] } {
  if (input.toolAllow) {
    assertKnownTools(input.toolAllow)
    return { toolAllow: normalizeToolAllow(input.toolAllow) }
  }
  if (input.toolDeny) {
    assertKnownTools(input.toolDeny)
    return { toolAllow: normalizeToolAllow(undefined, input.toolDeny) }
  }
  return {}
}
