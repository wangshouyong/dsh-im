import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ImApp } from '../client/ImApp.tsx'
import { httpModelTransport, httpNativeTransport, httpSink, loadNativeStatus, loadRemoteModels, loadRemoteState, loadToolGroups, saveRemoteState } from '../client/httpStore.ts'
import { ImService } from '../core/im.ts'
import { BoundModelSpeaker, defaultChair } from '../core/runtime.ts'
import type { ModelCatalog } from '../host/models.ts'
import { findModel } from '../host/models.ts'
import { usePanelTheme } from '../client/theme.ts'
import './style.css'

/** dev 预览的工作区根：默认 '.'；需要绝对根时用 `?root=D:\path`（避免把预览数据写进正式工作区）。 */
const projectRoot = new URLSearchParams(window.location.search).get('root')?.trim() || '.'

function seed(im: ImService) {
  const pm = im.createPersona({
    name: '产品经理',
    avatar: '产',
    personality: '先问值不值得做，专挑需求缺口与用户体验。',
    duties: ['需求分析', '产品规划', '方案评审'],
    origin: 'mine',
    model: 'preview-account::deepseek-v41-flash',
    provider: 'preview-account',
    toolAllow: ['read', 'search', 'write'],
    proactiveDm: false,
    defaultActivity: 'review',
  })
  const arch = im.createPersona({
    name: '架构师',
    avatar: '架',
    personality: '先问能不能长久，专挑结构风险。',
    duties: ['架构', '技术方案'],
    origin: 'mine',
    model: 'preview-account::deepseek-v41-flash',
    provider: 'preview-account',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  const qa = im.createPersona({
    name: '测试',
    avatar: '测',
    personality: '先问怎么证伪，专挑可测性。',
    duties: ['测试', '质量保障'],
    origin: 'mine',
    model: 'preview-account::deepseek-v41-flash',
    provider: 'preview-account',
    proactiveDm: false,
    defaultActivity: 'review',
  })
  im.createGroup('方案评审组', [pm.id, arch.id, qa.id], projectRoot)
  im.createTriad([arch.id, pm.id], projectRoot)
  im.openDm(pm.id, projectRoot)
}

/** dev 预览也要套一层 `.dsh-im-root`：主题是挂在它上面的（DSH 里这层由插件根提供）。 */
function Preview(props: { im: ImService; models: ModelCatalog }) {
  const theme = usePanelTheme()
  return (
    <div className="dsh-im-root" data-theme={theme}>
      <ImApp
        im={props.im}
        projectRoot={projectRoot}
        models={props.models}
        persist={(state) => saveRemoteState(state, projectRoot)}
      />
    </div>
  )
}

async function boot() {
  const listed = await loadRemoteModels().catch(() => [])
  const models: ModelCatalog = { list: () => listed }
  await loadToolGroups().catch(() => undefined)
  const saved = await loadRemoteState(projectRoot).catch(() => null)
  const native = await loadNativeStatus().catch(() => ({ enabled: false }))
  const speaker = new BoundModelSpeaker(native.enabled ? httpNativeTransport() : httpModelTransport(), {
    contextWindowFor: (model) => findModel(models, model)?.contextWindow,
  })
  const im = new ImService(speaker, defaultChair(), saved ?? undefined, httpSink())
  try {
    const mode = localStorage.getItem('dsh-im:retrieval')
    if (mode === 'off' || mode === 'shadow' || mode === 'on') im.retrievalMode = mode
  } catch {
    // 预览环境保持默认 shadow
  }
  im.consensusEnabled = true
  try {
    localStorage.removeItem('dsh-im:consensus')
  } catch {
    // 预览环境：忽略
  }
  if (!saved?.personas.length) {
    seed(im)
    await saveRemoteState(im.snapshot(), projectRoot).catch(() => undefined)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Preview im={im} models={models} />
    </StrictMode>,
  )
}

void boot()
