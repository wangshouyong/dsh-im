# 工具授权契约（TOOL-GRANTS）

> 角色能用工具，但不是"拿到整个宿主"。授权按「**内置能力** → **来源组** → **单工具**」三级授予，默认全不授予。

## 1. 授权条目的形状

角色的 `toolAllow` 是一个字符串数组，每一项只能是：

| 条目 | 含义 | 例子 |
| --- | --- | --- |
| `read` | 内置能力：读文件（`read_file`；`list_dir` 由 read 或 search 任一覆盖） | `read` |
| `search` | 内置能力：搜索文件内容 | `search` |
| `write` | 内置能力：写本群工作区（`.dsh-im/groups/<threadId>/`） | `write` |
| `check` | 内置能力：跑本仓检查（`vitest` / `tsc`） | `check` |
| `memory` | 内置能力：读历史（`memory_search` / `memory_expand` 句柄协议） | `memory` |
| `grp:<groupId>` | 整组授予**宿主**工具（含该组以后新增的工具） | `grp:browser`、`grp:mcp:<server>` |
| `tool:<toolName>` | 只授予**单个**宿主工具 | `tool:browser_navigate`、`tool:mcp__<server>__<tool>` |

旧数据兼容：`browser` → `grp:browser`，`image` → `grp:image`。

## 2. 来源组怎么来

DSH 的工具注册没有 owner / 来源元数据，唯一可靠信号是命名约定，因此分组顺序是：

1. **插件配置声明**：`dsh-im` 配置里的 `toolGroups`（部署方可以追加声明）；
2. **出厂声明**：已知的宿主插件（浏览器类工具、图像类工具）；
3. **MCP 命名约定**：`mcp__<server>__<tool>` → 归到 `mcp:<server>` 组；
4. **兜底**：未声明来源的工具统一进 `ext:other`，仍可单工具授权。

> 分组只影响"怎么勾选"，不改变可信级别：未显式授予的工具一律拒绝。

## 3. 强制的边界

- **未授权一律拒绝**：原生 session 用 `tools.guard` 做硬白名单（先按工具名判：插件内置工具 → 对应能力；宿主工具 → `tool:` / `grp:` 授权）；`tools.restrict(deny)` 只负责收窄可见性。
- **默认不授予宿主工具**：新建角色默认只勾内置能力；浏览器 / MCP / 其它宿主工具需要手动加。
- **连接器管理类工具永远不授予角色**：它们属于宿主管理面，与角色能力无关。
- **授权变化会重建原生会话**：工具可见性在会话创建时固定，不能原地放宽；签名变化后下一轮重建会话（该角色自己的原生记忆随之丢失，群窗口与事实仍按全量重新投喂）。
- **回退路径的限制**：`ctx.llm` 兼容路径没有宿主工具代理，只跑插件内置工具；此时界面必须明示"宿主工具本轮不可用"，不能假装可用。

## 4. 与「记忆可见性」的关系

记忆检索（`memory_search` / `memory_expand`）也受同一套可见性谓词约束：同群、同根、成员、禁言、系统消息五条规则，**search 与 expand 同权**（能搜到就必须能展开）。表即代码：`src/core/memory-visibility.ts`。

## 5. 排查

- 客户端：`GET /api/im/tool-groups` 返回当前可授予的来源组与单工具；
- 原生会话状态：`GET /api/im/native-status`（宿主能力缺失时 `enabled:false` 并给出原因）；
- 每条工具调用都会写进执行轨迹与 `metrics.jsonl`，拒绝原因可在轨迹里看到。
