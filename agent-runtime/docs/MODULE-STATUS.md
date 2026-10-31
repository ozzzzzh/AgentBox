# 模块完成状态（MODULE-STATUS）

> 每完成一个模块，更新本表与"模块详情"。
> 模块规格、边界与验收标准见 [MODULES.md](MODULES.md)。
>
> 状态：⬜ 未开始 · 🚧 进行中 · ✅ 已完成 · ⛔ 阻塞
> 最后更新：2026-10-31

---

## 1. 总览

> **Milestone 1 — Codex Runtime 集成：✅ 已封版（2026-10-30）**
> 见 [MILESTONE-1.md](MILESTONE-1.md)。
> **UI-1 — Webview 侧边栏：✅ 已完成（2026-10-31）**；方案见 [UI-PROPOSAL.md](UI-PROPOSAL.md)。
> 下一阶段：UI-2（持久化/原生 diff/重试）。

| 模块 | 状态 | 完成日期 | 关键产物 | 本模块测试 | 验证结果 |
|---|---|---|---|---|---|
| **P0** 运行时探测 | ✅ | 2026-10-30 | [RUNTIME-PROBE.md](RUNTIME-PROBE.md) + `.probe/` 日志/schema | — | 协议/取消/认证/沙箱/DeepSeek E2E/10 条 eval 完成；内网 Qwen、断网验证为生产跟进 |
| **M1** 契约、配置校验与工程边界 | ✅ | 2026-10-28 | `src/types.ts`、`src/errors.ts`、`src/config.ts`、`scripts/check-boundaries.mjs` | 27 | build / test / boundaries 全部通过 |
| **M2** 安全工具 | ✅ | 2026-10-28 | `src/security/paths.ts`、`redact.ts`、`env.ts`、`index.ts` | 31 | build / test / boundaries 全部通过 |
| **M3** 进程管理 | ✅ | 2026-10-28 | `src/process.ts` + fixtures | 12 | build / test / boundaries 通过；Windows 进程树终止测试通过 |
| **M4** 事件总线与 Turn 守卫 | ✅ | 2026-10-28 | `src/events.ts`、`src/turn.ts` | 18 | build / test / boundaries 全部通过 |
| **M5** FakeRuntime + 契约测试 | ✅ | 2026-10-28 | `src/testing/fake-runtime.ts`、`src/testing/contract.ts` | 14 | 契约套件 10 项全部通过 |
| **M6** Codex adapter | ✅ | 2026-10-30 | `src/runtime/codex/{index,jsonrpc,mapping,config}.ts` + mock | 15 | contract suite + 真实 DeepSeek E2E 通过 |
| **M7** OpenCode adapter | ⬜ | — | — | — | 暂缓（用户决定） |
| **M8** CLI + JSONL | ✅ | 2026-10-30 | `src/cli/{index,args,run,jsonl,config}.ts` | 15 | 真实 CLI smoke 通过（DeepSeek，exit 0） |
| **M9** Eval harness | ✅ | 2026-10-30 | `src/eval/*`、`eval/tasks.json`、`eval/results/*` | 9 | 10 条基线：9/10（90%） |
| **M10** 打包与接入契约 | ✅ | 2026-10-30 | exports / NOTICE / LICENSE / COMPATIBILITY / examples | — | `npm pack --dry-run` 干净；`example:fake` 运行通过 |
| **V1** VS Code Walking Skeleton | ✅ | 2026-10-28 | `extension/` 独立包 + `agentbox-0.1.0.vsix` | 9 | typecheck / build / test / vsce / 隔离安装通过 |
| **V2** 真实 Codex VSIX | ✅ | 2026-10-30 | `extension@0.2.0` + `agentbox-0.2.0.vsix` | 13 + 1 real | 真实 VS Code UAT 通过：写文件、审批 Allow/Deny、Cancel |
| **V3** 双 runtime VSIX | ⬜ | — | — | — | 待 M7/M8 |
| **V4** Release VSIX | ⬜ | — | — | — | 待 V4 发布流程（M9/M10 已就绪） |
| **UI-1** Webview 侧边栏 MVP | ✅ | 2026-10-31 | `extension@0.3.0` + `agentbox-0.3.0.vsix` | 67 | build / test / package / 隔离安装通过；含多会话与编辑器面板 |

**当前累计**：208 个测试通过（默认套件）。

- `agent-runtime`：141 个测试 / 14 个文件（含 CLI 15、eval 9）
- `extension`：67 个测试 / 11 个文件（controller 11、settings 7、chat-view 17、timeline 5、context 5、webview-ui 5、file-policy 6、project-instructions 4、loop-detector 4、task-profile 2、bundle 1）
- 另有 1 个真实 Codex 集成测试（`V2_E2E=1` 手动运行）已通过。
- 10 条 eval 基线已跑通：9/10（90%）。

验证命令：

```powershell
npm run verify   # build + vitest + check-boundaries
```

---

## 2. 模块详情

### P0 — 运行时探测 🚧

**已完成**

- 本地隔离安装 pin 版本：`codex-cli 0.165.0`（Apache-2.0）、`opencode 1.19.4`（MIT）。
- Codex：
  - 用 `generate-json-schema` / `generate-ts` 固定完整协议；
  - 确认 stdio 为逐行 JSON（无 `jsonrpc` 字段）；
  - `initialize` → `getAuthStatus` → `thread/start` → `turn/start` 全链路；
  - `turn/interrupt` 实测 9ms 内 `turn/completed(status=interrupted)`；
  - 确认 provider 配置 `wire_api="responses"`、自定义 provider 下不要求 OpenAI 登录。
- OpenCode：
  - `serve` 默认 `127.0.0.1:0`，health/OpenAPI/session/SSE 全部可用；
  - Basic auth（`OPENCODE_SERVER_USERNAME/PASSWORD`）实测 401/200；
  - `/session/{id}/abort` 实测 686ms 内 idle；
  - provider 配置走 `@ai-sdk/openai-compatible` / `/v1/chat/completions`。
- 记录遥测/更新/分享关闭项与错误脱敏要求。
- **DeepSeek 公网模型 E2E（2026-10-29）**：
  - Codex：`deepseek-flash` + `/v1/responses`，文本 + commandExecution 审批 + 写出 `codex-ok`；
  - OpenCode：`deepseek-flash` + `/v1/chat/completions`，文本 + edit 权限审批 + 写出 `opencode-ok`；
  - 均只使用合成 `.probe/workspace*` 目录。

**关键发现 / 阻塞**

1. **Codex Windows sandbox 已修复（2026-10-29）**：
   - `setupStart({mode:"unelevated"})` 成功；同一进程 readiness 缓存为 `notConfigured`，
     **重启 app-server 后变为 `ready`**。
   - 修复后 `workspaceWrite`/`:workspace` 允许 workspace 内写入、外写 `EPERM`；
     `readOnly` 内写也 `EPERM`。
   - 沙箱生效后 Codex + DeepSeek 仍能完成文本、审批、workspace 内文件写入。
   - 前置：每台 Windows 机器首次需 setup；`thread/shellCommand` 仍 unsandboxed。
2. **内网 LiteLLM/Qwen 仍未验证**：当前无内部可用 LLM；DeepSeek 是公网过渡。
3. OpenCode 未设密码时服务无认证，`/config` 会返回明文 apiKey；M7 必须开 Basic auth。
4. Codex/OpenCode 错误体可能包含部分 key / key hash，事件必须脱敏。
5. Codex 0.165 忽略 `preferred_auth_method`；`deepseek-flash` 模型元数据缺失会 fallback，
   后续需 `model_catalog_json`（不阻塞协议冒烟）。
6. OpenCode 的 DeepSeek 模型 ID 必须用 `deepseek-flash`；`deepseek-v4-flash` 会报
   `ProviderModelNotFoundError`。

**产物**

- [RUNTIME-PROBE.md](RUNTIME-PROBE.md)（完整报告与复现命令）
- `agent-runtime/.probe/logs/`（原始日志、Codex schema/TS、OpenCode OpenAPI）
- `agent-runtime/.probe/codex-home/`、`agent-runtime/.probe/opencode-home/`（隔离配置）

**下一步**

- **M10 打包/接入契约** ✅：exports、NOTICE、兼容矩阵、consumer 示例、pack 检查。
- **M7（OpenCode adapter）→ V3**：按需再做（当前暂缓）。
- 内网 Qwen/Qwen3-Coder 与断网/防火墙验证：生产部署前跟进。
- Windows 首次启动需检测 `windowsSandbox/readiness`；`notConfigured` 时执行
  `setupStart(unelevated)` 并重启 app-server（M6 已实现）。

---

### M1 — 契约、配置校验与工程边界 ✅

**完成内容**

- `src/types.ts`
  - `AgentRuntime` 增加 `resolveApproval(turnId, callId, decision)`。
  - `TurnInput.limits` 改为 `Partial<Limits>` 单次覆盖；`RuntimeConfig.limits` 为默认值。
  - `turn.start` 支持 `metadata` 回显。
  - 导出 `AGENT_EVENT_SCHEMA_VERSION = 1`；`DEFAULT_LIMITS` 冻结。
- `src/errors.ts`
  - 新增 `INVALID_ARGUMENT`、`TURN_IN_PROGRESS`、`APPROVAL_NOT_PENDING`。
- `src/config.ts`
  - `validateRuntimeConfig` / `validateTurnInput` / `resolveLimits` / `resolveTurnLimits`。
  - 校验 workspaceRoot 存在且为目录、limits 正整数与未知字段、OpenCode 仅 loopback、端口范围、env/command 类型。
- `src/runtime/factory.ts`：创建前先校验配置。
- `scripts/check-boundaries.mjs`：禁止 `src/` import `vscode` / `pluginVersion`。

**测试**：`tests/config.spec.ts`（22）、`tests/factory.spec.ts`（5）。

**备注**

- Codex/OpenCode adapter 仍为 stub；`start()` / `resolveApproval()` 抛 `NOT_IMPLEMENTED`。
- 配置校验在 `createRuntime` 中同步执行，失败抛 `INVALID_CONFIG` / `INVALID_RUNTIME`。

---

### M2 — 安全工具 ✅

**完成内容**

- `src/security/paths.ts`
  - `assertInsideWorkspace`：词法解析 + 工作区约束，拒绝 `..`、绝对路径逃逸、兄弟目录前缀、空路径、null byte、Windows drive-relative。
  - `toWorkspaceRelative`：输出 POSIX 分隔符、无前导 `/`、无 `..`，根路径映射为 `.`。
  - `assertRealPathInsideWorkspace`：解析 symlink / junction，防止工作区内链接逃逸；允许不存在的尾部路径段。
- `src/security/redact.ts`
  - `redactSecrets`：按长度降序字面替换，避免前缀截断；忽略空密钥。
  - `redactDeep`：递归脱敏对象/数组的字符串值与 key，支持循环引用，不修改输入。
- `src/security/env.ts`
  - `buildChildEnv`：Windows/POSIX 默认白名单 + 显式附加；默认不继承 `MODEL_API_KEY` 等密钥；extra 显式注入/覆盖；Windows 大小写不敏感。
- `src/security/index.ts`：内部入口，不导出到主入口。

**测试**：`tests/security/paths.spec.ts`（15）、`redact.spec.ts`（9）、`env.spec.ts`（7）。

**错误语义**

- 路径逃逸 → `RuntimeError('POLICY_DENIED')`。
- 空路径、null byte、drive-relative、工作区不可访问 → `RuntimeError('INVALID_ARGUMENT')`。

**已知限制（后续模块处理）**

- shell allowlist / 命令策略不在 M2，属于调用方 Policy 与后续阶段。
- `redactDeep` 只深拷贝 plain object / array；Date、Map 等对象原样返回（事件载荷预期为 JSON-like）。
- 路径工具默认不解析 symlink；需要安全边界时使用 `assertRealPathInsideWorkspace`。

**下游依赖**

- M3 进程管理使用 `buildChildEnv`。
- M6/M7 adapter 使用路径约束与脱敏。

---

### M3 — 进程管理 ✅

**完成内容**

- `src/process.ts`
  - `spawnManaged(options)`：command/args 分离、`shell: false`，避免 shell 注入。
  - 环境变量走 M2 的 `buildChildEnv`：默认白名单 + 显式 `env` / `envAllowlist`，不继承父进程密钥。
  - `ManagedProcess`：`pid` / `running` / `exited` / `write` / `onStdoutLine` / `onStderrLine` / `onExit` / `kill`。
  - 行缓冲：处理 CRLF、跨 chunk 半行、结尾无换行的最后一行；`maxLineChars` 截断并限制内存增长。
  - 生命周期：`exited` 在进程退出且 stdio 关闭后 resolve；`onExit` 在进程 exit 时触发。
  - Windows：`taskkill /pid <pid> /T /F` 杀整棵进程树，超时后回退 `child.kill()`。
  - POSIX：`detached` 进程组，先 SIGTERM 后 SIGKILL。
  - `kill()` 幂等；已退出/未 spawn 成功时安全返回。
  - 选项校验：命令、cwd、args、env、envAllowlist、maxLineChars、killGraceMs。

**测试**：`tests/process.spec.ts`（12）+ `tests/fixtures/process/line-writer.cjs`。

覆盖：分块行/CRLF/最后半行、stderr + 非零退出、onExit、stdin 写入、密钥不继承与显式注入、
超长行截断、kill 幂等、Windows 子进程+孙进程树终止、spawn 失败、退出后 write、参数校验、退订。

**错误语义**

- 参数非法 → `INVALID_ARGUMENT`
- spawn 失败 → `exited` reject `SPAWN_FAILED`
- 进程未运行仍 write → `NOT_RUNNING`

**已知限制**

- 协议无关：不解析 JSON-RPC/HTTP，不做业务级重启策略（由 adapter 决定）。
- POSIX 进程组终止是 best effort；Windows 树终止依赖系统 `taskkill`。
- `onExit` 可能早于 stdout 最后一行 flush；需要完整输出时以 `exited` 为准。

**下游依赖**

- M6 Codex adapter：`codex app-server` 的 spawn / stdio / 取消 / 停止。
- M7 OpenCode adapter：`opencode serve` 的启动 / 退出 / 端口释放。

---

### M4 — 事件总线与 Turn 守卫 ✅

**完成内容**

- `src/events.ts`
  - `EventBus.on/emit/clear`；emit 使用 listener 快照，允许监听器在分发期间订阅/退订。
  - 单个 listener 抛错不影响其他 listener；可通过 `onListenerError` 观测。
- `src/turn.ts`
  - `TurnGuard.begin`：单活动 turn，重复 begin 抛 `TURN_IN_PROGRESS`。
  - 自动发 `turn.start`，注入 `turnId` / `at`；`metadata` 仅在提供时回显。
  - `TurnContext.end`：`turn.end` 恰好一次；结束后迟到事件丢弃；结束前取消所有 pending 审批（调用 `onCancel`）。
  - 超时：`turnTimeoutMs` 到点发 `error(TIMEOUT)` + `turn.end('error')`。
  - `requestApproval` + `resolveApproval(turnId, callId, decision)`：审批双向契约；未知/重复/迟到回执抛 `APPROVAL_NOT_PENDING` 或 `INVALID_ARGUMENT`。
  - 允许注入 `now` / `setTimer` / `clearTimer` / `turnIdFactory`，便于确定性测试。
- 禁止通过 `emit` 伪造 `turn.start` / `turn.end`（运行时抛 `INVALID_ARGUMENT`）。

**测试**：`tests/events.spec.ts`（5）、`tests/turn.spec.ts`（13）。

**已知限制**

- 审批没有独立超时；由 turn 总超时兜底。
- `onListenerError` 默认 no-op，避免日志泄露事件内容；需要时由调用方注入。

**下游依赖**

- M5 FakeRuntime 基于 TurnGuard 实现 turn 生命周期。
- M6/M7 adapter 必须通过 TurnGuard 发事件与处理审批。

---

### M5 — FakeRuntime + 契约测试套件 ✅

**完成内容**

- `src/testing/fake-runtime.ts`
  - `FakeRuntime` 实现完整 `AgentRuntime`，支持脚本化步骤：
    `text` / `tool` / `file` / `error` / `approval` / `delay`。
  - 支持 `enqueueTurn()` 排队脚本、默认脚本、能力覆盖、`abort()` / `stop()`。
  - `createFakeRuntimeContractFixture()` 将 FakeRuntime 接入统一契约套件。
- `src/testing/contract.ts`
  - `runtimeContractSuite(name, createFixture)` + `RuntimeContractFixture`：
    `startLongTurn` 必填；`startNormalTurn` / `startFailedToolTurn` / `startApprovalTurn` 可选。
  - 9 个通用契约用例：start/stop 幂等、事件顺序与唯一 turn.end、并发拒绝、tool 成对、
    abort 5 秒内 cancelled、审批回执、超时、结束后丢弃事件、退订生效。
  - adapter 专有的"无残留进程/端口"由各 adapter 测试补充。
- 测试-only：`src/testing/` 不从包主入口导出。

**测试**：`tests/contract/fake.spec.ts`（14 = 9 契约 + 5 FakeRuntime 专项）。

**已知限制**

- `startFailedToolTurn` / `startApprovalTurn` 未提供时，对应用例跳过；M6/M7 必须提供。
- FakeRuntime 只模拟事件形状，不校验真实协议。

**下游依赖**

- M6/M7 adapter 复用 `runtimeContractSuite`。
- V1 VSIX 使用 FakeRuntime 打通端到端链路。

---

### M6 — Codex adapter ✅

**完成内容**

- `src/runtime/codex/config.ts`
  - 从 `RuntimeConfig` 生成隔离 `CODEX_HOME/config.toml`；
  - `wire_api="responses"`；DeepSeek/内网 provider 可切换；
  - 可选 `model_catalog_json`；临时 home 在 stop 时清理。
- `src/runtime/codex/jsonrpc.ts`
  - 逐行 JSON（无 `jsonrpc` 字段）；请求/id 关联/超时/通知/服务端请求；
  - 服务端请求回执；退出时 reject 所有 pending。
- `src/runtime/codex/mapping.ts`
  - `item/started|completed` → tool.start/end；
  - `commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall`；
  - `file.changed` 路径归一化为 workspace 相对 POSIX；
  - 审批请求/决策映射（新 command/file + legacy exec/applyPatch）；
  - `thread/tokenUsage/updated` → `token.usage`（`last` 本轮 / `total` 线程累计）。
- `src/runtime/codex/index.ts`
  - spawn `codex app-server --listen stdio://`（M3）；
  - initialize → Windows sandbox readiness → thread/start → turn/start；
  - `thread/start` 支持可选 `developerInstructions`（消费者注入环境/文件卫生提示词）；
  - `notConfigured` 时自动 `setupStart(unelevated)` 并重启 app-server；
  - 文本/tool/file/turn.completed/error/token.usage 事件映射；
  - 审批双向（approval.request + resolveApproval）；
  - abort：turn/interrupt；5s 未停杀进程树并 `turn.end(cancelled)`；
  - 崩溃：error + turn.end(error)；
  - API key 错误消息脱敏。
- 测试：`tests/runtime/codex/codex.spec.ts`（15）+ `tests/fixtures/codex/mock-app-server.cjs`。
  - 复用 M5 contract suite（9 项）+ 适配器专项（映射、approval allow、崩溃、config、sandbox 未配置）。

**真实集成结果（2026-10-30）**

- Codex + DeepSeek（`deepseek-flash`）：
  - 新临时 `CODEX_HOME` 自动 setup Windows sandbox，重启后 readiness=`ready`；
  - 真实 turn 输出文本、tool.start/end、写出 workspace 内文件、`turn.end(end_turn)`；
  - 未出现残留进程。
- 备注：DeepSeek 曾把 `apply_patch` 当 PowerShell 命令调用失败，随后改用 `Set-Content` 成功；
  这是模型行为，不是 adapter 协议问题。

**已知限制**

- 进程崩溃后不自动重连；调用方需重新 `start()`。
- `file.changed` 依赖 Codex `fileChange` item；模型通过 shell 写文件时不会产生该事件，
  V2 应叠加 VS Code 文件 watcher 兜底。
- `item/permissions/requestApproval` 的 allow 只回传请求 profile；deny 以 JSON-RPC error 表达；
  未做真实 E2E（当前 workspace 场景未触发）。
- 临时 CODEX_HOME 每次 start 都会重新 setup sandbox；V2 应传持久 `codex.home` 复用状态。
- DeepSeek 模型元数据仍走 fallback；M6 支持 `modelCatalogJson`，后续补文件。
- 未实现知识/Skill 注入；`TurnInput.context` 仅作为文本前缀拼入 prompt。

**下游**

- V2：VS Code extension 从 FakeRuntime 切到 `CodexRuntime`；
- M7：OpenCode adapter（暂缓）。

---

### M8 — CLI + JSONL ✅

**完成内容**

- `src/cli/args.ts`：`run` / `replay` / `eval` 参数解析；provider/model/baseUrl/key/env/home/approval 等。
- `src/cli/config.ts`：env 文件解析；workspace/home 解析为绝对路径；key 仅通过 `codex.env` 传递。
- `src/cli/jsonl.ts`：事件/摘要逐行 JSON；读取与行号错误。
- `src/cli/run.ts`：单 turn 驱动、审批 allow/deny、AbortSignal、summary、首 token/steps/toolErrors。
- `src/cli/index.ts`：CLI 入口、退出码（0/1/2/130）、SIGINT abort、replay。
- `package.json` bin：`agentbox` → `dist/cli/index.js`。

**测试**：args 5 + jsonl 3 + run 4 + config 3 = 15。

**真实 smoke**：Codex + DeepSeek 写文件，exit 0，steps=1，3.8s；JSONL summary 正确。

**已知限制**

- `opencode` runtime 仍为 stub（M7 暂缓），CLI 会报 `NOT_IMPLEMENTED`。
- 默认 `--approval deny`；eval 需要显式 `allow`（task10 在任务级覆盖为 deny）。
- token usage 尚未从 Codex 事件映射，summary 不含 tokens。

---

### M9 — Eval harness ✅

**完成内容**

- `eval/tasks.json`：10 条任务（读/改/修语法/docstring/搜索/重命名/pytest/写测试/SQL/危险命令）。
- `src/eval/types.ts` / `checks.ts`：text、file、python-compile、command、all、approval+file 检查。
- `src/eval/runner.ts`：临时 fixture、逐任务 runtime、JSONL、report.json/report.md。
- `src/eval/metrics.ts` / `report.ts`：成功率、steps、duration、首 token、审批、tool errors。
- CLI `eval` 命令：`--tasks` / `--out-dir` / `--task` / provider 参数。

**测试**：checks 4 + metrics 2 + runner 3 = 9。

**基线（2026-10-30，Codex + DeepSeek）**

- 结果：**9/10（90%）**，达到 ≥80% KPI。
- 指标：avg steps 6.9；avg duration 41.4s；avg first token 2.7s；approvals 2；tool errors 22。
- 安全任务（危险命令审批）通过：`approvals=1`、`important.txt` 未被删除。
- 失败：`add-test` 的功能检查通过（测试 1 passed），但 turn 在 180s 超时（模型成功写测试后停顿），严格口径记为失败。
- 报告：[eval/results/2026-10-30-codex-deepseek/report.md](../eval/results/2026-10-30-codex-deepseek/report.md)
- 主要风险：DeepSeek/Windows 下 `apply_patch` 反复失败导致 tool errors 偏高；建议 `maxSteps` 24–30、补 `model_catalog_json`。

**已知限制**

- M7/OpenCode 暂缓，基线只有 Codex；双 runtime 对比待 M7。
- token 指标未采集，报告用 null/省略。
- task 8 是 turn timeout，不是 check 失败；报告已保留该区分。
- 每个任务独立 `CODEX_HOME` 状态复用同一持久 home；并发未测试。

---

### M10 — 打包与接入契约 ✅

**完成内容**

- `package.json`
  - exports：`.`、`./testing`、`./package.json`；
  - `files`：`dist`、README、LICENSE、NOTICE、examples；
  - `bin`：`agentbox` → `dist/cli/index.js`；
  - `verify` 增加 examples typecheck；新增 `pack:check`。
- `LICENSE`：Apache-2.0；`NOTICE`：Codex Apache-2.0 / OpenCode MIT，明确二进制不随包分发。
- `docs/COMPATIBILITY.md`：Codex 0.165.0、OpenCode 1.19.4、Node 18+、VS Code 1.85+、
  DeepSeek provider、事件 schema 版本与风险。
- `examples/consumer.ts`：`createRuntime` + `AgentRuntime` + `AgentEvent` 接入示例（typecheck 通过）。
- `examples/run-fake.cjs`：`npm run example:fake` 可运行，输出 turn 生命周期并完成。
- `tsconfig.examples.json`：独立 typecheck，不影响主构建。
- `scripts/clean.mjs`：构建前清理 dist，避免旧的 test-only contract/fixture 进入包。

**验证**

- `npm run verify`：141 个测试 + examples typecheck + boundaries 通过。
- `npm pack --dry-run`：93 个文件，约 72.8 KB；包含 LICENSE/NOTICE/README/dist/examples；
  **不包含** `dist/testing/contract` / `fixture` / node_modules / src。
- `npm run example:fake`：正常输出 `turn.start → text.delta → tool.start/end → turn.end`。

**已知限制**

- `examples/consumer.ts` 通过 tsconfig paths 对源码做 typecheck；实际安装消费用包 exports。
- OpenCode adapter 暂缓，兼容矩阵中的 OpenCode 仅探测状态。
- 包仍为 `private`，未发布公共 npm；内部分发用 tarball/VSIX。

---

### V1 — VS Code Walking Skeleton ✅

**完成内容**

- 独立包 `extension/`（与 `agent-runtime/` 同级），不修改 `agent-runtime/src`。
- `extension/src/controller.ts`：headless `RuntimeController`，通过 `TurnUi` 接口隔离 VS Code。
- `extension/src/ui/vscode-ui.ts`：OutputChannel、审批模态、状态栏 / `agentbox.busy` context key。
- `extension/src/extension.ts`：激活、命令、设置、controller 生命周期、FakeRuntime 演示脚本。
- 命令：`agentbox.runTurn` / `agentbox.cancelTurn` / `agentbox.showOutput`。
- 设置：`agentbox.runtime`（仅 fake）、`agentbox.limits.turnTimeoutMs`、`agentbox.limits.maxSteps`。
- 构建：esbuild target `node18`，`vscode` external；VSIX 不包含 node_modules。
- runtime 增加 `@agentbox/runtime/testing` 子路径导出 `FakeRuntime`（主入口仍不导出测试代码）。

**测试**：`extension/tests/controller.spec.ts`（8）+ `bundle.spec.ts`（1）= 9。

**验证结果**

- `npm run verify`：runtime build + extension typecheck + 9 个测试通过。
- `npm run package`：产出 `extension/agentbox-0.1.0.vsix`（16.96 KB，6 个文件）。
- `code --install-extension ... --extensions-dir <隔离目录>` 安装成功。
- bundle smoke test：在 mock `vscode` 下加载 `dist/extension.js`，3 个命令均注册。

**人工验收**

- 已在真实 VS Code 执行 `AgentBox: Run Turn`，确认：
  - 文本流、`read_file` tool、`file.changed` 正常显示；
  - 审批弹窗选择 **Allow** 后继续；
  - 最后 `■ turn end_turn`。
- 建议补测：审批 **Deny**、2 秒窗口内 **Cancel**（本次日志未覆盖）。
- **后续 UI 需求（已确认，暂不阻塞 M3/M6）**：
  - 侧边对话栏（类似 Claude Code）；
  - 显示/使用当前聚焦文件与选区作为上下文。

**已知限制**

- 仅 FakeRuntime；不读写真实文件、不接模型。
- 无 Chat webview、会话历史、多会话、知识/Skill UI。
- 模态审批在 turn 被取消时可能仍停留，关闭即可。
- 固定第一个 workspace folder；切换工作区会重建 controller。

---

### V2 — 真实 Codex VSIX ✅（人工 UAT 通过）

**完成内容**

- `extension/src/extension.ts`
  - `agentbox.runtime = codex` 时创建真实 `CodexRuntime`；`fake` 保留用于 UI 冒烟。
  - 持久 `CODEX_HOME`：默认 `context.globalStorageUri/codex-home`，可用 `agentbox.codex.home` 覆盖。
  - API key 解析顺序：SecretStorage → 进程环境变量 → `agentbox.envFile`（支持 `${workspaceFolder}`）。
  - 外部 provider 首次运行弹窗确认；取消则不启动。
  - 命令：Run Turn / Cancel / Show Output / Set API Key / Clear API Key / Restart Runtime。
- `extension/src/settings.ts`
  - `.env` 解析；`ModelSettings` → `RuntimeConfig`（provider/baseUrl/apiKeyEnv/scope/home/approvalPolicy/permissions/autoSetupSandbox）。
- `extension/src/controller.ts` / `ui/vscode-ui.ts` 复用 V1；真实审批/取消事件已接通。
- VS Code 设置新增 `agentbox.codex.*`、`agentbox.envFile`。

**测试与验证**

- 默认套件 13 个：controller 8 + settings 4 + bundle 1。
- 真实 Codex + DeepSeek 集成测试（`extension/tests/v2-real.spec.ts`，`V2_E2E=1`）：
  - 通过 `RuntimeController` 启动真实 Codex、DeepSeek；
  - 自动 sandbox setup；完成写文件 turn；文件内容校验通过；8.7s。
- `extension/agentbox-0.2.0.vsix` 已打包（30.07 KB），隔离扩展目录安装成功。

**人工 UI 验收**

- ✅ **主路径已通过**（真实 VS Code）：
  - `AgentBox: Run Turn` 成功创建 `agentbox-v2.txt`，内容 `hello from AgentBox`；
  - Output 正确显示 text/tool 事件与 `■ turn end_turn`；
  - 使用持久 `CODEX_HOME`（`globalStorage/.../codex-home`）。
- 日志显示 DeepSeek/Windows shell 摩擦：
  - `apply_patch` 经 PowerShell 传 here-string 时被截断/引号破坏，前两次失败；
  - Codex 找到临时 `apply_patch.bat`，但 `bash --version` 在 sandbox 下报
    `CreateFileMapping ... Win32 error 5`；
  - 最终模型改用 PowerShell 构造 patch 成功。
  - 这是模型/Windows shell 行为，不是 adapter 事件映射问题；但会消耗 steps。
- 建议：
  - 将 `agentbox.limits.maxSteps` 提到 **24–30**（本次一个文件写入用了约 7 次 tool call，默认 12 偏紧）；
  - 后续补 `model_catalog_json`，减少 DeepSeek 元数据 fallback 导致的工具调用偏差；
  - 需要 bash 的任务可能仍受 sandbox/Git Bash 限制，优先用 PowerShell/git.exe。
- **Headless 真实 Codex 审批/取消 UAT（2026-10-30）**：
  - `approvalPolicy=untrusted` + `Get-ChildItem`：触发 `approval.request(commandExecution)`；
    Deny 后 `tool.end ok=false`，turn `end_turn`，命令未执行。
  - workspace 外写文件 prompt：同样触发 commandExecution 审批；Deny 后外部文件不存在。
  - Cancel：`PowerShell Start-Sleep 30s` 运行中 abort → `turn cancelled`，耗时 **124ms**。
  - 脚本：`.probe/v2-approval-cancel-probe.cjs`。
- ✅ **VS Code UI UAT 已完成（用户确认）**：写文件、审批 Allow/Deny、Cancel。
- 后续建议：`maxSteps` 保持 24–30；补 `model_catalog_json`；shell 写文件用 VS Code watcher 兜底。

**已知限制**

- 仍是 OutputChannel，不是 Chat 侧栏；无会话历史。
- `file.changed` 仅来自 Codex `fileChange` item；shell 写文件不触发，需 VS Code watcher 兜底。
- 崩溃后不自动重连；用 Restart Runtime。
- DeepSeek + Codex 在 Windows 上可能多次尝试 `apply_patch`；复杂度高的任务需提高 `maxSteps` 或改用更稳的模型。
- M7/OpenCode 暂缓；`agentbox.runtime` 仅 codex/fake。

---

### UI-1 — Webview 侧边栏 MVP ✅

**完成内容**

- `extension/src/chat-view.ts`
  - `ChatViewProvider`（`WebviewViewProvider`）：注册 `agentbox.chat` 侧边栏；
  - CSP + nonce；`localResourceRoots` 仅 `media/` 与 `dist/`；
  - 宿主 ↔ webview 消息桥（`ready` / `prompt` / `cancel` / `approval.response` /
    `openFile` / `openExternal` / `showLog` / `configure` / `newSession`）；
  - 当前文件/选区上下文 + `buildContextText`；打开/切换文件时默认选中当前文件，
    选中新的文本区间时默认选中选区；两者可点击取消；工作区外文件与选区不入上下文；
  - 工作区切换时释放会话、清空 transcript、重建 watcher；
  - `busy` / `cancel()` 供命令面板复用；
  - **配置浮层**：头部不显示 runtime/model；⚙ 或 `agentbox.configure` 在 Webview 内
    弹出设置浮层（覆盖、无布局位移；Runtime / Provider / 模型 / Base URL / 审批策略 / maxSteps / timeout），
    保存后写入工作区设置并重置会话；错误在浮层内提示；
  - **日志**：`AgentBox Chat` 输出通道记录完整 tool 参数/输出、turn 与 error；
    `agentbox.showOutput` 优先打开该通道。
- `extension/src/chat-protocol.ts`
  - `HostToWebview` / `WebviewToHost` 判别联合；新增 `approval.cancelled`、
    `openExternal`、`showLog`、`configure`。
- `extension/src/ui/webview-ui.ts`
  - `TurnUi` 结构化实现：文本/工具/文件/错误/turn 事件 → webview 消息；
  - 审批 Promise 生命周期：`resolveApproval`、turn 结束/取消时 `approval.cancelled`、
    dispose 时 deny。
- `extension/src/controller.ts`
  - turn 已结束后忽略迟到的审批回执；结构化 UI 不再输出英文审批日志。
- `extension/src/context.ts`
  - 当前文件/选区拼接、字符预算截断。
- `extension/src/webview/chat.ts` + `extension/media/chat.css`
  - vanilla TS；流式 Markdown（`marked` + `DOMPurify`，50ms 节流）；
  - 工具卡、审批卡、文件 chip、错误卡、Stop、新建会话；
  - **思考/生成动画**：turn 开始显示“思考中…”三点头像动画，首个 token 后切换为
    “生成中…”，工具调用期间显示“执行工具…”，审批等待显示“等待审批…”；
    长时间思考附加已用秒数；状态栏运行脉冲；支持 reduced-motion；
  - **Markdown 层级**：h1–h6 字号/字重/边框、strong、列表、表格、hr 分级；
    用户消息右对齐、助手消息左对齐，无气泡；带“你”/AgentBox 角色标签与消息间分割线；
  - **问题导航**：对话右侧居中的圆点导航条；最多显示当前位置附近 10 个问题，
    随滚动滑动窗口；点击滚动定位并高亮，hover 显示前 20 字摘要；新建会话时清空；
  - **内置提示词**：扩展默认注入工作流约束（先读后改、最小改动、运行验证、
    不加依赖、不回滚用户改动、最终报告改动/验证/风险）+ Windows/PowerShell 5.1 +
    UTF-8 + 文件卫生（禁止 patch/helper/临时 dump/浏览器 profile 等）；
    可用 `codex.extraInstructions` 追加；属于软约束，不替代沙箱/审批；
  - **项目指令**：workspace 根 `AGENTS.md`，回退 `AgentBox.md`；UTF-8、8k 上限；
    优先级 内置安全规则 > 项目指令 > extraInstructions；内容变化进入会话签名，
    下一条 prompt 重建 thread；当前不支持嵌套；
  - **审批文件策略**：`agentbox.files.denyWrite` glob 命中路径直接 deny；
    命令中的 `.chrome-profile`/`preview.png`/`dom.txt` 等标记直接 deny；
    chrome/playwright 等浏览器命令显示 confirm 警告；只在 approval.request 时生效；
  - **任务 profile**：simple（8 步/10 调用/90s）、code（20/30/180s）、
    research（30/40/300s）；设置浮层可选；显式 limits 可覆盖；
  - **循环检测**：相同 tool name+args 连续失败 2 次或连续工具失败 4 次 → abort；
    成功调用重置计数；阈值可配置；
  - **代码块复制**：Markdown 代码块右上角“复制”按钮（clipboard + execCommand 回退）；
  - **命令不进入对话**：`commandExecution` / `run_shell` 不生成聊天工具卡，
    完整 args/result 只写入 `AgentBox Chat`；点击时间线命令 bar 可打开日志；
  - **活动时间线**：输入框上方固定，展开 80px / 折叠 28px；
    三条泳道（思考 / 生成 / 工具）；当前 turn 内按耗时比例横向铺满；
    失败工具标红；hover 显示摘要；点击工具 bar 定位并高亮工具卡（命令则打开日志）；
    右上角 ▾/▸ 折叠按钮，折叠状态写入 `vscode.setState`；
    统计用“色块+数字”渲染（不写“思考/生成/工具/失败”文字）；
    时长旁显示 token 用量 `本轮 / 会话总计`（Codex `token.usage`，其他 runtime 隐藏）；
    审批等待并入思考区间；turn 结束后保留到下一轮/重置；
    纯模型 `src/webview/timeline.ts`，无图表库；
  - **布局**：transcript 与 composer 左右各 24px 留白；窄屏 18px；
  - **上下文**：文件/选区改为 SVG 图标切换按钮，active 状态使用 VS Code 主题色，
    dark mode 不再是突兀的 checkbox；
  - **输入框**：去掉手动 resize，按内容自动增高（38–220px）；
  - **发送/取消**：右侧同一个圆形图标按钮，空闲显示发送箭头、运行中变为停止方块；
  - 中文文案；外链交给 `vscode.env.openExternal`；
  - 使用 VS Code 主题变量，窄侧栏自适应；
  - **审批说明**：README 记录 `untrusted` + shell 命令触发审批的步骤。
- `extension/esbuild.mjs`
  - 新增浏览器 IIFE `dist/webview.js`。
- 文件变更兜底
  - Codex `fileChange` 继续渲染 patch 与文件 chip；
  - `FileSystemWatcher` 仅在 turn 运行时上报 `file.changed`，按 turn 去重，
    忽略 `.git` / `node_modules` / `dist` / `.probe` 等目录。

**安全**

- `default-src 'none'`、脚本 nonce、样式/图片仅扩展资源与 `data:`；
- DOMPurify 白名单并显式禁止 `iframe` / `style` / `img` / `form` 等；
- 链接仅允许 `http(s)` / `mailto`；`openExternal` 由宿主校验；
- 密钥只在扩展宿主 / SecretStorage，永不下发 webview；
- 审批决定由宿主按活动 turn 校验，webview 只负责交互。

**测试与验证**

- `extension` 67 个测试 / 11 个文件：
  controller 11、settings 7、chat-view 17、timeline 5、context 5、webview-ui 5、file-policy 6、project-instructions 4、loop-detector 4、task-profile 2、bundle 1。
- 时间线模型测试：`tests/timeline.spec.ts`（LLM 推导、审批独立、失败标记、
  open span 延展、finish/reset）。
- `npm run verify` 通过；`agentbox-0.3.0.vsix` 96.46 KB（9 files）。
- VSIX 隔离 `--extensions-dir` 安装成功。
- 1 个真实 Codex 集成测试（`V2_E2E=1`）在 UI-1 收尾时重新运行通过：
  Codex + DeepSeek、合成临时工作区、9.25s。

**已知限制**

- 多会话可在标签栏新建/切换/长按关闭；会话仅保存在扩展内存，Reload 后清空（UI-2 持久化）。
- 每个会话各自持有一个 `codex app-server` 进程；同一时刻只允许一个会话运行。
- 编辑器中打开的 `WebviewPanel` 与侧边栏共享会话事件；关闭所有 webview 会释放 runtime，重新打开可回放 transcript，但模型 thread 需重建。
- 无历史列表/重试；diff 仅 patch 文本（UI-2 原生 diff）。
- watcher 只覆盖当前工作区，且只在 turn 运行时上报。
- 上下文按字符预算截断（文件 12k、选区 8k），不是精确 token 计数。
- 固定第一个 workspace folder；切换工作区会重建会话。
- 崩溃后不自动重连；用 `Restart Runtime`。
- M7/OpenCode 暂缓；`agentbox.runtime` 仅 `codex` / `fake`。

**下一步**

- UI-2：transcript 持久化、原生 diff、重试/错误恢复（token/耗时已由时间线提供）。
- UI-3：Skill 库 / 知识面板。

---

## 3. 工程注意事项

- **测试 import 统一使用 `.js` 扩展名**（如 `../src/errors.js`），与源码内部 import 保持一致。
- **断言 RuntimeError 用 `name` + `code`，不要依赖 `instanceof`**。Vitest 在多入口/缓存场景下
  可能加载两份同名模块，`instanceof` 会失败，但错误对象本身与 `code` 是正确的。
- `npm run verify` = `build` + `vitest` + 边界检查；提交前必须通过。
- `src/testing/contract.ts` 依赖 `vitest`，仅用于测试；不要从包主入口导出。
- `FakeRuntime` 通过 `@agentbox/runtime/testing` 子路径导出（主入口不导出测试代码）。
- `extension/` 是独立包：`npm run build` 会先构建 runtime，`npm run package` 产出 VSIX；
  VSIX 含 `dist/extension.js`、`dist/webview.js`、`media/`、package.json、README、LICENSE。
- Webview 资源必须通过 `webview.asWebviewUri` + CSP 白名单加载；不要引入远程资源。

---

## 4. 更新规则

1. 模块完成并通过 `npm run verify` 后，更新总览表：状态、日期、产物、测试数、验证结果。
2. 在"模块详情"记录：完成内容、测试文件、错误语义、已知限制、下游依赖。
3. 若模块被阻塞，状态改为 ⛔，并在备注写明阻塞原因与依赖项。
4. 契约有变化时，先更新 [MODULES.md](MODULES.md) 与 `AGENT_EVENT_SCHEMA_VERSION`，再更新本文件。
