import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { activityLabel } from '../core/floor.ts'
import { activeMention } from '../core/ids.ts'
import { FACT_KIND_LABEL } from '../core/facts.ts'
import { CONSENSUS_STATUS_LABEL, type ConsensusState, type ConsensusStatus } from '../core/consensus.ts'
import type { ImService } from '../core/im.ts'
import type { Activity, FactKind, ImState, Persona, Thread } from '../core/types.ts'
import { labelForGrant } from '../core/tools.ts'
import { stripLegacyReasoning } from '../core/text.ts'
import { blockedAdvice } from '../core/blocked.ts'
import { findModel, type ModelCatalog } from '../host/models.ts'
import { Avatar } from './Avatar.tsx'
import {
  attachmentUrl,
  browseFolders,
  createWorkspace,
  loadWorkspaces,
  uploadAttachment,
  onNativeCompat,
  toolGroupsSnapshot,
  type FsListing,
  type WorkspaceOption,
} from './httpStore.ts'
import { draftFromPersona, PersonaEditor, type PersonaDraft } from './PersonaEditor.tsx'
import type { MessageAttachment, TurnTrace } from '../core/types.ts'
import { SessionRow, GroupList, Contacts } from './im/lists.tsx'
import { Chat } from './im/chat.tsx'




export function ImApp(props: {
  im: ImService
  projectRoot: string
  models: ModelCatalog
  persist?: (state: ImState) => Promise<void>
}) {
  const { im, projectRoot, models, persist } = props
  const [, setTick] = useState(0)
  const persistTimer = useRef<number>(0)
  const refresh = () => {
    setTick((n) => n + 1)
    if (!persist) return
    window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      void persist(im.snapshot())
    }, 200)
  }
  // 异步事实抽取完成后重新渲染并触发落盘（抽取不阻塞回复）。
  useEffect(() => {
    im.onAsyncChange = refresh
    return () => {
      if (im.onAsyncChange === refresh) im.onAsyncChange = undefined
    }
  })
  // 主动私聊调度：每 60s 让 ImService 看一次有没有角色该来敲门（判定在 core/proactive.ts）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void im.tickProactive().then((result) => {
        if (result.fired) refresh()
      }).catch(() => undefined)
    }, 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [im])
  const [tab, setTab] = useState<'inbox' | 'groups' | 'contacts'>('inbox')
  // 进入面板默认落在“最近更新”的那条会话（和左侧列表第一行一致）。
  const initialThreadId = useMemo(
    () => [...im.state.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id,
    [im],
  )
  const [activeId, setActiveId] = useState<string | undefined>(initialThreadId)
  // 用户明确要求私聊时，ImService 会开小窗并通过这个回调把界面切过去。
  useEffect(() => {
    im.onDmOpened = (threadId) => {
      setActiveId(threadId)
      refresh()
    }
    return () => { im.onDmOpened = undefined }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [im])
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | undefined>()
  const [showProfile, setShowProfile] = useState(true)
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  const [editor, setEditor] = useState<null | { mode: 'create' } | { mode: 'edit'; persona: Persona }>(null)

  function savePersona(input: PersonaDraft, existing?: Persona) {
    const picked = findModel(models, input.model)
    const duties = input.duties.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
    const payload = {
      name: input.name.trim(),
      avatar: input.avatar || input.name.trim().slice(0, 1),
      avatarUrl: input.avatarUrl,
      personality: input.personality.trim() || '协作者',
      duties: duties.length ? duties : ['协作'],
      model: input.model,
      provider: picked?.provider,
      proactiveDm: input.proactiveDm,
      defaultActivity: input.defaultActivity,
      toolAllow: input.toolAllow,
    }
    const p = existing ? im.updatePersona(existing.id, payload) : im.createPersona({ ...payload, origin: 'mine' })
    setEditor(null)
    openPersona(p)
  }

  const thread = im.state.threads.find((t) => t.id === activeId)
  const sessions = useMemo(
    () => [...im.state.threads]
      .filter((t) => t.title.includes(q) || (t.messages.at(-1)?.text.includes(q) ?? false))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [im.state.threads, q, im.state.threads.map((t) => t.updatedAt).join()],
  )

  // 群共识自动生成：只在**切到某个群**时补一次（有事实但还没共识/共识落后）。
  // 不跟 updatedAt/version 走，否则一轮里消息变化会反复触发 curate（实测重复调用、拖慢面板）。
  useEffect(() => {
    if (!thread || !im.consensusEnabled) return
    im.ensureConsensus(thread.id)
  }, [im, thread?.id])

  async function run(fn: () => Promise<unknown> | unknown) {
    await fn()
    refresh()
  }

  function openPersona(p: Persona) {
    const t = im.openDm(p.id, projectRoot)
    setSelectedPersonaId(p.id)
    setActiveId(t.id)
    setShowProfile(true)
    refresh()
  }

  function openThread(t: Thread) {
    t.unread = 0
    setActiveId(t.id)
    setSelectedPersonaId(t.kind === 'dm' ? t.memberIds[0] : undefined)
    setShowProfile(t.kind === 'dm')
    refresh()
  }

  const profilePersona = selectedPersonaId
    ? im.state.personas.find((p) => p.id === selectedPersonaId)
    : thread?.kind === 'dm'
      ? im.state.personas.find((p) => p.id === thread.memberIds[0])
      : undefined

  return (
    <div className="work">
      <section className="col-inbox">
        <div className="tabs">
          <button className={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>消息</button>
          <button className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>群</button>
          <button
            className={tab === 'contacts' ? 'on' : ''}
            onClick={() => {
              setTab('contacts')
              const first = im.state.personas[0]
              if (first && !selectedPersonaId) openPersona(first)
            }}
          >
            通讯录
          </button>
        </div>
        {tab === 'inbox' ? (
          <div className="rows">
            <input className="search" placeholder="搜索聊天记录" value={q} onChange={(e) => setQ(e.target.value)} />
            {sessions.length === 0 && <div className="empty">还没有聊天。从通讯录找人，或到「群」里进群。</div>}
            {sessions.map((t, i) => (
              <SessionRow key={t.id} thread={t} index={i} active={t.id === activeId} im={im} onOpen={openThread} />
            ))}
          </div>
        ) : tab === 'groups' ? (
          <GroupList
            im={im}
            q={q}
            setQ={setQ}
            activeId={activeId}
            onOpen={(t) => { openThread(t); setTab('groups') }}
            onCreate={() => setTab('contacts')}
          />
        ) : (
          <Contacts
            im={im}
            q={q}
            setQ={setQ}
            projectRoot={projectRoot}
            selectedPersonaId={selectedPersonaId}
            onPersona={openPersona}
            onThread={(t) => { openThread(t); setTab('groups') }}
            onCreate={() => setEditor({ mode: 'create' })}
            models={models}
          />
        )}
      </section>
      {editor && (
        <PersonaEditor
          title={editor.mode === 'create' ? '新建角色' : '编辑角色'}
          catalog={models}
          initial={editor.mode === 'edit' ? draftFromPersona(editor.persona) : undefined}
          toolCatalog={toolGroupsSnapshot()}
          onClose={() => setEditor(null)}
          onSave={(d) => savePersona(d, editor.mode === 'edit' ? editor.persona : undefined)}
        />
      )}
      {thread ? (
        <Chat
          im={im}
          thread={thread}
          draft={draft}
          setDraft={setDraft}
          run={run}
          profilePersona={showProfile ? profilePersona : undefined}
          onShowProfile={(id) => { setSelectedPersonaId(id); setShowProfile(true) }}
          onHideProfile={() => setShowProfile(false)}
          onEditPersona={(p) => setEditor({ mode: 'edit', persona: p })}
          projectRoot={projectRoot}
          refresh={refresh}
          models={models}
        />
      ) : (
        <div className="col-chat"><div className="empty">从通讯录建角色或拉群</div></div>
      )}
    </div>
  )
}
