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
| 模型 | 内网 LiteLLM / OpenAI-compatible；优先 Qwen3-Coder | 安全合规；编码能力优先 |
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

### 不做

- 知识库、Skill Registry、采集 pipeline、文档生成。
- VS Code Chat UI / TreeView / diff 面板。
- OpenClaw adapter、修改 `pluginVersion/`。
- 自研 agent loop、MCP server、多 agent、并发会话。
- 外部模型/外部知识库接入。

---

## 4. 环境事实（已确认）

| 项 | 值 |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| 主目录 | `D:\Tools\agentBox` |
| 新目录 | `D:\Tools\agentBox\agent-runtime` |
| Node | v24.14.1 |
| PowerShell | 只有 Windows PowerShell 5.1，**没有 `pwsh`** |
| 现有扩展 | `pluginVersion/vscode-extension`，TypeScript `module: commonjs`、`target ES2022`、`engines.vscode ^1.85.0` |
| 模型网关 | LiteLLM `http://172.22.26.117:8085/v1`，OpenAI-compatible |
| 当前模型 | `Qwen3-235B-A22B-Instruct-2507`；**优先确认是否有 Qwen3-Coder** |
| 密钥 | `MODEL_API_KEY`，必须 `sk-` 开头；同时配在 OpenClaw 的 `~/.openclaw/openclaw.json` 与后端环境变量 |
| Git 分支 | `vscodePlugin`（本轮不要在 `main` 上直接改） |

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

### 5.7 模型

- 编码质量主要取决于模型：优先确认内网是否有 **Qwen3-Coder**。
- 如果只有 `Qwen3-235B-A22B-Instruct-2507`，Phase 0 先跑 tool-calling 冒烟。
- Codex 的 prompt 更偏 GPT 系；接 Qwen 必须实测，掉得厉害就切 OpenCode。
- 不要在代码里硬编码 baseURL/key；走配置/环境变量。

---

## 6. 当前状态（本目录）

| 文件 | 状态 |
|---|---|
| `src/types.ts` | ✅ 契约已定 |
| `src/errors.ts` | ✅ |
| `src/runtime/factory.ts` | ✅ 只支持 codex/opencode |
| `src/runtime/codex.ts` | 🚧 stub，`start()` 抛 `NOT_IMPLEMENTED` |
| `src/runtime/opencode.ts` | 🚧 stub，同上 |
| `src/index.ts` | ✅ 导出 |
| `package.json` / `tsconfig.json` | ✅ 脚手架 |
| `tests/factory.spec.ts` | ✅ 3 个测试通过 |
| `npm install && npm run build && npm test` | ✅ 已在本机验证通过（Node 24.14.1） |
| CLI / eval | ⬜ Phase 4 |

**没有实现任何 runtime 协议。** 下一步从 Phase 0 开始。

---

## 7. 下一步（按顺序）

1. 读 `README.md`、`docs/ARCHITECTURE.md`、`IMPLEMENTATION_PLAN.md`。
2. 执行 **Phase 0**：探测本机 Codex/OpenCode 版本与协议，写 `docs/RUNTIME-PROBE.md`。
3. Phase 1：核心契约 + 进程生命周期 + 测试。
4. Phase 2：Codex adapter。
5. Phase 3：OpenCode adapter。
6. Phase 4：CLI + eval（10 条任务）。
7. Phase 5：导出包，准备下一阶段 VS Code 接入。

---

## 8. 给下一个 agent 的启动提示（可直接复制）

```
你在 D:\Tools\agentBox 工作。先读：
  agent-runtime/README.md
  agent-runtime/docs/HANDOFF.md
  agent-runtime/docs/ARCHITECTURE.md
  agent-runtime/IMPLEMENTATION_PLAN.md
  agent-runtime/docs/RUNTIME-PROBE.md

任务：按计划实现 AgentRuntime 运行时层。
- Codex app-server 为主，OpenCode server 为备；OpenClaw 弃用，不新增代码。
- 本阶段不做知识/Skill 注入、不做 VS Code UI、不改 pluginVersion/。
- 先做 Phase 0：探测本机 Codex/OpenCode 版本、CLI flags、JSON-RPC/HTTP 协议、
  事件形状、审批/沙箱、LiteLLM/Qwen 配置、遥测开关；把结果写进 docs/RUNTIME-PROBE.md。
- 环境：Windows 11、Node 24、PowerShell 5.1（无 pwsh）、内网 LiteLLM。
- 约束：纯 Node/TS，不 import vscode；进程集成；统一 AgentEvent；默认不出网；
  安全审批；pin 版本。
- 每完成一个 phase，更新 IMPLEMENTATION_PLAN.md 的复选框和 HANDOFF.md 的当前状态。
```

---

## 9. 待确认 / 风险

| 项 | 影响 | 处理 |
|---|---|---|
| Codex app-server 是否支持 Qwen/LiteLLM 且工具调用稳定 | 决定主备是否互换 | Phase 0 冒烟 + 10 条 eval |
| Codex app-server 协议是否稳定 | adapter 维护成本 | pin 版本；contract test |
| OpenCode server API/事件是否稳定 | adapter 维护成本 | pin 版本；contract test |
| 内网是否有 Qwen3-Coder | 编码质量 | 向管理员确认；没有则先用 235B 冒烟 |
| 两个 runtime 的遥测/更新检查能否关闭 | 保密合规 | 断网环境验证；必要时防火墙 |
| Codex/OpenCode 许可证与 NOTICE | 合规 | 保留 LICENSE/NOTICE；法务确认 |
| Windows 进程树/编码问题 | 稳定性 | taskkill /T；UTF-8 preamble；集成测试 |
