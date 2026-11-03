import { useEffect, useRef, useState } from 'react'
import { generateAvatar } from '../core/avatar.ts'
import { AVATAR_PRESETS, type AvatarPreset } from '../core/avatar-presets.ts'
import { defaultToolAllow, type DiscoveredToolGroup, type ToolGroupCatalog } from '../core/tools.ts'
import type { Activity, Persona } from '../core/types.ts'
import type { ModelCatalog } from '../host/models.ts'
import { Avatar } from './Avatar.tsx'
import { IconChevronDown, IconChevronRight, IconClose } from './im/icons.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { readAvatarFile } from './readAvatarFile.ts'
import { loadToolGroups, toolGroupsSnapshot } from './httpStore.ts'

export interface PersonaDraft {
  name: string
  post: string
  personality: string
  duties: string
  model: string
  avatar: string
  avatarUrl: string
  defaultActivity: Activity
  proactiveDm: boolean
  toolAllow: string[]
}

export function emptyDraft(): PersonaDraft {
  return {
    name: '',
    post: '',
    personality: '',
    duties: '',
    model: '',
    avatar: '',
    avatarUrl: '',
    defaultActivity: 'review',
    proactiveDm: false,
    toolAllow: defaultToolAllow(),
  }
}

export function draftFromPersona(p: Persona): PersonaDraft {
  return {
    name: p.name,
    post: p.post ?? '',
    personality: p.personality,
    duties: p.duties.join('、'),
    model: p.model,
    avatar: p.avatar,
    avatarUrl: p.avatarUrl || generateAvatar(p.name),
    defaultActivity: p.defaultActivity,
    proactiveDm: p.proactiveDm,
    toolAllow: p.toolAllow ? [...p.toolAllow] : defaultToolAllow(),
  }
}

export function PersonaEditor(props: {
  title: string
  catalog: ModelCatalog
  initial?: PersonaDraft
  onClose: () => void
  onSave: (draft: PersonaDraft) => void
  /** 工具目录（内置能力 + 宿主来源组）；不传读最近一次发现结果。 */
  toolCatalog?: ToolGroupCatalog
}) {
  const { title, catalog, onClose, onSave } = props
  const [draft, setDraft] = useState<PersonaDraft>(props.initial ?? emptyDraft())
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  // 头像是否还跟着角色名自动生成：默认就是自动生成（没传图就用字母头像）；
  // 选了预制头像或上传图片后置 false，改名字不再把它顶掉（预设也是 svg，不能只看 data:image/svg 前缀）。
  const [avatarAuto, setAvatarAuto] = useState(() => !props.initial || props.initial.avatarUrl === generateAvatar(props.initial.name))
  const models = catalog.list()
  const readyModels = models.filter((m) => m.ready)
  // 打开编辑器时再拉一次目录：宿主刚启动/路由未就绪时首屏可能没取到，这里兜底自愈。
  const [toolCatalog, setToolCatalog] = useState<ToolGroupCatalog>(() => props.toolCatalog ?? toolGroupsSnapshot())
  useEffect(() => {
    let live = true
    loadToolGroups().then((catalog) => { if (live) setToolCatalog(catalog) }).catch(() => undefined)
    return () => { live = false }
  }, [])

  function patch(part: Partial<PersonaDraft>) {
    setDraft((cur) => ({ ...cur, ...part }))
    setError('')
  }

  function uniqueAllow(entries: string[]): string[] {
    return [...new Set(entries)]
  }

  function toggleCapability(id: string, on: boolean): void {
    patch({ toolAllow: on ? uniqueAllow([...draft.toolAllow, id]) : draft.toolAllow.filter((entry) => entry !== id) })
  }

  /** 勾/取消整组：授予用 grp:，取消时清掉该组的单工具条目。 */
  function toggleGroup(group: DiscoveredToolGroup, on: boolean): void {
    const groupId = `grp:${group.id}`
    const rest = draft.toolAllow.filter((entry) => entry !== groupId && !group.tools.some((tool) => entry === `tool:${tool}`))
    patch({ toolAllow: on ? uniqueAllow([...rest, groupId]) : rest })
  }

  /** 单工具勾选：组已授予时取消一个 → 展开成“其余工具单授”，保证意图精确。 */
  function toggleGroupTool(group: DiscoveredToolGroup, tool: string, on: boolean): void {
    const groupId = `grp:${group.id}`
    const toolId = `tool:${tool}`
    if (draft.toolAllow.includes(groupId)) {
      if (on) return
      const expandedTools = draft.toolAllow.filter((entry) => entry !== groupId)
      for (const name of group.tools) if (name !== tool) expandedTools.push(`tool:${name}`)
      patch({ toolAllow: uniqueAllow(expandedTools) })
      return
    }
    patch({ toolAllow: on ? uniqueAllow([...draft.toolAllow, toolId]) : draft.toolAllow.filter((entry) => entry !== toolId) })
  }

  /** 恢复“按角色名自动生成”的头像（默认状态），也是「恢复自动生成」的落点。 */
  function autoAvatar(name = draft.name) {
    setAvatarAuto(true)
    const url = generateAvatar(name || '角')
    patch({ avatarUrl: url, avatar: (name.trim().slice(0, 1) || '角') })
  }

  function choosePreset(preset: AvatarPreset) {
    setAvatarAuto(false)
    patch({ avatarUrl: preset.dataUrl, avatar: (draft.name.trim().slice(0, 1) || '角') })
  }

  return (
    <div className="modal-mask" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-labelledby="persona-editor-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="persona-editor-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}><IconClose size={14} /></button>
        </div>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault()
            const name = draft.name.trim()
            if (!name) {
              setError('请填写角色名')
              return
            }
            if (!draft.model) {
              setError('必须绑定一个可调用的模型')
              return
            }
            const picked = models.find((m) => m.id === draft.model)
            if (!picked?.ready) {
              setError('所选模型当前不可调用，请换一个或先在 DSH 里配好')
              return
            }
            onSave({
              ...draft,
              name,
              avatar: draft.avatar || name.slice(0, 1),
              avatarUrl: draft.avatarUrl || generateAvatar(name),
              duties: draft.duties,
            })
          }}
        >
          <div className="avatar-presets" role="group" aria-label="角色头像">
            <div className="avatar-presets-head">
              <span className="avatar-presets-label">头像</span>
              {!avatarAuto && (
                <button type="button" className="avatar-reset" onClick={() => autoAvatar()} title="丢掉当前头像，按角色名生成字母头像">
                  恢复自动生成
                </button>
              )}
            </div>
            <div className="avatar-picker">
              <button
                type="button"
                className="avatar-upload"
                onClick={() => fileRef.current?.click()}
                title="上传本地图片（PNG / JPG / WebP / GIF，≤2MB，自动裁成圆形）"
                aria-label="上传本地图片"
              >
                <Avatar persona={{ name: draft.name || '角', avatar: draft.avatar || '角', avatarUrl: draft.avatarUrl }} size="lg" />
                <span className="avatar-upload-mask" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 8.5h2.7l1.4-2h6.8l1.4 2h2.7a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1Z" />
                    <circle cx="12" cy="13.7" r="3.1" />
                  </svg>
                </span>
              </button>
              <div className="avatar-preset-grid">
                {AVATAR_PRESETS.map((preset) => {
                  const active = draft.avatarUrl === preset.dataUrl
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={active ? 'avatar-preset on' : 'avatar-preset'}
                      title={preset.label}
                      aria-label={preset.label}
                      aria-pressed={active}
                      onClick={() => choosePreset(preset)}
                    >
                      <img src={preset.dataUrl} alt="" draggable={false} />
                    </button>
                  )
                })}
              </div>
            </div>
            <small className="avatar-presets-hint">
              点头像上传本地图片，点图标直接用作头像；这些图标是各家的商标，只作头像占位。
            </small>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                void readAvatarFile(file)
                  .then((avatarUrl) => {
                    setAvatarAuto(false)
                    patch({ avatarUrl, avatar: draft.name.trim().slice(0, 1) || '角' })
                  })
                  .catch((err: Error) => setError(err.message))
              }}
            />
          </div>

          <label className="field">
            <span>角色名</span>
            <input
              required
              value={draft.name}
              placeholder="例如 产品经理"
              onChange={(e) => {
                const name = e.target.value
                const fallback = name.trim().slice(0, 1)
                // 只有头像还是自动生成的时候才跟着名字变；预设/上传的头像保持不动。
                if (!avatarAuto) {
                  patch({ name, avatar: fallback })
                  return
                }
                patch({ name, avatar: fallback, avatarUrl: generateAvatar(name || '角') })
              }}
            />
          </label>
          <label className="field">
            <span>岗位</span>
            <input value={draft.post} placeholder="例如 产品经理" onChange={(e) => patch({ post: e.target.value })} />
          </label>
          <label className="field">
            <span>人设</span>
            <textarea value={draft.personality} placeholder="这个角色怎么想、专挑什么" onChange={(e) => patch({ personality: e.target.value })} />
          </label>
          <label className="field">
            <span>职责</span>
            <input value={draft.duties} placeholder="顿号或逗号分隔，如 需求分析、方案评审" onChange={(e) => patch({ duties: e.target.value })} />
          </label>
          <div className="field">
            <span>模型</span>
            {readyModels.length === 0 ? (
              <div className="field-hint warn">当前没有可调用的模型。先在 DSH 设置里配好模型，再创建角色。</div>
            ) : (
              <ModelPicker
                models={models}
                value={draft.model}
                onChange={(modelId) => patch({ model: modelId })}
              />
            )}
          </div>
          <label className="field">
            <span>默认活跃度</span>
            <select value={draft.defaultActivity} onChange={(e) => patch({ defaultActivity: e.target.value as Activity })}>
              <option value="review">评审才参与</option>
              <option value="high">高活跃</option>
              <option value="mention-only">仅@</option>
              <option value="muted">禁言</option>
            </select>
          </label>
          <fieldset className="tool-list">
            <legend>可用工具</legend>
            <div className="field-hint">
              内置能力两条传输都可用；宿主工具按来源组授权，只在原生会话生效。新装的插件/MCP 工具默认不授予，展开组可以单独勾选。
            </div>
            {toolCatalog.capabilities.map((capability) => (
              <label key={capability.id} className="check">
                <input
                  type="checkbox"
                  checked={draft.toolAllow.includes(capability.id)}
                  onChange={(e) => toggleCapability(capability.id, e.target.checked)}
                />
                {capability.label}
              </label>
            ))}
            {toolCatalog.groups.length === 0 ? (
              <div className="field-hint">宿主上没有发现可授予的第三方工具（或当前宿主不支持原生会话）。</div>
            ) : (
              toolCatalog.groups.map((group) => {
                const groupId = `grp:${group.id}`
                const groupOn = draft.toolAllow.includes(groupId)
                const checkedTools = group.tools.filter((tool) => draft.toolAllow.includes(`tool:${tool}`))
                const someTools = !groupOn && checkedTools.length > 0
                const isExpanded = expanded.includes(group.id)
                return (
                  <div key={group.id} className="tool-group">
                    <div className="tool-group-head">
                      <button
                        type="button"
                        className="tool-group-toggle"
                        aria-label={isExpanded ? '收起' : '展开'}
                        onClick={() => setExpanded((cur) => (cur.includes(group.id) ? cur.filter((id) => id !== group.id) : [...cur, group.id]))}
                      >
                        {isExpanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                      </button>
                      <label className="check tool-group-label">
                        <input
                          type="checkbox"
                          checked={groupOn}
                          ref={(el) => { if (el) el.indeterminate = someTools }}
                          onChange={(e) => toggleGroup(group, e.target.checked)}
                        />
                        {group.label}
                      </label>
                      <span className="tool-group-meta">
                        {someTools ? `已选 ${checkedTools.length}/${group.tools.length}` : `${group.tools.length} 个工具`}
                        {group.kind === 'other' ? ' · 未声明来源' : ''}
                        {' · 需原生会话'}
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="tool-group-tools">
                        {group.tools.map((tool) => (
                          <label key={tool} className="check tool-item">
                            <input
                              type="checkbox"
                              checked={groupOn || draft.toolAllow.includes(`tool:${tool}`)}
                              onChange={(e) => toggleGroupTool(group, tool, e.target.checked)}
                            />
                            {tool}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </fieldset>
          <label className="check">
            <input type="checkbox" checked={draft.proactiveDm} onChange={(e) => patch({ proactiveDm: e.target.checked })} />
            允许在不宜公开时主动私聊
          </label>
          {error && <div className="field-hint warn">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose}>取消</button>
            <button type="submit" disabled={readyModels.length === 0}>保存</button>
          </div>
        </form>
      </div>
    </div>
  )
}
