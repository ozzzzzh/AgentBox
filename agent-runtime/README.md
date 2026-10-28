# AgentBox Agent Runtime

> **状态：脚手架（Phase 0 尚未开始）**
> 本目录只做 **运行时层（AgentRuntime）**：把编码引擎抽象成可替换的 adapter。
> **知识/Skill 注入、知识库沉淀、VS Code UI 不在本阶段范围**，在下一阶段接入。

---

## 1. 为什么有这个目录

AgentBox 的产品价值在 **知识资产层**（业务逻辑采集、文档沉淀、规范强制、Skill 库、知识库接入），
coding agent 只是可替换的引擎。当前 `pluginVersion/` 里的 OpenClaw 集成验证了 P1 闭环，
但协议/配置变动成本高，因此本阶段把运行时单独抽出来：

- **Codex app-server（主）**：开源、专为 IDE 集成设计、编码能力强、有沙箱/审批。
- **OpenCode server（备）**：开源、TypeScript 生态、provider-agnostic，适合接内网 Qwen。
- **OpenClaw：先弃用**。不在本目录新增 adapter；旧代码留在 `pluginVersion/` 作为历史参考。

运行时层必须 **headless、可测试、不依赖 VS Code**；VS Code 只是它的一个消费者。

---

## 2. 已确定的决策

| 决策 | 内容 |
|---|---|
| 主 runtime | `codex app-server`，stdio JSON-RPC |
| 备 runtime | `opencode serve`，HTTP + SSE |
| 弃用 | OpenClaw 不再新增功能，不进入新 runtime 工厂 |
| 集成方式 | 进程集成（spawn），不 fork、不把 agent 代码拷进插件 |
| 模型 | 内网 LiteLLM / OpenAI-compatible，优先 `Qwen3-Coder`；默认 `Qwen3-235B-A22B-Instruct-2507` 仅作兜底 |
| 配置 | 全部走环境变量/配置文件，不硬编码密钥 |
| 事件 | 统一 `AgentEvent`；UI/捕获/审计只消费这一套 |
| 安全 | 默认不出网、localhost only、工作区沙箱、shell 审批、关闭遥测 |
| 平台 | 不与任何 agent 绑定；后续知识/Skill 走 MCP/平台 API |

---

## 3. 架构（本阶段实现范围）

```
┌────────────────────────── 调用方（下一阶段：VS Code 插件） ──────────────────────────┐
│  turn orchestrator / UI / capture / policy                                         │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │ AgentRuntime（本目录实现的接口）
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
      │ CodexRuntime │      │ OpenCode     │      │ OpenClaw     │
      │ 主             │      │ Runtime 备选  │      │ 弃用，不实现   │
      └──────┬───────┘      └──────┬───────┘      └──────────────┘
             │ stdio JSON-RPC        │ HTTP/SSE
             ▼                       ▼
      codex app-server         opencode serve
             │                       │
             └───────────┬───────────┘
                         ▼
              工作区文件 / PowerShell / 终端
                         │
                         ▼
          LiteLLM → Qwen3-Coder（内网，OpenAI-compatible）
```

详细架构、时序和安全边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 4. 目录结构

```
agent-runtime/
├─ README.md                  # 本文件
├─ IMPLEMENTATION_PLAN.md     # 分阶段任务、验收标准、顺序
├─ package.json
├─ tsconfig.json
├─ .gitignore
├─ docs/
│  ├─ ARCHITECTURE.md         # 架构图、时序、安全边界
│  ├─ HANDOFF.md              # 交接上下文、重要事项、下一步
│  ├─ RUNTIME-PROBE.md        # Phase 0：Codex/OpenCode 协议探测清单
│  └─ EVAL-TASKS.md           # 10 条评测任务与指标
├─ src/
│  ├─ index.ts                # 导出
│  ├─ types.ts                # AgentRuntime / AgentEvent / Limits / Config
│  ├─ errors.ts               # RuntimeError、错误码
│  └─ runtime/
│     ├─ codex.ts             # Codex app-server adapter（stub）
│     ├─ opencode.ts          # OpenCode server adapter（stub）
│     └─ factory.ts           # 按配置选择 runtime
└─ tests/                     # vitest（待实现）
```

---

## 5. 快速开始（脚手架阶段）

```bash
cd agent-runtime
npm install
npm run build
npm test        # 目前没有测试，后续补
```

当前只实现了类型、工厂和两个 adapter 的 **stub**；`start()` 会抛
`NOT_IMPLEMENTED`。真正实现从 `IMPLEMENTATION_PLAN.md` 的 **Phase 0** 开始。

> 已在 Node 24.14.1 / Windows 11 上验证：`npm install`、`npm run build`、
> `npm test`（3 个 factory 测试）全部通过。

---

## 6. 当前状态

| 项 | 状态 |
|---|---|
| `AgentRuntime` / `AgentEvent` / `Limits` 契约定稿 | ✅ |
| `RuntimeConfig` + factory | ✅ |
| Codex app-server adapter | 🚧 stub，待 Phase 0/2 |
| OpenCode server adapter | 🚧 stub，待 Phase 0/3 |
| CLI / eval harness | ⬜ Phase 4 |
| VS Code 集成 | ⬜ 下一阶段 |
| 知识/Skill 注入 | ⬜ 下一阶段 |
| OpenClaw | ⛔ 弃用，不新增 |

---

## 7. 先读哪几份文档

1. [docs/HANDOFF.md](docs/HANDOFF.md) —— **交接必读**：业务上下文、决策、坑、当前状态。
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构、时序、安全边界。
3. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) —— 按顺序执行的任务与验收标准。
4. [docs/RUNTIME-PROBE.md](docs/RUNTIME-PROBE.md) —— Phase 0 的具体探测步骤。
5. [docs/EVAL-TASKS.md](docs/EVAL-TASKS.md) —— 评测任务与指标。
