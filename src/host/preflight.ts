import { listDshModels, type LlmService } from './dsh-llm.ts'
import { resolveModelBinding, type ModelOption } from './models.ts'

export interface PreflightMemberInput {
  personaId: string
  name: string
  post?: string
  model: string
  provider?: string
}

export interface PreflightMember {
  personaId: string
  name: string
  post?: string
  ok: boolean
  level: 'ok' | 'error'
  /** 解析出的可调用路由，ok 时才有。 */
  binding?: { route: string; model: string }
  reason?: string
}

export interface PreflightResult {
  ok: boolean
  checkedAt: number
  members: PreflightMember[]
}

/**
 * 开始讨论前的配置级体检：只读宿主模型目录，不发任何模型请求。
 * 不可用的成员给出原因，由用户决定“本轮移除候选”还是“去修好再检测”。
 */
export async function preflightMembers(
  llm: LlmService | undefined,
  members: PreflightMemberInput[],
): Promise<PreflightResult> {
  if (!llm?.listProviders) {
    throw Object.assign(new Error('DSH 模型服务未就绪'), { status: 503 })
  }
  const catalog: ModelOption[] = await listDshModels(llm)
  const checked = members.map((member): PreflightMember => {
    const base = { personaId: member.personaId, name: member.name, ...(member.post ? { post: member.post } : {}) }
    if (!member.model?.trim()) {
      return { ...base, ok: false, level: 'error', reason: '角色没有绑定模型' }
    }
    const binding = resolveModelBinding(catalog, member.model, member.provider)
    if (!binding) {
      return {
        ...base,
        ok: false,
        level: 'error',
        reason: '绑定的模型不在 DSH 当前目录里，或与记录的提供方不一致：请重选模型',
      }
    }
    return { ...base, ok: true, level: 'ok', binding }
  })
  return { ok: checked.every((member) => member.ok), checkedAt: Date.now(), members: checked }
}
