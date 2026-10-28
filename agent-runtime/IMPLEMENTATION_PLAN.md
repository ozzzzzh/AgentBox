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

---

## Phase 0：运行时探测（先做，不要写 adapter）

> 目的：把"假设"变成"实测"。Codex/OpenCode 的 CLI flags、协议、事件、配置都可能随版本变化。

### 任务

- [ ] **P0.1 版本与许可**：记录 `codex --version`、`opencode --version`、安装方式、LICENSE/NOTICE。
- [ ] **P0.2 Codex 探测**：
  - `codex --help`、`codex app-server --help`（确认 app-server 是否可用、是否 experimental）。
  - 启动 app-server，记录 stdio JSON-RPC 的握手、会话创建、发送 turn、中断、审批、退出。
  - 记录事件形状（文本增量、工具调用、文件变更、turn 结束、错误）。
  - 记录配置方式（`CODEX_HOME` / `config.toml`）：自定义 `model_providers`、`base_url`、`env_key`、`wire_api`。
  - 记录沙箱/审批模式（read-only / workspace-write / full-access）。
- [ ] **P0.3 OpenCode 探测**：
  - `opencode --help`、`opencode serve --help`。
  - 启动 `opencode serve --hostname 127.0.0.1 --port <port>`；记录 health、session、prompt、event stream、permission、abort。
  - 记录 SDK/HTTP/SSE 的形状；确认是否需要 `@opencode-ai/sdk`。
  - 记录 provider 配置（OpenAI-compatible / LiteLLM / Qwen）。
- [ ] **P0.4 模型冒烟**：两个 runtime 都指向内网 LiteLLM + Qwen，跑"读文件 → 改一行 → 报告 diff"。
  - 记录 tool-call 合法率、是否卡住、token、延迟。
  - 如果 Codex 接 Qwen 明显不稳，记录备选方案（OpenCode 主、Codex 备）。
- [ ] **P0.5 离线性/遥测**：断网（只留 localhost + LiteLLM）验证；找出遥测/自动更新/登录检查并关闭。
- [ ] **P0.6 写探测报告**：把以上结果、命令、payload 样例、坑，写进 [docs/RUNTIME-PROBE.md](docs/RUNTIME-PROBE.md)。

### 验收

- `docs/RUNTIME-PROBE.md` 能让另一个开发者照着重现。
- 明确：主/备是否维持 Codex 主、OpenCode 备；两个 runtime 各支持哪些事件/审批/取消。
- 明确：Qwen 在两个 runtime 下的基本可用性。

### 决策门

- Codex + Qwen 工具调用**明显不可用** → 主备互换，记录原因。
- 两者都不可用 → 暂停 adapter 实现，先解决模型（Qwen3-Coder）。

---

## Phase 1：核心契约 + 进程生命周期

### 任务

- [ ] **P1.1 契约**：完善 `src/types.ts`（RuntimeConfig、Limits、AgentEvent、Capabilities、TurnHandle）。
- [ ] **P1.2 错误模型**：`src/errors.ts`，统一错误码（`SPAWN_FAILED`、`HANDSHAKE_FAILED`、`TIMEOUT`、`CANCELLED`、`PROTOCOL_ERROR`、`NOT_IMPLEMENTED`）。
- [ ] **P1.3 进程管理**：`src/process.ts`
  - spawn、stdout/stderr 捕获、行缓冲、退出码。
  - Windows 杀进程树：`taskkill /pid <pid> /T /F`。
  - 超时、重启策略、`stop()` 幂等。
  - 环境变量最小化；不传无关密钥。
- [ ] **P1.4 事件总线**：类型安全 emitter；保证 `turn.start` / `turn.end` 成对且 `turn.end` 只发一次。
- [ ] **P1.5 配置校验**：`RuntimeConfig` 校验（runtime 枚举、workspaceRoot 存在、limits 合理）。
- [ ] **P1.6 fake runtime**：用于单测的 `FakeRuntime`（可脚本化事件）。
- [ ] **P1.7 contract test 骨架**：一套测试，两个 adapter 将来都要跑（start/stop、turn、事件顺序、cancel、超时）。
- [ ] **P1.8 静态约束**：加 lint/脚本检查 `src/` 不含 `vscode` import、不 import `pluginVersion`。

### 验收

- `npm run build` 通过。
- `npm test` 通过（fake runtime + 进程管理单测）。
- `grep -r "vscode" src/` 为空（或仅注释）。
- spawn 一个假子进程，`stop()` 后无残留（Windows 上验证）。

---

## Phase 2：Codex app-server adapter（主）

> 依赖 P0 的实测结果；**不要假设方法名**。

### 任务

- [ ] **P2.1 JSON-RPC 客户端**：stdio 分帧、请求/响应关联、notification、超时、错误映射。
- [ ] **P2.2 启动与握手**：spawn `codex app-server`，等待 ready；失败重试/报错。
- [ ] **P2.3 会话/turn**：创建会话、发送用户消息、接收流式事件。
- [ ] **P2.4 事件映射**：runtime 事件 → `text.delta` / `tool.start` / `tool.end` / `file.changed` / `turn.end`。
- [ ] **P2.5 审批**：approval request → `approval.request` 事件；提供 resolve API；未决时阻塞/超时。
- [ ] **P2.6 取消**：`abort(turnId)` → interrupt；确认 runtime 真的停止。
- [ ] **P2.7 错误/重连**：进程退出、协议错误、超时；turn 结束要发 `turn.end` + `error`。
- [ ] **P2.8 能力声明**：按实测填 `RuntimeCapabilities`。
- [ ] **P2.9 测试**：
  - 用 mock app-server（本地脚本）测协议映射。
  - 真 Codex 集成测试：临时目录、读文件、改文件、跑命令、取消。
- [ ] **P2.10 文档**：把配置示例、协议差异写进 `docs/ARCHITECTURE.md` 或新文档。

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

- [ ] **P4.1 CLI**：`node dist/cli.js run --runtime codex|opencode --workspace <dir> --prompt <text> --out <jsonl>`。
- [ ] **P4.2 事件日志**：每行一个 `AgentEvent` + turn 元数据；可回放。
- [ ] **P4.3 评测任务**：按 [docs/EVAL-TASKS.md](docs/EVAL-TASKS.md) 准备 10 条；固定 fixture 仓库/临时目录。
- [ ] **P4.4 指标**：任务成功率、tool-call 合法率、步数、token、首 token 延迟、总耗时、取消成功率、崩溃/残留。
- [ ] **P4.5 对比报告**：Codex vs OpenCode，同模型、同任务；输出 Markdown/JSON。
- [ ] **P4.6 复现脚本**：一条命令跑完全部（或按 runtime 分开）。

### 验收

- 两个 runtime 都能跑完 10 条任务（允许失败，但要有记录）。
- 报告能回答："哪个 runtime 在 Qwen 下更稳？"
- 结果可复现（固定 commit/版本/模型）。

---

## Phase 5：打包与下一阶段接入

### 任务

- [ ] **P5.1 导出**：`package.json` exports、`dist` 产物、类型声明。
- [ ] **P5.2 接入文档**：VS Code 插件如何 import、构造 config、startTurn/onEvent/abort/stop。
- [ ] **P5.3 许可证**：NOTICE、第三方依赖清单（Codex/OpenCode 由其进程分发，注意合规）。
- [ ] **P5.4 版本策略**：pin Codex/OpenCode 版本；记录兼容矩阵。
- [ ] **P5.5 更新 HANDOFF**：当前状态、已知问题、下一阶段 TODO。

### 验收

- 一个示例 consumer（可以是 `examples/consumer.ts`）能 import 并启动 fake runtime。
- `npm pack` 内容干净（无 node_modules/src 冗余）。
- 下一阶段只需接 `createRuntime` + 事件，不需要改 adapter。

---

## Definition of Done（本阶段）

- [ ] `agent-runtime` 可在 Windows + Node 24 下 `npm install && npm run build && npm test`。
- [ ] `src/` 无 `vscode` import，无 `pluginVersion` import。
- [ ] Codex/OpenCode 两个 adapter 都通过 contract test。
- [ ] 统一事件完整；`turn.end` 兜底；取消/超时可用。
- [ ] 无残留进程（Windows 进程树）。
- [ ] 默认不出网；遥测/更新关闭；localhost only。
- [ ] CLI 能跑 10 条 eval 任务并输出 JSONL。
- [ ] `docs/RUNTIME-PROBE.md` / `HANDOFF.md` 已更新。
- [ ] 没有修改 `pluginVersion/`。

---

## 不要做（本阶段）

- ❌ 不实现知识库/Skill/文档生成。
- ❌ 不做 VS Code Chat UI / TreeView / diff。
- ❌ 不新增 OpenClaw adapter，不改旧 gateway。
- ❌ 不 fork Codex/OpenCode，不复制它们的源码进本仓库。
- ❌ 不硬编码模型地址/密钥。
- ❌ 不把 runtime 事件直接透传给上层；必须映射成 `AgentEvent`。
- ❌ 不在没有实测的情况下假设协议方法名。
