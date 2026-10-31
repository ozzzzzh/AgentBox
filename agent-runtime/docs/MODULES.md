# 模块拆分与实现契约（MODULES）

> 目的：把本阶段（运行时层）拆成**可独立实现、可独立测试、边界清晰**的模块，
> 固定模块之间的接口与依赖方向，供后续编码者按顺序实现。
>
> 本文件是**实现契约**：改接口先改本文件，再改代码与 contract test。
> 需求见 [REQUIREMENTS.md](REQUIREMENTS.md)，总体架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，
> 分阶段任务见 [../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)。
>
> **Milestone 1（Codex Runtime）已封版（2026-10-30）**：M1–M6、M8–M10、V1、V2；
> M7/V3/V4 暂缓。封版记录见 [MILESTONE-1.md](MILESTONE-1.md)；
> 下一阶段 UI 方案见 [UI-PROPOSAL.md](UI-PROPOSAL.md)。

---

## 1. 全局规则（所有模块必须遵守）

1. **纯 Node/TS**：`src/` 禁止 `import 'vscode'`，禁止 import `pluginVersion/`。
   由 `scripts/check-boundaries.mjs` 强制检查。
2. **依赖方向**：只允许高层模块依赖低层模块；低层模块不得反向 import 高层模块。
   唯一的公共类型来源是 `src/types.ts`。
3. **进程集成**：不 fork、不复制 Codex/OpenCode 源码；通过 spawn + 协议交互。
4. **统一事件**：所有 runtime 私有事件必须映射为 `AgentEvent`；上层不得看到 runtime 私有事件。
5. **安全默认**：不出网、只绑 `127.0.0.1`、子进程环境变量最小化、事件脱敏、路径限制在 workspace。
6. **每个模块必须有测试**：单元测试随模块提交；adapter 必须通过统一 contract suite。
7. **接口即契约**：公共接口只放在 `src/index.ts` 或本文件声明的子路径；
   模块内部文件不互相跨层 import。
8. **扩展宿主兼容**：`agent-runtime` 代码必须能在 VS Code 1.85+ 的扩展宿主（Node 18）运行；
   开发/测试用 Node 24，但打包目标按 `node18`。不要引入 Node 20+ 专属 API。
9. **VS Code 代码隔离**：任何 `vscode` import 只能出现在独立的 `extension/` 包；
   `agent-runtime/src` 永远不依赖 VS Code。

### 1.1 模块完成定义（Definition of Done）

- 模块的公共接口与本文件一致（或本文件已同步更新）。
- 单元测试覆盖：正常路径、边界值、错误路径、取消/超时（如适用）。
- `npm run build` 通过。
- `npm test` 通过。
- `npm run check:boundaries` 通过。
- 若涉及契约变化：同步更新本文件 + `ARCHITECTURE.md` + contract test。
- **在 [MODULE-STATUS.md](MODULE-STATUS.md) 记录完成情况**（状态、日期、产物、测试数、验证结果、已知限制）。
- 若完成一个 Phase 的子项：更新 [../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) 与 [HANDOFF.md](HANDOFF.md)。

---

## 2. 模块总览

| ID | 模块 | 职责一句话 | 对应 Phase | 依赖 |
|---|---|---|---|---|
| **M1** | 契约、配置校验与工程边界 | 定义所有公共类型、错误码、配置/输入校验、静态边界检查 | P1.1 / P1.2 / P1.5 / P1.8 | 无 |
| **M2** | 安全工具 | 工作区路径约束、事件脱敏、子进程最小环境变量 | P1（辅助） | M1 |
| **M3** | 进程管理 | spawn、行缓冲、超时、Windows 进程树终止、幂等 stop | P1.3 | M1、M2 |
| **M4** | 事件总线与 Turn 守卫 | 类型安全分发、单活动 turn、`turn.end` 恰好一次、超时兜底 | P1.4 | M1 |
| **M5** | FakeRuntime + 契约测试套件 | 可脚本化假 runtime；所有 adapter 复用的 contract test | P1.6 / P1.7 | M1、M4 |
| **M6** | Codex adapter（主） | `codex app-server` 进程 + JSON-RPC + 事件映射 + 审批/取消 | P2 | M1–M5 |
| **M7** | OpenCode adapter（备） | `opencode serve` 生命周期 + HTTP/SSE + 权限/取消 | P3 | M1–M5 |
| **M8** | CLI + JSONL 事件日志 | headless 运行入口、事件落盘、可回放 | P4.1 / P4.2 | M1–M7 |
| **M9** | Eval harness | 10 条任务、指标采集、Codex vs OpenCode 报告 | P4.3–P4.6 | M6–M8 |
| **M10** | 打包与接入契约 | exports、NOTICE、版本矩阵、consumer 示例、npm pack | P5 | 全部 |

> 另有 **VSIX 验证轨道 V1–V4**（独立包 `extension/`，只消费 runtime 公共入口），
> 见 §2.2 与 §4。V 轨道不是产品 UI，只用于端到端验证。

### 2.1 依赖图

```
M1 ──┬── M2 ─── M3 ──┐
     │               ├── M6 (Codex) ──┐
     ├── M4 ─── M5 ──┤                ├── M8 ── M9
     │               └── M7 (OpenCode)┘         │
     └──────────────────────────────────────────┴── M10
```

- M2/M3/M4/M5 之间除声明依赖外不得互相 import 内部文件。
- M6/M7 只能依赖 M1–M5 的**公共入口**，不得依赖其内部实现细节。
- M8 只依赖 `createRuntime` + `AgentEvent`，不依赖任何 adapter 内部类型。
- VSIX 轨道：`V1 → V2 → V3 → V4`，位于独立包 `extension/`，只消费 `@agentbox/runtime` 公共入口。

### 2.2 端到端验证门（E2E Gates / VSIX）

模块级验证可以全部 headless（vitest / contract suite）；**VSIX 只在下列门禁点打包**。
VS Code 代码放在独立包 `extension/`，不进入 `agent-runtime/src`。

| 门 | 何时 | 依赖 | VSIX 能力 | 能验证什么 | 还不能验证 |
|---|---|---|---|---|---|
| **G0 模块级** | 每个模块完成 | — | 不打包 | build / 单测 / contract | VSIX 安装与 UI |
| **V1 Walking Skeleton** | M4 + M5 之后 | M1/M4/M5 | FakeRuntime；输入 prompt → OutputChannel 流式输出；审批弹窗；取消 | **打包链路、扩展激活、AgentEvent 契约、审批 UI、取消** | 真实文件修改、真实模型 |
| **V2 Real Codex** | P0 + M3 + M6 之后 | V1/P0/M3/M6 | 真实 Codex + LiteLLM/Qwen；真实 workspace | 读/改/搜/跑命令、diff、审批、5 秒取消、断网、无残留 | OpenCode、eval |
| **V3 Dual runtime** | M7 + M8 之后 | V2/M7/M8 | 设置里切换 codex/opencode；CLI JSONL | 双 runtime 契约、事件日志/回放 | 10 条 eval 指标 |
| **V4 Release** | M9 + M10 之后 | V3/M9/M10 | 正式 VSIX | 10 条 eval、许可/NOTICE、版本矩阵、`npm pack` | 生产推广（知识/Skill 仍在下一阶段） |

**关键点：V1 不需要模型、不需要 P0。** 它就能证明
"安装 VSIX → 扩展激活 → `AgentRuntime` → `AgentEvent` → UI → 审批 → 取消"整条链路可用。
因此建议把 **M4/M5 提前到 M2/M3 之前**，最快拿到第一个可安装的 VSIX。

> 注意：V1/V2 是**验证壳**，不是产品 UI。没有知识/Skill/资产面板、没有会话历史、没有多会话。
> 完整产品 UI 仍在下一阶段；V 轨道只是把"打包 + 契约 + 审批 + 取消"提前验证。

---

## 3. 契约决策（ADR）

> 这些决策同时写入 [ARCHITECTURE.md](ARCHITECTURE.md)。改动必须走"M10 级"评审。

| # | 决策 | 理由 |
|---|---|---|
| **D1** | 上层只依赖 `AgentRuntime` 接口与 `AgentEvent`；runtime 私有事件/类型不出 adapter | 保证 runtime 可替换 |
| **D2** | **每个 runtime 实例同一时刻只允许一个活动 turn**；并发 `startTurn` 抛 `TURN_IN_PROGRESS` | 本阶段不做并发会话；避免事件串流 |
| **D3** | 审批是**双向契约**：`approval.request` 事件 + `resolveApproval(turnId, callId, decision)`；decision 为 `allow`/`deny` | 仅通知无法阻止子进程执行 |
| **D4** | 被拒绝的工具**不得执行**；adapter 必须把 deny 回传给子进程。若因拒绝导致 turn 结束，`turn.end.reason = 'policy_denied'` | 安全边界可验证 |
| **D5** | `turn.start` / `turn.end` 成对，`turn.end` **恰好一次**；超时/崩溃由守卫兜底发 `error` + `turn.end('error')` | 上层状态机不被卡死 |
| **D6** | `turn.end` 之后该 turnId 的事件一律丢弃（不报错） | 处理子进程迟到事件 |
| **D7** | 事件契约版本 `AGENT_EVENT_SCHEMA_VERSION = 1`；破坏性变更必须递增 | JSONL 回放/审计可判定 |
| **D8** | `file.changed.path` 必须是 **workspace 相对路径、POSIX 分隔符、无前导 `/`、无 `..`** | 审计/UI 跨平台一致 |
| **D9** | Limits 优先级：`DEFAULT_LIMITS` < `RuntimeConfig.limits` < `TurnInput.limits`（partial 覆盖） | 配置默认值 + 单次覆盖 |
| **D10** | `TurnInput.metadata` 必须可 JSON 序列化、不含密钥；仅在 `turn.start` 回显 | 捕获/审计关联，不污染事件流 |
| **D11** | 取消：`abort()` 后 5 秒内必须 `turn.end('cancelled')`；adapter 先协议中断，超时则杀进程树；杀完后 runtime 置为未运行，调用方可重新 `start()` | Windows 无残留进程 |
| **D12** | `capabilities` 必须反映**实测**能力；缺失能力由调用方降级；`mcp` 字段本阶段仅声明，无 MCP 事件 | 不假设协议 |
| **D13** | 安全工具与事件脱敏在 runtime 侧强制执行；密钥只通过环境变量注入需要的子进程 | 保密要求 |
| **D14** | **模型提供商由用户配置**：默认内网；公网 provider 必须显式 opt-in、告警、审计。配置需含 `baseUrl` / `apiKeyEnv` / `model` / `wireApi` / `scope`。Codex 要求 `wire_api="responses"`，OpenCode 使用 chat completions | 2026-10-28 产品决策；支持公网模型但不默认 |
| **D15** | 新增**非破坏性**事件 `token.usage`（`last` / `total` token 用量）；不支持该能力的 runtime 不发，上层忽略即可；不递增 schema 版本 | UI 展示单轮/会话 token；Codex 由 `thread/tokenUsage/updated` 映射 |
| **D16** | Codex adapter 支持可选 `developerInstructions` 并随 `thread/start` 发送；不传则保持 Codex 默认。内置的环境/文件卫生提示词由消费者（extension）提供 | 避免 runtime 绑定产品提示词，同时让 UI 默认获得 PowerShell/文件卫生约束 |
| **D17** | 项目指令文件：workspace 根 `AGENTS.md`，回退 `AgentBox.md`；UTF-8、单文件 8k 字符上限；优先级 内置安全规则 > 项目指令 > extraInstructions；内容变化使会话签名变化，下一条 prompt 重建 thread | 让项目约定可版本化，同时不突破安全/文件卫生边界 |
| **D18** | 审批阶段文件策略：从 `approval.request` 可见路径/命令中匹配 deny glob 与浏览器命令；命中路径/标记直接 deny，浏览器命令 confirm；仅当 Codex 请求审批时生效 | 在不改动 Codex 沙箱的前提下减少垃圾产物；硬限制仍需沙箱/ACL |
| **D19** | 任务 profile（extension 侧）：`simple` 8 步/90s、`code` 20 步/180s、`research` 30 步/300s；`limits.maxSteps` / `turnTimeoutMs` 显式设置可覆盖 | 简单静态任务不再使用研究级预算，降低 token/时间 |
| **D20** | 循环检测（extension 侧）：相同 tool name+args 连续失败 2 次或连续工具失败 4 次 → abort；成功调用重置计数 | 避免 apply_patch/浏览器预览等失败循环耗尽 token |

---

## 4. 模块规格

### M1 — 契约、配置校验与工程边界

**职责**

- 定义 `AgentRuntime`、`AgentEvent`、`RuntimeConfig`、`Limits`、`TurnInput`、`ApprovalDecision`。
- 定义统一错误码与 `RuntimeError`。
- 校验 `RuntimeConfig`、`TurnInput`，解析有效 Limits。
- 强制静态边界：`src/` 不含 `vscode` / `pluginVersion` import。

**边界（不做）**

- 不 spawn 进程、不发事件、不实现任何 runtime 协议。
- 只做结构性校验与 workspaceRoot 存在性检查，不做业务/权限判断。

**文件**

```
src/types.ts                 契约类型 + AGENT_EVENT_SCHEMA_VERSION
src/errors.ts                RuntimeError + RuntimeErrorCode
src/config.ts                validateRuntimeConfig / validateTurnInput / resolveLimits
src/index.ts                 公共导出
scripts/check-boundaries.mjs 静态边界检查
tests/config.spec.ts
tests/factory.spec.ts
```

**公共接口**

```ts
// types.ts
type RuntimeId = 'codex' | 'opencode';
type ApprovalDecision = 'allow' | 'deny';
type StopReason = 'end_turn' | 'max_steps' | 'cancelled' | 'error' | 'policy_denied';
const AGENT_EVENT_SCHEMA_VERSION: 1;

interface AgentRuntime {
  readonly id: RuntimeId;
  readonly capabilities: RuntimeCapabilities;
  start(): Promise<void>;
  startTurn(input: TurnInput): Promise<TurnHandle>;
  onEvent(listener: EventListener): () => void;
  resolveApproval(turnId: string, callId: string, decision: ApprovalDecision): Promise<void>;
  abort(turnId: string): Promise<void>;
  stop(): Promise<void>;
}

interface TurnInput {
  prompt: string;
  context?: string;
  workspaceRoot: string;
  limits?: Partial<Limits>;   // 单次覆盖
  metadata?: Record<string, unknown>;
}

interface RuntimeConfig {
  runtime: RuntimeId;
  workspaceRoot: string;
  limits?: Partial<Limits>;   // 默认值覆盖
  codex?: CodexRuntimeConfig;
  opencode?: OpenCodeRuntimeConfig;
}

// config.ts
function validateRuntimeConfig(config: RuntimeConfig): void; // 失败抛 INVALID_CONFIG / INVALID_RUNTIME
function validateTurnInput(input: TurnInput): void;          // 失败抛 INVALID_CONFIG
function resolveLimits(...sources: Array<Partial<Limits> | undefined>): Limits;
function resolveTurnLimits(config: RuntimeConfig, input: TurnInput): Limits;
```

**测试要求**

- 两个 runtime 的合法配置通过。
- workspaceRoot 缺失 / 不存在 / 不是目录 → `INVALID_CONFIG`。
- Limits：0、负数、非整数、未知字段 → `INVALID_CONFIG`；覆盖优先级正确且不修改 `DEFAULT_LIMITS`。
- OpenCode：hostname 仅允许 loopback；port 0–65535；非法端口/主机 → `INVALID_CONFIG`。
- 空 prompt / 空白 prompt、非法 metadata → `INVALID_CONFIG`。
- 未知 runtime → `INVALID_RUNTIME`。
- `check-boundaries` 在含 `vscode` import 时退出码非 0。

**验收**

- `npm run build && npm test && npm run check:boundaries` 全部通过。

---

### M2 — 安全工具

**职责**

- 工作区路径约束：拒绝逃逸 `workspaceRoot`、拒绝 `..`、可选 symlink realpath 校验。
- `file.changed.path` 归一化：绝对路径 → workspace 相对 POSIX 路径。
- 事件/文本脱敏：把已知密钥替换为 `***`（含嵌套对象）。
- 子进程最小环境变量：默认白名单 + 显式追加；不继承无关密钥。

**边界（不做）**

- 不做 shell allowlist / 命令策略（属于调用方 Policy 与后续阶段）。
- 不读写工作区文件内容；只做路径与字符串处理。

**文件**

```
src/security/paths.ts
src/security/redact.ts
src/security/env.ts
src/security/index.ts
tests/security/*.spec.ts
```

**公共接口（供 M3/M6/M7 使用，不出现在主入口）**

```ts
function assertInsideWorkspace(workspaceRoot: string, candidate: string): string; // 绝对路径
function toWorkspaceRelative(workspaceRoot: string, candidate: string): string;   // POSIX 相对路径
function redactSecrets(text: string, secrets: string[]): string;
function redactDeep<T>(value: T, secrets: string[]): T;
function buildChildEnv(parent: NodeJS.ProcessEnv, extra?: Record<string, string>, allowlist?: string[]): NodeJS.ProcessEnv;
```

**测试要求**

- `..` 逃逸、绝对路径逃逸、大小写差异（Windows）、同一路径返回 `.` 或空串的行为固定。
- 符号链接逃逸（若实现 realpath 校验）。
- 空密钥不参与替换；嵌套对象/数组脱敏。
- 子进程环境：默认不含 `MODEL_API_KEY`；白名单变量保留；extra 覆盖优先级明确。

**验收**

- 路径工具在 Windows 下对 `C:\` 与 `c:\` 行为一致。
- 脱敏后原文中的密钥不再出现。

---

### M3 — 进程管理

**职责**

- 统一封装 `spawn`：command/args 分离、cwd、最小环境变量、stdio pipe。
- stdout/stderr 行缓冲：处理 CRLF、跨 chunk 半行、超长行截断。
- 退出信息（code/signal）、`exited` Promise、exit 监听。
- 超时与终止：Windows 用 `taskkill /pid <pid> /T /F`，POSIX 先 SIGTERM 后 SIGKILL；`kill()` 幂等。
- 不残留孙进程。

**边界（不做）**

- 不理解 JSON-RPC/HTTP 协议，不做重连，不做业务级重启。
- 不打印/记录环境变量。

**文件**

```
src/process.ts
tests/process.spec.ts
tests/fixtures/process/*.cjs
```

**公共接口**

```ts
interface SpawnOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;       // 显式注入（可含密钥，勿日志）
  envAllowlist?: string[];            // 额外继承的父进程变量
  maxLineChars?: number;              // 默认 1 MiB
  killGraceMs?: number;               // 默认 3s
}
interface ExitInfo { code: number | null; signal: NodeJS.Signals | null; at: number; }
interface ManagedProcess {
  readonly pid: number | undefined;
  readonly running: boolean;
  /** 进程退出且 stdio 关闭后 resolve；spawn 失败时 reject SPAWN_FAILED。 */
  readonly exited: Promise<ExitInfo>;
  write(data: string): void;          // 已退出时抛 NOT_RUNNING
  onStdoutLine(cb: (line: string) => void): () => void;
  onStderrLine(cb: (line: string) => void): () => void;
  onExit(cb: (info: ExitInfo) => void): () => void; // 进程 exit 时触发
  kill(): Promise<void>;              // 幂等；Windows 杀进程树
}
function spawnManaged(options: SpawnOptions): ManagedProcess;
```

**测试要求**

- 行事件：分 chunk 输出、CRLF、结尾无换行、超长行截断。
- 正常退出、非零退出、spawn 失败（命令不存在）行为明确。
- `kill()` 两次幂等；已退出进程 `kill()` 不抛。
- Windows：子进程 + 孙进程 → `kill()` 后孙进程不存在。
- 环境：密钥不传给子进程。

**验收**

- 单元测试在 Windows + Node 24 通过，测试结束无残留 node 进程。

---

### M4 — 事件总线与 Turn 守卫

**职责**

- 类型安全的事件订阅/分发；单个 listener 抛错不影响其他 listener。
- 单活动 turn：重复 `startTurn` → `TURN_IN_PROGRESS`。
- 生命周期：`turn.start` 自动发；`turn.end` 恰好一次；结束后丢弃迟到事件。
- 超时：`turnTimeoutMs` 到点发 `error(code=TIMEOUT)` + `turn.end('error')`。
- 取消：`abort()` 标记 + 交给 adapter 执行；守卫负责兜底超时。

**边界（不做）**

- 不生成协议消息、不操作子进程。
- 不决定审批 allow/deny（只维护 pending 审批的关联与回执转发）。

**文件**

```
src/events.ts        EventBus
src/turn.ts          TurnGuard / TurnContext
tests/events.spec.ts
```

**公共接口**

```ts
interface EventBusOptions {
  onListenerError?: (error: unknown, event: AgentEvent) => void;
}
class EventBus {
  constructor(options?: EventBusOptions);
  on(listener: EventListener): () => void;
  emit(event: AgentEvent): void;   // listener 快照；单个 listener 抛错被隔离
  clear(): void;
}

interface TurnGuardOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  turnIdFactory?: () => string;
}
class TurnGuard {
  constructor(runtimeId: RuntimeId, bus: EventBus, options?: TurnGuardOptions);
  readonly activeTurnId: string | null;
  begin(options: { turnTimeoutMs: number; metadata?: Record<string, unknown> }): TurnContext;
  /** adapter 收到 caller 的审批决定后转发 */
  resolveApproval(turnId: string, callId: string, decision: ApprovalDecision): Promise<void>;
}

// 已去掉 turnId/at，且不允许 turn.start / turn.end
type TurnEventInput = /* AgentEvent 的非生命周期子集 */;

interface TurnContext {
  readonly turnId: string;
  readonly ended: boolean;
  emit(event: TurnEventInput): void;   // 结束后丢弃
  /** 发 approval.request 并登记 resolver；turn 结束时调用 onCancel */
  requestApproval(
    request: { callId: string; name: string; args: unknown },
    resolve: (decision: ApprovalDecision) => void | Promise<void>,
    onCancel?: () => void
  ): void;
  end(reason: StopReason): void;       // 恰好一次
}
```

**测试要求**

- 事件顺序：`turn.start` 第一；`turn.end` 最后且只一次。
- 并发 begin → `TURN_IN_PROGRESS`。
- 超时 → `error` + `turn.end('error')`。
- 结束后 emit 被丢弃；listener 抛错被隔离。
- 取消路径最终 `turn.end('cancelled')`。

**验收**

- 守卫可在 FakeRuntime 下完整驱动一个 turn。

---

### M5 — FakeRuntime + 契约测试套件

**职责**

- `FakeRuntime`：可脚本化事件、审批、取消、超时、崩溃；实现完整 `AgentRuntime`。
- 统一 `runtimeContractSuite(name, createFixture)`：所有 adapter 必须通过。
  - `RuntimeContractFixture.startLongTurn` 必填；`startNormalTurn` / `startFailedToolTurn` /
    `startApprovalTurn` 可选（缺失则对应用例跳过，adapter 应尽量全部提供）。
- `createFakeRuntimeContractFixture()` 把 FakeRuntime 接入同一套用例。
- 作为 M6/M7 单测与 CLI 测试的替身。

**边界（不做）**

- 不模拟真实协议细节；真实协议由 M6/M7 的 mock server 测试覆盖。
- 不进入生产主入口；`FakeRuntime` 通过 `@agentbox/runtime/testing` 子路径导出，
  vitest 契约套件不导出。

**文件**

```
src/testing/fake-runtime.ts
src/testing/fixture.ts       FakeRuntime → contract fixture
src/testing/contract.ts      基于 vitest 的契约套件
src/testing/index.ts         ./testing 子路径入口（仅 FakeRuntime）
tests/contract/fake.spec.ts
```

**契约测试用例（所有 adapter 必须通过）**

1. `start()` 成功后 `stop()` 幂等。
2. `startTurn` 先发 `turn.start`，最后恰好一次 `turn.end`。
3. 同实例并发 `startTurn` → `TURN_IN_PROGRESS`。
4. `tool.start` / `tool.end` 成对；`ok=false` 时结果非空。
5. `abort()` 后 5 秒内 `turn.end('cancelled')`。
6. 审批：`approval.request` → `resolveApproval(deny)` → 工具不执行、事件可解释。
7. 超时：到点 `error(TIMEOUT)` + `turn.end('error')`。
8. 事件在 `turn.end` 后不再出现。
9. `onEvent` 退订后不再收到事件。
10. `stop()` 后无残留进程/端口（由 adapter 各自补充）。

---

### M6 — Codex adapter（主）

> **状态：✅ 已完成（2026-10-30）**，代码在 `src/runtime/codex/`；
> contract suite + 真实 DeepSeek E2E 通过。下一步 V2 接线。

**职责**

- spawn `codex app-server`（stdio JSON-RPC），握手、会话、turn、通知。
- 把 Codex 事件映射为 `AgentEvent`；审批请求 → `approval.request`，并回传 `resolveApproval` 决定。
- 取消：interrupt；5 秒未停则杀进程树并发 `turn.end('cancelled')`。
- 崩溃：`error` + `turn.end('error')`；进程退出时更新运行状态。
- 配置 `CODEX_HOME` / `config.toml`（以 P0 实测为准），接内网 LiteLLM + Qwen。

**P0 实测结论（2026-10-28，详见 RUNTIME-PROBE.md）**

- stdio 是**逐行 JSON**，无 `jsonrpc` 字段；通知带 `emittedAtMs`。
- 方法：`initialize`、`thread/start`、`turn/start`、`turn/interrupt`、`command/exec`；
  通知：`turn/started`、`item/*`、`item/agentMessage/delta`、`turn/completed`、`error`。
- 认证：自定义 provider + `env_key` 时 `requiresOpenaiAuth=false`。
- 配置：`wire_api="responses"`（`chat` 无效）；provider 必须完整定义。
- `thread/start` 用 `permissions: ":workspace"`（`sandbox: "workspace-write"` 会降级 readOnly）。
- `turn/interrupt` 实测 9ms 内 `turn/completed(status=interrupted)`。
- **Windows sandbox 已修复**：首次 `windowsSandbox/setupStart({mode:"unelevated"})` 后
  **必须重启 app-server**，readiness 才会变 `ready`；修复后 `:workspace`/`workspaceWrite`
  内写成功、外写 `EPERM`，`readOnly` 内写 `EPERM`。M6 启动时需检测 readiness 并在
  `notConfigured` 时引导/执行 setup（见 RUNTIME-PROBE.md §1.8）。
- **模型提供商**：从 `RuntimeConfig` 生成 `CODEX_HOME/config.toml`；DeepSeek 已原生支持
  Responses API，可直接作为公网 provider（`base_url=https://api.deepseek.com/`、
  `wire_api="responses"`、`env_key="DEEPSEEK_API_KEY"`、`model="deepseek-flash"`）。
  `deepseek-v4-flash` 是别名；规范 ID 为 `deepseek-flash`。
  `model_catalog_json` 可消除元数据 fallback，M6 需支持该配置。

**边界（不做）**

- 不修改用户全局 Codex 配置：使用独立 `CODEX_HOME` 或显式注入。
- 不实现 OpenCode/OpenClaw 逻辑。
- 不猜方法名：所有方法名以 [RUNTIME-PROBE.md](RUNTIME-PROBE.md) 为准。

**文件**

```
src/runtime/codex/index.ts
src/runtime/codex/jsonrpc.ts        stdio 分帧 / 请求关联 / 通知
src/runtime/codex/mapping.ts        Codex 事件 → AgentEvent
tests/runtime/codex/*.spec.ts
tests/fixtures/codex/mock-app-server.cjs
```

**测试要求**

- mock app-server：握手、正常 turn、tool 事件、审批 allow/deny、取消、协议错误、进程退出。
- 真实集成（`CODEX_E2E=1` 时运行）：临时目录读文件 → 改一行 → `git diff`；abort 后无残留。
- 事件顺序与 M5 契约套件一致。

**验收**

- 真实任务事件完整；取消 5 秒内停止；断网只连 LiteLLM 可运行。

---

### M7 — OpenCode adapter（备）

**职责**

- spawn `opencode serve --hostname 127.0.0.1 --port <0|port>`，health check，端口自动分配与释放。
- HTTP + SSE 客户端；事件订阅、断线重连或明确失败。
- 会话/turn、权限审批、abort/stop。
- provider 配置（OpenAI-compatible → LiteLLM + Qwen，以 P0 为准）。

**P0 实测结论（2026-10-28，详见 RUNTIME-PROBE.md）**

- `opencode serve` 默认 `127.0.0.1:0`，打印实际端口；`GET /global/health` 可用。
- `GET /doc` 返回 OpenAPI 3.1；`/session`、`/event`(SSE)、`/session/{id}/message`、
  `/session/{id}/abort`、`/permission/{id}/reply` 均已确认。
- 认证：`OPENCODE_SERVER_USERNAME` + `OPENCODE_SERVER_PASSWORD` → HTTP Basic；
  未设置时服务无认证且启动告警。`/config` 会返回明文 apiKey，必须避免记录。
- prompt：`POST /session/{id}/message`，body `{model,parts}`；错误以 200 + `info.error`
  和 `session.error` 返回。
- 事件：`message.part.updated` / `message.part.delta` / `session.status` / `session.idle` /
  `session.error` / `file.edited` / `permission.asked` / `permission.replied`。
- abort：`POST /session/{id}/abort` → `true`，实测 686ms 内 idle。
- provider 走 `@ai-sdk/openai-compatible`，实际请求 `/v1/chat/completions`。
- DeepSeek 公网 provider 已实测 chat completions + edit 权限审批 + 文件写入；
  模型 ID 必须用规范名 `deepseek-flash`（`deepseek-v4-flash` 会报 ProviderModelNotFoundError）。
- 必须关闭：`OPENCODE_DISABLE_AUTOUPDATE`、`share:"disabled"`、
  `OPENCODE_DISABLE_MODELS_FETCH`、`experimental.openTelemetry:false`、
  建议 `OPENCODE_DISABLE_EMBEDDED_WEB_UI=1`。

**边界（不做）**

- 不绑定 `0.0.0.0`；不暴露非 loopback。
- 不混入 Codex 协议代码。
- 不假设 API 形状：以 [RUNTIME-PROBE.md](RUNTIME-PROBE.md) 为准。

**文件**

```
src/runtime/opencode/index.ts
src/runtime/opencode/http.ts        HTTP 客户端
src/runtime/opencode/sse.ts         SSE 解析/重连
src/runtime/opencode/mapping.ts     事件映射
tests/runtime/opencode/*.spec.ts
tests/fixtures/opencode/mock-server.cjs
```

**测试要求**

- mock server：health 失败、会话创建、prompt、事件流、权限 allow/deny、abort、SSE 断开、端口释放。
- 真实集成（`OPENCODE_E2E=1`）同 M6 验收。

---

### M8 — CLI + JSONL 事件日志

> **状态：✅ 已完成（2026-10-30）**，`src/cli/`；真实 DeepSeek CLI smoke 通过。

**职责**

- `run`：指定 runtime/workspace/prompt/limits，输出每个 `AgentEvent` 一行 JSON 到 stdout 或 `--out`。
- `replay`：回放 JSONL 做离线检查。
- 退出码：成功 0；任务失败/协议错误非 0；Ctrl+C 触发 abort。
- 不直接依赖 adapter 内部类型。

**边界（不做）**

- 不做交互式 UI、不做多会话。
- 不在 CLI 内实现知识/Skill 注入（只透传 `context`）。

**文件**

```
src/cli/index.ts
src/cli/args.ts
src/cli/jsonl.ts
tests/cli/*.spec.ts
```

**测试要求**

- 参数解析（缺参、非法 runtime、limits 覆盖）。
- JSONL 每行可解析、事件顺序正确、turn 摘要字段完整。
- 使用 FakeRuntime 的端到端 run/replay。

---

### M9 — Eval harness

> **状态：✅ 已完成（2026-10-30）**，`src/eval/` + `eval/tasks.json`；
> Codex + DeepSeek 基线 9/10（90%），报告在 `eval/results/2026-10-30-codex-deepseek/`。

**职责**

- 按 [EVAL-TASKS.md](EVAL-TASKS.md) 准备 10 条任务与固定 fixture。
- 逐 runtime 执行，采集：成功率、tool-call 合法率、步数、token、首 token 延迟、总耗时、取消成功率、残留进程。
- 输出 Markdown/JSON 对比报告；失败任务附最后 20 行事件。

**边界（不做）**

- 不做自动改代码/自动评分的主观判断；完成判据必须可脚本化。
- 不在 harness 内改动 runtime 实现。

**文件**

```
eval/tasks.json
eval/fixtures/task-01..task-10/
src/eval/runner.ts
src/eval/metrics.ts
src/eval/report.ts
tests/eval/*.spec.ts
```

**测试要求**

- metrics 计算用固定 JSONL 样例单测。
- 用 FakeRuntime 跑 dry-run；真实 runtime 由 `npm run eval` 手动/CI 触发。

---

### M10 — 打包与接入契约

> **状态：✅ 已完成（2026-10-30）**；`npm pack --dry-run` 干净，
> `npm run example:fake` 通过；兼容矩阵见 docs/COMPATIBILITY.md。

**职责**

- `package.json` exports：主入口 + `./testing`（可选）；`files` 只含 `dist`/README/NOTICE。
- `npm pack` 内容检查；类型声明完整。
- NOTICE/第三方许可说明（Codex Apache-2.0、OpenCode MIT）。
- Codex/OpenCode 版本兼容矩阵（pin 版本）。
- `examples/consumer.ts`：import → createRuntime → startTurn/onEvent/abort/stop。
- 更新 HANDOFF/README 的接入说明。

**边界（不做）**

- 不发布到公共 npm；不做安装器。
- 不包含 node_modules/src。

**验收**

- `npm run build && npm pack --dry-run` 内容干净。
- consumer 示例可编译并跑 FakeRuntime。
- 下一阶段只接 `createRuntime` + `AgentEvent`，无需改 adapter。

---

### V1 — VS Code Walking Skeleton（独立包 `extension/`）

> 位置：仓库根目录 `extension/`（与 `agent-runtime/` 同级）。
> 只消费 `@agentbox/runtime` 主入口与 `@agentbox/runtime/testing` 子路径。

**职责**

- 独立 npm 包 `extension/`，`engines.vscode ^1.85.0`。
- 激活后注册命令：`AgentBox: Run Turn`、`AgentBox: Cancel Turn`。
- 用 `FakeRuntime` 跑通：输入 prompt → `OutputChannel` 流式追加 `text.delta` / tool 事件 →
  审批用 `showWarningMessage` 模态 → 取消命令触发 `abort()`。
- 打包：esbuild（target `node18`）→ 单文件 `dist/extension.js`；
  `@vscode/vsce package` 产出 VSIX。

**边界（不做）**

- 不接真实 Codex/OpenCode，不需要模型/P0。
- 不做知识/Skill/资产 UI、不做会话历史、不做多会话。
- 不向 `agent-runtime/src` 引入 `vscode`；依赖只通过包入口。

**文件**

```
extension/package.json          engines.vscode、commands、settings
extension/esbuild.mjs
extension/src/extension.ts      activate/deactivate、命令、设置
extension/src/controller.ts     RuntimeController：turn 生命周期、事件 → UI（headless）
extension/src/ui/vscode-ui.ts   OutputChannel、审批弹窗、状态栏
extension/tests/controller.spec.ts
extension/tests/bundle.spec.ts  mock vscode 加载 dist/extension.js 的冒烟测试
```

**命令 / 设置**

```
命令：agentbox.runTurn / agentbox.cancelTurn / agentbox.showOutput
设置：agentbox.runtime = "fake"（V1 仅 fake）
      agentbox.limits.turnTimeoutMs / maxSteps
```

**测试与验收**

- controller 单测：事件 → 文本/工具/审批/结束状态的映射；取消后状态复位。
- bundle 冒烟：mock `vscode` 加载 `dist/extension.js`，3 个命令均注册。
- `npm run package` 产出 `agentbox-<version>.vsix`；隔离 `--extensions-dir` 安装成功。
- 在 VS Code 1.85+ 人工验收：
  - 执行 `AgentBox: Run Turn`，输出流式出现；
  - 审批 allow / deny 都走通；
  - 取消后 5 秒内 `turn.end(cancelled)`，可再次运行；
  - 重载窗口后扩展正常激活。

---

### V2 — 真实 Codex 端到端（VSIX）

> **状态：✅ 已完成（2026-10-30）**，`agentbox-0.2.0.vsix`；
> 真实 VS Code UAT（写文件 / 审批 Allow/Deny / Cancel）通过。

**职责**

- 同一 extension 接入 M6 的 Codex adapter：设置 `agentbox.runtime = "codex"`。
- 选择/确认 workspace；状态栏显示 turn 状态；错误以通知呈现。
- 可选：`file.changed` 时用 VS Code 原生 diff 打开变更文件（不实现自绘 diff）。

**前置条件**

- P0 决策门通过（Codex + Qwen 可用）。
- 本机安装 pin 版本的 `codex`，`CODEX_HOME`/`config.toml` 指向内网 LiteLLM。
- `MODEL_API_KEY` 通过安全方式注入，不写入 VSIX。

**验收**

- 在临时仓库执行："读取 README.md → 追加一行 → 运行 git diff"。
- 事件完整：`turn.start` → text/tool/file → `turn.end`。
- `AgentBox: Cancel Turn` 后 5 秒内停止，任务管理器无 codex/node 残留。
- 断网（仅内网 LiteLLM）可运行；遥测关闭。

---

### V3 — 双 runtime 切换（VSIX）

**职责**

- 设置里切换 `codex` / `opencode`，无需重启扩展。
- 展示 `RuntimeCapabilities`；缺失能力时降级（如无 `fileEvents` 用文件 watcher 兜底）。
- 与 M8 CLI 共用同一套 `AgentEvent` / JSONL 语义。

**验收**

- 同一任务在两个 runtime 下都能跑；
- 切换失败时给出明确错误，不崩溃；
- `opencode` 只绑 `127.0.0.1`，`stop()` 后端口释放。

---

### V4 — Release VSIX

**职责**

- 正式打包：NOTICE、第三方许可、版本兼容矩阵、VSIX 安装说明。
- 确认 VSIX 不包含 Codex/OpenCode 二进制、不包含密钥。
- 与 M10 的 `npm pack` 检查一致。

**验收**

- 干净环境安装 VSIX，按文档完成一次 V2 任务；
- `vsce ls` 内容符合预期；
- 版本矩阵写明 Codex/OpenCode/VS Code 兼容范围。

---

## 5. 建议实现顺序

### 5.1 运行时轨道

```
M1 ✅ → M4 → M5 → M2 → M3 → M6 → M7 → M8 → M9 → M10
```

- 先做 **M4/M5**（只依赖 M1），是为了尽早解锁 **V1 VSIX**；M2/M3 可以与 V1 并行。
- 若更看重先打通进程管理，也可按 `M2 → M3 → M4 → M5`，代价是 V1 推后。
- **P0 探测**与 M2–M5 并行；**M6/M7 必须等 P0 结论**，不得提前假设协议方法名。

### 5.2 VSIX 轨道

```
V1（M4+M5 后）→ V2（P0+M3+M6 后）→ V3（M7+M8 后）→ V4（M9+M10 后）
```

### 5.3 可验证的时间点

| 时间点 | 产出 | 依赖 | 是否能真实编码 |
|---|---|---|---|
| **第一个可安装 VSIX** | V1 Walking Skeleton | M1/M4/M5 | ❌ 假 runtime，仅验证链路 |
| **第一个真实 agent VSIX** | V2 | + P0/M3/M6 | ✅ Codex + Qwen |
| **双 runtime VSIX** | V3 | + M7/M8 | ✅ Codex / OpenCode 可切换 |
| **可发布 VSIX** | V4 | + M9/M10 | ✅ 附 eval 报告与合规材料 |

> 结论：**不需要等到 P5 才能"打包进 VS Code"**。
> 最早在 M4/M5 完成后即可安装 VSIX（无模型）；P0 + M3 + M6 完成后即可做真实编码验证。

---

## 6. 接口变更流程

1. 先改本文件（含受影响的契约决策 D#）。
2. 更新 `src/types.ts` / 对应公共入口。
3. 更新 contract test / 单元测试。
4. 更新 `ARCHITECTURE.md`；若影响接入方，更新 `HANDOFF.md` 与 README。
5. 破坏性事件变更递增 `AGENT_EVENT_SCHEMA_VERSION`。
