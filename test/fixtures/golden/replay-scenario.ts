/**
 * 黄金回放场景（A-3）：冻结时钟 + 脚本化 speaker，投影"窗口/摘要/事实/仲裁/因果/指标"。
 *
 * 快照外置到 `test/fixtures/golden/replay-golden.json`（可人工审 diff），
 * **不允许隐式更新**：只有 `DSH_IM_UPDATE_GOLDEN=1`（`npm run golden:update -- --allow-update` 会设）
 * 才写文件；否则不一致直接失败，并把"拒绝隐式更新"的原因写进错误信息。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ImService } from '../../../src/core/im.ts'
import { summarizeMetrics } from '../../../src/core/metrics.ts'
import type { SpeakResult, Speaker } from '../../../src/core/types.ts'

class ScriptedSpeaker implements Speaker {
  private index = 0
  constructor(private readonly replies: SpeakResult[]) {}
  async complete(): Promise<SpeakResult> {
    const reply = this.replies[this.index] ?? { text: '默认回复' }
    this.index += 1
    return reply
  }
}

export function runReplayScenario() {
  const im = new ImService(new ScriptedSpeaker([
    { text: '需求缺口：缺支付失败态。' },
    { text: '结构风险：重试没有幂等。' },
    { text: '可测性：没有失败注入。' },
    { text: '收到，周三上线灰度我记下了。' },
  ]))
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
  const group = im.createGroup('方案评审', [pm.id, arch.id, qa.id], 'proj')
  return { im, group, threadId: group.id }
}

export function normalizeReplayText(text: string, threadId: string): string {
  return text.split(threadId).join('<tid>')
}

export function replayDigestOf(im: ImService, threadId: string) {
  const thread = im.requireThread(threadId)
  return {
    messages: thread.messages.map((message) => ({
      seq: message.seq ?? null,
      kind: message.kind,
      author: message.authorName,
      text: normalizeReplayText(message.text, threadId),
      pass: Boolean(message.pass),
      stale: Boolean(message.stale),
      basedOnSeq: message.basedOnSeq ?? null,
    })),
    facts: im.factsFor(threadId).map((fact) => ({
      kind: fact.kind,
      text: fact.text,
      source: fact.source,
      owner: fact.owner ?? null,
    })),
    summary: thread.summaryState
      ? {
        untilSeq: thread.summaryState.untilSeq,
        l1: thread.summaryState.l1,
        l2: thread.summaryState.l2,
        factsVersionPrefix: thread.summaryState.factsVersion.split(':')[0],
      }
      : null,
    decisions: (thread.floorDecisions ?? []).map((decision) => ({
      action: decision.action,
      persona: decision.personaId ? im.requireThread(threadId).memberIds.indexOf(decision.personaId) : -1,
      reason: decision.reason,
    })),
    metrics: (thread.pendingMetrics ?? []).map((entry) => ({
      kind: entry.kind,
      value: entry.value,
      fields: entry.fields ?? null,
    })),
    rollup: summarizeMetrics(thread.pendingMetrics ?? []).byKind,
  }
}

/** 跑两轮固定剧本，返回语义快照。 */
export async function buildReplayDigest() {
  const { im, group, threadId } = runReplayScenario()
  await im.sendUser(group.id, '开始评审')
  await im.sendUser(group.id, '@产品经理 记住：周三上线灰度')
  return replayDigestOf(im, threadId)
}

export const GOLDEN_DIR = fileURLToPath(new URL('.', import.meta.url))
export const REPLAY_GOLDEN_PATH = fileURLToPath(new URL('./replay-golden.json', import.meta.url))
export const LONG_SESSION_GOLDEN_PATH = fileURLToPath(new URL('./long-session-golden.json', import.meta.url))

/** 只允许显式开关更新 golden；隐式更新一律拒绝（错误信息说明怎么改）。 */
export function assertGoldenUpdateAllowed(allowUpdate: boolean): void {
  if (allowUpdate) return
  throw new Error(
    'golden 快照不一致：拒绝隐式更新。'
    + '确认 diff 后运行 `npm run golden:update -- --allow-update`（等价 DSH_IM_UPDATE_GOLDEN=1）并人工审阅 diff。',
  )
}

export function readGoldenFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function readGoldenFileOrThrow<T>(path: string): T {
  const value = readGoldenFile<T>(path)
  if (value === undefined) {
    throw new Error(`golden 快照缺失：${path}。确认后运行 \`npm run golden:update -- --allow-update\` 生成并人工审 diff。`)
  }
  return value
}

export function writeGoldenFile(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 简单的 JSON diff 摘要（重录时打印；不引入第三方 diff 库）。 */
export function goldenDiffSummary(previous: unknown, next: unknown): string {
  const before = JSON.stringify(previous)
  const after = JSON.stringify(next)
  if (before === after) return '无变化'
  const previousLines = JSON.stringify(previous ?? '（文件不存在）', null, 2).split('\n')
  const nextLines = JSON.stringify(next ?? null, null, 2).split('\n')
  const removed = previousLines.filter((line) => !nextLines.includes(line))
  const added = nextLines.filter((line) => !previousLines.includes(line))
  const samples = [
    ...removed.slice(0, 6).map((line) => `- ${line.trim()}`),
    ...added.slice(0, 6).map((line) => `+ ${line.trim()}`),
  ]
  return `${before?.length ?? 0} → ${after?.length ?? 0} 字符；-${removed.length} / +${added.length} 行`
    + (samples.length ? `\n${samples.join('\n')}` : '')
}
