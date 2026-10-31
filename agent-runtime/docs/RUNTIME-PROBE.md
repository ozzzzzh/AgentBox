# Phase 0：运行时探测报告

> 实测日期：2026-10-28
> 结论先行（2026-10-29 更新）：**Codex 与 OpenCode 均已用 DeepSeek 跑通端到端
> （文本 + 工具 + 审批）；Codex Windows sandbox 已通过 `setupStart(unelevated)` 修复，
> 外写被拦截，沙箱生效后 Codex 仍能完成 workspace 内文件写入。**
> 未完成项：内网 Qwen/LiteLLM 冒烟、10 条 eval。
> **M6 Codex adapter 已实现（2026-10-30）；M7 暂缓；下一步 V2 真实 Codex VSIX。**
>
> 所有探测产物在 `agent-runtime/.probe/`（已 gitignore，不提交）：
> `tools/`（pin 版本二进制）、`logs/`（原始输出/协议 schema）、`codex-home/`、`opencode-home/`。

---

## 0. 环境记录

| 项 | 值 |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Node / npm | v24.14.1 / 11.11.0 |
| VS Code | 1.142.0（`code` CLI） |
| PowerShell | 5.1.26100.9711（无 pwsh） |
| npm registry | `https://registry.npmmirror.com` |
| LiteLLM | `http://172.22.26.117:8085/v1`，可达；无 key 返回 **HTTP 401** |
| 当前模型 | `Qwen3-235B-A22B-Instruct-2507`（Qwen3-Coder 是否存在待确认） |
| `DEEPSEEK_API_KEY` | 已写入 `agent-runtime/.env`（gitignored）；本报告不记录 key 值 |
| 公网模型决策 | **2026-10-28 用户拍板：开放公网模型，内网/外网由用户配置；使用 DeepSeek API** |
| Codex | 未预装；本地隔离安装 **0.165.0** |
| OpenCode | 未预装；本地隔离安装 **1.19.4** |

安装方式（不污染全局 PATH）：

```powershell
# agent-runtime/.probe/tools/package.json
npm install --prefix agent-runtime/.probe/tools
# @openai/codex 0.165.0 (Apache-2.0)
# opencode-ai 1.19.4  (MIT)
```

- Codex 实际二进制：`@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`
- OpenCode 实际二进制：`opencode-ai/bin/opencode.exe`
- 版本已 pin；生产环境需保持同一版本矩阵并保留 NOTICE。

---

## 1. Codex app-server（0.165.0）

### 1.1 CLI 表面

```text
codex app-server [--listen stdio://|unix://|ws://...]
codex app-server generate-json-schema --out <DIR> [--experimental]
codex app-server generate-ts --out <DIR> [--experimental]
codex app-server daemon start|stop|restart|version
codex app-server proxy --sock <PATH>
```

- `app-server` 仍标 **[experimental]**。
- 默认 transport：`stdio://`；生产必须显式 `--listen stdio://`，不要开 ws。
- `generate-json-schema` / `generate-ts` 直接产出完整协议，**不要靠猜方法名**。
- 本次生成结果：`.probe/logs/codex-schema/`、`.probe/logs/codex-ts/`。

### 1.2 传输与信封

**逐行 JSON（newline-delimited），没有 `jsonrpc` 字段。**

```jsonc
// 请求（client -> server）
{ "id": 1, "method": "initialize", "params": { /* ... */ } }

// 成功响应
{ "id": 1, "result": { /* ... */ } }

// 错误响应
{ "id": 3, "error": { "code": -32602, "message": "..." } }

// 服务端通知
{ "method": "turn/completed", "params": { /* ... */ }, "emittedAtMs": 1793173463053 }
```

- 通知额外带 `emittedAtMs`（生成的 TS 类型未包含，需按 wire 处理）。
- 请求/响应按 `id` 关联；`id` 可为 string 或 int64。
- 必须处理 stdout 行缓冲（M3 的 `onStdoutLine` 直接可用）。

### 1.3 握手与认证

请求：

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"agentbox-probe","title":"AgentBox Phase 0 Probe","version":"0.1.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
```

响应：

```json
{"id":1,"result":{"userAgent":"agentbox-probe/0.165.0 (Windows 10.0.26200; x86_64) ...","codexHome":"D:\\...\\.probe\\codex-home","platformFamily":"windows","platformOs":"windows"}}
```

`getAuthStatus`（自定义 provider 下）：

```json
{"id":2,"result":{"authMethod":null,"authToken":null,"requiresOpenaiAuth":false}}
```

- 只要 provider 完整定义且 `env_key` 有值，**不要求 OpenAI/ChatGPT 登录**。
- 未配置 provider 时默认 `openai`，`requiresOpenaiAuth` 会变 true。

### 1.4 配置（CODEX_HOME / config.toml）

实测有效的配置：

```toml
# 顶层 key 必须在任何 [table] 之前，否则会被解析进上一个 table
model_provider = "litellm"
model = "Qwen3-235B-A22B-Instruct-2507"

[analytics]
enabled = false

[model_providers.litellm]
name = "LiteLLM"
base_url = "http://172.22.26.117:8085/v1"
env_key = "MODEL_API_KEY"
wire_api = "responses"
```

关键结论：

- **`wire_api` 只接受 `"responses"`**；`"chat"` / `"chat_completions"` 会报 `invalid data` 导致配置加载失败。
- `model_provider = "litellm"` 必须同时定义 `[model_providers.litellm]`，否则 `entity not found`。
- 省略 `wire_api` 也能加载（默认按 responses 处理），但建议显式写死。
- 顶层 `model_provider` / `model` 放在 `[analytics]` 之后会变成 `analytics.model_provider` 并被忽略。
- app-server 会向 `config.toml` 写入 `[projects.'<cwd>'] trust_level = "trusted"`（本次探测自动写入）。
- `[analytics] enabled = false` 生效；app-server 默认 analytics 关闭。
- Codex 请求走 **`/v1/responses`**（日志确认），不是 chat completions。

### 1.5 核心协议方法

客户端请求（节选，完整见 `ClientRequest.ts`）：

| 方法 | 用途 |
|---|---|
| `initialize` | 握手 |
| `getAuthStatus` | 认证状态 |
| `thread/start` | 创建会话/线程 |
| `turn/start` | 发送用户 turn |
| `turn/interrupt` | 取消当前 turn |
| `command/exec` | 在 sandbox 中执行 argv 命令 |
| `thread/shellCommand` | 执行 shell 字符串（**明确 unsandboxed/full access**） |
| `model/list` / `permissionProfile/list` / `windowsSandbox/readiness` | 诊断 |

通知（节选，完整见 `ServerNotification.ts`）：

| 方法 | 映射 |
|---|---|
| `thread/started` | 会话创建 |
| `turn/started` | turn 开始 |
| `item/started` / `item/completed` | 工具/消息 item 生命周期 |
| `item/agentMessage/delta` | 文本增量（`{threadId,turnId,itemId,delta}`） |
| `item/commandExecution/outputDelta` | 命令输出增量 |
| `item/fileChange/outputDelta` / `item/fileChange/patchUpdated` | 文件变更 |
| `turn/completed` | turn 结束（`turn.status`: `completed`/`interrupted`/`failed`/`inProgress`） |
| `turn/diff/updated` | turn 聚合 diff |
| `error` | 运行错误（含 `willRetry`） |
| `warning` | 模型元数据等警告 |
| `thread/status/changed` | `idle`/`active`/`systemError` |

服务端请求（需要客户端回应）：

| 方法 | 响应 |
|---|---|
| `item/commandExecution/requestApproval` | `{decision}` |
| `item/fileChange/requestApproval` | `{decision}` |
| `item/permissions/requestApproval` | `{decision}` |
| `item/tool/requestUserInput` | 用户输入 |
| `mcpServer/elicitation/request` | MCP 引导 |

命令审批决策：`accept` / `acceptForSession` / `decline` / `cancel`（可带 execpolicy/network amendment）。
文件审批决策：`accept` / `acceptForSession` / `decline` / `cancel`。

> 审批 E2E 未实测：需要模型触发工具调用。结构已从生成 schema 固定。

### 1.6 thread/turn 实测样例

`thread/start` 参数（推荐）：

```json
{
  "modelProvider": "litellm",
  "model": "Qwen3-235B-A22B-Instruct-2507",
  "cwd": "<workspace>",
  "approvalPolicy": "on-request",
  "permissions": ":workspace"
}
```

**必须用 `permissions: ":workspace"`，不要用 `sandbox: "workspace-write"`**（原因见 1.8）。

`turn/start`：

```json
{
  "threadId": "<thread id>",
  "input": [{ "type": "text", "text": "Reply with exactly: probe-ok", "text_elements": [] }]
}
```

实测返回：

- thread id / turn id 为 UUIDv7，例如 `01a18177-9df3-74c2-aa47-87b58bb162c8`。
- `thread/start` 返回 `{thread, model, modelProvider, cwd, approvalPolicy, sandbox, activePermissionProfile, ...}`。
- `turn/start` 立即返回 `{turn:{id,status:"inProgress",...}}`，随后通过通知推进。
- 用户消息会以 `item/started` + `item/completed`（`type:"userMessage"`）回显。
- 模型元数据缺失时收到 `warning`：
  `Model metadata for Qwen3-235B-A22B-Instruct-2507 not found. Defaulting to fallback metadata...`

### 1.7 取消

```json
{"id":6,"method":"turn/interrupt","params":{"threadId":"...","turnId":"..."}}
```

实测：interrupt 后 **9ms** 收到：

```json
{"method":"turn/completed","params":{"threadId":"...","turn":{"id":"...","status":"interrupted","error":null}}}
```

- 取消语义满足 5 秒要求。
- 取消后 app-server 保持运行，可继续下一个 turn。

### 1.8 Sandbox / 权限（**已修复**）

修复前实测（Windows sandbox `notConfigured`）：

| 请求 | 返回 sandbox | 实际效果（修复前） |
|---|---|---|
| `sandbox: "workspace-write"` | `readOnly` | 降级为只读 |
| `permissions: ":workspace"` | `workspaceWrite` | **未实际限制写入** |
| `permissions: ":read-only"` | `readOnly` | **未实际限制写入** |
| `command/exec` 显式 `workspaceWrite/readOnly` | 对应策略 | 外写/内写均成功，无强制 |

**修复过程（2026-10-29）**：

1. `windowsSandbox/readiness` 初始为 `notConfigured`。
2. 调用 `windowsSandbox/setupStart`：

```json
{"id":3,"method":"windowsSandbox/setupStart","params":{"mode":"unelevated","cwd":"<workspace>"}}
```

3. 收到 `windowsSandbox/setupCompleted {"mode":"unelevated","success":true,"error":null}`。
4. **同一 app-server 进程内 readiness 仍显示 `notConfigured`（缓存）；重新启动 app-server 后变为 `ready`。**
5. 重启后复测：

| 请求 | 实际效果（修复后） |
|---|---|
| `permissions: ":workspace"` | workspace 内写入成功；workspace 外写入 **EPERM** |
| `sandboxPolicy: workspaceWrite` | 内写成功；外写 **EPERM** |
| `sandboxPolicy: readOnly` | workspace 内写入也 **EPERM** |

实测证据：

- `workspaceWrite inside` → exit 0，`inside-ok`
- `workspaceWrite outside` → sandbox denied，`EPERM`
- `readOnly inside` → sandbox denied，`EPERM`
- 文件结果：`inside=true`、`outside=false`

修复后再次跑 Codex + DeepSeek（`permissions:":workspace"`）：
文本 `probe-ok`、commandExecution 审批、workspace 内写出 `codex-ok` 均成功。

**M6/V2 需要落实**：

- Windows 上启动时先查 `windowsSandbox/readiness`；`notConfigured` 时提示/执行一次性
  `setupStart`（本次 `unelevated` 成功，无需 UAC），**然后重启 app-server**。
- 不要把同一进程内的 readiness 结果当作 setup 后的最终状态。
- `thread/shellCommand` 仍明确 unsandboxed，生产不要暴露给模型/调用方。
- 非 Windows 平台按 POSIX sandbox 处理（待补测）。

### 1.9 错误 / 重试 / 脱敏

dummy key 实测：

- Codex 请求 `http://172.22.26.117:8085/v1/responses`，401。
- 收到 `error` 通知，`willRetry: true`，`codexErrorInfo.responseStreamDisconnected.httpStatusCode = 401`。
- 会重试 `1/5`…`5/5`；期间可 `turn/interrupt`。
- 错误 `additionalDetails` 含**部分 API key 与 key hash**，接入时必须走 M2 脱敏。

### 1.10 遥测 / 更新 / 外部依赖

- app-server 默认 analytics 关闭；`[analytics] enabled=false` 生效。
- **不要**传 `--analytics-default-enabled`（那是 OpenAI 第一方 IDE 用例的默认开启开关）。
- 启动通知 `remoteControl/status/changed` = disabled；未观察 remote control 外联。
- 未观察自动更新；`codex update` 是显式子命令。生产仍应 pin 二进制并用防火墙阻断非内网出口。
- 本次唯一模型出口：内网 LiteLLM `/v1/responses`。

---

## 2. OpenCode server（1.19.4）

### 2.1 启动与 health

```powershell
opencode serve --hostname 127.0.0.1 --port 0 --print-logs --log-level INFO
```

实测：

- 默认 `hostname=127.0.0.1`、`port=0`（自动分配）。
- 启动日志：`opencode server listening on http://127.0.0.1:<port>`。
- `GET /global/health` → `{"healthy":true,"version":"1.19.4"}`。
- `GET /doc` → OpenAPI 3.1 JSON（已保存 `.probe/logs/opencode-openapi.json`）。
- `GET /` / `/app` / `/health` 返回内置 Web UI HTML（建议生产禁用 Web UI）。
- 未设置 `OPENCODE_SERVER_PASSWORD` 时启动告警：
  `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`

### 2.2 认证（Basic）

设置：

```powershell
$env:OPENCODE_SERVER_USERNAME = "agentbox"
$env:OPENCODE_SERVER_PASSWORD = "<random>"
```

实测：

- 无 Authorization → **401**，`WWW-Authenticate: Basic realm="Secure Area"`。
- `Authorization: Basic base64(agentbox:<password>)` → 200。
- 错误密码 → 401。
- **`GET /config` 会返回明文 `provider.options.apiKey`**（即使 `debug config` 显示 `***`）。
  因此必须开 Basic auth；runtime 不得把 `/config` 内容写日志/事件。

### 2.3 API 路径（节选）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/global/health` | GET | 健康检查 |
| `/event` | GET | SSE 事件流 |
| `/session` | GET/POST | 列出/创建会话 |
| `/session/{id}/message` | POST | 发送 prompt（`session.prompt`） |
| `/session/{id}/abort` | POST | 取消会话 |
| `/permission` | GET | 待处理权限 |
| `/permission/{requestID}/reply` | POST | 审批回执 |
| `/session/{id}/shell` | POST | 直接执行 shell（用户命令，绕过模型权限） |
| `/file` / `/find` / `/vcs` | GET | 文件/搜索/diff |
| `/agent` | GET | agent 与权限 |
| `/config` | GET/PATCH | 配置（含明文 key，见上） |

### 2.4 会话与 prompt

创建会话：

```http
POST /session
{}
```

返回：

```json
{"id":"ses_...","slug":"quiet-mountain","directory":"...","version":"1.19.4","time":{"created":...}}
```

发送 prompt：

```http
POST /session/{sessionID}/message
{
  "model": {"providerID":"litellm","modelID":"Qwen3-235B-A22B-Instruct-2507"},
  "parts": [{"type":"text","text":"Reply with exactly: probe-ok"}]
}
```

- 返回 HTTP 200，body `{info: AssistantMessage, parts: Part[]}`。
- **模型错误不改变 HTTP 状态**：`info.error` 为 `APIError`/`ProviderAuthError` 等，
  同时 SSE 发 `session.error`。
- dummy key 实测请求 `http://172.22.26.117:8085/v1/chat/completions`，401。
- 错误 body 也含部分 key / key hash，必须脱敏。

### 2.5 SSE 事件

`GET /event`（可带 `directory` / `workspace` query）→ `text/event-stream`。

实测/从 OpenAPI 固定的事件：

| 事件 | 关键字段 |
|---|---|
| `server.connected` | — |
| `server.heartbeat` | — |
| `session.created` / `session.updated` | `{sessionID, info}` |
| `session.status` | `{sessionID, status:{type:"idle"|"busy"|"retry"}}` |
| `session.idle` | `{sessionID}` |
| `session.error` | `{sessionID, error}` |
| `session.diff` | `{sessionID, diff}` |
| `message.updated` | `{sessionID, info}` |
| `message.part.updated` | `{sessionID, part, time}` |
| `message.part.delta` | `{sessionID, messageID, partID, field, delta}` |
| `file.edited` | `{file}` |
| `permission.asked` | PermissionRequest |
| `permission.replied` | `{sessionID, requestID, reply}` |

`Part` 类型：`text` / `tool` / `reasoning` / `file` / `step-start` / `step-finish` / `snapshot` / `patch` / `retry` / `compaction`。

`ToolPart`：

```json
{"type":"tool","tool":"bash","callID":"...","state":{"status":"running|completed|error","input":{},"output":"...","error":"...","time":{...}}}
```

### 2.6 审批

- 权限请求事件：`permission.asked`，字段与 `PermissionRequest` 一致：
  `{id:"per...", sessionID, permission, patterns, metadata, always, tool?}`。
- 回执：

```http
POST /permission/{requestID}/reply
{"reply":"once" | "always" | "reject"}
```

- 也有 session 作用域路径 `/session/{sessionID}/permissions/{permissionID}`（OpenAPI）。
- 实测说明：`session/shell` 是用户直接命令，**绕过模型权限**，不会产生 `permission.asked`；
  审批 E2E 需要真实模型触发工具调用，本次因无 key 未完成。

### 2.7 取消

```http
POST /session/{sessionID}/abort
{}
```

实测：

- 返回 `true`。
- 正在运行的 shell 工具在 **686ms** 内结束，输出：
  `User aborted the command`。
- 随后 SSE `session.status(idle)` + `session.idle`。
- 满足 5 秒取消要求。

### 2.8 Provider 配置

1.19.4 仍接受 deprecated `provider` 形式（本次实测有效）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "litellm/Qwen3-235B-A22B-Instruct-2507",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM",
      "options": {
        "baseURL": "http://172.22.26.117:8085/v1",
        "apiKey": "{env:MODEL_API_KEY}"
      },
      "models": {
        "Qwen3-235B-A22B-Instruct-2507": { "name": "Qwen3-235B-A22B-Instruct-2507" }
      }
    }
  },
  "permission": { "bash": "ask", "edit": "ask", "external_directory": "ask" },
  "update": "disable",
  "share": "disabled",
  "autoupdate": false,
  "experimental": { "openTelemetry": false }
}
```

- 新 schema 也有 `providers`（`canonical/package/settings/models`）形式；V2 可再评估。
- 使用 `@ai-sdk/openai-compatible`，实际打 **`/v1/chat/completions`**。
- 配置隔离：设置 `HOME` / `USERPROFILE` 到独立目录即可把 `~/.config/opencode` 隔离。

### 2.9 更新 / 分享 / 遥测 / 离线

实测可用的开关：

| 目标 | 配置/环境 |
|---|---|
| 关闭自动更新 | `OPENCODE_DISABLE_AUTOUPDATE=1`；config `autoupdate:false`、`update:"disable"` |
| 禁止分享 | config `share:"disabled"` |
| 禁止 models.dev 拉取 | `OPENCODE_DISABLE_MODELS_FETCH=1` |
| 关闭 Web UI | `OPENCODE_DISABLE_EMBEDDED_WEB_UI=1`（建议，未实测） |
| OpenTelemetry | `experimental.openTelemetry:false` |
| 服务认证 | `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` |
| 配置路径 | `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` |

- 本次启动/会话未观察到更新检查或外部 models.dev 请求（已设禁用开关）。
- 二进制内存在 `telemetry` / `checkForUpdates` 字符串；生产仍需防火墙/断网验证。
- `/config` 会暴露明文 key；Basic auth 必开，且不要记录该响应。

---

## 3. 模型冒烟（DeepSeek 已完成；内网 Qwen 待定）

产品决策（2026-10-28）：**支持公网模型，内网/外网模型由用户配置**。
计划先用 **DeepSeek API** 完成协议冒烟；内网 LiteLLM/Qwen 仍保留为默认目标。

### 3.1 DeepSeek 兼容性

官方文档/公开资料确认：

- DeepSeek 已提供 **Responses API**（`POST /responses`，2026-07-31 起随 V4-Flash），
  官方配置可直接用于 Codex，无需翻译代理。
- 支持模型：`deepseek-flash` / `deepseek-v4-flash`（同一代际）、`deepseek-v4-pro`
  （Responses 支持稍后开放；以 `/v1/models` 实测为准）。
- Responses API 支持 `function` tools、`custom` 的 `apply_patch`、`tool_choice`、streaming；
  `web_search` 仅 `deepseek-v4-pro`；**stateless**（不发 `previous_response_id`/`conversation`）；
  没有 `data: [DONE]` 终止帧。
- Codex 需要 **0.144.0+**；本机为 0.165.0，满足。
- OpenCode 走 `/v1/chat/completions`，DeepSeek 同样兼容；工具调用需实测。

Codex 配置草案（以真实 key 验证后固化）：

```toml
model = "deepseek-v4-flash"
model_provider = "deepseek"
preferred_auth_method = "apikey"
forced_login_method = "api"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
```

注意：

- 公网模型属于显式例外：默认关闭；配置后需要界面告警、审计、数据分级。
- 不要把源码/业务数据发给公网模型；冒烟只用合成临时目录。
- 可能需要 `model_catalog_json`（官方指南提到）；先用最小配置实测，失败再补。
- 无 key 探测 `/v1/responses` 返回 401（网关先鉴权），**不能据此判断路由不存在**；
  必须用真实 key 做一次最小 `responses.create`。

### 3.2 冒烟状态

| 项 | 状态 |
|---|---|
| DeepSeek `/v1/models` | ✅ 返回 `deepseek-flash`、`deepseek-v4-pro` |
| DeepSeek `/v1/responses` | ✅ 最小请求 `completed`；`deepseek-v4-flash` 被接受并规范化为 `deepseek-flash` |
| DeepSeek `/v1/chat/completions` | ✅ OpenCode 实测可用 |
| `DEEPSEEK_API_KEY` | ✅ 已配置在 `.env`（不记录值） |
| Codex + DeepSeek | ✅ 文本 turn + commandExecution 审批 + 写出 `codex-ok` |
| OpenCode + DeepSeek | ✅ 文本 turn + edit 权限审批 + 写出 `opencode-ok` |
| 读文件→改一行→报告 diff | ✅ 合成目录完成（Codex + OpenCode） |
| tool-call 合法率 / 步数 / token / 延迟 | ⬜ 待 10 条 eval |
| 内网 LiteLLM + Qwen | ⬜ 当前无可用内网 LLM |
| 10 条 eval | ⬜ 待 M9（M6 已就绪；M7 暂缓） |

### 3.3 实测结果（2026-10-29）

**Codex + DeepSeek**

- 配置：`model="deepseek-flash"`、`base_url="https://api.deepseek.com/"`、
  `wire_api="responses"`、`env_key="DEEPSEEK_API_KEY"`。
- `thread/start`：`sandbox={"type":"workspaceWrite","writableRoots":[]}`，
  `activePermissionProfile={id:":workspace"}`。
- Turn 1（纯文本）：输出 `probe-ok`，`turn/completed(status=completed)`。
- Turn 2（写文件）：触发两次 `item/commandExecution/requestApproval`，接受后写出
  `probe-codex.txt`，内容 `codex-ok`，turn 完成。
- 警告：
  - `preferred_auth_method` 在 0.165 **不被识别**（可移除）。
  - `Model metadata for deepseek-flash not found. Defaulting to fallback metadata...`
    —— 建议后续提供 `model_catalog_json`，避免 fallback 影响性能。
- 关键结论：**Codex 可直连 DeepSeek，不需要代理**；`deepseek-v4-flash` 别名可用，
  规范 ID 为 `deepseek-flash`。
- **Windows shell 摩擦（2026-10-30 人工验收）**：
  - DeepSeek 通过 PowerShell 传 `apply_patch` here-string 时前两次失败（patch 被截断/引号破坏）；
  - `bash --version` 在 sandbox 下报 `CreateFileMapping ... Win32 error 5`；
  - 模型最终改用 PowerShell 构造 patch 成功写出文件；
  - 建议 `maxSteps` 提到 24–30，并补 `model_catalog_json`；这不是 adapter 协议错误。

**OpenCode + DeepSeek**

- 配置：`npm="@ai-sdk/openai-compatible"`、`baseURL="https://api.deepseek.com"`、
  `apiKey="{env:DEEPSEEK_API_KEY}"`、模型 `deepseek/deepseek-flash`。
- Turn 1（纯文本）：输出 `probe-ok`。
- Turn 2（写文件）：SSE `permission.asked`（`permission:"edit"`，带 filepath/diff），
  `POST /permission/{id}/reply {reply:"once"}` 后写出 `probe-opencode.txt`，
  内容 `opencode-ok`，返回 `DONE`。
- 事件序列覆盖：`message.part.delta`、`permission.asked/replied`、`file.edited`、
  `session.idle`、`session.diff`。
- **模型 ID 必须用规范名 `deepseek-flash`**；`deepseek-v4-flash` 在 OpenCode 会报
  `ProviderModelNotFoundError`（提示 `deepseek-flash, deepseek-v4-pro`）。
- 关键结论：**OpenCode 可直连 DeepSeek chat completions，权限审批 E2E 已验证**。

**安全说明**

- 两次冒烟都只使用 `.probe/workspace*` 合成目录，没有挂载真实仓库。
- DeepSeek 是公网模型，提示词/工具输出会离开本机；生产必须 opt-in/告警/审计。
- Codex 的 Windows sandbox 仍未生效；当前测试仅靠审批 + 合成目录控制风险。

---

## 4. 决策门（P0）

| 项 | 结论 |
|---|---|
| 公网模型 | ✅ **允许，用户可配置**（2026-10-28 决策）；默认仍内网，公网需 opt-in/告警/审计 |
| DeepSeek + Codex | ✅ **实测通过**：文本、commandExecution 审批、写文件、完成 |
| DeepSeek + OpenCode | ✅ **实测通过**：文本、edit 权限审批、写文件、完成 |
| 主备是否互换 | **维持 Codex 主 / OpenCode 备**；sandbox 已修复，最终由 10 条 eval 决定 |
| Codex 是否可用 | ✅ 协议/工具/审批/取消可用；**Windows sandbox 已 setup 并验证拦截外写** |
| OpenCode 是否可用 | ✅ 服务/SSE/认证/取消/权限审批可用 |
| 是否可以进入 M6/M7 | ✅ **可以开始**；V2 先实现真实 Codex 闭环 |
| 安全前置 | Windows 机器首次使用需 `windowsSandbox/setupStart` 并重启 app-server；`notConfigured` 时不得静默运行 |

需要拍板/跟进：

1. **内网 Qwen/Qwen3-Coder**：确认是否可用；没有则 DeepSeek 作为过渡，但生产仍需内网模型。
2. **10 条 eval**：用 DeepSeek + Codex/OpenCode 跑基线（M6/M7/M9）。
3. **OpenCode 安全配置**：M7 必须生成随机 server password、只绑 127.0.0.1、禁用 Web UI。
4. **Codex model catalog**：补 `model_catalog_json` 消除 DeepSeek fallback 警告（不阻塞）。

---

## 5. 安全发现清单（必须落到 M6/M7）

1. Codex Windows sandbox：**已通过 `setupStart(unelevated)` 修复并验证外写拦截**；
   但每台 Windows 机器首次需 setup，且 setup 后必须重启 app-server。
   `thread/shellCommand` 仍明确 unsandboxed，生产不要暴露。
2. Codex 错误详情含部分 API key / key hash → 事件/日志必须脱敏。
3. OpenCode 未设 password 时服务无认证；`/config` 返回明文 apiKey。
   M7 必须生成随机 `OPENCODE_SERVER_USERNAME/PASSWORD`，并只绑 127.0.0.1。
4. OpenCode 错误 `responseBody` 可能含敏感内容 → 脱敏后再进事件。
5. Codex 默认 analytics 关闭；不要传 `--analytics-default-enabled`。
6. OpenCode 需显式关闭更新/分享/models 拉取；生产仍要防火墙/断网验证。
7. 两个 runtime 都可能输出超长/敏感错误；M3 行截断 + M2 脱敏必须串联。
8. 公网模型（DeepSeek）会把 prompt/tool 输出发到外部；默认关闭，需 opt-in/告警/审计；
   本次冒烟只使用合成目录，生产禁止把秘密级数据发给公网模型。
9. OpenCode 的 DeepSeek 模型 ID 必须用规范名 `deepseek-flash`；`deepseek-v4-flash`
   是 Responses/Codex 侧别名，OpenCode 会报 `ProviderModelNotFoundError`。

---

## 6. 复现命令

```powershell
# 安装（隔离）
cd agent-runtime
npm install --prefix .probe/tools

# Codex 版本/配置/schema
.probe/tools/node_modules/.bin/codex.cmd --version
$env:CODEX_HOME = "$PWD/.probe/codex-home"
.probe/tools/node_modules/.bin/codex.cmd doctor
.probe/tools/node_modules/.bin/codex.cmd app-server generate-json-schema --experimental --out .probe/logs/codex-schema
.probe/tools/node_modules/.bin/codex.cmd app-server generate-ts --experimental --out .probe/logs/codex-ts

# Codex 握手/thread/turn/取消/沙箱
node .probe/codex-stdio-probe.mjs
node .probe/codex-turn-probe.mjs
node .probe/codex-cancel-sandbox-probe.mjs
node .probe/codex-sandbox-readiness.mjs
node .probe/codex-profile-probe.mjs
node .probe/codex-exec-sandbox-probe.mjs
node .probe/codex-sandboxpolicy-probe.mjs

# OpenCode serve/health/auth/审批/取消
node .probe/opencode-serve-probe.mjs
node .probe/opencode-auth-probe.mjs
node .probe/opencode-permission-probe.mjs
node .probe/opencode-abort-probe.mjs
```

---

## 7. 待解问题

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | 内网是否有 Qwen3-Coder | 编码质量 | 待 key/管理员 |
| 2 | Codex Windows sandbox 能否配置成功 | 安全边界 / 主备 | 待拍板 |
| 3 | Codex + Qwen `/v1/responses` 工具调用稳定性 | 主备选择 | 待 key |
| 4 | OpenCode permission.asked E2E | 审批可用性 | 待 key |
| 5 | Codex app-server 仍是 experimental | adapter 维护成本 | 已 pin 0.165.0；contract test |
| 6 | OpenCode server API 稳定性 | adapter 维护成本 | 已 pin 1.19.4；OpenAPI 快照 |
| 7 | 两个 runtime 遥测能否完全关闭 | 保密合规 | 配置已做；断网/防火墙验证待做 |
| 8 | OpenCode `/config` 明文 key | 保密 | 必须开 Basic auth + 不记录 |
