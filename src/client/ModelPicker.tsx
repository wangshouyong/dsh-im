import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelOption } from '../host/models.ts'

/** 下拉菜单最大高度：超过就滚动，不再被模型数量撑长。 */
const MENU_MAX_HEIGHT = 320
/** 视口空间不足时至少保留的高度，低于它才考虑向上翻。 */
const MENU_MIN_HEIGHT = 160
const MENU_GAP = 4

interface MenuRect {
  left: number
  top: number
  width: number
  maxHeight: number
}

/**
 * DSH 风格的模型选择器：按 provider 分组、可搜索、固定高度可滚动。
 *
 * 菜单用 portal 挂在 body 上，避免被弹窗的 `overflow: auto` 裁掉；
 * 下方空间不够时自动向上翻。数据来自宿主的 `ctx.llm` 目录。
 */
export function ModelPicker(props: {
  models: ModelOption[]
  value: string
  placeholder?: string
  disabled?: boolean
  onChange: (modelId: string) => void
}) {
  const { models, value, placeholder = '选择 DSH 已配置的模型', disabled } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rect, setRect] = useState<MenuRect | null>(null)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selected = models.find((model) => model.id === value)

  const measure = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const below = window.innerHeight - box.bottom - MENU_GAP - 8
    const above = box.top - MENU_GAP - 8
    const openUp = below < MENU_MIN_HEIGHT && above > below
    const maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, openUp ? above : below))
    setRect({
      left: box.left,
      top: openUp ? Math.max(8, box.top - MENU_GAP - maxHeight) : box.bottom + MENU_GAP,
      width: box.width,
      maxHeight,
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    measure()
    searchRef.current?.focus()
  }, [open, measure])

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const isInside = (node: Node | null) => Boolean(node && (rootRef.current?.contains(node) || menuRef.current?.contains(node)))
    const onPointerDown = (event: MouseEvent) => {
      if (!isInside(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    const onReflow = () => measure()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, measure])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const result: { label: string; items: ModelOption[] }[] = []
    for (const model of models) {
      if (needle && !`${model.provider} ${model.label}`.toLowerCase().includes(needle)) continue
      const last = result.at(-1)
      if (last && last.label === model.provider) last.items.push(model)
      else result.push({ label: model.provider, items: [model] })
    }
    return result
  }, [models, query])

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])

  useEffect(() => {
    setActive(0)
  }, [query, open])

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(flat.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(0, index - 1))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActive(Math.max(0, flat.length - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const pick = flat[active]
      if (pick) choose(pick)
    }
  }

  function choose(model: ModelOption) {
    if (!model.ready) return
    props.onChange(model.id)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((cur) => !cur)}
      >
        <span className={`model-picker-value${selected ? '' : ' placeholder'}`}>
          {selected ? selected.label : placeholder}
        </span>
        {selected && <span className="model-picker-provider">{selected.provider}</span>}
        <span className="model-picker-caret" aria-hidden="true">▾</span>
      </button>
      {open && rect && createPortal(
        <div className="dsh-im-root">
          <div
            ref={menuRef}
            className="model-picker-menu"
            role="listbox"
            style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight }}
          >
          <input
            ref={searchRef}
            className="model-picker-search"
            placeholder="搜索模型…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <div className="model-picker-list">
            {groups.length === 0 && <div className="model-picker-empty">没有匹配的模型</div>}
            {groups.map((group) => (
              <div key={group.label} className="model-picker-group">
                <div className="model-picker-group-label">{group.label}</div>
                {group.items.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={model.id === value}
                    className={`model-picker-option${model.id === value ? ' on' : ''}${flat[active]?.id === model.id ? ' active' : ''}`}
                    disabled={!model.ready}
                    title={model.note}
                    onClick={() => choose(model)}
                  >
                    <span className="model-picker-option-label">{model.label}</span>
                    {model.note && <span className="model-picker-note">{model.note}</span>}
                    {model.id === value && <span className="model-picker-check" aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
