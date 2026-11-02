import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BoundModelSpeaker,
  commandEnv,
  generateAvatar,
  ImService,
  interpretSpeech,
  isEligible,
  isInsideThreadDir,
  ModelCallError,
  PathFence,
  rememberBaseline,
  sanitizeCatalogSummary,
  speechLeaksOtherThread,
  toolsForAllow,
} from '../src/core/index.ts'
import type { SpeakRequest, SpeakResult, Speaker } from '../src/core/types.ts'
import { listDshModels } from '../src/host/dsh-llm.ts'
import { createImApi } from '../src/host/im-api.ts'
import { catalogModelId, findModel, parseCatalogModelId, previewModelCatalog } from '../src/host/models.ts'
import { loadState, nodeSink, readWorkspaceFile, saveState } from '../src/core/workspace-node.ts'

class ScriptedSpeaker implements Speaker {
  constructor(private readonly replies: SpeakResult[]) {}
  async complete(): Promise<SpeakResult> {
    return this.replies.shift() ?? { text: '默认回复' }
  }
}

function seed(im: ImService, root: string) {
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '挑需求缺口',
    duties: ['需求'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const arch = im.createPersona({
    name: '架构师',
    avatar: '架',
    personality: '挑结构风险',
    duties: ['结构'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const qa = im.createPersona({
    name: '测试',
    avatar: '测',
    personality: '挑可测性',
    duties: ['可测性'],
    proactiveDm: false,
    model: 'mock',
    defaultActivity: 'review',
  })
  const group = im.createGroup('方案评审', [pm.id, arch.id, qa.id], root)
  return { pm, arch, qa, group }
}

describe('mentions', () => {
  it('reads the @ being typed at the caret', async () => {
    const { activeMention } = await import('../src/core/ids.ts')
    expect(activeMention('你好 @实', 5)).toEqual({ start: 3, query: '实' })
    expect(activeMention('@实测顾问 看一下', 6)).toBeNull()
    expect(activeMention('邮件a@b.com', 9)).toBeNull()
  })
})

describe('free speech', () => {
  it('@全体 lets everyone answer without opening a review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker = new ScriptedSpeaker([
      { text: '在' },
      { text: '在' },
      { text: '在' },
    ])
    const im = new ImService(speaker)
    const { group } = seed(im, root)
    await im.sendUser(group.id, '@全体 在吗？不超过3个字')
    expect(group.roundMode).toBe('idle')
    expect(group.messages.filter((m) => m.kind === 'persona').map((m) => m.text)).toEqual(['在', '在', '在'])
    expect(group.messages.some((m) => m.text.includes('互斥焦点'))).toBe(false)
  })

  it('drops the previous round when the user speaks again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker = new ScriptedSpeaker([{ text: '先说完' }, { text: '再说' }])
    const im = new ImService(speaker)
    const { pm, arch, group } = seed(im, root)
    await im.sendUser(group.id, `@${arch.name} 先说`)
    expect(group.members.find((m) => m.personaId === arch.id)?.completedRound).toBe(true)
    await im.sendUser(group.id, `@${pm.name} 再说`)
    expect(group.members.find((m) => m.personaId === arch.id)?.completedRound).toBe(false)
    expect(group.members.find((m) => m.personaId === pm.id)?.completedRound).toBe(true)
    expect(group.speakingPersonaId).toBeUndefined()
  })
})

describe('chat turns', () => {
  it('keeps history behind the latest user question', async () => {
    const { toChatMessages } = await import('../src/core/runtime.ts')
    const turns = toChatMessages({
      persona: { id: 'p', name: '架构师', avatar: '架', personality: '', duties: [], origin: 'mine', model: 'm', proactiveDm: false, defaultActivity: 'review' },
      thread: { id: 't', kind: 'group', title: '群', topic: '', shortSummary: '', memberIds: [], members: [], projectRoot: '.', messages: [], unread: 0, roundMode: 'idle', createdAt: 0, updatedAt: 0 },
      focus: '',
      identity: '',
      userGlobal: [],
      threadMemory: ['旧记忆不该盖住问题'],
      catalog: [],
      visibleMessages: [
        { id: '1', threadId: 't', kind: 'persona', authorName: '架构师', text: '很长的旧讨论', createdAt: 1 },
        { id: '2', threadId: 't', kind: 'user', authorName: '你', text: '在吗？不超过3个字', createdAt: 2 },
        { id: '3', threadId: 't', kind: 'persona', authorName: '产品经理', text: '在', createdAt: 3 },
      ],
    })
    expect(turns.at(-1)).toEqual({ role: 'user', content: '在吗？不超过3个字' })
    expect(turns[0].content).toContain('很长的旧讨论')
    expect(turns.some((t) => t.content.includes('产品经理：在'))).toBe(true)
    expect(turns.some((t) => t.content.includes('旧记忆'))).toBe(false)
  })
})

describe('persona', () => {
  it('requires a bound model and generates an avatar', () => {
    const im = new ImService()
    expect(() => im.createPersona({
      name: '产品经理',
      avatar: '产',
      personality: '挑需求',
      duties: ['需求'],
      model: '',
      proactiveDm: false,
      defaultActivity: 'review',
    })).toThrow(/模型/)
    const p = im.createPersona({
      name: '产品经理',
      avatar: '产',
      personality: '挑需求',
      duties: ['需求'],
      model: 'deepseek-chat',
      proactiveDm: false,
      defaultActivity: 'review',
    })
    expect(p.model).toBe('deepseek-chat')
    expect(p.avatarUrl).toMatch(/^data:image\/svg/)
    expect(generateAvatar('架构师')).toMatch(/svg/)
  })
})

describe('tools', () => {
  it('rejects tools that are not inherited', () => {
    const im = new ImService()
    expect(() => im.createPersona({
      name: '架构师',
      avatar: '架',
      personality: '挑结构',
      duties: ['结构'],
      model: 'deepseek-chat',
      proactiveDm: false,
      defaultActivity: 'review',
      toolAllow: ['read', 'spawn-subagent'],
    })).toThrow(/不能新增工具/)
    const p = im.createPersona({
      name: '架构师',
      avatar: '架',
      personality: '挑结构',
      duties: ['结构'],
      model: 'deepseek-chat',
      proactiveDm: false,
      defaultActivity: 'review',
      toolAllow: ['read'],
    })
    expect(p.toolAllow).toEqual(['read'])
    // 旧 toolDeny 已迁移：加载/创建时收敛成 toolAllow，不再双写。
    expect(p.toolDeny).toBeUndefined()
  })
})

describe('model call', () => {
  it('fails in the open when the transport errors and does not invent a reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker = new BoundModelSpeaker({
      async complete() {
        throw new Error('DSH 模型服务未就绪，不能调用模型')
      },
    })
    const im = new ImService(speaker)
    const { pm, group } = seed(im, root)
    await im.sendUser(group.id, `@${pm.name} 你怎么看`)
    const blob = group.messages.map((m) => m.text).join('\n')
    expect(blob).toMatch(/调用失败/)
    expect(blob).toMatch(/不会用假回复顶上/)
    expect(blob).toMatch(/deepseek-chat|mock/)
    expect(group.messages.some((m) => m.kind === 'persona')).toBe(false)
  })

  it('maps provider::model ids and reads the DSH catalog', async () => {
    expect(parseCatalogModelId('deepseek-account::deepseek-flash')).toEqual({
      route: 'deepseek-account',
      model: 'deepseek-flash',
    })
    expect(parseCatalogModelId('deepseek-flash', 'deepseek-account')).toEqual({
      route: 'deepseek-account',
      model: 'deepseek-flash',
    })
    const catalog = {
      list: () => [{
        id: catalogModelId('deepseek-account', 'deepseek-flash'),
        label: 'DeepSeek-V41-Flash',
        provider: 'DeepSeek 账号',
        route: 'deepseek-account',
        modelId: 'deepseek-flash',
        ready: true,
      }],
    }
    expect(findModel(catalog, 'deepseek-account::deepseek-flash')?.label).toBe('DeepSeek-V41-Flash')
    expect(findModel(previewModelCatalog(), 'deepseek-chat')?.ready).toBe(true)
    const dshListed = await listDshModels({
      listProviders: () => [
        { id: 'deepseek-account', name: 'DeepSeek 账号' },
        { id: 'deepseek-official', name: 'DeepSeek' },
      ],
      listConfigurableProviders: () => [
        { provider: 'deepseek-account', displayName: 'DeepSeek 账号' },
        { provider: 'deepseek-official', displayName: 'DeepSeek' },
      ],
      listModels: async (provider) => provider === 'deepseek-account'
        ? [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
        : [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
    })
    expect(dshListed.map((m) => `${m.provider}:${m.label}`)).toEqual([
      'DeepSeek 账号:DeepSeek-V41-Flash',
      'DeepSeek:DeepSeek-V4-Pro',
    ])
    expect(interpretSpeech(
      '我想起「缓存讨论」要不要调出来？',
      [{ threadId: 't2', title: '缓存讨论', shortSummary: '' }],
      't1',
    ).proposeRecallThreadId).toBeUndefined()
    expect(interpretSpeech(
      '我想起「缓存讨论」要不要调出来？',
      [{ threadId: 't2', title: '缓存讨论', shortSummary: '用了本地缓存。' }],
      't1',
    ).proposeRecallThreadId).toBe('t2')
    await expect(new BoundModelSpeaker({
      async complete() {
        throw new Error('超时')
      },
    }).complete({
      persona: {
        id: 'p',
        name: '产品经理',
        avatar: '产',
        personality: '',
        duties: [],
        origin: 'mine',
        model: 'deepseek-chat',
        proactiveDm: false,
        defaultActivity: 'review',
      },
      thread: {
        id: 't',
        kind: 'dm',
        title: '产品经理',
        topic: '',
        shortSummary: '',
        memberIds: ['p'],
        members: [],
        projectRoot: rootPlaceholder(),
        messages: [],
        unread: 0,
        roundMode: 'idle',
        createdAt: 0,
        updatedAt: 0,
      },
      focus: '',
      visibleMessages: [],
      identity: '',
      userGlobal: [],
      threadMemory: [],
      catalog: [],
    })).rejects.toBeInstanceOf(ModelCallError)
  })
})

function rootPlaceholder() {
  return 'proj'
}

describe('path fence', () => {
  it('blocks existing source, rename escapes, and remaps package caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const source = join(root, 'src', 'app.ts')
    const fence = new PathFence(root, 't1', rememberBaseline([source]))
    expect(fence.decide({ op: 'read', target: source }).allow).toBe(true)
    expect(fence.decide({ op: 'write', target: source }).code).toBe('existing-source')
    expect(fence.decide({ op: 'delete', target: source }).allow).toBe(false)
    expect(fence.decide({ op: 'write', target: source }).code).toBe('existing-source')
    expect(fence.decide({ op: 'write', target: join(root, 'src', 'new.ts') }).code).toBe('outside')
    expect(fence.decide({ op: 'write', target: join(root, '.dsh-im', 't1', 'note.md') }).allow).toBe(true)
    expect(fence.decide({
      op: 'rename',
      from: source,
      target: join(root, '.dsh-im', 't1', 'app.ts'),
    }).code).toBe('rename-escape')
    expect(fence.decide({
      op: 'rename',
      from: join(root, '.dsh-im', 't1', 'a.md'),
      target: join(root, 'src', 'a.md'),
    }).code).toBe('escape')
    const cache = fence.decide({ op: 'write', target: 'C:/Users/a/AppData/Roaming/npm-cache/x' })
    expect(cache.code).toBe('cache-remap')
    expect(cache.env?.npm_config_cache).toContain('.dsh-im')
    expect(cache.env?.npm_config_cache).toContain('.cache')
    const env = commandEnv(root, 't1', { npm_config_cache: 'C:/Users/a/AppData/Roaming/npm-cache' })
    expect(env.npm_config_cache).toContain('.dsh-im/t1/.cache/npm')
    expect(env.npm_config_cache).not.toBe('C:/Users/a/AppData/Roaming/npm-cache')
    let during = ''
    fence.runOnce(() => {
      during = fence.mode
      expect(fence.decide({ op: 'write', target: source }).allow).toBe(false)
      expect(fence.decide({ op: 'write', target: source }).reason).toMatch(/完全权限/)
    })
    expect(during).toBe('danger-full-access')
    expect(fence.mode).toBe('workspace-write')
    expect(() => fence.runOnce(() => { throw new Error('boom') })).toThrow(/boom/)
    expect(fence.mode).toBe('workspace-write')
  })
})

describe('workspace fence', () => {
  it('allows writes only under .dsh-im/thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    expect(isInsideThreadDir(root, 't1', join(root, '.dsh-im', 't1', 'a.md'))).toBe(true)
    expect(isInsideThreadDir(root, 't1', join(root, 'src', 'app.ts'))).toBe(false)
    expect(isInsideThreadDir(root, 't1', join(root, '.dsh-im', 't1', '..', 't2', 'x'))).toBe(false)
  })
})

describe('persist', () => {
  it('saves and loads IM state under .dsh-im', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const im = new ImService()
    const { pm, group } = seed(im, root)
    await saveState(root, im.snapshot())
    const loaded = await loadState(root)
    expect(loaded?.personas.map((p) => p.name)).toContain(pm.name)
    expect(loaded?.threads.some((t) => t.id === group.id)).toBe(true)
  })

  it('reads workspace files inside the project and refuses escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const dest = join(root, 'README.md')
    await nodeSink.writeThreadFile(root, 't1', 'note.md', 'inside')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(dest, '# hello workspace', 'utf8')
    await expect(readWorkspaceFile(root, 't1', 'README.md')).resolves.toMatch(/hello workspace/)
    await expect(readWorkspaceFile(root, 't1', '../secret')).rejects.toThrow(/只能读关联项目/)
  })
})

describe('catalog sanitize', () => {
  it('drops secret-like sentences', () => {
    expect(sanitizeCatalogSummary('谈了缓存。薪资是保密的。还谈了登录。')).not.toMatch(/薪资/)
  })
})

describe('eligibility', () => {
  it('muted member is eligible only when mentioned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const im = new ImService()
    const { pm, group } = seed(im, root)
    im.setActivity(group.id, pm.id, 'muted')
    const member = group.members[0]
    expect(isEligible(group, member, [])).toBe(false)
    expect(isEligible(group, member, [pm.id])).toBe(true)
  })
})

describe('review floor', () => {
  it('calls members serially then writes summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker = new ScriptedSpeaker([
      { text: '需求缺口：缺支付失败态。' },
      { text: '结构风险：重试没有幂等。' },
      { text: '可测性：没有失败注入。' },
    ])
    const im = new ImService(speaker, undefined, undefined, nodeSink)
    const { group } = seed(im, root)
    await im.sendUser(group.id, '开始评审登录方案', { startReview: true })
    const texts = group.messages.map((m) => m.text).join('\n')
    expect(texts).toMatch(/需求缺口/)
    expect(texts).toMatch(/结构风险/)
    expect(texts).toMatch(/可测性/)
    expect(texts).toMatch(/本轮汇总/)
    const dest = join(root, '.dsh-im', group.id, '本轮汇总.md')
    const file = await readFile(dest, 'utf8')
    expect(file).toMatch(/方案评审/)
  })

  it('PASS only removes that member', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker: Speaker = {
      async complete(req) {
        if (req.persona.duties.includes('结构')) return { text: 'PASS：没增量', pass: true }
        if (req.persona.duties.includes('可测性')) return { text: '测试观点' }
        return { text: '产品观点' }
      },
    }
    const im = new ImService(speaker)
    const { arch, group } = seed(im, root)
    await im.sendUser(group.id, '开始评审', { startReview: true })
    expect(group.members.find((m) => m.personaId === arch.id)?.passedRound).toBe(true)
    expect(group.messages.some((m) => m.text.includes('测试观点'))).toBe(true)
  })
})

describe('memory isolation', () => {
  it('does not inject group B body into group A without consent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const im = new ImService()
    const { pm, arch, group } = seed(im, root)
    const secret = im.createGroup('薪资评审', [pm.id], root)
    im.addMemory({
      id: 'm1',
      scope: 'thread',
      threadId: secret.id,
      text: '年薪数字是保密的',
      createdAt: Date.now(),
    })
    secret.shortSummary = '谈了缓存。'
    secret.topic = '缓存'
    const req: SpeakRequest[] = []
    const spy: Speaker = {
      async complete(r) {
        req.push(r)
        return { text: '群A回复' }
      },
    }
    const watching = new ImService(spy, undefined, im.snapshot())
    const g = watching.requireThread(group.id)
    await watching.sendUser(g.id, `@${pm.name} 看登录`)
    const last = req.find((r) => r.persona.id === pm.id) ?? req.at(-1)
    expect(last?.threadMemory.join(' ')).not.toMatch(/年薪/)
    expect(last?.catalog.some((c) => c.threadId === secret.id)).toBe(true)
    expect(last?.catalog.find((c) => c.threadId === secret.id)?.shortSummary).not.toMatch(/年薪|薪资/)
    expect(speechLeaksOtherThread('年薪数字是保密的', ['年薪数字是保密的'], last?.catalog.map((c) => c.shortSummary) ?? [])).toBe(true)
  })

  it('drops another thread body until the user agrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const secretText = '年薪数字是保密的不要外传'
    const speaker = new ScriptedSpeaker([{ text: `群A不该看到：${secretText}` }])
    const im = new ImService(speaker)
    const { pm, group } = seed(im, root)
    const secret = im.createGroup('薪资评审', [pm.id], root)
    secret.messages.push({
      id: 'sec1',
      threadId: secret.id,
      kind: 'user',
      authorName: '你',
      text: secretText,
      createdAt: Date.now(),
    })
    await im.sendUser(group.id, `@${pm.name} 看登录`)
    const blob = group.messages.map((m) => m.text).join('\n')
    expect(blob).not.toMatch(/年薪数字是保密的/)
    expect(blob).toMatch(/未同意/)
    await im.confirmRecall(false)
    expect(group.messages.some((m) => m.text.includes(secretText))).toBe(false)
  })

  it('recall waits for user confirm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker = new ScriptedSpeaker([
      { text: '想调另一场', proposeRecallThreadId: 'later' },
    ])
    const im = new ImService(speaker)
    const { pm, group } = seed(im, root)
    const other = im.createGroup('缓存讨论', [pm.id], root)
    other.shortSummary = '用了本地缓存。'
    speaker['replies'][0] = { text: '想调', proposeRecallThreadId: other.id }
    await im.sendUser(group.id, `@${pm.name} 登录`)
    expect(im.state.pendingRecall?.targetThreadId).toBe(other.id)
    await im.confirmRecall(false)
    expect(group.messages.at(-1)?.text).toMatch(/拒绝/)
    expect(group.messages.some((m) => m.text.includes('用了本地缓存'))).toBe(false)
  })
})

describe('proactive dm', () => {
  it('opens dm with badge when enabled and text is sensitive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker = new ScriptedSpeaker([{ text: '这一点不宜公开，涉及人事。' }])
    const im = new ImService(speaker)
    const { pm, group } = seed(im, root)
    im.updatePersona(pm.id, { proactiveDm: true })
    await im.sendUser(group.id, `@${pm.name} 你怎么看`)
    const dm = im.state.threads.find((t) => t.kind === 'dm' && t.memberIds[0] === pm.id)
    expect(dm?.unread).toBeGreaterThan(0)
    expect(dm?.messages.at(-1)?.text).toMatch(/不宜/)
  })

  it('does not fire when switch is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const speaker = new ScriptedSpeaker([{ text: '这一点不宜公开。' }])
    const im = new ImService(speaker)
    const { pm, group } = seed(im, root)
    await im.sendUser(group.id, `@${pm.name} 你怎么看`)
    expect(im.state.threads.filter((t) => t.kind === 'dm')).toHaveLength(0)
  })
})

describe('pause round', () => {
  it('stops the floor without writing a summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const im = new ImService()
    const { group } = seed(im, root)
    await im.sendUser(group.id, '开始评审', { startReview: true })
    im.pauseRound(group.id)
    expect(group.roundMode).toBe('idle')
    expect(group.speakingPersonaId).toBeUndefined()
    expect(group.messages.at(-1)?.text).toMatch(/全员暂停/)
  })
})

describe('mute window', () => {
  it('muted speaker only sees a window and stores wake excerpt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshim-'))
    const seen: SpeakRequest[] = []
    const spy: Speaker = {
      async complete(r) {
        seen.push(r)
        return { text: '窗口内回复' }
      },
    }
    const im = new ImService(spy)
    const { pm, arch, group } = seed(im, root)
    im.setActivity(group.id, arch.id, 'muted')
    for (let i = 0; i < 10; i++) {
      group.messages.push({
        id: `old${i}`,
        threadId: group.id,
        kind: 'user',
        authorName: '你',
        text: `旧消息${i}`,
        createdAt: Date.now(),
      })
    }
    await im.sendUser(group.id, `@${arch.name} 只要最近`)
    const vis = seen.at(-1)?.visibleMessages.map((m) => m.text).join(' ') ?? ''
    expect(vis).toMatch(/只要最近/)
    expect(vis).not.toMatch(/旧消息0/)
    expect(Object.keys(im.state.wakeExcerpts).length).toBeGreaterThan(0)
  })
})

describe('DSH host model catalog', () => {
  it('lists and calls through ctx.llm, never a local gateway', async () => {
    const streamed: unknown[] = []
    const api = createImApi({
      projectRoot: () => '.',
      llm: () => ({
        listProviders() {
          return [{ id: 'deepseek-account', name: 'DeepSeek 账号' }]
        },
        async listModels() {
          return [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }]
        },
        async *stream(options) {
          streamed.push(options)
          yield { type: 'text-delta', text: '来自宿主模型' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }),
    })
    const models = await api.models()
    expect(models).toEqual([expect.objectContaining({
      id: 'deepseek-account::deepseek-flash',
      label: 'DeepSeek-V41-Flash',
      provider: 'DeepSeek 账号',
      ready: true,
    })])
    const { text } = await api.complete({
      model: 'deepseek-account::deepseek-flash',
      system: '你是产品经理',
      messages: [{ role: 'user', content: '你好' }],
    })
    expect(text).toBe('来自宿主模型')
    expect(streamed[0]).toMatchObject({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    })
  })

  it('fails loudly instead of inventing a model path when the host has no llm', async () => {
    const api = createImApi({ projectRoot: () => '.', llm: () => undefined })
    await expect(api.models()).rejects.toMatchObject({ status: 503 })
    await expect(api.complete({ model: 'anything', user: 'hi' })).rejects.toMatchObject({ status: 503 })
  })

  it('describes allowed tools with the host ToolSchema shape', () => {
    const readTools = toolsForAllow(['read'])
    expect(readTools.map((t) => t.name)).toEqual(['list_dir', 'read_file'])
    for (const tool of readTools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.parameters).toMatchObject({ type: 'object' })
    }
    expect(toolsForAllow(['search']).map((t) => t.name)).toEqual(['list_dir', 'search_files'])
    expect(toolsForAllow(undefined)).toEqual([])
  })

  it('keeps the DSH group order and lists unreadable providers as disabled', async () => {
    const listed = await listDshModels({
      listProviders: () => [
        { id: 'magpie', name: 'Magpie' },
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'deepseek-account', name: 'DeepSeek 账号' },
        { id: 'broken', name: 'Broken' },
      ],
      async listModels(provider) {
        if (provider === 'broken') throw new Error('no credentials')
        return [{ id: `model-${provider}`, name: `Model ${provider}` }]
      },
    })
    expect(listed.map((m) => m.route)).toEqual(['deepseek-account', 'deepseek-official', 'magpie', 'broken'])
    expect(listed.filter((m) => m.ready)).toHaveLength(3)
    expect(listed.find((m) => m.route === 'broken')).toMatchObject({
      provider: 'Broken',
      ready: false,
      note: 'no credentials',
    })
  })
})
