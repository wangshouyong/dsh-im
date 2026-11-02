/** 接入 DSH 后模型目录来自宿主 `ctx.llm`，不要写死 Harness 版本，也不要直连网关。 */
export interface ModelOption {
  /** 选择器值：`provider::model`。 */
  id: string
  label: string
  /** 展示用提供方名（与 DSH 模型选择器的分组一致）。 */
  provider: string
  /** DSH provider 路由，发给 ctx.llm.stream。 */
  route?: string
  /** 发给 ctx.llm.stream 的模型 id；目录读不出来的分组为空。 */
  modelId?: string
  /** 当前能否真正发起调用。提供方目录读取失败时为 false。 */
  ready: boolean
  /** 模型上下文窗口（token）；宿主查得到才有，用来按 60/20/20 分配 prompt 预算。 */
  contextWindow?: number
  /** 不可调用时的原因（来自宿主目录错误）。 */
  note?: string
}

export interface ModelCatalog {
  list(): ModelOption[]
}

export function catalogModelId(route: string, modelId: string): string {
  return `${route}::${modelId}`
}

export function parseCatalogModelId(id: string, fallbackRoute?: string): { route: string; model: string } | null {
  const trimmed = id.trim()
  if (!trimmed) return null
  const sep = trimmed.indexOf('::')
  if (sep > 0) {
    return { route: trimmed.slice(0, sep), model: trimmed.slice(sep + 2) }
  }
  if (fallbackRoute?.trim()) return { route: fallbackRoute.trim(), model: trimmed }
  return { route: '', model: trimmed }
}

export function previewModelCatalog(): ModelCatalog {
  return {
    list() {
      return [
        { id: 'deepseek-chat', label: 'DeepSeek-V3', provider: 'DeepSeek', ready: true, contextWindow: 64_000 },
        { id: 'deepseek-reasoner', label: 'DeepSeek-R1', provider: 'DeepSeek', ready: true, contextWindow: 64_000 },
        { id: 'deepseek-v3-0324', label: 'DeepSeek-V3-0324', provider: 'DeepSeek', ready: true, contextWindow: 64_000 },
      ]
    },
  }
}

/**
 * 把保存的模型值解析成可调用的 `provider::model`。
 * 老数据可能只存了模型 id，而同一个 id 会出现在多个提供方分组里
 * （例如 deepseek-flash 同时在「DeepSeek 账号」和「DeepSeek」），
 * 只在角色记录的那个提供方里找（route 或显示名都认）；找不到直接返回空，
 * 由调用方提示重选——绝不静默换到别的提供方。
 */
export function resolveModelBinding(
  options: ModelOption[],
  model: string | undefined,
  storedProvider?: string,
): { route: string; model: string } | null {
  const wanted = model?.trim()
  if (!wanted) return null
  const stored = storedProvider?.trim()

  // 已经是 provider::model：必须精确存在且可用，否则报错，不猜别的组。
  const sep = wanted.indexOf('::')
  if (sep > 0) {
    const route = wanted.slice(0, sep)
    const modelId = wanted.slice(sep + 2)
    if (!modelId) return null
    const exact = options.find((option) => option.ready && option.route === route && option.modelId === modelId)
    return exact ? { route, model: modelId } : null
  }

  // 老数据只存了模型 id：只在“角色记录的那个提供方”里找；找不到就报错。
  const candidates = options.filter((option) => (
    option.ready && option.modelId !== undefined && option.modelId !== '' && option.modelId === wanted
  ))
  if (!stored) {
    // 没有记录提供方时，只有唯一候选才能确定；多个候选视为歧义，交给用户重选。
    return candidates.length === 1 && candidates[0].route
      ? { route: candidates[0].route, model: wanted }
      : null
  }
  const hit = candidates.find((option) => option.route === stored) ?? candidates.find((option) => option.provider === stored)
  return hit?.route ? { route: hit.route, model: wanted } : null
}

export function findModel(catalog: ModelCatalog, id: string | undefined): ModelOption | undefined {
  if (!id) return undefined
  const list = catalog.list()
  return list.find((m) => m.id === id)
    ?? list.find((m) => m.modelId === id)
    ?? list.find((m) => m.route && id === catalogModelId(m.route, m.modelId ?? m.id))
}
