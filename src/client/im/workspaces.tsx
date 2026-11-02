/** 工作区选择器：DSH 原生工作区列表 + 文件夹浏览 + 添加工作区（portal 弹层，样式走 .ws-*）。 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { browseFolders, createWorkspace, loadWorkspaces, type FsListing, type WorkspaceOption } from '../httpStore.ts'

/** DSH 原生工作区列表：面板内多处复用，模块级缓存一次；添加工作区后刷新所有使用方。 */
export let workspacesPromise: Promise<WorkspaceOption[]> | null = null
export const workspaceSubscribers = new Set<() => void>()
export function refreshWorkspaces() {
  workspacesPromise = null
  for (const subscriber of workspaceSubscribers) subscriber()
}
export function useWorkspaces(): WorkspaceOption[] {
  const [list, setList] = useState<WorkspaceOption[]>([])
  useEffect(() => {
    let alive = true
    const load = () => {
      workspacesPromise ??= loadWorkspaces().catch(() => [])
      void workspacesPromise.then((items) => {
        if (alive) setList(items)
      })
    }
    load()
    workspaceSubscribers.add(load)
    return () => {
      alive = false
      workspaceSubscribers.delete(load)
    }
  }, [])
  return list
}

export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')
}

/** 工作区选择器：和 DSH 原生一样是“文件夹 + 名字 + 勾选”的弹层（原生 select 会溢出、样式也对不上）。 */
export function WorkspacePicker(props: {
  value: string
  options: WorkspaceOption[]
  onChange: (path: string) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 240 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const label = props.options.find((item) => item.path === props.value)?.title ?? props.value ?? '选择工作区'

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (buttonRef.current?.contains(target as Node)) return
      if (target?.closest?.('.ws-menu')) return
      close()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    const onScroll = () => close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const toggle = () => {
    if (open) { setOpen(false); return }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(320, Math.max(rect.width, 240))
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12)
    const top = Math.min(rect.bottom + 6, window.innerHeight - 330)
    setPos({ top: Math.max(12, top), left, width })
    setOpen(true)
  }

  const [adding, setAdding] = useState(false)
  const [fs, setFs] = useState<FsListing | null>(null)
  const [fsError, setFsError] = useState('')
  const [fsBusy, setFsBusy] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const go = async (path: string) => {
    setFsBusy(true)
    setFsError('')
    try {
      setFs(await browseFolders(path))
    } catch (err) {
      setFsError(err instanceof Error ? err.message : String(err))
    } finally {
      setFsBusy(false)
    }
  }

  const openBrowser = (start?: string) => {
    setOpen(false)
    setAdding(true)
    setNewTitle('')
    setFs(null)
    void go(start && isAbsolutePath(start) ? start : '')
  }

  const addCurrent = async () => {
    if (!fs?.path || creating) return
    // 会话目录/插件数据目录（.dsh-im 下）不能被注册成工作区：之前测试误把
    // team/.dsh-im/t_xxx 加进 DSH 工作区列表，侧栏因此多出垃圾项。
    if (/[\\/]\.dsh-im(?:[\\/]|$)/i.test(fs.path)) {
      setFsError('这是会话/插件数据目录，不能添加为工作区；请选它的上层目录')
      return
    }
    setCreating(true)
    setFsError('')
    try {
      const created = await createWorkspace(fs.path, newTitle.trim() || undefined)
      refreshWorkspaces()
      props.onChange(created.path)
      setAdding(false)
    } catch (err) {
      setFsError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const folder = (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  )

  return (
    <span className={'ws-picker' + (props.compact ? ' compact' : '')}>
      <button
        ref={buttonRef}
        type="button"
        className="ws-picker-btn"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ws-picker-folder">{folder}</span>
        <span className="ws-picker-title">{label}</span>
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" className="ws-picker-caret">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
      {open ? createPortal(
        <div className="dsh-im-root">
          <div className="ws-menu" role="listbox" style={{ top: pos.top, left: pos.left, width: pos.width }}>
            <div className="ws-menu-head">工作区</div>
            {props.options.length === 0 ? (
              <div className="ws-menu-empty">还没有工作区：在 DSH 里「添加工作区…」后刷新本面板</div>
            ) : null}
            {props.options.map((item) => {
              const selected = item.path === props.value
              return (
                <button
                  key={item.path}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={'ws-item' + (selected ? ' selected' : '')}
                  onClick={() => { props.onChange(item.path); setOpen(false) }}
                >
                  <span className="ws-item-folder">{folder}</span>
                  <span className="ws-item-name">{item.title}</span>
                  {selected ? <span className="ws-item-check">✓</span> : null}
                </button>
              )
            })}
            <button type="button" className="ws-add" onClick={() => openBrowser(props.value)}>
              <span aria-hidden="true">＋</span>
              <span>添加工作区…</span>
            </button>
            <div className="ws-menu-hint">也可以去 DSH 原生「+ 添加工作区…」加，刷新本面板后出现</div>
          </div>
        </div>,
        document.body,
      ) : null}
      {adding ? createPortal(
        <div className="dsh-im-root">
          <div
            className="ws-dialog-mask"
            onMouseDown={(event) => { if (event.target === event.currentTarget) setAdding(false) }}
          >
            <div className="ws-dialog" role="dialog" aria-label="添加工作区">
              <div className="ws-dialog-head">
                <h2>添加工作区</h2>
                <button type="button" className="ws-dialog-close" onClick={() => setAdding(false)}>关闭</button>
              </div>
              <div className="ws-dialog-body">
              <div className="ws-crumbs">
                <button type="button" className="ws-crumb-btn" disabled={!fs || fs.path === ''} onClick={() => void go(fs?.parent ?? '')}>
                  ↑ 上一级
                </button>
                <span className="ws-path" title={fs?.path || ''}>{fs?.path || '选择磁盘'}</span>
                <button type="button" className="ws-crumb-btn" onClick={() => void go(fs?.path ?? '')}>刷新</button>
              </div>
              <div className="ws-list">
                {fsBusy ? <div className="ws-list-note">读取中…</div> : null}
                {fs?.entries.map((entry) => (
                  <button key={entry.path} type="button" className="ws-entry" onClick={() => void go(entry.path)}>
                    <span className="ws-item-folder">{folder}</span>
                    <span className="ws-entry-name">{entry.name}</span>
                  </button>
                ))}
                {!fsBusy && fs && fs.entries.length === 0 ? <div className="ws-list-note">（没有子文件夹）</div> : null}
              </div>
              {fsError ? <div className="ws-error">{fsError}</div> : null}
              <label className="ws-field">
                <span>显示名称（可选）</span>
                <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="默认用文件夹名" />
              </label>
              <div className="ws-dialog-actions">
                <button type="button" disabled={!fs?.path || creating} onClick={() => void addCurrent()}>
                  {creating ? '添加中…' : '把当前文件夹添加为工作区'}
                </button>
              </div>
              <div className="ws-field-hint">会同步进 DSH 原生工作区列表，其他 DSH 面板也能看到。</div>
            </div>
          </div>
        </div>
      </div>,
        document.body,
      ) : null}
    </span>
  )
}

