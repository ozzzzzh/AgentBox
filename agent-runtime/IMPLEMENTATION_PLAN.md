# Agent Runtime 实现计划

> 目标：实现可替换的运行时层，**Codex app-server 为主、OpenCode server 为备，OpenClaw 弃用**。
> 本阶段不做知识/Skill 注入、不做 VS Code UI。
> 每个 Phase 完成后勾选任务，并更新 [docs/HANDOFF.md](docs/HANDOFF.md) 的"当前状态"。

---

## 0. 总览

| Phase | 内容 | 预估 | 依赖 |
|---|---|---|---|
| **P0** | 运行时探测（协议/版本/模型/遥测） | 1–2 天 | 无 |
| **P1** | 核心契约 + 进程生命周期 + 测试骨架 | 2–3 天 | P0 结论 |
| **P2** | Codex app-server adapter | 3–5 天 | P1 |
| **P3** | OpenCode server adapter | 3–5 天 | P1 |
| **P4** | CLI + eval（10 条任务对比） | 2–3 天 | P2/P3 |
| **P5** | 打包 + 下一阶段接入契约 | 1–2 天 | P4 |

**总时长：约 2–3 周**（单人；不含模型/环境阻塞）。

> **端到端验证门（VSIX）** 见 [docs/MODULES.md §2.2](docs/MODULES.md)。
> 不必等到 P5 才打包 VS Code：
> - **V1**：✅ 已产出 `../extension/agentbox-0.1.0.vsix`（FakeRuntime，无需模型/P0）；
> - **V2**：✅ `../extension/agentbox-0.2.0.vsix`；真实 VS Code UAT（写文件/审批/Cancel）通过；
> - **V3/V4**：M7/M8、M9/M10 后。
> 薄消费者放在独立 `extension/` 包，不进 `agent-runtime/src`。

---

## Phase 0：运行时探测（先做，不要写 adapter）

> 目的：把"假设"变成"实测"。Codex/OpenCode 的 CLI flags、协议、事件、配置都可能随版本变化。

### 任务

- [x] **P0.1 版本与许可**：`codex-cli 0.165.0`（Apache-2.0）、`opencode 1.19.4`（MIT）；本地隔离安装，已 pin。
- [x] **P0.2 Codex 探测**（协议/配置/取消完成；审批 E2E 待模型）：
  - `codex --help`、`codex app-server --help`（确认 app-server 是否可用、是否 experimental）。
  - 启动 app-server，记录 stdio JSON-RPC 的握手、会话创建、发送 turn、中断、审批、退出。
  - 记录事件形状（文本增量、工具调用、文件变更、turn 结束、错误）。
  - 记录配置方式（`CODEX_HOME` / `config.toml`）：自定义 `model_providers`、`base_url`、`env_key`、`wire_api`。
  - 记录沙箱/审批模式（read-only / workspace-write / full-access）。
- [x] **P0.3 OpenCode 探测**（服务/认证/事件/取消完成；审批 E2E 待模型）：
  - `opencode --help`、`opencode serve --help`。
  - 启动 `opencode serve --hostname 127.0.0.1 --port <port>`；记录 health、session、prompt、event stream、permission、abort。
  - 记录 SDK/HTTP/SSE 的形状；确认是否需要 `@opencode-ai/sdk`。
  - 记录 provider 配置（OpenAI-compatible / LiteLLM / Qwen）。
- [x] **P0.4 模型冒烟**（DeepSeek 公网）：
  - DeepSeek `deepseek-flash` 已与 Codex（Responses API）和 OpenCode（chat completions）
    跑通文本 + 工具 + 审批 + 合成文件写入。
  - 内网 LiteLLM + Qwen **仍未验证**（当前无内部 LLM）；生产仍需内网模型。
  - tool-call 合法率、token、延迟等指标留给 10 条 eval。
- [ ] **P0.5 离线性/遥测**：已配置关闭项（Codex analytics off；OpenCode autoupdate/share/models-fetch/telemetry off）；断网/防火墙验证待做。
- [x] **P0.6 写探测报告**：结果、命令、payload 样例、坑已写入 [docs/RUNTIME-PROBE.md](docs/RUNTIME-PROBE.md)。

> **P0 状态（2026-10-29）**：协议、配置、认证、取消、DeepSeek 双 runtime E2E、
> Codex Windows sandbox 修复（`setupStart(unelevated)` + 重启 app-server，外写 EPERM）已完成；
> 剩余跟进：内网 Qwen 可用性、10 条 eval。详见 RUNTIME-PROBE.md。

### 验收

- `docs/RUNTIME-PROBE.md` 能让另一个开发者照着重现。
- 明确：主/备是否维持 Codex 主、OpenCode 备；两个 runtime 各支持哪些事件/审批/取消。
- 明确：Qwen 在两个 runtime 下的基本可用性。

### 决策门

- Codex + Qwen 工具调用**明显不可用** → 主备互换，记录原因。
- 两者都不可用 → 暂停 adapter 实现，先解决模型（Qwen3-Coder）。

**2026-10-29 探测结论**：

- **维持 Codex 主 / OpenCode 备**；两者均已用 DeepSeek 跑通文本 + 工具 + 审批。
- **Codex Windows sandbox 已修复**：`windowsSandbox/setupStart({mode:"unelevated"})` 成功，
  重启 app-server 后 readiness=`ready`；`:workspace`/`workspaceWrite` 内写成功、外写 `EPERM`，
  `readOnly` 内写也 `EPERM`。M6 启动时需检测/执行该步骤。
- **M6/M7 adapter 开发可以开始**；优先 M6 → V2，10 条 eval 作为后续质量门。

---

## Phase 1：核心契约 + 进程生命周期

> 模块拆分见 [docs/MODULES.md](docs/MODULES.md)，完成情况见 [docs/MODULE-STATUS.md](docs/MODULE-STATUS.md)。
> **M1–M5 全部完成**（P1.1–P1.8）：契约、安全工具、进程管理、事件守卫、FakeRuntime/契约测试。
> 下一步进入 **Phase 0 探测**，随后 M6/V2。

### 任务

- [x] **P1.1 契约**（M1）：`src/types.ts` 已含 `RuntimeConfig`、`Limits`（config/turn 覆盖）、`AgentEvent`、`Capabilities`、`TurnHandle`、`resolveApproval`、`AGENT_EVENT_SCHEMA_VERSION`。
- [x] **P1.2 错误模型**（M1）：`src/errors.ts` 统一错误码，含 `TURN_IN_PROGRESS`、`APPROVAL_NOT_PENDING`、`INVALID_ARGUMENT`。
- [x] **P1.3 进程管理**（M3）：`src/process.ts`
  - spawn、stdout/stderr 行缓冲、CRLF/半行/超长行截断、退出码。
  - Windows 杀进程树：`taskkill /pid <pid> /T /F`；POSIX 进程组 SIGTERM→SIGKILL。
  - `kill()` 幂等；`exited` 在 stdio 关闭后 resolve。
  - 环境变量最小化（`buildChildEnv`）；不传无关密钥。
- [x] **P1.4 事件总线**（M4）：`EventBus` + `TurnGuard`；单活动 turn、`turn.end` 恰好一次、超时兜底、审批回执、迟到事件丢弃。
- [x] **P1.5 配置校验**（M1）：`src/config.ts` 校验 runtime 枚举、workspaceRoot 存在且为目录、limits 正整数、OpenCode 仅 loopback/端口范围、env/command 类型。
- [x] **P1.6 fake runtime**（M5）：`src/testing/fake-runtime.ts`，支持 text/tool/file/error/approval/delay 脚本。
- [x] **P1.7 contract test 骨架**（M5）：`src/testing/contract.ts`，9 个通用用例 + fixture hooks；M6/M7 必须通过。
- [x] **P1.8 静态约束**（M1）：`scripts/check-boundaries.mjs` + `npm run check:boundaries`（已并入 `npm run verify`）。

### 验收

- `npm run build` 通过。
- `npm test` 通过（fake runtime + 进程管理单测）。
- `grep -r "vscode" src/` 为空（或仅注释）。
- spawn 一个假子进程，`stop()` 后无残留（Windows 上验证）。

---

## Phase 2：Codex app-server adapter（主）

> 依赖 P0 的实测结果；**不要假设方法名**。
> **M6 已完成（2026-10-30）**：contract suite + 真实 DeepSeek E2E 通过。
> **V2 已接线**：`agentbox-0.2.0.vsix` 已打包，真实 controller+Codex E2E 通过；待人工 VS Code UI 验收。

### 任务

- [x] **P2.1 JSON-RPC 客户端**（M6）：`src/runtime/codex/jsonrpc.ts`，逐行 JSON（无 `jsonrpc` 字段）、请求/响应关联、通知、超时、服务端请求。
- [x] **P2.2 启动与握手**（M6）：spawn `codex app-server --listen stdio://`；初始化；Windows sandbox readiness/setup + 重启。
- [x] **P2.3 会话/turn**（M6）：`thread/start`、`turn/start`、流式事件。
- [x] **P2.4 事件映射**（M6）：text/tool/file/turn.completed/error → `AgentEvent`。
- [x] **P2.5 审批**（M6）：`item/*/requestApproval` → `approval.request`；`resolveApproval` 回传 accept/decline。
- [x] **P2.6 取消**（M6）：`turn/interrupt`；5 秒未停杀进程树并 `turn.end(cancelled)`。
- [x] **P2.7 错误处理**（M6）：进程退出/协议错误/超时 → `error` + `turn.end`；**不自动重连**，调用方需重新 `start()`。
- [x] **P2.8 能力声明**（M6）：streaming/toolEvents/fileEvents/approvals/mcp；protocolVersion 取 initialize userAgent。
- [x] **P2.9 测试**（M6）：
  - mock app-server + 15 个测试（contract suite + 映射/审批/崩溃/config/sandbox）。
  - 真实 Codex + DeepSeek：合成目录写文件、tool 事件、turn 完成（手动 E2E，非 CI）。
- [x] **P2.10 文档**（M6）：协议/配置/沙箱/DeepSeek 已写入 RUNTIME-PROBE.md、MODULES.md、MODULE-STATUS.md。

### 验收

- 一个真实任务：读 `README.md` → 追加一行 → `git diff`，事件完整。
- `abort()` 后 5 秒内无残留进程，`turn.end(reason=cancelled)`。
- 事件顺序：`turn.start` → ... → `turn.end`；tool start/end 成对。
- 断网下能跑（只连 LiteLLM）。

---

## Phase 3：OpenCode server adapter（备）

### 任务

- [ ] **P3.1 服务生命周期**：spawn `opencode serve`，端口选择（0 → 自动分配），health check，stop。
- [ ] **P3.2 客户端**：HTTP + SSE（或 `@opencode-ai/sdk`，以 P0 为准）；事件订阅/断线重连。
- [ ] **P3.3 会话/turn**：创建会话、发送 prompt、流式事件。
- [ ] **P3.4 事件映射**：同 P2.4。
- [ ] **P3.5 权限/审批**：permission request → `approval.request`；resolve API。
- [ ] **P3.6 取消**：abort session/turn；确认停止。
- [ ] **P3.7 错误/重连**：服务退出、HTTP 错误、SSE 断开。
- [ ] **P3.8 能力声明**：按实测填。
- [ ] **P3.9 测试**：mock server + 真 OpenCode 集成；临时目录任务。
- [ ] **P3.10 文档**：provider 配置、端口、SDK 版本。

### 验收

同 Phase 2，且：
- 端口只绑 `127.0.0.1`。
- `stop()` 后端口释放、无残留进程。
- SSE 断开后能重连或明确失败（不静默丢事件）。

---

## Phase 4：CLI + eval harness

### 任务

- [x] **P4.1 CLI**（M8）：`node dist/cli/index.js run --runtime codex --workspace <dir> --prompt <text> --out <jsonl>`；另有 `replay` / `eval`。
- [x] **P4.2 事件日志**（M8）：每行一个 `AgentEvent` + `taskId` + summary；`replay` 可统计。
- [x] **P4.3 评测任务**（M9）：`eval/tasks.json` 10 条；runner 自动生成临时 fixture。
- [x] **P4.4 指标**（M9）：成功率、步数、首 token、总耗时、tool errors、审批数；**token usage 未采集**；取消/残留由契约与 UAT 覆盖。
- [ ] **P4.5 对比报告**：Codex vs OpenCode 双 runtime **待 M7**；当前只有 Codex+DeepSeek 基线。
- [x] **P4.6 复现脚本**（M8/M9）：`agentbox eval ...` 一条命令；基线命令见 `eval/results/2026-10-30-codex-deepseek/README.md`。

> **Phase 4 结果（2026-10-30）**：Codex + DeepSeek 10 条任务 **9/10（90%）**；
> 失败项 `add-test` 功能检查通过但 turn 180s 超时。详见 MODULE-STATUS.md 与 eval 报告。

### 验收

- 两个 runtime 都能跑完 10 条任务（允许失败，但要有记录）。
- 报告能回答："哪个 runtime 在 Qwen 下更稳？"
- 结果可复现（固定 commit/版本/模型）。

---

## Phase 5：打包与下一阶段接入

### 任务

- [x] **P5.1 导出**（M10）：exports `.` / `./testing` / `./package.json`；dist 类型声明完整。
- [x] **P5.2 接入文档**（M10）：README 接入契约 + `examples/consumer.ts` + `run-fake.cjs`。
- [x] **P5.3 许可证**（M10）：NOTICE + LICENSE；Codex/OpenCode 明确不随包分发。
- [x] **P5.4 版本策略**（M10）：pin Codex 0.165.0 / OpenCode 1.19.4；`docs/COMPATIBILITY.md`。
- [x] **P5.5 更新 HANDOFF**（M10）：当前状态、已知问题、下一阶段 TODO 已更新。

> **M10 / Phase 5 已完成（2026-10-30）**：`npm pack --dry-run` 干净；
> `npm run example:fake` 通过；下一阶段只需 `createRuntime` + `AgentEvent`。

### 验收

- 一个示例 consumer（可以是 `examples/consumer.ts`）能 import 并启动 fake runtime。
- `npm pack` 内容干净（无 node_modules/src 冗余）。
- 下一阶段只需接 `createRuntime` + 事件，不需要改 adapter。

---

## Definition of Done（Milestone 1）

- [x] `agent-runtime` 可在 Windows + Node 24 下 `npm install && npm run build && npm test`。
- [x] `src/` 无 `vscode` import，无 `pluginVersion` import。
- [x] **Codex adapter** 通过 contract test；OpenCode adapter 明确不在 Milestone 1（M7 暂缓）。
- [x] 统一事件完整；`turn.end` 兜底；取消/超时可用。
- [x] 无残留进程（Windows 进程树）。
- [x] 默认内网/不出网；Codex Windows sandbox 外写被拦截；公网模型需显式 opt-in。
- [x] CLI 能跑 10 条 eval 任务并输出 JSONL（Codex+DeepSeek 9/10）。
- [x] `docs/RUNTIME-PROBE.md` / `HANDOFF.md` / `MILESTONE-1.md` 已更新。
- [x] 没有修改 `pluginVersion/`。

> 封版记录：[docs/MILESTONE-1.md](docs/MILESTONE-1.md)。M7/V3/V4 留待后续。

---

## 下一阶段：UI-1 Webview 侧边栏（✅ 2026-10-30）

- [x] **UI-1.1** `ChatViewProvider` + `agentbox.chat` 侧边栏 + 活动栏入口。
- [x] **UI-1.2** 流式 Markdown、思考/生成动画、工具卡、内联审批（Allow/Deny）、Stop、新建会话。
- [x] **UI-1.3** 当前文件/选区上下文 chips（显式勾选、工作区边界、字符截断）。
- [x] **UI-1.4** CSP + nonce、DOMPurify 白名单、外链走宿主、密钥不下发。
- [x] **UI-1.5** 文件 watcher 兜底 `file.changed`，按 turn 去重。
- [x] **UI-1.6** 测试（62）与 `agentbox-0.3.0.vsix` 打包/隔离安装。
- [x] **UI-1.7** 头部去 runtime/model；⚙ 配置菜单选择 runtime/模型。
- [x] **UI-1.8** shell 调用缩略展示；完整明细写入 `AgentBox Chat` 输出通道。
- [x] **UI-1.9** 对话上方活动时间线：LLM / 工具 / 审批泳道、失败红色、hover 摘要、点击定位工具卡。
- [ ] **UI-2**：transcript 持久化、原生 diff、重试、token/耗时。
- [ ] **UI-3**：Skill 库 / 知识面板。

## 不要做（本阶段）

- ❌ 不实现知识库/Skill/文档生成。
- ❌ Milestone 1 不做 VS Code Chat UI；UI-1 已完成侧边聊天，TreeView/原生 diff/历史留给 UI-2。
- ❌ 不新增 OpenClaw adapter，不改旧 gateway。
- ❌ 不 fork Codex/OpenCode，不复制它们的源码进本仓库。
- ❌ 不硬编码模型地址/密钥。
- ❌ 不把 runtime 事件直接透传给上层；必须映射成 `AgentEvent`。
- ❌ 不在没有实测的情况下假设协议方法名。
