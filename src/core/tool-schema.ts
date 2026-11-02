/**
 * 角色可勾选的工具 → DSH `ctx.llm.stream({ tools })` 需要的 schema。
 *
 * 纯数据，不发网络请求，也不含任何模型地址/密钥：
 * 插件只把工具清单交给宿主 DSH，真正调模型的是 `ctx.llm`。
 */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function toolsForAllow(ids: string[] | undefined): ToolSpec[] {
  const allow = new Set(ids ?? [])
  const tools: ToolSpec[] = []
  if (allow.has('read') || allow.has('search')) {
    tools.push({
      name: 'list_dir',
      description: '列出关联项目里某个相对路径下的文件和目录。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对项目根的目录，空表示根目录' } },
      },
    })
  }
  if (allow.has('read')) {
    tools.push({
      name: 'read_file',
      description: '读取关联项目里的 UTF-8 文本文件（.dsh-im 内部状态目录不可读）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对项目根的文件路径' } },
        required: ['path'],
      },
    })
  }
  if (allow.has('search')) {
    tools.push({
      name: 'search_files',
      description: '在关联项目文本文件中搜索一段关键字（不搜 .dsh-im 内部状态目录）。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    })
  }
  if (allow.has('write')) {
    tools.push({
      name: 'write_file',
      description: '写到本群的群工作区（.dsh-im/groups/<本群>/下），用于纪要/草案/验收标准；不能改项目源码。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对群工作区的路径，例如 纪要/验收标准.md' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    })
  }
  if (allow.has('check')) {
    tools.push({
      name: 'run_check',
      description:
        '跑一次项目检查（不能装依赖、不能执行任意命令、不能写源码）：'
        + 'target="typecheck" 跑 `npx tsc -p tsconfig.json --noEmit`；'
        + '其余取值等价 `npx vitest run [目标]`（填相对工作区的测试文件/目录，省略表示全量）。'
        + '讨论 bug 需要证据时用它；跑不了先看报错里的“当前检查根”，那是群关联项目目录。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'typecheck，或相对工作区的测试文件/目录（省略=全量 vitest）' },
        },
      },
    })
  }
  if (allow.has('memory')) {
    tools.push({
      name: 'memory_search',
      description:
        '在当前会话的历史记录里检索相关旧消息（只返回句柄：#seq / 状态 / 作者 / 40 字标签，**不含原文**）。'
        + '句柄只表示"存在"，不要复述没看到的内容；需要原文时用 memory_expand 按 #seq 展开。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索词：可以用 #seq、引号里的原话、文件名、时间/编号、人名' } },
        required: ['query'],
      },
    })
    tools.push({
      name: 'memory_expand',
      description:
        '展开历史原文：传 seqs（如 "12" 或 "12,30"，最多 3 条、每条 600 字）按句柄展开；'
        + '或传 question 走同轮多跳展开（问题→章节目录→代表句柄→最多再跳一次，≤2 跳/轮；'
        + '回执里带 hops/expandChars/hopBudgetUsed，触顶会显式说明缺口）。两种形式都按不可信输入包裹。',
      parameters: {
        type: 'object',
        properties: {
          seqs: { type: 'string', description: '要展开的消息序号，如 "12" 或 "12,30"（最多 3 条）' },
          question: { type: 'string', description: '（可选）要查的问题；传了就按问题做多跳展开，和 seqs 二选一' },
          hops: { type: 'string', description: '（可选）多跳展开的跳数，目前上限 2，默认按上限执行' },
        },
      },
    })
  }
  return tools
}
