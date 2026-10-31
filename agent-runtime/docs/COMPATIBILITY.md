# 兼容矩阵（COMPATIBILITY）

> 最后实测：2026-10-30。升级任何组件前先重跑 contract suite / eval。

## 1. 运行时版本

| 组件 | 实测版本 | 许可 | 状态 |
|---|---|---|---|
| `@agentbox/runtime` | 0.1.0 | Apache-2.0 | 当前 |
| Codex CLI | 0.165.0 | Apache-2.0 | 主 runtime；`app-server` experimental，必须 pin |
| OpenCode | 1.19.4 | MIT | 已探测；M7 adapter 暂缓 |
| Node（开发/测试） | >=18；本机 24.14.1 | — | runtime 代码兼容 Node 18 |
| VS Code（extension） | 1.85+；本机 1.142.0 | — | 扩展宿主 Node 18 |
| Windows | 11 10.0.26200 | — | Codex Windows sandbox 需首次 setup |
| PowerShell | 5.1（无 pwsh） | — | 不支持 `pwsh` 专属语法 |

## 2. 模型 provider

| Provider | Codex | OpenCode | 备注 |
|---|---|---|---|
| DeepSeek `deepseek-flash` | ✅ Responses API 实测 | ✅ chat completions 实测（M7 adapter 暂缓） | 公网；需显式 opt-in |
| DeepSeek `deepseek-v4-pro` | 官方称支持 Responses；未实测 | 未实测 | 以 `/v1/models` 为准 |
| 内网 LiteLLM + Qwen3-Coder | 未实测 | 未实测 | 生产默认目标；需确认可用性 |
| 内网 Qwen3-235B | 未实测 | 未实测 | 兜底 |

Codex 配置约束：

- `wire_api` 只接受 `"responses"`。
- 自定义 provider 必须完整定义（`base_url` / `env_key`）。
- `thread/start` 用 `permissions: ":workspace"`；Windows sandbox `notConfigured` 时
  M6 会自动 `setupStart(unelevated)` 并重启 app-server。

## 3. 事件/协议版本

| 项 | 值 |
|---|---|
| `AGENT_EVENT_SCHEMA_VERSION` | 1 |
| Codex transport | newline-delimited JSON，无 `jsonrpc` 字段 |
| Codex 协议来源 | `codex app-server generate-ts --experimental` |
| OpenCode API | OpenAPI `/doc`（1.19.4 快照） |

## 4. 接入契约

消费方只需：

1. `createRuntime(config)`；
2. `start()`；
3. `startTurn()` + `onEvent()`；
4. `resolveApproval()`（收到 `approval.request` 时）；
5. `abort()` / `stop()`。

不得依赖 Codex/OpenCode 私有类型；所有事件必须是 `AgentEvent`。

## 5. 已知兼容风险

- Codex `app-server` 仍标 experimental；升级需重跑 contract + eval。
- OpenCode `serve` API 可能随版本变化；M7 实现时需 pin + contract test。
- DeepSeek + Windows 下 `apply_patch` 可能多次重试；建议 `maxSteps` 24–30。
- 公网 provider 需要数据出境/opt-in/审计；内网 Qwen 未验证前不能作为生产唯一依赖。
