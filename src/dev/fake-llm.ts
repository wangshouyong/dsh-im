import type { LlmService } from '../host/dsh-llm.ts'

/** 预览目录：分组/搜索/滚动都要看得到效果，所以给足几条。 */
const PREVIEW_PROVIDERS: { id: string; name: string; models: string[] }[] = [
  {
    id: 'preview-account',
    name: '预览账号',
    models: ['DeepSeek-V41-Flash', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash'],
  },
  {
    id: 'preview-official',
    name: '预览官方',
    models: ['DeepSeek-V41-Flash', 'DeepSeek-V4-Pro', 'DeepSeek-R2'],
  },
  {
    id: 'preview-gateway',
    name: '预览网关',
    models: [
      'Grok 4.7 @ 256k · Cursor',
      'Grok 4.7 @ 500k · Cursor',
      'Grok 4.6 · Cursor',
      'Claude Opus 5.5 @ 1m · Cursor',
      'Claude Opus 4.8 @ 1m · Cursor',
      'GLM-5.3 · WorkBuddy',
      'GLM-5.3-Flash · WorkBuddy',
      'GLM-5.2 · WorkBuddy',
      'Kimi-K3.1-Pro · WorkBuddy',
      'Kimi-K3 · WorkBuddy',
      'Hy3 · WorkBuddy',
    ],
  },
]

/**
 * 想核对“模型到底看到了什么 prompt”时把这里打开：回显完整 prompt。
 * 默认关——不然预览里会把内部摘要/规则整段当成角色发言显示出来（正式环境不会）。
 */
const ECHO_PROMPT = false

/**
 * 仅 `npm run dev` 用的内存假模型。
 *
 * 不发任何网络请求、不读密钥、不认识任何网关地址：
 * 只是让界面能在“没有 DSH 宿主”的情况下跑通。
 * 正式插件里模型目录与调用只走宿主 DSH 的 `ctx.llm`。
 */
export function createPreviewLlm(): LlmService {
  return {
    listProviders: () => [
      ...PREVIEW_PROVIDERS.map((provider) => ({ id: provider.id, name: provider.name })),
      { id: 'preview-broken', name: '预览不可用' },
    ],
    listConfigurableProviders: () => PREVIEW_PROVIDERS.map((provider) => ({
      provider: provider.id,
      displayName: provider.name,
    })),
    async listModels(provider) {
      if (provider === 'preview-broken') throw new Error('预览：这个提供方没有配置凭据')
      const group = PREVIEW_PROVIDERS.find((entry) => entry.id === provider)
      if (!group) return []
      return group.models.map((name) => ({ id: slug(name), name }))
    },
    // 和真实宿主一样提供上下文窗口（预览里用来验证 60/20/20 预算）。
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 64_000 } }
    },
    async *stream(options) {
      const input = options as { system?: unknown; messages?: { role?: string; content?: unknown }[] }
      const prompt = textOf([...(input.messages ?? [])].reverse().find((m) => m.role === 'user')?.content).trim()
      const systemText = textOf(input.system)
      // 共识整理（curator）：返回一条合法聚类草稿，让 dev 预览能验证共识板/状态机。
      if (systemText.includes('共识整理器')) {
        yield { type: 'text-delta', text: curatorReply(prompt) }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // 事实抽取：dev 不产生 LLM 事实，只用规则抽取，避免 provenance 报错。
      if (systemText.includes('事实抽取器')) {
        yield { type: 'text-delta', text: '[]' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (ECHO_PROMPT) {
        yield {
          type: 'text-delta',
          text: `（开发预览：内存假模型，没有连接任何网关。）\n\n${prompt}`,
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const persona = /角色「([^」]+)」/.exec(textOf(input.system))?.[1] ?? '专家'
      const question = currentUserQuestion(prompt) || '（空消息）'
      yield {
        type: 'text-delta',
        text: [
          `（开发预览 · 内存假模型）收到「${question}」。`,
          `我是「${persona}」的占位回复：没有连接任何网关，正式环境这里由 DSH 的真实模型发言。`,
          '承诺：随时可以帮忙',
          '约束：我没有 shell，无法执行命令',
          '立场：可能还要再确认',
        ].join('\n'),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

interface CuratorPromptFact {
  factId: string
  owner: string
  kind: string
  text: string
}

/** 从 curator prompt 里解析 fact 列表，按正文合并成簇；能力自述进 D，可能/待定进 candidate。 */
function curatorReply(prompt: string): string {
  const rows: CuratorPromptFact[] = []
  for (const line of prompt.split('\n')) {
    const match = /^- (f_\S+) \| ([^|]+) \| ([^|]+) \| (.+)$/.exec(line.trim())
    if (!match) continue
    rows.push({ factId: match[1], owner: match[2].trim(), kind: match[3].trim(), text: match[4].trim() })
  }
  const grouped = new Map<string, { factIds: string[]; owner: string; kind: string; text: string }>()
  for (const row of rows) {
    const existing = grouped.get(row.text)
    if (existing) existing.factIds.push(row.factId)
    else grouped.set(row.text, { factIds: [row.factId], owner: row.owner, kind: row.kind, text: row.text })
  }
  const counters = { A: 0, B: 0, C: 0, D: 0 }
  const clusters = [...grouped.values()].map((group) => {
    const userOwner = group.owner === '用户' || group.owner === '你'
    const capability = !userOwner && /(没有|不跑|不能跑|跑不了|无法)\s*(run_check|shell|权限|工具)|只能(?:在群里|读文件)/.test(group.text)
    let lane: 'A' | 'B' | 'C' | 'D' = 'B'
    let kind = '事实'
    let status: string | undefined
    if (capability) {
      lane = 'D'
      kind = '能力自述'
      status = 'archived'
    } else if (userOwner && /todo/.test(group.kind)) {
      lane = 'C'
      kind = '任务'
    } else if (userOwner) {
      lane = 'A'
      kind = '决定'
    } else if (/commitment/.test(group.kind)) {
      lane = 'B'
      kind = '承诺'
    } else if (/stance/.test(group.kind)) {
      lane = 'B'
      kind = '立场'
      if (group.text.includes('可能')) status = 'candidate'
    }
    counters[lane] += 1
    return {
      key: `P${lane}${counters[lane]}`,
      lane,
      kind,
      ...(status === undefined ? {} : { status }),
      factIds: group.factIds,
      text: group.text.slice(0, 80),
    }
  })
  return JSON.stringify({ clusters, derived: [] })
}

/** 从组装好的 prompt 里只取“当前消息”那一段（避免把摘要/规则一起当回复显示）。 */
function currentUserQuestion(prompt: string): string {
  const marker = '[当前消息]'
  const index = prompt.lastIndexOf(marker)
  const tail = index >= 0 ? prompt.slice(index + marker.length) : prompt
  return tail
    .replace(/^\s*\[#\d+\]\[[^\]]*\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}
