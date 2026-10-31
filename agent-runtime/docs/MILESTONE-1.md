# Milestone 1 — Codex Runtime 集成

> **状态：✅ 完成（2026-10-30）**
> **交付物：可替换的 AgentRuntime 运行时层 + Codex app-server 集成。**
> 本文是阶段封版记录；下一阶段 UI 方案见 [UI-PROPOSAL.md](UI-PROPOSAL.md)。

---

## 1. 目标与结果

**目标**：在信息安全/保密前提下，把编码引擎抽象成可替换的 runtime，并完成
Codex app-server 的真实集成与验证。

**结果**：

- `@agentbox/runtime` 0.1.0 可用：契约、配置校验、安全工具、进程管理、事件守卫、
  Codex adapter、CLI/JSONL、eval harness、打包与接入契约。
- V2 VS Code 扩展作为真实 consumer 完成 UAT（写文件/审批 Allow/Deny/Cancel）。
- Codex + DeepSeek 10 条 eval 基线 **9/10（90%）**。
- M7（OpenCode adapter）按用户决定暂缓，不在本 milestone 交付范围内。

---

## 2. 范围

### ✅ 已交付

| 范围 | 内容 |
|---|---|
| M1 | 契约、错误码、配置/输入校验、边界检查 |
| M2 | 工作区路径约束、脱敏、子进程最小环境变量 |
| M3 | 进程管理、行缓冲、Windows 进程树终止 |
| M4 | EventBus、TurnGuard、审批回执、超时/取消 |
| M5 | FakeRuntime、统一 contract suite |
| M6 | Codex app-server adapter（JSON-RPC、thread/turn、审批、取消、sandbox setup） |
| M8 | CLI `run`/`replay`、JSONL 事件日志 |
| M9 | 10 条 eval 任务、指标、报告 |
| M10 | exports、NOTICE/LICENSE、兼容矩阵、consumer 示例、pack 检查 |
| V1 | FakeRuntime VSIX walking skeleton |
| V2 | 真实 Codex VSIX + 真实 VS Code UAT |

### ⛔ 不在本 milestone

- M7 OpenCode adapter、V3 双 runtime VSIX。
- V4 正式 Release VSIX（发布流程）。
- 知识/Skill 注入、完整产品 UI、知识库连接器、RBAC/审计。
- 多 agent、多会话并发。

---

## 3. 交付物

| 交付物 | 路径/说明 |
|---|---|
| Runtime 包 | `agent-runtime/`（`npm pack --dry-run` 93 files / 72.8 KB） |
| Codex adapter | `src/runtime/codex/` |
| CLI + JSONL | `src/cli/`；`agentbox run/replay/eval` |
| Eval harness | `src/eval/`、`eval/tasks.json` |
| 扩展 V2 | `extension/agentbox-0.2.0.vsix` |
| 基线报告 | `eval/results/2026-10-30-codex-deepseek/` |
| 兼容矩阵 | [COMPATIBILITY.md](COMPATIBILITY.md) |
| 接入示例 | `examples/consumer.ts`、`examples/run-fake.cjs` |
| 许可 | `LICENSE`（Apache-2.0）、`NOTICE`（Codex/OpenCode） |

---

## 4. 验证证据

| 项 | 结果 |
|---|---|
| runtime 测试 | **141 passed**（含 CLI 15、eval 9） |
| extension 测试 | **13 passed**（controller/settings/bundle） |
| examples typecheck | ✅ |
| 边界检查 | ✅（31 files，无 vscode/pluginVersion import） |
| `npm pack --dry-run` | ✅ 无 node_modules/src/test-only contract/fixture |
| `example:fake` | ✅ turn 生命周期正常 |
| Codex + DeepSeek E2E | ✅ 文本/tool/审批/文件写入 |
| V2 VS Code UAT | ✅ 写文件、审批 Allow/Deny、Cancel |
| Codex Windows sandbox | ✅ `setupStart(unelevated)` + 重启后 ready；外写 EPERM |
| 10 条 eval | **9/10（90%）**；avg steps 6.9；avg 41.4s；avg first token 2.7s |
| OpenCode 探测 | ✅ 协议/认证/取消/权限 E2E；adapter 未实现 |

复现：

```powershell
cd agent-runtime
npm install
npm run verify
npm run pack:check
npm run example:fake

# 真实 eval（需要 .env 中的 DEEPSEEK_API_KEY/Codex 路径）
node dist/cli/index.js eval --tasks eval/tasks.json --out-dir .probe/eval-results/run-1 `
  --runtime codex --provider deepseek --model deepseek-flash `
  --base-url https://api.deepseek.com --api-key-env DEEPSEEK_API_KEY --env-file .env `
  --home .probe/codex-home --command "<path-to-codex.exe>" `
  --approval allow --approval-policy on-request --permissions :workspace `
  --max-steps 30 --turn-timeout-ms 180000
```

---

## 5. 已拍板决策（本阶段）

- 主 runtime：Codex app-server；备 runtime：OpenCode（adapter 暂缓）。
- 进程集成：spawn + stdio/HTTP，不 fork、不复制源码。
- 模型：默认内网；允许用户显式配置公网 OpenAI-compatible（DeepSeek 已实测）。
- 事件：统一 `AgentEvent`，schema version = 1。
- 安全：默认不出网；工作区沙箱；shell 审批；事件脱敏；子进程最小环境。
- 扩展：VS Code only；复用原生编辑器/搜索/终端；V2 用 OutputChannel + 模态审批。

---

## 6. 已知问题 / 风险

| # | 问题 | 影响 | 处理 |
|---|---|---|---|
| 1 | M7 OpenCode 未实现 | 无备用 runtime / V3 缺失 | 下一阶段按需补 |
| 2 | 内网 LiteLLM/Qwen 不可用 | 生产保密目标未满足 | 生产前置确认 Qwen3-Coder |
| 3 | DeepSeek 公网数据出境 | 保密风险 | 显式 opt-in/告警/审计；秘密数据禁止 |
| 4 | Windows sandbox 每 home 首次需 setup | 首次启动延迟/失败 | M6 自动 setup + 重启；持久 home |
| 5 | DeepSeek + Windows `apply_patch` 摩擦 | tool errors 高、steps 多 | `maxSteps` 24–30；补 `model_catalog_json` |
| 6 | `file.changed` 仅 fileChange item | shell 写文件不触发 | UI 阶段加 VS Code 文件 watcher |
| 7 | token usage 未采集 | eval 指标不完整 | 后续从 Codex usage 通知映射 |
| 8 | 无产品 UI | 只有 OutputChannel + 模态审批 | 下一阶段 UI 方案（见 UI-PROPOSAL） |
| 9 | V4 发布流程未做 | 无正式 VSIX 发布 | 后续补 NOTICE/版本矩阵/安装文档 |

---

## 7. 下一阶段入口

- 上层改造：**UI / Skill 库 / 知识注入**。
- 先做 UI 方案评审：[UI-PROPOSAL.md](UI-PROPOSAL.md)。
- UI 消费者继续只依赖 `createRuntime` + `AgentEvent`，不修改 adapter。

---

## 8. Definition of Done 核对

- [x] Windows + Node 24：`npm install && npm run build && npm test`。
- [x] `src/` 无 `vscode` import、无 `pluginVersion` import。
- [x] Codex adapter 通过 contract suite。
- [x] 统一事件；`turn.end` 兜底；取消/超时可用。
- [x] Windows 无残留进程（进程树终止）。
- [x] 默认不出网；Codex sandbox 外写被拦截。
- [x] CLI/eval 可运行；10 条基线有报告。
- [x] 文档、NOTICE、兼容矩阵、接入示例齐全。
- [x] 未修改 `pluginVersion/`。
- [ ] M7/V3/V4（明确不在本 milestone）。
