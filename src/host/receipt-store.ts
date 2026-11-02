import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { groupDir } from './event-store.ts'
import { verifyReceipt, type ReceiptIntent, type ReceiptOutcome, type TurnReceipt } from '../core/receipt.ts'

/** 每群的回合回执：intent 先写，outcome 完成后补写。 */
export function receiptsPath(root: string, threadId: string): string {
  return join(groupDir(root, threadId), 'receipts.jsonl')
}

export async function appendIntent(root: string, threadId: string, intent: ReceiptIntent): Promise<void> {
  await mkdir(groupDir(root, threadId), { recursive: true })
  await appendFile(receiptsPath(root, threadId), JSON.stringify({ intent }) + '\n', 'utf8')
}

export async function appendOutcome(
  root: string,
  threadId: string,
  turnId: string,
  outcome: ReceiptOutcome,
): Promise<void> {
  await mkdir(groupDir(root, threadId), { recursive: true })
  await appendFile(receiptsPath(root, threadId), JSON.stringify({ turnId, outcome }) + '\n', 'utf8')
}

/** 读回执：坏行跳过；intent/outcome 按 turnId 合并成一个 TurnReceipt。 */
export async function readReceipts(root: string, threadId: string, limit = 200): Promise<TurnReceipt[]> {
  let raw: string
  try {
    raw = await readFile(receiptsPath(root, threadId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const byTurn = new Map<string, TurnReceipt>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as { intent?: ReceiptIntent; turnId?: string; outcome?: ReceiptOutcome }
      if (parsed.intent?.turnId) byTurn.set(parsed.intent.turnId, { intent: parsed.intent })
      else if (parsed.turnId && parsed.outcome) {
        const found = byTurn.get(parsed.turnId)
        if (found) found.outcome = parsed.outcome
      }
    } catch {
      continue
    }
  }
  return [...byTurn.values()].slice(-limit)
}

/** 最小回放：拿当前重算的窗口序号校验一条回执，失败时给出复现包。 */
export function replayTurn(receipt: TurnReceipt, currentWindowSeqs: readonly number[]) {
  const verdict = verifyReceipt(receipt.intent, currentWindowSeqs)
  if (verdict.ok) return { ok: true as const }
  return {
    ok: false as const,
    reason: verdict.reason ?? '不一致',
    capsule: {
      turnId: receipt.intent.turnId,
      personaId: receipt.intent.personaId,
      model: `${receipt.intent.provider}/${receipt.intent.model}`,
      expectedWindowSeqs: receipt.intent.windowSeqs,
      actualWindowSeqs: [...currentWindowSeqs],
      summaryUntil: receipt.intent.summaryUntil,
      versions: receipt.intent.versions,
      promptHash: receipt.intent.promptHash,
    },
  }
}
