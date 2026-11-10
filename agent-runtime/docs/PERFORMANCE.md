# Turn 性能与循环分析

> 记录一次真实大文件 Skill 调用的性能问题、根因和修复。日期：2026-11-05。

## 1. 案例

任务：

```text
D:\expirmentalArea\TestFileFold\intern_test.sql   （2490 行 / 136 KB）
@etlsql_adapter 使用此 skill 改造，新 SQL 放同目录新文件
```

结果：

- 时长：约 **991s**（用户配置 `turnTimeoutMs=600000`，但 Codex 在归一化 turn 结束后仍在运行）
- token：约 **9.7M**
- Codex 记录：**157 次 commandExecution**、**121 个 reasoning item**、14 个 agentMessage
- tool 输出：约 **444k 字符**
- 失败：16 次，其中 6 次 Git Bash 启动失败（`couldn't create signal pipe` / `CreateFileMapping ... Win32 error 5`）
- context compaction：1 次

## 2. 根因

### 2.1 步数上限思路不合适

`Limits` 只被传给 runtime，但 Codex adapter 只使用了 `turnTimeoutMs`；`maxSteps` 和
`maxToolCallsPerTurn` 没有在事件流中计数。用户设置的 `maxSteps=12` 实际无效，
任务继续跑到 157 次工具调用。

后来评估认为直接按步数硬停会误伤大任务（2490 行 SQL 本来就需要很多步），
因此最终选择**移除步数硬中断**，改为超时 + 循环检测 + reasoning effort。

### 2.2 TurnGuard 超时只结束归一化 turn，没有中断 Codex

`TurnGuard` 在 600s 时发出 `error(TIMEOUT)` + `turn.end(error)`，但 Codex app-server
的底层 turn 没有被 `turn/interrupt`，模型继续读文件/执行命令，token 继续消耗。

### 2.3 大文件读取 + 全量重写放大上下文

模型先分块读取 2490 行 SQL，再反复读取生成的新 SQL 做校验；每一步都会把累积上下文
重新发给模型。157 次工具调用 × 逐步增长的上下文，是 9.7M token 的主要乘数。

### 2.4 环境选择错误（历史）

模型曾尝试 Git Bash，但 Codex 0.165/0.166 的 Windows sandbox 使用 restricted
token，MSYS2 启动时需要创建 signal pipe，会报 `couldn't create signal pipe,
Win32 error 5`；PowerShell 5.1 又不支持 `&&`。该尝试已回退，当前 Codex 统一使用
PowerShell；bash-capable runtime 作为 PENDING-1 暂缓（见 HANDOFF §10）。

## 3. 已修复

| 修复 | 位置 |
|---|---|
| 移除按步数硬中断，改为超时 + 循环检测 + reasoning effort 控制 | `extension/src/controller.ts` |
| 超时/异常 `turn.end` 时向 Codex 发送 `turn/interrupt` | `agent-runtime/src/runtime/codex/index.ts` |
| 推理强度可配置，默认 `medium`；低强度减少 thinking 时间/token | `agent-runtime/src/runtime/codex/index.ts`、extension settings |
| 禁止依赖 `sqlparse` 等未安装包；禁止重复读同一文件/重复命令 | `extension/src/settings.ts` |
| 大文件（约 >500 行或 >50KB）先出计划、targeted edit，不整文件重写 | `extension/src/settings.ts` |
| `@skill-id` 已注入，不要读 skill 目录 | `extension/src/settings.ts` |
| 回退 Codex Windows 默认 PowerShell；移除 Git Bash 探测/PATH 注入/Shell 设置 | `extension/src/settings.ts`、`extension/src/runtime-host.ts` |
| Reasoning summary 可折叠展示（不影响 token，改善可观测性） | runtime + webview |

## 4. 后续建议

1. **工具输出预算**：将 `maxOutputCharsPerTool` 真正用于 runtime/上下文；当前只限制 UI 展示。
2. **成功重复检测**：除失败循环外，检测同一文件反复读取、同一命令重复执行。
3. **上下文压缩**：在 N 步后压缩旧工具输出，只保留文件变更摘要和最近关键输出。
4. **大文件专用策略**：先结构索引/计划，再按段落生成；禁止一次性全文件重写。
5. **bash-capable runtime**：见 HANDOFF §10 PENDING-1；当前 Codex 使用 PowerShell，不在 adapter 内继续折腾 MSYS2。
6. **Skill 目录外的输入**：Skill 内容通过 `@` 注入，不应让模型再从磁盘读取 skill 目录。

## 5. Shell 选择

- 这次命令执行总时长只有约 52s，Shell 选择不是性能主因；
- Codex 在 Windows 上默认使用 PowerShell；`windows.shell_path` 尚未实现，
  `<environment_context>` 也会写 `<shell>powershell</shell>`；
- Git Bash 在 Codex Windows sandbox 内会因 MSYS2 signal pipe 失败，已回退；
- 当前不注入 Git Bash PATH、不设置 `agentbox.codex.shell`；
- 后续若需要 Bash，走 bash-capable runtime（OpenCode / NativeRuntime），
  见 HANDOFF §10 PENDING-1；
- PowerShell 模式下写文件仍需显式 UTF-8（`Set-Content -Encoding UTF8`），
  避免中文乱码。

## 6. 复现与验证

- 同类任务使用 `reasoningEffort=medium/low`，观察 thinking 时间和步数变化；
- 使用 `turnTimeoutMs=300000` 时，超时后 Codex 进程不应继续执行工具；
- 检查 `AgentBox Chat` 日志和 Codex `thread_history` 的 turn duration/item 数。
