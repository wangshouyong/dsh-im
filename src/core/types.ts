import type { ConsensusState } from './consensus.ts'

export type Activity = 'muted' | 'mention-only' | 'review' | 'high'
export type ThreadKind = 'dm' | 'triad' | 'group'
export type MessageKind = 'user' | 'persona' | 'system'

/** 原生会话一轮要投喂的一行（已带 seq，host 按 seq 去重）。 */
export interface NativeFrameLine {
  seq: number
  kind: 'user' | 'persona' | 'system'
  authorName: string
  text: string
}

/**
 * 原生会话的增量帧。
 * 静态人设走 systemPrompt 段，这里只带窗口行、当前消息和 L2 事实快照。
 */
export interface NativeFrame {
  /** 本轮窗口内的行（已按 seq 升序）。 */
  windowLines: NativeFrameLine[]
  /** 触发本轮的消息（可能已在 windowLines 里，host 按 seq 去重）。 */
  currentLine?: NativeFrameLine
  /** L2 不可压缩事实。原生会话创建时写入，内容变了会换掉这一段。 */
  factsL2?: string[]
  /** 事实快照截止 seq（写进段首「截止 #N」）。 */
  factsUntilSeq?: number
  /** Phase 1 handle directory; only sent when memoryContextMode=on (appended to this turn's user text, not the system prefix). */
  memoryBlock?: string
  /**
   * 双层窗口的冷区上下文（L1 摘要 + 章节目录）：只在记忆层 on 时追加到**本轮用户文本**
   * （`memoryBlock` 同模式），绝不写 system 前缀（否则 prompt 缓存全失效）。
   */
  contextBlock?: string
}
export type RoundMode = 'idle' | 'review'

/** 主动私聊频率预设：克制 / 标准 / 活跃。 */
export type ProactiveLevel = 'low' | 'standard' | 'high'

export interface Persona {
  /** 岗位/头衔，例如 产品经理；name 是这个人叫什么。 */
  post?: string
  id: string
  name: string
  avatar: string
  avatarUrl?: string
  personality: string
  duties: string[]
  origin: 'mine' | 'team'
  provider?: string
  model: string
  toolAllow?: string[]
  toolDeny?: string[]
  proactiveDm: boolean
  /** 主动私聊频率预设（默认 standard）。 */
  proactiveLevel?: ProactiveLevel
  defaultActivity: Activity
}

export interface ThreadMember {
  personaId: string
  activity: Activity
  completedRound: boolean
  passedRound: boolean
}

export interface CatalogCard {
  threadId: string
  title: string
  topic: string
  shortSummary: string
}

export interface MemoryEntry {
  id: string
  scope: 'identity' | 'user_global' | 'thread'
  threadId?: string
  text: string
  createdAt: number
}

/** 消息里的附件（用户上传；文件/图片）。 */
export interface MessageAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  mediaType: string
  bytes: number
  /** DSH 附件存储的持久引用 id（sha256:...）；没有时模型看不到图片，只能看占位。 */
  attachmentId?: string
  width?: number
  height?: number
  /** 文本类文件的截断内容（拼 prompt 用；二进制文件没有）。 */
  text?: string
  /** 群工作区内的相对路径（用于 UI 预览/下载，如 attachments/xxx.png）。 */
  path?: string
  /** 是否成功登记到 DSH 附件存储（false 时模型看不到图片内容，只能看占位）。 */
  modelVisible?: boolean
  /** 声明/扩展名是图片、但内容嗅探不是图片，已降级按文件处理。 */
  downgraded?: boolean
}

/** 模型消息内容块：文本 / 图片（DSH ImageBlock）/ 文件（DSH FileBlock）。 */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: { attachmentId: string; name?: string; mediaType?: string; width?: number; height?: number } }
  | { type: 'file'; attachment: { attachmentId: string; name?: string; bytes?: number } }

export interface Message {
  id: string
  threadId: string
  /** 事件日志里的持久序号（与 events.jsonl 的 seq 对应）；老数据由 saveState 回填。 */
  seq?: number
  kind: MessageKind
  authorId?: string
  authorName: string
  text: string
  /** 用户随消息上传的附件。 */
  attachments?: MessageAttachment[]
  /** 这条回复生成时“模型看到的最后一条消息 seq”（因果一致性校验用）。 */
  basedOnSeq?: number
  /** 生成期间有新消息：回复基于旧版本（annotate 策略）。 */
  stale?: boolean
  interrupted?: boolean
  pass?: boolean
  /** 运行时主动发起的私聊（不来自用户提问）。 */
  proactive?: boolean
  windowReply?: boolean
  createdAt: number
}

/** 一条发言权仲裁决策：谁、做了什么、为什么、什么时候。 */
export interface FloorDecision {
  /** 决策针对的角色；pass（全场无人可发）时为空串。 */
  personaId: string
  action: 'speak' | 'wait' | 'pass'
  reason: string
  at: number
}

/** 事实的分类（不可压缩项优先：决策/待办/承诺/约束）。 */
export type FactKind = 'decision' | 'todo' | 'commitment' | 'constraint' | 'stance' | 'fact'
/** 事实来源决定写入优先级：用户 > 角色显式声明 > LLM 抽取。 */
export type FactSource = 'user' | 'persona' | 'extractor'

/** 从事件投影出来的事实（不可变，可重建）。 */
export interface Fact {
  factId: string
  kind: FactKind
  text: string
  owner?: string
  source: FactSource
  confidence: number
  /** 产生这条事实的事件序号。 */
  seq: number
  at: number
  /** 来源消息的事件 id（provenance；旧数据可能缺失）。 */
  sourceMessageId?: string
  /** 来源消息的持久 seq（provenance；旧数据可能缺失）。 */
  sourceMessageSeq?: number
}

/** 客户端产生、待 host 落成 fact 事件的事实操作（异步抽取 / 任务板完成）。 */
export interface PendingFactOp {
  op: 'assert' | 'supersede' | 'retract'
  factId: string
  kind: FactKind
  text: string
  source: FactSource
  owner?: string
  supersedes?: string
  /** 来源消息事件 id / seq（provenance；任务板归档等用户操作可不带）。 */
  sourceMessageId?: string
  sourceMessageSeq?: number
  at: number
}

/** 一条指标（`metrics.jsonl` 的一行；客户端先攒在 thread.pendingMetrics，saveState 落盘）。 */
export interface MetricEntry {
  /**
   * 稳定指纹（`core/metrics.ts` 的 `metricFingerprint`）：同一条指标在任何进程/任何写入路径下算出同一个 id。
   * 落盘/读取都按它去重——并发 saveState 把同一批 pendingMetrics 写两遍时，行可以重复，指标不会重复计数。
   * 老数据没有这个字段，读侧按「同 kind/at/value/fields」补算指纹去重。
   */
  id?: string
  at: number
  /** 指标类型：llm_call / stale / floor_round / extraction / facts / summary。 */
  kind: string
  value?: number
  fields?: Record<string, string | number | boolean>
}

/** 群级摘要投影：L1 = 旧消息压缩，L2 = 事实/决策/待办（不可压缩项）。 */
export interface SummaryDigest {
  version: string
  /** 摘要覆盖到的消息 seq；窗口只取它之后的消息。 */
  untilSeq: number
  l1: string
  l2: string[]
  factsVersion: string
  at: number
}

/** 中途某个角色调用失败时，整轮先停在可恢复的暂停态。 */
export interface BlockedState {
  personaId: string
  name: string
  /** 宿主给出的稳定失败码，如 MISSING_CREDENTIAL / RATE_LIMIT。 */
  code?: string
  message: string
  at: number
}

export interface Thread {
  /** 角色调用失败后的暂停态；清掉就能继续。 */
  blocked?: BlockedState
  id: string
  kind: ThreadKind
  title: string
  /**
   * 用户手改过标题（只有三人小窗会用到：默认标题由两个角色名派生，点标题改名后置 true，
   * 之后角色改名不再覆盖；群标题本来就由用户起，不需要这个标记；DM 永远派生）。
   */
  titleCustom?: boolean
  topic: string
  shortSummary: string
  memberIds: string[]
  members: ThreadMember[]
  projectRoot: string
  messages: Message[]
  unread: number
  roundMode: RoundMode
  speakingPersonaId?: string
  nextHint?: string
  /** 本轮发言权仲裁记录（只保留最近若干条；每轮用户新消息开始时清空）。 */
  floorDecisions?: FloorDecision[]
  /** 摘要投影已覆盖到的事件序号；窗口只取它之后的消息（摘要分层落地的接口）。 */
  summaryUntilSeq?: number
  /** 分层摘要投影（L1 旧消息压缩 + L2 事实/决策/待办）；随 state.json 落盘。 */
  summaryState?: SummaryDigest
  /** 事实投影（saveState 时由事件/消息重建）；角色 prompt 会带上。 */
  facts?: Fact[]
  factsVersion?: string
  /**
   * 共识状态（A 用户指令 / B 群共识 / C 任务 / D 归档）。
   * 开关打开时由 curator + consensus builder 生成；关闭 / 旧数据时为空。
   */
  consensusState?: ConsensusState
  /** 最近一次共识生成失败的原因（成功时清空；界面用它提示 + 重试）。 */
  consensusError?: string
  /** host 侧事实投影已覆盖到的消息 seq：客户端只把比它更新的消息派生事实合并进来（防止已归档事实被重算复活）。 */
  factsUntilSeq?: number
  /** 本轮客户端异步抽取/任务板操作产生、还没落成事件的事实。 */
  pendingFactOps?: PendingFactOp[]
  /** 成员执行轨迹（最近若干轮；用于右栏“执行”Tab 和成员卡最近动作）。 */
  traces?: TurnTrace[]
  /** 客户端本地看到过、但还没被 host 投影收录的抽取事实（落盘后清空）。 */
  extractedFacts?: Fact[]
  /** 客户端本地已归档的事实 id（防消息规则重算把它们复活；落盘后清空）。 */
  retractedFactIds?: string[]
  /** 待落盘的指标（saveState 写进 groups/<id>/metrics.jsonl 后清空）。 */
  pendingMetrics?: MetricEntry[]
  createdAt: number
  updatedAt: number
}

/**
 * 角色状态快照（Phase 1）：不是历史，而是“结论”。
 * 全部由 facts 投影视图 + 运行时状态派生，确定性、可重建、零额外模型调用。
 */
export interface RoleState {
  personaName: string
  /** 我答应/认领的事（commitment / todo）。 */
  commitments: string[]
  /** 我做过的决定（decision）。 */
  decisions: string[]
  /** 我坚持的约束（constraint）。 */
  constraints: string[]
  /** 我最近的立场（stance，取最新一条）。 */
  position?: string
  /** 我在等谁（来自运行时状态机）。 */
  waitingOn?: string
  /** 我最后看到的消息 seq。 */
  lastSeq: number
}

/** 检索开关三档：off 完全不跑；shadow 跑检索+回执但不进 prompt；on 进 prompt。 */
export type RetrievalMode = 'off' | 'shadow' | 'on'

/** 按需检索命中的一条旧事件（Phase 2：确定性检索，不依赖 embedding）。 */
export interface RetrievalHit {
  seq: number
  authorName: string
  kind: MessageKind
  text: string
  /** 命中原因（实体命中/被引用/同话题/最近兜底），写进回执便于审计。 */
  reason: string
}

/** 结构化检索查询（回执里可以 diff，不用自然语言字符串）。 */
export interface RetrievalQuery {
  /** 当前话题段 id（按用户消息边界切，等于该段用户消息 seq）。 */
  topicId: number
  entities: { type: 'mention' | 'name' | 'file' | 'quoted' | 'number'; value: string }[]
  replyChainRoots: number[]
  params: {
    retrievalVersion: string
    topicSegVersion: string
    weights: Record<string, number>
  }
}

export interface RetrievalResult {
  query: RetrievalQuery
  /** 最终进 prompt 的命中（受 token 预算/条数约束）。 */
  hits: RetrievalHit[]
  /** 打分后的完整命中 seq 列表（截断 top50，用于审计“为什么没选某条”）。 */
  hitIds: number[]
  /** indexVersion = 检索器版本 + 话题分段版本 + lastSeq，保证可重建。 */
  indexVersion: string
}

export interface SpeakRequest {
  persona: Persona
  thread: Thread
  focus: string
  visibleMessages: Message[]
  identity: string
  userGlobal: string[]
  threadMemory: string[]
  catalog: CatalogCard[]
  /** 角色状态快照（由 ImService 用 facts + 运行时状态派生）。 */
  roleState?: RoleState
  /** 群里所有角色名：检索时识别 @/人名实体。 */
  memberNames?: string[]
  /** 本轮检索档位（覆盖 speaker 的默认值）：off/shadow/on。 */
  retrievalMode?: RetrievalMode
  /** 本轮引用句柄协议档位（覆盖 speaker 默认值）：off 不跑 / shadow 只写回执 / on 注入。 */
  memoryContextMode?: import('./memory-context.ts').MemoryContextMode
  /** 主动私聊生成（prompt 会追加“主动私聊模式”说明）。 */
  proactive?: boolean
}

/** 一轮发言里的一步执行（工具调用/最终回复），用于"成员行为"时间线。 */
export interface TurnStepTrace {
  step: number
  kind: 'tool' | 'reply'
  name?: string
  /** 参数/结果只存截断预览，避免把大段文件内容塞进 state。 */
  args?: string
  result?: string
  ok?: boolean
  ms?: number
  at: number
  /** 本轮工具调用统计（只在最终 reply 步出现；trace/metrics 审计用）。 */
  toolCalls?: number
  toolExecuted?: number
  toolBudgetExhausted?: boolean
}

/** 一轮发言的完整执行轨迹（按 角色×轮 存，最多保留最近若干轮）。 */
export interface TurnTrace {
  id: string
  personaId: string
  personaName: string
  messageId?: string
  at: number
  ms: number
  steps: TurnStepTrace[]
}

export interface SpeakResult {
  text: string
  pass?: boolean
  proposeRecallThreadId?: string
  /** 生成时模型看到的最后一条消息 seq（运行时填；测试/假模型可省略）。 */
  basedOnSeq?: number
  /** 这一轮的工具执行轨迹（host 返回；假模型可省略）。 */
  trace?: TurnStepTrace[]
}

/** 生成期间出现新消息时的处理策略。 */
export type StalePolicy = 'regenerate' | 'annotate' | 'drop'

export interface Speaker {
  complete(req: SpeakRequest): Promise<SpeakResult>
}

export interface ChairSelector {
  pickNext(input: {
    candidates: Persona[]
    dutiesLeft: string[]
    latestText: string
    mentionedIds: string[]
  }): { personaId: string; focus: string } | null
}

export interface ImState {
  personas: Persona[]
  threads: Thread[]
  memories: MemoryEntry[]
  wakeExcerpts: Record<string, string[]>
  pendingRecall: { threadId: string; personaId: string; targetThreadId: string } | null
  lastProactiveAt: Record<string, number>
}
