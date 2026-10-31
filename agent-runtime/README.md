# AgentBox Agent Runtime

> **状态：Milestone 1（Codex Runtime）✅ 已封版；V2 UAT 通过，10 条 eval 基线 9/10；M7 暂缓。**
> 封版记录见 [docs/MILESTONE-1.md](docs/MILESTONE-1.md)；下一阶段 UI 方案见
> [docs/UI-PROPOSAL.md](docs/UI-PROPOSAL.md)（待评审）。
> 本目录只做 **运行时层（AgentRuntime）**：把编码引擎抽象成可替换的 adapter。
> 模块拆分与契约决策见 [docs/MODULES.md](docs/MODULES.md)，完成情况见
> [docs/MODULE-STATUS.md](docs/MODULE-STATUS.md)。
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
├─ NOTICE / LICENSE           # 第三方许可与 Apache-2.0
├─ package.json
├─ tsconfig.json
├─ vitest.config.ts
├─ .gitignore
├─ docs/
│  ├─ MODULES.md              # 模块拆分、依赖、接口、测试与验收（实现契约）
│  ├─ MODULE-STATUS.md        # 各模块完成情况记录
│  ├─ COMPATIBILITY.md        # Codex/OpenCode/Node/VS Code/provider 兼容矩阵
│  ├─ ARCHITECTURE.md         # 架构图、时序、安全边界
│  ├─ HANDOFF.md              # 交接上下文、重要事项、下一步
│  ├─ RUNTIME-PROBE.md        # Phase 0：Codex/OpenCode 协议探测清单
│  └─ EVAL-TASKS.md           # 10 条评测任务与指标
├─ eval/
│  ├─ tasks.json              # 10 条评测任务
│  └─ results/                # 基线报告（Codex+DeepSeek）
├─ examples/                  # consumer 接入示例
├─ scripts/
│  ├─ check-boundaries.mjs    # 禁止 src/ import vscode / pluginVersion
│  └─ clean.mjs               # 构建前清理 dist
├─ src/
│  ├─ index.ts                # 导出
│  ├─ types.ts                # AgentRuntime / AgentEvent / Limits / Config
│  ├─ errors.ts               # RuntimeError、错误码
│  ├─ config.ts               # 配置/输入校验、limits 解析
│  ├─ events.ts               # EventBus（M4）
│  ├─ turn.ts                 # TurnGuard：单 turn / turn.end / 超时 / 审批（M4）
│  ├─ process.ts              # spawn / 行缓冲 / 进程树终止（M3）
│  ├─ security/               # 路径约束、脱敏、最小环境变量（M2）
│  ├─ testing/                # FakeRuntime + 契约测试套件（M5，测试专用）
│  ├─ cli/                    # CLI + JSONL（M8）
│  ├─ eval/                   # eval runner/checks/metrics/report（M9）
│  └─ runtime/
│     ├─ codex/               # Codex app-server adapter（M6）
│     ├─ opencode.ts          # OpenCode server adapter（stub，M7 暂缓）
│     └─ factory.ts           # 按配置选择 runtime（先校验）
└─ tests/                     # vitest（config / security / process / contract / runtime / cli / eval）
```

---

## 5. 快速开始（脚手架阶段）

```bash
cd agent-runtime
npm install
npm run build
npm test                    # vitest
npm run check:boundaries    # 禁止 vscode / pluginVersion import
npm run verify              # build + test + boundaries
```

当前实现：**M1–M6、M8–M10、V1、V2**；**M7（OpenCode）暂缓**。
Codex adapter、CLI/eval、V2 真实 VS Code UAT 均已完成。

```bash
npm run verify       # build + examples typecheck + 141 tests + boundaries
npm run pack:check   # npm pack --dry-run
npm run example:fake # 可运行 consumer 示例
npm run cli -- run --runtime codex --workspace <dir> --prompt "..." --out events.jsonl
```

10 条 eval 基线：Codex + DeepSeek **9/10（90%）**；报告见
[eval/results/2026-10-30-codex-deepseek/](eval/results/2026-10-30-codex-deepseek/)。
版本兼容见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

> `agent-runtime` 已在 Node 24.14.1 / Windows 11 上验证：141 个测试通过（含 CLI/eval）。
> `extension` 已验证：13 个测试通过；V2 已完成真实 VS Code UAT（写文件/审批/Cancel）。
> V1/V2 VSIX：`../extension/agentbox-0.1.0.vsix` / `agentbox-0.2.0.vsix`。

### 5.1 消费方接入契约

```ts
import { createRuntime, type AgentEvent, type RuntimeConfig } from '@agentbox/runtime';

const runtime = createRuntime(config);          // config: RuntimeConfig
runtime.onEvent((event: AgentEvent) => {
  if (event.type === 'approval.request') {
    void runtime.resolveApproval(event.turnId, event.callId, 'deny');
  }
});

await runtime.start();
const handle = await runtime.startTurn({
  prompt: 'hello',
  workspaceRoot: '/path/to/workspace',
});
// ... consume AgentEvent ...
await runtime.abort(handle.turnId);
await runtime.stop();
```

- exports：`@agentbox/runtime`、`@agentbox/runtime/testing`（FakeRuntime）。
- 上层只依赖 `AgentRuntime` / `AgentEvent`；不要 import adapter 私有类型。
- 完整示例：[examples/consumer.ts](examples/consumer.ts)、[examples/run-fake.cjs](examples/run-fake.cjs)。

---

## 6. 当前状态

| 项 | 状态 |
|---|---|
| **Milestone 1 — Codex Runtime** | ✅ [docs/MILESTONE-1.md](docs/MILESTONE-1.md) |
| `docs/MODULES.md` 模块与契约决策 | ✅ |
| `docs/MODULE-STATUS.md` 模块完成记录 | ✅ |
| `docs/UI-PROPOSAL.md` 下一阶段 UI 方案 | 🚧 待评审 |
| **P0** 运行时探测 | ✅ 协议/认证/取消/沙箱/DeepSeek E2E/10 条 eval 完成；内网 Qwen、断网验证为生产跟进 |
| **M1** 契约 / 配置校验 / 边界检查 | ✅ |
| **M2** 安全工具（路径 / 脱敏 / 环境变量） | ✅ |
| `AgentRuntime` / `AgentEvent` / `Limits` 契约（含审批回执） | ✅ |
| `RuntimeConfig` + factory（先校验） | ✅ |
| **M6** Codex app-server adapter | ✅ JSON-RPC / thread / turn / 审批 / 取消 / sandbox 自动 setup |
| **M8** CLI + JSONL | ✅ `agentbox run` / `replay` / `eval`，事件逐行 JSONL |
| **M9** Eval harness | ✅ 10 条任务；Codex+DeepSeek 基线 9/10（90%） |
| **M10** 打包与接入契约 | ✅ exports/NOTICE/LICENSE/COMPATIBILITY/examples；pack 干净 |
| OpenCode server adapter | ⬜ **M7 暂缓**（stub，`start()` 抛 `NOT_IMPLEMENTED`） |
| **M4** 事件总线 / Turn 守卫 | ✅ |
| **M5** FakeRuntime / 契约测试套件 | ✅ |
| **M3** 进程管理 | ✅ |
| **V1 VSIX（FakeRuntime 薄消费者）** | ✅ `../extension/agentbox-0.1.0.vsix`（已人工跑通主路径） |
| **V2 VSIX（真实 Codex）** | ✅ `../extension/agentbox-0.2.0.vsix`（写文件/审批/Cancel UAT 通过） |
| V3 双 runtime VSIX / V4 发布 VSIX | ⬜ V3 待 M7；V4 待 M10 打包流程 |
| CLI / eval harness | ✅ M8/M9；基线见 `eval/results/2026-10-30-codex-deepseek/` |
| 完整产品 UI（知识/资产/Skill 面板） | ⬜ 下一阶段 |
| 知识/Skill 注入 | ⬜ 下一阶段 |
| OpenClaw | ⛔ 弃用，不新增 |

---

## 7. 先读哪几份文档

1. [docs/HANDOFF.md](docs/HANDOFF.md) —— **交接必读**：业务上下文、决策、坑、当前状态。
2. [docs/MILESTONE-1.md](docs/MILESTONE-1.md) —— **Milestone 1 封版记录**。
3. [docs/MODULES.md](docs/MODULES.md) —— **实现契约**：模块边界、依赖、接口、测试与验收。
4. [docs/MODULE-STATUS.md](docs/MODULE-STATUS.md) —— 各模块完成情况与验证结果。
5. [docs/UI-PROPOSAL.md](docs/UI-PROPOSAL.md) —— 下一阶段 UI 方案（待评审）。
6. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构、时序、安全边界。
7. [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) —— 兼容矩阵。
8. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) —— 按顺序执行的任务与验收标准。
9. [docs/RUNTIME-PROBE.md](docs/RUNTIME-PROBE.md) —— Phase 0 的具体探测步骤。
10. [docs/EVAL-TASKS.md](docs/EVAL-TASKS.md) —— 评测任务与指标。
