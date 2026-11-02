import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ImApp } from '../client/ImApp.tsx'
import { scopeCss } from '../client/scoped-css.ts'
import { availablePanelHeight } from '../client/panel-size.ts'
import { httpModelTransport, httpNativeTransport, httpSink, loadNativeStatus, loadRemoteModels, loadRemoteState, loadStateRoots, loadToolGroups, nativePreference, saveRemoteState, setNativePreference, createWorkspace, formatStateRoot } from '../client/httpStore.ts'
import type { StateRootInfo } from '../host/state-roots.ts'
import { ImService } from '../core/im.ts'
import { BoundModelSpeaker, defaultChair } from '../core/runtime.ts'
import type { ModelCatalog } from '../host/models.ts'
import { findModel } from '../host/models.ts'
import { logInfo, logWarn } from '../core/log.ts'
import css from '../dev/style.css?raw'

export const inject = ['slots', 'sessions', 'workspaces']

const STYLE_ID = 'dsh-im-css'
const PANEL_ID = 'dsh-im'

/** 检索档位覆盖：控制用 `localStorage.setItem('dsh-im:retrieval','on')` 后刷新即可（off/shadow/on）。 */
function applyRetrievalOverride(im: ImService) {
  try {
    const mode = localStorage.getItem('dsh-im:retrieval')
    if (mode === 'off' || mode === 'shadow' || mode === 'on') im.retrievalMode = mode
  } catch {
    // 非浏览器环境/隐私模式：保持默认 shadow
  }
}

/** 引用句柄协议档位覆盖：`localStorage.setItem('dsh-im:memory','on')` 后刷新（默认 shadow 只写回执）。 */
function applyMemoryContextOverride(im: ImService) {
  try {
    const mode = localStorage.getItem('dsh-im:memory')
    if (mode === 'off' || mode === 'shadow' || mode === 'on') im.memoryContextMode = mode
  } catch {
    // 非浏览器环境/隐私模式：保持默认 shadow
  }
}

/** 群共识常开（不需要用户操作）。顺手清掉旧版本留在这个 key 里的开关值，避免历史 'off' 继续生效。 */
function applyConsensusOverride(im: ImService) {
  im.consensusEnabled = true
  try {
    localStorage.removeItem('dsh-im:consensus')
  } catch {
    // 非浏览器环境/隐私模式：忽略
  }
}

function installStyles() {
  const existing = document.getElementById(STYLE_ID)
  if (existing) {
    // 热更新/面板重载时旧 style 可能还在：必须覆盖，不能因为 id 存在就跳过。
    existing.textContent = scopeCss(css)
    return () => existing.remove()
  }
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = scopeCss(css)
  document.head.appendChild(el)
  return () => el.remove()
}

const ROOT_OVERRIDE_KEY = 'dsh-im:root'

function savedRootOverride(): string {
  try {
    return localStorage.getItem(ROOT_OVERRIDE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 工作区根不应落在 .dsh-im 内部（否则角色记录会“消失”在别的根里）。 */
function normalizeRoot(root: string): string {
  const cleaned = root.trim()
  const nested = cleaned.match(/^(.*?)[\\/]\.dsh-im(?:[\\/].*)?$/i)
  return nested?.[1] ? nested[1].replace(/[\\/]+$/, '') : cleaned
}

/** 数据根必须是绝对路径；相对路径（'.'）交给宿主默认工作区会变成“看起来对、实际另一个根”。 */
function isAbsoluteRoot(root: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('/')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function currentProjectRoot(ctx: DshClientCtx): string {
  const override = savedRootOverride()
  if (override) return normalizeRoot(override)
  try {
    const workspace = ctx.workspaces?.list?.getSnapshot?.()
    const current = ctx.sessions?.list?.getSnapshot?.()?.current
    const items = workspace?.items ?? []
    const selected = current
      ? items.find((item) => item.sessionIds?.includes(current))
      : items.find((item) => item.workspaceId === workspace?.recentWorkspaceId)
    return normalizeRoot(selected?.path || selected?.cwd || selected?.title || '.')
  } catch {
    return '.'
  }
}

type DshClientCtx = {
  get?: (name: string) => unknown
  layout?: { selectPanel?: (id: string | null) => void; panelInfo?: { getSnapshot?: () => { activePanelId?: string } } }
  slots: {
    inject: (name: string, fn: () => (() => void) | void) => void
    register: (meta: Record<string, unknown>, component: unknown) => () => void
  }
  effect: (fn: () => (() => void) | void, label?: string) => void
  sessions?: { list?: { getSnapshot?: () => { current?: string } } }
  workspaces?: {
    list?: {
      getSnapshot?: () => {
        recentWorkspaceId?: string
        items?: { workspaceId?: string; sessionIds?: string[]; title?: string; path?: string; cwd?: string }[]
      }
    }
  }
}

function TeamIcon(props: { size?: number }) {
  const size = Number.isFinite(props.size) ? props.size : 16
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="5" cy="6" r="2" />
      <circle cx="11" cy="6" r="2" />
      <path d="M2 13c0-1.7 1.3-3 3-3h0c1.7 0 3 1.3 3 3" />
      <path d="M8 13c0-1.7 1.3-3 3-3h0c1.7 0 3 1.3 3 3" />
    </svg>
  )
}

function DshImPanel(props: { projectRoot?: string; closePanel?: () => void }) {
  const [projectRoot, setProjectRoot] = useState(() => normalizeRoot(savedRootOverride() || props.projectRoot || '.'))
  const [workspaces, setWorkspaces] = useState<{ title?: string; path?: string }[]>([])
  const [ready, setReady] = useState<{ im: ImService; models: ModelCatalog } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** 数据根读不出来（400/坏文件/网络）：绝不静默渲染成「空团队」。 */
  const [loadFailure, setLoadFailure] = useState<{ root: string; message: string } | null>(null)
  /** 各数据根体检结果（只读）：失败页和下拉都用它。 */
  const [rootInfos, setRootInfos] = useState<StateRootInfo[]>([])
  /** 保存失败：必须显式告诉用户「这轮没存进磁盘」，否则刷新就真没了。 */
  const [persistError, setPersistError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<'register' | 'retry' | 'save' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [nativeOn, setNativeOn] = useState(nativePreference)
  const [nativeAvailable, setNativeAvailable] = useState(false)
  const [nativeReason, setNativeReason] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  // 宿主给插件 slot 的高度可能是 auto：只写 height:100% 在 DSH 里解析不出来，
  // 结果右栏/任务板高度跟着内容涨，内部 overflow 永远不触发（滚动失效 + 顶部空白）。
  // 这里按“窗口底部 - 插件顶部”算出确定像素高度，宿主怎么排版都能滚。
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const apply = () => {
      const rect = el.getBoundingClientRect()
      const height = availablePanelHeight(rect.top, window.innerHeight)
      if (height > 0) el.style.height = `${height}px`
    }
    apply()
    // DSH 面板打开时有动画/过渡：挂载瞬间量到的 top 可能是动画中间态，
    // 只量一次会把根节点写成偏小的高度（表现为下半截空白、内部不滚）。
    // 这里在动画期间多次重算，并监听过渡/动画结束再校准。
    const timers = [50, 120, 250, 500, 900, 1600, 2600].map((ms) => window.setTimeout(apply, ms))
    const onMotion = () => apply()
    document.addEventListener('transitionend', onMotion, true)
    document.addEventListener('animationend', onMotion, true)
    window.visualViewport?.addEventListener('resize', apply)
    window.addEventListener('resize', apply)
    const observer = new ResizeObserver(apply)
    observer.observe(document.documentElement)
    if (el.parentElement) observer.observe(el.parentElement)
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      document.removeEventListener('transitionend', onMotion, true)
      document.removeEventListener('animationend', onMotion, true)
      window.visualViewport?.removeEventListener('resize', apply)
      window.removeEventListener('resize', apply)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const dispose = installStyles()
    let cancelled = false
    if (!cancelled) {
      setLoadFailure(null)
      setPersistError(null)
      setActionError(null)
    }
    void (async () => {
      try {
        const [ws, listedWorkspaces, infos] = await Promise.all([
          fetch('/api/im/workspace').then((r) => r.json()).catch(() => null) as Promise<{ path?: string } | null>,
          fetch('/api/im/workspaces').then((r) => r.json()).catch(() => null) as Promise<
            { title?: string; path?: string }[] | { value?: { title?: string; path?: string }[] } | null
          >,
          loadStateRoots(),
        ])
        if (!cancelled) {
          const raw = Array.isArray(listedWorkspaces) ? listedWorkspaces : listedWorkspaces?.value ?? []
          // 过滤落在 .dsh-im 内部的坏工作区，避免再次把面板根指进内部目录。
          setWorkspaces(raw.filter((item) => !item.path || !/[\\/]\.dsh-im([\\/]|$)/i.test(item.path)))
          setRootInfos(infos)
        }
        const resolved = normalizeRoot(savedRootOverride() || props.projectRoot || ws?.path || '.')
        // 相对根（'.'）→ 用宿主默认工作区绝对路径，避免“面板显示一个根、实际读写另一个根”。
        const root = isAbsoluteRoot(resolved) ? resolved : normalizeRoot(ws?.path || resolved)
        if (!cancelled) setProjectRoot(root)
        let listed: Awaited<ReturnType<typeof loadRemoteModels>> = []
        try {
          listed = await loadRemoteModels()
        } catch (err) {
          if (!cancelled) {
            setError('模型目录加载失败：' + errorMessage(err))
          }
          return
        }
        let saved: Awaited<ReturnType<typeof loadRemoteState>> = null
        try {
          saved = await loadRemoteState(root)
        } catch (err) {
          // 关键修复：以前这里是 .catch(() => null)，400 会变成「空团队」。
          if (!cancelled) setLoadFailure({ root, message: errorMessage(err) })
          return
        }
        const catalog: ModelCatalog = { list: () => listed }
        const native = await loadNativeStatus().catch(() => ({ available: false, enabled: false, reason: '原生会话状态读不到' }))
        if (!cancelled) {
          setNativeAvailable(native.available)
          setNativeOn(native.enabled)
          setNativeReason(native.reason ?? '')
        }
        if (native.enabled) logInfo('[dsh-im] 原生会话已开')
        // 群级预算需要「每个成员自己的模型窗口」：经 imRef 读面板里的角色表。
        const imRef: { current?: ImService } = {}
        const budgetTier = localStorage.getItem('dsh-im:budget') ?? 'standard'
        const contextWindowForPersona = (personaId: string): number | undefined => {
          const persona = imRef.current?.snapshot().personas.find((item) => item.id === personaId)
          return persona ? findModel(catalog, persona.model)?.contextWindow : undefined
        }
        const modelForPersona = (personaId: string): string | undefined => (
          imRef.current?.snapshot().personas.find((item) => item.id === personaId)?.model
        )
        const speaker = new BoundModelSpeaker(native.enabled ? httpNativeTransport() : httpModelTransport(), {
          contextWindowFor: (model) => findModel(catalog, model)?.contextWindow,
          contextWindowForPersona,
          modelForPersona,
          budgetTier,
        })
        const im = new ImService(speaker, defaultChair(), saved ?? undefined, httpSink())
        imRef.current = im
        // A-2：摘要预算贯通——L1 摘要生成器与冷区章节目录用与 speaker 同一份群级预算输入。
        im.groupBudgetPolicy = { tier: budgetTier, contextWindowForPersona, modelForPersona }
        applyRetrievalOverride(im)
        applyMemoryContextOverride(im)
        applyConsensusOverride(im)
        if (!cancelled) {
          setError(null)
          setLoadFailure(null)
          setPersistError(null)
          setReady({ im, models: catalog })
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    })()
    return () => {
      cancelled = true
      dispose()
    }
  }, [reloadKey])

  // 还有没写进磁盘的修改时，关窗口/刷新要拦一下（保存失败不能静默丢）。
  useEffect(() => {
    if (!persistError) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [persistError])

  function switchRoot(path: string): void {
    const target = normalizeRoot(path)
    if (!target) return
    try {
      localStorage.setItem(ROOT_OVERRIDE_KEY, target)
    } catch {
      // 忽略隐私模式下的 localStorage 失败。
    }
    setReady(null)
    setReloadKey((key) => key + 1)
  }

  const retryLoad = () => {
    setReady(null)
    setReloadKey((key) => key + 1)
  }

  /** 把当前数据根注册进 DSH 工作区表：否则宿主会一直 400（未注册的根）。 */
  const registerCurrentRoot = async () => {
    if (actionBusy) return
    setActionBusy('register')
    setActionError(null)
    try {
      await createWorkspace(projectRoot)
      retryLoad()
    } catch (err) {
      setActionError('注册失败：' + errorMessage(err))
    } finally {
      setActionBusy(null)
    }
  }

  /** 保存失败后手动重存（不静默丢）。 */
  const retrySave = async () => {
    if (!ready || actionBusy) return
    setActionBusy('save')
    try {
      await saveRemoteState(ready.im.snapshot(), projectRoot)
      setPersistError(null)
    } catch (err) {
      setPersistError(errorMessage(err))
    } finally {
      setActionBusy(null)
    }
  }

  /** 保存包装：失败必须冒到界面，不许 void 掉。 */
  const persistState = async (state: Parameters<typeof saveRemoteState>[0]): Promise<void> => {
    try {
      await saveRemoteState(state, projectRoot)
      setPersistError(null)
    } catch (err) {
      setPersistError(errorMessage(err))
      throw err
    }
  }

  const rootInfosByPath = new Map(rootInfos.map((info) => [normalizeRoot(info.path).toLowerCase(), info]))
  const rootLabel = (path: string): string => {
    const info = rootInfosByPath.get(normalizeRoot(path).toLowerCase())
    const base = info ? formatStateRoot(info) : path
    return loadFailure?.root === path ? `${base}（当前读不到）` : base
  }
  const otherRoots = rootInfos.filter((info) => normalizeRoot(info.path) !== projectRoot && (info.hasState || info.registered))

  const rootbar = (
    <div className="dsh-im-rootbar">
      <span className="rootbar-label">IM 数据根</span>
      <select
        className="rootbar-select"
        value={projectRoot}
        onChange={(event) => switchRoot(event.target.value)}
        title="切换后加载该工作区自己的角色和聊天记录"
      >
        <option value={projectRoot}>{rootLabel(projectRoot)}</option>
        {workspaces
          .filter((item) => item.path && item.path !== projectRoot)
          .map((item) => (
            <option key={item.path} value={item.path}>{rootLabel(item.path!)}</option>
          ))}
        {otherRoots
          .filter((info) => !workspaces.some((item) => item.path === info.path))
          .map((info) => (
            <option key={info.path} value={info.path}>{formatStateRoot(info)}</option>
          ))}
      </select>
      <button
        type="button"
        className="rootbar-reset"
        onClick={() => {
          try { localStorage.removeItem(ROOT_OVERRIDE_KEY) } catch { /* ignore */ }
          setReady(null)
          setReloadKey((key) => key + 1)
        }}
      >
        跟随当前会话
      </button>
      <label
        className="rootbar-native"
        title={nativeAvailable
          ? '这次讨论的工作底稿。默认开；宿主不支持或能力缺失时本轮自动走兼容路径。'
          : (nativeReason || '这个宿主没有原生会话')}
      >
        <input
          type="checkbox"
          checked={nativeOn}
          disabled={!nativeAvailable}
          onChange={(event) => {
            const on = event.target.checked
            setNativePreference(on)
            setNativeOn(on)
            setReady(null)
            setReloadKey((key) => key + 1)
          }}
        />
        原生会话
      </label>
    </div>
  )

  if (error) return <div className="dsh-im-root" style={{ padding: 16 }}>{rootbar}{error}</div>

  if (loadFailure) {
    const candidates = rootInfos.filter((info) => info.hasState && normalizeRoot(info.path) !== loadFailure.root)
    return (
      <div className="dsh-im-root" style={{ padding: 16, overflow: 'auto' }}>
        {rootbar}
        <h2 style={{ margin: '12px 0 6px', fontSize: 15 }}>数据没加载出来（不是数据被删了）</h2>
        <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.6 }}>
          数据根 <code>{loadFailure.root}</code> 读取失败：{loadFailure.message}
        </p>
        <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.6, opacity: 0.8 }}>
          常见原因：这个目录不在 DSH 工作区注册表里（宿主会拒绝读写），或者文件坏了。
          为避免再写坏数据，这里先不进入面板。下面这些数据根里还有数据，可以直接切过去。
        </p>
        {actionError ? <p style={{ margin: '0 0 10px', fontSize: 13, color: '#c0392b' }}>{actionError}</p> : null}
        {candidates.length ? (
          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
            {candidates.map((info) => (
              <li key={info.path}>
                <code>{info.path}</code> — 角色 {info.personas}、会话 {info.threads}
                {info.updatedAt ? `，最后更新 ${new Date(info.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}
                {info.registered ? '' : '（未注册）'}
                <button type="button" style={{ marginLeft: 8 }} onClick={() => switchRoot(info.path)}>切到这个根</button>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: '0 0 12px', fontSize: 13, opacity: 0.8 }}>
            没发现别的有数据的数据根。你的数据可能还在 <code>{loadFailure.root}\.dsh-im\state.json</code>，先别删它。
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={retryLoad} disabled={actionBusy !== null}>重试</button>
          <button type="button" onClick={() => void registerCurrentRoot()} disabled={actionBusy !== null}>
            {actionBusy === 'register' ? '注册中…' : '把当前目录注册为 DSH 工作区并重试'}
          </button>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12, opacity: 0.6 }}>
          提示：数据按「DSH 工作区」分开存放（&lt;工作区&gt;/.dsh-im/state.json）。换工作区/换会话后先看一眼这个下拉里的「数据根」。
        </p>
      </div>
    )
  }

  if (!ready) return <div className="dsh-im-root" style={{ padding: 16 }}>{rootbar}加载专家团队…</div>

  return (
    <div ref={rootRef} className="dsh-im-root" style={{ height: '100%', width: '100%', flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {rootbar}
      {persistError ? (
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#fdecea', color: '#a12b1f', fontSize: 12, borderBottom: '1px solid #f5c6c0' }}>
          <span>这轮修改没存进磁盘：{persistError}</span>
          <button type="button" onClick={() => void retrySave()} disabled={actionBusy === 'save'}>
            {actionBusy === 'save' ? '保存中…' : '重试保存'}
          </button>
        </div>
      ) : null}
      <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, width: '100%', display: 'flex', overflow: 'hidden' }}>
        <ImApp
          key={projectRoot}
          im={ready.im}
          projectRoot={projectRoot}
          models={ready.models}
          persist={persistState}
        />
      </div>
    </div>
  )
}

function installSidebarSlots(ctx: DshClientCtx) {
  let mainReady = false
  let panelListReady = false
  let nativeEntryDispose: (() => void) | null = null

  const layout = () => (typeof ctx.get === 'function' ? (ctx.get('layout') as DshClientCtx['layout']) ?? ctx.layout : ctx.layout)
  const leaveNativePanel = () => {
    const controller = layout()
    try {
      if (controller?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) controller.selectPanel?.(null)
    } catch (error) {
      logWarn('[dsh-im] failed to leave native panel:', error)
    }
  }
  const disposeNativeEntry = () => {
    if (!nativeEntryDispose) return
    leaveNativePanel()
    nativeEntryDispose()
    nativeEntryDispose = null
  }
  const syncEntries = () => {
    if (mainReady && panelListReady && nativeEntryDispose === null) {
      nativeEntryDispose = ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 35,
        label: '专家团队',
      }, TeamIcon)
    }
  }

  ctx.slots.inject('main', () => {
    const disposeMain = ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({
        presentation: 'panel',
        projectRoot: currentProjectRoot(ctx),
        closePanel: () => layout()?.selectPanel?.(null),
      }),
    }, DshImPanel)
    mainReady = true
    syncEntries()
    return () => {
      leaveNativePanel()
      mainReady = false
      syncEntries()
      disposeMain()
    }
  })

  ctx.slots.inject('sidebar.panellist', () => {
    panelListReady = true
    syncEntries()
    return () => {
      panelListReady = false
      disposeNativeEntry()
    }
  })
}

export function apply(ctx: DshClientCtx) {
  installSidebarSlots(ctx)
}
