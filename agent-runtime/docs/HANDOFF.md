# 交接文档（HANDOFF）

> 给下一个执行 agent / 下一位开发者。**先读这份，再读计划。**
> 本文件记录业务上下文、已拍板的决策、环境事实、不要做的事。

---

## 1. 业务上下文（为什么做）

AgentBox 的目标不是"再造一个 coding agent"，而是：

1. **收集分散在不同开发人员手上的业务逻辑**，沉淀为可检索、可复用的文档/知识。
2. **强制统一开发规范**（规则即代码 + CI 门禁，而不是靠 prompt）。
3. **一键导入团队 Skill 库**，并**自主接入其他知识库系统**。
4. 满足**信息安全与保密**要求（内网部署、数据分级、审计、默认不出网）。

核心判断：**知识资产层是护城河，coding agent 是商品。**
所以运行时层要可替换；本阶段只做运行时，不做知识/Skill 注入。

当前已有实现：
`pluginVersion/` = P1 闭环（VS Code 插件 + knowledge-backend + OpenClaw）。
其中 OpenClaw 集成已验证，但协议/配置变动成本高，故本阶段弃用。

---

## 2. 已拍板的决策

| 决策 | 内容 | 原因 |
|---|---|---|
| 主 runtime | **Codex app-server** | 开源（Apache-2.0）、专为 IDE 设计、编码能力强、有沙箱/审批 |
| 备 runtime | **OpenCode server** | 开源（MIT）、TS 生态、provider-agnostic、适合内网 Qwen |
| OpenClaw | **先弃用**，不新增 adapter | 协议/配置变动成本高；保留旧代码做参考 |
| 集成方式 | 进程集成（spawn + JSON-RPC/HTTP） | 不 fork、不把 agent 代码拷进插件；可独立升级 |
| 模型 | **默认内网 LiteLLM/OpenAI-compatible；用户可显式配置公网 provider（如 DeepSeek）**。内网优先 Qwen3-Coder | 2026-10-28 决策：支持公网但不默认；公网需 opt-in/告警/审计 |
| 客户端 | 只做 VS Code 插件；复用原生编辑器/diff/终端 | 不做额外前端 |
| 知识/Skill | **下一阶段**，走 MCP/平台 API | 本阶段不碰 |
| 事件 | 统一 `AgentEvent` | UI/捕获/审计只消费一套 |
| 安全 | 默认不出网、localhost、沙箱、审批、关闭遥测 | 保密要求 |

---

## 3. 本阶段范围

### 做

- `AgentRuntime` 接口、统一事件、配置、错误模型。
- Codex app-server adapter（主）。
- OpenCode server adapter（备）。
- 进程生命周期：spawn、握手、超时、取消、退出清理、Windows 杀进程树。
- 能力探测与降级。
- headless CLI + eval harness（同一套任务对比两个 runtime）。
- 测试（unit + integration + contract）。
- **薄消费者 `extension/`（V1–V4）**：最小 VSIX，用于端到端验证打包、审批、取消；
  V1 用 FakeRuntime，最早在 M4/M5 后即可安装。

### 不做

- 知识库、Skill Registry、采集 pipeline、文档生成。
- UI-2/UI-3 之后的完整产品 UI（多会话/历史、原生 diff、知识/资产视图）；
  UI-1 侧边聊天面板已完成（2026-10-31）。
- OpenClaw adapter、修改 `pluginVersion/`。
- 自研 agent loop、MCP server、多 agent、并发会话。
- 外部模型/外部知识库接入。

---

## 4. 环境事实（已确认）

| 项 | 值 |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| 文档中的原始主目录 | `D:\Tools\agentBox` |
| 当前检出目录 | `D:\expirmentalArea\agentBox`（若与原始路径不同，以实际为准） |
| 运行时目录 | `agent-runtime/` |
| Node（开发/测试） | v24.14.1 |
| VS Code | 本机 1.142.0（`code` CLI）；`engines.vscode ^1.85.0`；扩展宿主为 Node 18，runtime 代码需兼容 Node 18 API |
| PowerShell | 只有 Windows PowerShell 5.1，**没有 `pwsh`** |
| 现有扩展 | `pluginVersion/vscode-extension`，TypeScript `module: commonjs`、`target ES2022`、`engines.vscode ^1.85.0` |
| 模型网关 | LiteLLM `http://172.22.26.117:8085/v1`，OpenAI-compatible；无 key 返回 401 |
| 当前模型 | `Qwen3-235B-A22B-Instruct-2507`；**优先确认是否有 Qwen3-Coder** |
| 密钥 | `MODEL_API_KEY`，必须 `sk-` 开头；**当前 shell 不存在**；本机也没有 `~/.openclaw/openclaw.json` / `.env` |
| Codex（P0 探测） | `codex-cli 0.165.0`，隔离安装在 `agent-runtime/.probe/tools` |
| OpenCode（P0 探测） | `opencode 1.19.4`，同一隔离目录 |
| Git 分支 | 当前检出为 `main`（原文档写 `vscodePlugin`，以实际为准） |

---

## 5. 重要事项（不要踩）

### 5.1 不要动 `pluginVersion/`

本阶段所有新代码放 `agent-runtime/`。`pluginVersion/` 只读参考：

- `vscode-extension/src/gateway/*` 是旧 OpenClaw 集成，**不要继续加功能**。
- `knowledge-backend/` 下一阶段再对接。
- 如果确实要改，先和用户确认。

### 5.2 不要 import `vscode`

`agent-runtime/src` 必须是纯 Node/TS，可在 CLI 和 vitest 下运行。
VS Code 集成在下一阶段通过消费者/adapter 完成。

### 5.3 OpenClaw 弃用

- 不在 `factory.ts` 里增加 OpenClaw 分支。
- 不复制 OpenClaw 的协议代码。
- 旧代码保留，仅作参考；不要删除（用户可能还要对照）。

### 5.4 Windows 专项

- 子进程停不掉时用 `taskkill /pid <pid> /T /F`；`child.kill()` 杀不掉孙进程。
- PowerShell 用 `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <base64 utf16le>`。
- PowerShell 5.1 默认不是 UTF-8：脚本前加
  `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;`
- 路径比较注意 Windows 大小写不敏感；文件工具必须防 `..`、符号链接。
- 行尾 CRLF/LF 不要擅自改；编辑工具按原文件行尾写回。

### 5.5 安全 / 保密

- 默认不出网；模型只走内网 LiteLLM。
- 关闭 Codex/OpenCode 的遥测、自动更新、云端登录；用断网环境验证。
- 子进程只绑定 `127.0.0.1`；不要 `0.0.0.0`。
- 不要把 `MODEL_API_KEY` 传给不需要它的子进程；shell 子进程环境要最小化。
- 事件/日志脱敏；不要落盘完整密钥。
- 文件工具限制在 `workspaceRoot`；shell 走 allowlist + 审批。
- 保留许可证/NOTICE：Codex Apache-2.0、OpenCode MIT。

### 5.6 版本与协议

- **Codex app-server 可能仍是 experimental**：pin 版本，不要跟 main。
- **OpenCode server API 也可能变**：pin 版本，contract test。
- 不要假设方法名/事件名；Phase 0 先探测并写入 `docs/RUNTIME-PROBE.md`。
- 两个 runtime 的差异只能出现在 adapter 内部；上层只看 `AgentEvent`。
- **测试 import 统一带 `.js` 扩展名**，与源码一致；断言 `RuntimeError` 用 `name` + `code`，
  不要依赖 `instanceof`（Vitest 多入口/缓存下可能加载两份同名模块）。

### 5.7 模型

- 编码质量主要取决于模型：优先确认内网是否有 **Qwen3-Coder**。
- 如果只有 `Qwen3-235B-A22B-Instruct-2507`，Phase 0 先跑 tool-calling 冒烟。
- **公网模型已开放（2026-10-28）**：内网/外网由用户配置；默认仍内网。公网 provider
  必须显式 opt-in、告警、审计；秘密级数据禁止出口。
- 计划用 **DeepSeek** 做公网冒烟：V4-Flash 已原生支持 Responses API，Codex 可直接接入；
  OpenCode 走 chat completions。模型 ID 以 `/v1/models` 实测为准（`deepseek-flash` /
  `deepseek-v4-flash` / `deepseek-v4-pro`）。
- Codex 的 prompt 更偏 GPT 系；接 Qwen/DeepSeek 必须实测，掉得厉害就切 OpenCode。
- 不要在代码里硬编码 baseURL/key；走配置/环境变量（`DEEPSEEK_API_KEY` / `MODEL_API_KEY`）。

---

## 6. 当前状态（本目录）

| 文件 | 状态 |
|---|---|
| `docs/MILESTONE-1.md` | ✅ **Milestone 1（Codex Runtime）封版记录** |
| `docs/UI-PROPOSAL.md` | ✅ **UI 方案已评审；UI-1 已实现（2026-10-31）** |
| `docs/MODULES.md` | ✅ **模块拆分、依赖方向、契约决策 D1–D20 已固定** |
| `docs/MODULE-STATUS.md` | ✅ **各模块完成情况记录（M1–M6/M8/M9/M10、V1/V2、UI-1）** |
| `docs/COMPATIBILITY.md` | ✅ Codex/OpenCode/Node/VS Code/provider 兼容矩阵 |
| `docs/RUNTIME-PROBE.md` | ✅ P0 报告；DeepSeek 双 runtime E2E、Codex Windows sandbox、10 条 eval 已完成 |
| `.probe/tools` | ✅ codex-cli 0.165.0 + opencode 1.19.4（gitignored，不提交） |
| `.probe/logs/codex-schema` / `codex-ts` | ✅ Codex 协议 JSON Schema / TS 绑定 |
| `.probe/logs/opencode-openapi.json` | ✅ OpenCode 1.19.4 OpenAPI 快照 |
| `src/types.ts` | ✅ **M1**：`resolveApproval`、`metadata`、limits 覆盖、`AGENT_EVENT_SCHEMA_VERSION` |
| `src/errors.ts` | ✅ **M1**：统一错误码（含 `TURN_IN_PROGRESS`、`APPROVAL_NOT_PENDING`） |
| `src/config.ts` | ✅ **M1**：`validateRuntimeConfig` / `validateTurnInput` / `resolveLimits` |
| `scripts/check-boundaries.mjs` | ✅ **M1**：禁止 `vscode` / `pluginVersion` import |
| `src/security/paths.ts` | ✅ **M2**：工作区路径约束、POSIX 相对路径、symlink realpath 校验 |
| `src/security/redact.ts` | ✅ **M2**：文本/深层对象脱敏（含循环引用） |
| `src/security/env.ts` | ✅ **M2**：子进程最小环境变量（默认不继承密钥） |
| `src/process.ts` | ✅ **M3**：spawn / 行缓冲 / 超长行截断 / 幂等 kill / Windows 进程树 |
| `src/events.ts` | ✅ **M4**：EventBus（监听器隔离、快照分发） |
| `src/turn.ts` | ✅ **M4**：TurnGuard（单活动 turn、turn.end 恰好一次、超时、审批回执） |
| `src/testing/fake-runtime.ts` | ✅ **M5**：可脚本化 FakeRuntime + 契约 fixture |
| `src/testing/contract.ts` | ✅ **M5**：可复用 runtime 契约测试套件 |
| `src/runtime/codex/config.ts` | ✅ **M6**：隔离 CODEX_HOME/config.toml + DeepSeek provider |
| `src/runtime/codex/jsonrpc.ts` | ✅ **M6**：逐行 JSON-RPC（无 jsonrpc 字段） |
| `src/runtime/codex/mapping.ts` | ✅ **M6**：item/tool/file/approval 映射 |
| `src/runtime/codex/index.ts` | ✅ **M6**：Codex app-server adapter（sandbox 自动 setup） |
| `tests/runtime/codex/codex.spec.ts` | ✅ **M6**：15 个测试（contract suite + 专项） |
| `src/cli/*` | ✅ **M8**：CLI / args / run / JSONL / config |
| `src/eval/*` + `eval/tasks.json` | ✅ **M9**：10 条任务、checks、metrics、report |
| `eval/results/2026-10-30-codex-deepseek/` | ✅ 基线报告：9/10（90%） |
| `NOTICE` / `LICENSE` / `docs/COMPATIBILITY.md` | ✅ **M10**：许可、兼容矩阵 |
| `examples/consumer.ts` / `run-fake.cjs` | ✅ **M10**：接入示例；`example:fake` 通过 |
| `src/runtime/factory.ts` | ✅ 先校验配置，再创建 codex/opencode |
| `src/runtime/codex.ts` | ✅ 已拆分为 `src/runtime/codex/` 目录（M6） |
| `src/runtime/opencode.ts` | 🚧 stub，同上 |
| `src/index.ts` | ✅ 导出契约、错误、配置校验、factory |
| `tests/config.spec.ts` / `factory.spec.ts` | ✅ **M1**：27 个测试 |
| `tests/security/*.spec.ts` | ✅ **M2**：31 个测试 |
| `tests/process.spec.ts` + fixtures | ✅ **M3**：12 个测试（含 Windows 进程树） |
| `tests/events.spec.ts` / `turn.spec.ts` | ✅ **M4**：18 个测试 |
| `tests/contract/fake.spec.ts` | ✅ **M5**：14 个测试（含 9 个通用契约用例） |
| `package.json` / `tsconfig.json` | ✅ 脚手架 + `check:boundaries` / `verify` + `./testing` 导出 |
| `../../extension/` | ✅ **UI-1**：Webview 侧栏、左右留白、图标上下文切换（文件/选区默认选中）、右侧居中问题导航（圆点/附近 10 个窗口/20 字预览）、内嵌设置浮层、内置工作流/PowerShell/文件卫生提示词、AGENTS.md 项目指令、审批文件策略、任务 profile、工具循环检测、思考计时、Markdown 分级/左右对齐角色标签/分隔线/代码复制、发送/取消合并、输入框上方三条泳道可折叠时间线、色块统计、token 用量、命令不进对话、watcher 兜底；保留输出通道降级 |
| `extension/src/chat-view.ts` / `chat-protocol.ts` / `ui/webview-ui.ts` | ✅ **UI-1**：侧栏宿主、消息协议、结构化 TurnUi |
| `extension/src/context.ts` / `webview/chat.ts` / `webview/timeline.ts` / `media/chat.css` | ✅ **UI-1**：上下文拼接、vanilla 前端、活动时间线模型、主题样式 |
| `../../extension/agentbox-0.3.0.vsix` | ✅ 93.21 KB（9 files），隔离 `--extensions-dir` 安装成功 |
| `npm run verify`（runtime） | ✅ 141 个测试通过（含 CLI 15、eval 9） |
| `npm run verify`（extension） | ✅ 62 个测试通过（controller 11、settings 7、chat-view 12、timeline 5、context 5、webview-ui 5、file-policy 6、project-instructions 4、loop-detector 4、task-profile 2、bundle 1） |
| 真实 Codex 集成（`V2_E2E=1`） | ✅ UI-1 收尾重跑通过（DeepSeek、合成工作区、9.25s） |
| 10 条 eval | ✅ Codex + DeepSeek 基线 **9/10（90%）** |
| 真实 V2 controller + Codex | ✅ `V2_E2E=1` 手动集成测试通过（写文件 8.7s） |
| CLI / eval | ⬜ M8/M9 |

**Milestone 1（Codex Runtime）已封版（2026-10-30）**，详见
[MILESTONE-1.md](MILESTONE-1.md)。
M1–M6、M8、M9、M10、V1、V2 已完成；M7 暂缓。
V1 VSIX 已跑通 FakeRuntime 主路径；V2 已完成真实 VS Code UAT（写文件/审批/Cancel）。
M8 CLI + JSONL 已跑通真实 DeepSeek；M9 10 条基线 **9/10（90%）**，达到 KPI。
M10 导出/许可/兼容矩阵/consumer/pack 检查已完成。
**UI-1 侧边栏已完成（2026-10-31）**：`extension@0.3.0`、`agentbox-0.3.0.vsix`。
下一阶段：**UI-2（持久化/原生 diff/重试）→ UI-3 Skill 库/知识注入**。

P0/实施结论：

P0 当前结论：

- Codex：逐行 JSON 协议、`initialize`/`thread/start`/`turn/start`/`turn/interrupt` 已实测；
  `turn/interrupt` 9ms 内结束。配置必须 `wire_api="responses"`，`thread/start` 用
  `permissions:":workspace"`。
- **DeepSeek 冒烟已通过（2026-10-29）**：
  - Codex + `deepseek-flash`（Responses API）：文本 + commandExecution 审批 + 写出 `codex-ok`；
  - OpenCode + `deepseek-flash`（chat completions）：文本 + edit 权限审批 + 写出 `opencode-ok`；
  - 均只使用合成 `.probe/workspace*` 目录。
- **Codex Windows sandbox 已修复（2026-10-29）**：
  - `windowsSandbox/setupStart({mode:"unelevated"})` 成功；
  - 同一进程 readiness 缓存为 `notConfigured`，**重启 app-server 后 `ready`**；
  - 修复后 `:workspace`/`workspaceWrite` 内写成功、外写 `EPERM`；`readOnly` 内写 `EPERM`；
  - 沙箱生效后 Codex + DeepSeek 仍能完成文本、审批、workspace 内文件写入。
  - 前置：每台 Windows 机器首次需 setup；`thread/shellCommand` 仍 unsandboxed。
- OpenCode：`serve`/health/OpenAPI/会话/SSE/Basic auth/abort 已实测；abort 686ms。
  provider 走 `/v1/chat/completions`；未设 password 时无认证且 `/config` 暴露明文 key。
- **M6 Codex adapter 已实现**：JSON-RPC、thread/turn、事件映射、审批、取消、
  Windows sandbox 自动 setup、崩溃处理；contract suite + 真实 DeepSeek E2E 通过。
- **M7 仍为 stub，暂缓**（用户决定先落地 V2）。
- **V2 已接线**：extension 默认 `agentbox.runtime=codex`，支持 DeepSeek provider、
  SecretStorage/API key、持久 CODEX_HOME、外部模型告警；`agentbox-0.2.0.vsix` 已打包。
- **V2 人工 UAT 已完成（用户确认）**：真实 VS Code 写文件、审批 Allow/Deny、Cancel 均通过。
- **审批/取消 headless 真实 Codex 也已通过**：
  - `untrusted` 和 workspace 外写均触发 `approval.request`；Deny 后工具未执行、turn 正常结束；
  - Cancel 在 124ms 内 `turn cancelled`；脚本 `.probe/v2-approval-cancel-probe.cjs`。
- DeepSeek + Windows 下 `apply_patch` 可能多次失败后改用 PowerShell；建议 `maxSteps` 保持 24–30。
- **下一步：补测 V2 审批/取消，然后 10 条 eval。**

---

## 7. 下一步（按顺序）

> 模块拆分与接口见 [MODULES.md](MODULES.md)，完成情况见 [MODULE-STATUS.md](MODULE-STATUS.md)。
> Milestone 1（Codex Runtime）已封版；M7 暂缓。

1. 读 `README.md`、`docs/MILESTONE-1.md`、`docs/ARCHITECTURE.md`、`docs/MODULES.md`、
   `docs/MODULE-STATUS.md`、`docs/COMPATIBILITY.md`、`IMPLEMENTATION_PLAN.md`。
2. **UI-0 评审**：✅ 已确认 [UI-PROPOSAL.md](UI-PROPOSAL.md)（Webview、1.85、单会话、
   内联审批、patch 文本、显式上下文、中文 UI）。
3. **UI-1**：✅ 已完成侧边 Webview + 流式/工具卡/内联审批/Stop/上下文/watcher 兜底。
4. **UI-2**：transcript 持久化、原生 diff、重试/错误恢复（token/耗时已由时间线提供）。
5. **UI-3**：Skill 库 / 知识面板（等后端契约）。
6. **M7**（可选/暂缓）：OpenCode adapter → V3；需要双 runtime 时再做。
7. **内网 Qwen/Qwen3-Coder**：生产部署前确认。

---

## 8. 给下一个 agent 的启动提示（可直接复制）

```
你在 agentBox 工作。先读：
  agent-runtime/README.md
  agent-runtime/docs/HANDOFF.md
  agent-runtime/docs/ARCHITECTURE.md
  agent-runtime/docs/MODULES.md
  agent-runtime/IMPLEMENTATION_PLAN.md
  agent-runtime/docs/RUNTIME-PROBE.md

任务：Milestone 1（Codex Runtime）已封版；UI-0 评审与 UI-1 侧边栏已完成。
先读 docs/MILESTONE-1.md、docs/UI-PROPOSAL.md、docs/MODULE-STATUS.md、docs/HANDOFF.md。
M1–M6、M8、M9、M10、V1、V2、UI-1 已完成；M7 暂缓。
下一步：
1. UI-2：transcript 持久化、原生 diff、重试/错误恢复（token/耗时已由时间线提供）；
2. UI-3：Skill 库 / 知识面板（等后端契约）；
3. 内网 Qwen 确认仍作为生产部署前事项。
完成情况记录在 docs/MODULE-STATUS.md；每完成一个模块必须更新。
产物：../../extension/agentbox-0.3.0.vsix；构建/打包见 extension/README.md。
UI 消费者继续只依赖 createRuntime + AgentEvent，不修改 adapter。
- 每个模块先写接口与测试，再实现；adapter 必须通过 M5 的 contract suite。
- 事件契约决策 D1–D14 不得擅自更改；改契约先改 MODULES.md。
- 端到端验证门见 MODULES.md §2.2：V2 已完成；UI-1 产物已隔离安装。
- Codex app-server 为主，OpenCode server 为备；OpenClaw 弃用，不新增代码。
- 本阶段不做知识/Skill 注入、不改 pluginVersion/；UI-2 之前不加多会话/持久化。
- P0 已完成；协议/沙箱/DeepSeek 结果见 docs/RUNTIME-PROBE.md，不要重复探测，
  除非升级 Codex/OpenCode 版本。
- 环境：Windows 11、Node 24、PowerShell 5.1（无 pwsh）；DeepSeek 公网已获准，
  内网 LiteLLM/Qwen 仍待确认。
- 约束：纯 Node/TS，不 import vscode；进程集成；统一 AgentEvent；默认内网，
  公网 provider 需用户显式配置；安全审批；pin 版本。
- 每完成一个 phase，更新 IMPLEMENTATION_PLAN.md 的复选框和 HANDOFF.md 的当前状态。
```

---

## 9. 待确认 / 风险

| 项 | 影响 | 处理 |
|---|---|---|
| **Codex Windows sandbox 首次使用未配置** | 首次运行前需一次性 setup；否则可能无约束 | 已用 `setupStart(unelevated)` 修复；M6 启动时检测 readiness，notConfigured 时 setup 并重启 app-server |
| **内网 LiteLLM/Qwen 不可用**：当前无内部 LLM | 生产保密目标无法满足；只能用 DeepSeek 过渡 | 向管理员确认 Qwen3-Coder；生产仍以内网为准 |
| DeepSeek 公网 API 的数据出境 | 源码/业务数据泄露风险 | 默认关闭；仅合成数据冒烟；生产必须 opt-in/告警/审计、秘密级数据禁止 |
| DeepSeek 模型 ID/元数据 | Codex 用 `deepseek-flash` 会 fallback 元数据；OpenCode 只认 `deepseek-flash` | 后续补 `model_catalog_json`；OpenCode 用规范 ID |
| OpenCode 默认无认证，`/config` 返回明文 apiKey | 保密风险 | M7 必须设置 `OPENCODE_SERVER_USERNAME/PASSWORD`，只绑 127.0.0.1，不记录 `/config` |
| Codex app-server 是否支持 Qwen/LiteLLM 且工具调用稳定 | 决定主备是否互换 | Phase 0 冒烟 + 10 条 eval |
| Codex app-server 协议是否稳定 | adapter 维护成本 | pin 版本；contract test |
| OpenCode server API/事件是否稳定 | adapter 维护成本 | pin 版本；contract test |
| 内网是否有 Qwen3-Coder | 编码质量 | 向管理员确认；没有则先用 235B 冒烟 |
| 两个 runtime 的遥测/更新检查能否关闭 | 保密合规 | 断网环境验证；必要时防火墙 |
| Codex/OpenCode 许可证与 NOTICE | 合规 | 保留 LICENSE/NOTICE；法务确认 |
| Windows 进程树/编码问题 | 稳定性 | taskkill /T；UTF-8 preamble；集成测试 |
