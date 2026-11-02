import { describe, expect, it } from 'vitest'
import { preflightMembers } from '../src/host/preflight.ts'
import type { LlmService } from '../src/host/dsh-llm.ts'

function llm(): LlmService {
  return {
    listProviders: () => [
      { id: 'deepseek-account', name: 'DeepSeek 账号' },
      { id: 'deepseek-official', name: 'DeepSeek' },
    ],
    async listModels(provider) {
      return [{ id: 'deepseek-flash', name: 'V41-Flash' }, { id: provider + '-only', name: 'only' }]
    },
  }
}

describe('开始前的配置级体检', () => {
  it('全部可用时通过，并给出解析后的路由', async () => {
    const result = await preflightMembers(llm(), [
      { personaId: 'p1', name: '淇淇', post: '产品经理', model: 'deepseek-flash', provider: 'DeepSeek' },
    ])
    expect(result.ok).toBe(true)
    expect(result.members[0]).toMatchObject({ ok: true, level: 'ok', binding: { route: 'deepseek-official', model: 'deepseek-flash' } })
  })

  it('模型解析不了的角色标为不可用，并给出原因', async () => {
    const result = await preflightMembers(llm(), [
      { personaId: 'p1', name: '淇淇', model: 'deepseek-flash', provider: '已删除的提供方' },
      { personaId: 'p2', name: '测试2', model: '' },
    ])
    expect(result.ok).toBe(false)
    expect(result.members.map((m) => m.level)).toEqual(['error', 'error'])
    expect(result.members[0].reason).toContain('重选')
  })

  it('没有宿主模型服务时明确报 503', async () => {
    await expect(preflightMembers(undefined, [])).rejects.toMatchObject({ status: 503 })
  })
})
