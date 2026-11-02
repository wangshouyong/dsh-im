import type { ImState } from './types.ts'
import { normalizeToolAllow } from './tools.ts'

export function stateRelPath(): string {
  return 'state.json'
}

export function emptyState(): ImState {
  return {
    personas: [],
    threads: [],
    memories: [],
    wakeExcerpts: {},
    pendingRecall: null,
    lastProactiveAt: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * DM / 三人小窗的标题默认从角色名派生：
 * - DM 没有改名入口，永远按当前角色名重建；
 * - 三人小窗点标题改名后带 `titleCustom: true`，此后角色改名不再覆盖用户起的名字；
 * - 群标题由用户起（建群时填），不参与派生。
 * 旧数据没有该标记 → 继续按角色名自愈（例如角色已叫"敏敏"、会话还叫"测试2"）。
 */
export function repairDerivedThreadTitles(state: ImState): ImState {
  const nameOf = (id: string): string | undefined => state.personas.find((persona) => persona.id === id)?.name
  for (const thread of state.threads) {
    if (!Array.isArray(thread.memberIds)) continue
    if (thread.kind === 'dm' && thread.memberIds.length === 1) {
      const name = nameOf(thread.memberIds[0])
      if (name && thread.title !== name) thread.title = name
      continue
    }
    if (thread.kind === 'triad' && thread.memberIds.length === 2 && !thread.titleCustom) {
      const names = thread.memberIds.map(nameOf)
      if (names.every((name): name is string => Boolean(name))) thread.title = names.join('、')
    }
  }
  return state
}

export function parseState(raw: string): ImState {
  const data = JSON.parse(raw) as Partial<ImState>
  const personas = (Array.isArray(data.personas) ? data.personas : []).filter(
    (persona) => isRecord(persona) && typeof persona.id === 'string' && typeof persona.name === 'string',
  )
  return repairDerivedThreadTitles({
    // 老数据里的工具 id（例如已下线的 shell）在加载时收敛；旧 browser/image 迁移成 grp:。
    personas: personas.map((persona) => {
      const toolAllow = normalizeToolAllow(persona.toolAllow, persona.toolDeny)
      return toolAllow === undefined ? persona : { ...persona, toolAllow, toolDeny: undefined }
    }),
    threads: (Array.isArray(data.threads) ? data.threads : []).filter(
      (thread) => isRecord(thread) && typeof thread.id === 'string' && typeof thread.title === 'string',
    ),
    memories: (Array.isArray(data.memories) ? data.memories : []).filter(
      (memory) => isRecord(memory) && typeof memory.id === 'string',
    ),
    wakeExcerpts: data.wakeExcerpts && typeof data.wakeExcerpts === 'object' ? data.wakeExcerpts : {},
    pendingRecall: data.pendingRecall ?? null,
    lastProactiveAt: data.lastProactiveAt && typeof data.lastProactiveAt === 'object' ? data.lastProactiveAt : {},
  })
}
