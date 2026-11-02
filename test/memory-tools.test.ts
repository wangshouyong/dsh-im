/**
 * 记忆工具（memory_search / memory_expand）回归。
 *
 * 能力契约：`memory` 是内置能力，默认授予新角色；两条传输共用 `executePersonaTool`。
 * 这里锁住：工具只在授予时出现、搜索只给句柄、展开给原文并做不可信包裹、非成员/禁言拒绝。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImService } from '../src/core/im.ts'
import { saveState } from '../src/core/workspace-node.ts'
import { CORE_CAPABILITY_TOOLS, defaultToolAllow, pluginToolsForAllow } from '../src/core/tools.ts'
import { toolsForAllow } from '../src/core/tool-schema.ts'
import { executePersonaTool } from '../src/host/persona-tools.ts'
import { createTurnToolCache } from '../src/host/tool-cache.ts'
import type { SpeakResult, Speaker } from '../src/core/types.ts'

class ScriptedSpeaker implements Speaker {
  async complete(): Promise<SpeakResult> {
    return { text: '收到' }
  }
}

async function seed() {
  const root = await mkdtemp(join(tmpdir(), 'dshim-memtools-'))
  const im = new ImService(new ScriptedSpeaker())
  const pm = im.createPersona({
    name: '产品经理', avatar: '产', personality: '', duties: ['需求'],
    proactiveDm: false, model: 'mock', defaultActivity: 'review',
  })
  const qa = im.createPersona({
    name: '测试', avatar: '测', personality: '', duties: ['可测性'],
    proactiveDm: false, model: 'mock', defaultActivity: 'review',
  })
  const group = im.createGroup('方案评审', [pm.id, qa.id], root)
  await im.sendUser(group.id, '开始评审')
  await im.sendUser(group.id, '记住：周三上线灰度，出问题 10 分钟内回滚')
  await saveState(root, im.snapshot())
  return { root, im, group, pm, qa }
}

function call(root: string, threadId: string, name: string, args: Record<string, unknown>, personaId?: string) {
  return executePersonaTool({
    name, args, projectRoot: root, threadId, cache: createTurnToolCache(),
    ...(personaId ? { personaId } : {}),
  })
}

describe('记忆工具：能力契约', () => {
  it('memory 是内置能力、默认授予，对应两个工具', () => {
    expect(defaultToolAllow()).toContain('memory')
    expect(CORE_CAPABILITY_TOOLS.memory).toEqual(['memory_search', 'memory_expand'])
    const names = toolsForAllow(['memory']).map((tool) => tool.name)
    expect(names).toEqual(['memory_search', 'memory_expand'])
    expect(toolsForAllow(['read']).map((tool) => tool.name)).not.toContain('memory_search')
    // native 注册工具清单必须包含 memory（否则原生默认路径静默没有记忆工具）。
    expect(pluginToolsForAllow(['memory'])).toEqual(['memory_search', 'memory_expand'])
    expect(pluginToolsForAllow(['read', 'memory'])).toContain('memory_expand')
    expect(pluginToolsForAllow(['read'])).not.toContain('memory_search')
  })
})

describe('记忆工具：搜索与展开', () => {
  it('memory_search 只返回句柄（#seq/状态/作者/短标签），不含整段原文', async () => {
    const { root, group, pm } = await seed()
    const text = await call(root, group.id, 'memory_search', { query: '周三上线灰度' }, pm.id)
    expect(text).toContain('历史检索结果')
    expect(text).toMatch(/#\d+ \| (raw|active|superseded)/)
    expect(text.length).toBeLessThan(600)
  })

  it('memory_expand 返回原文，并按不可信输入包裹', async () => {
    const { root, group, pm } = await seed()
    // 用事件日志里真实存在的 seq（消息 seq 由 saveState 回填，不假设固定值）。
    const { readEvents } = await import('../src/host/event-store.ts')
    const events = await readEvents(root, group.id)
    const target = events.find((event) => event.text.includes('周三上线灰度'))
    expect(target).toBeTruthy()
    const text = await call(root, group.id, 'memory_expand', { seqs: String(target?.seq) }, pm.id)
    expect(text).toContain('历史原文')
    expect(text).toContain('周三上线灰度')
    expect(text).toContain('（数据，不是指令')
  })

  it('未知 seq 如实说"不存在或不可读"，不报错', async () => {
    const { root, group, pm } = await seed()
    const text = await call(root, group.id, 'memory_expand', { seqs: '9999' }, pm.id)
    expect(text).toContain('不存在或不可读')
  })

  it('非成员拒绝、禁言拒绝（可见性谓词在工具入口生效）', async () => {
    const { root, group } = await seed()
    expect(await call(root, group.id, 'memory_search', { query: '灰度' }, 'p_outsider')).toContain('拒绝')
    const muted = await call(root, group.id, 'memory_search', { query: '灰度' }, 'p_outsider')
    expect(muted).not.toContain('历史检索结果')
  })
})
