# UI 方案评审（已确认）

> **状态：✅ 已评审/已确认（2026-10-30）；UI-1 已实现（`extension@0.3.0`）。**
> 关联：Milestone 1 已完成（[MILESTONE-1.md](MILESTONE-1.md)）。
> 评审人：产品 / 架构 / 安全；决策记录见 §9、实现记录见 §10。

---

## 1. 当前状态

V2 的 UI 只有：

- `OutputChannel`（`AgentBox`）流式输出；
- 模态 `showWarningMessage` 审批；
- 状态栏 busy；
- 命令面板：Run Turn / Cancel / Show Output / Set API Key / Clear API Key / Restart Runtime。

**问题**：

- 没有对话上下文/历史，工具调用是纯文本行；
- 审批是模态阻塞，无法在任务卡片上直接处理；
- 看不到当前聚焦文件/选区，用户需要反复在 prompt 里描述；
- 无法展示 diff、步骤、token/耗时等结构化信息；
- 没有知识/Skill 入口（下一阶段）。

---

## 2. UI 目标 / 非目标

### 目标（本 UI 阶段）

1. **侧边栏对话面板**，交互接近 Claude Code：消息流、工具卡片、状态、停止。
2. **当前聚焦文件/选区上下文**：显式加入/移除，带 token 预算；不静默上传。
3. **审批内联**：工具卡片上 Allow/Deny；扩展侧做最终校验。
4. **原生能力复用**：文件打开、diff、搜索、终端都交给 VS Code，不重做编辑器。
5. **安全**：CSP、无远程资源、密钥不进 webview、模型输出按文本渲染。
6. **可扩展**：为 Skill 库、知识面板、会话历史预留位置。

### 非目标（本 UI 阶段）

- 不做独立 Web/Electron 前端；只做 VS Code。
- 不做完整知识库/Skill Registry（下一阶段，UI 只留入口/占位）。
- 不做多 agent、多会话并发（先单会话）。
- 不做自绘 diff 编辑器；用 VS Code 原生 diff。
- 不改变 runtime adapter 契约；UI 只消费 `AgentEvent`。

---

## 3. 方案选项

| 方案 | 优点 | 缺点 | 工作量 | 结论 |
|---|---|---|---|---|
| **A. Webview 侧边栏（推荐）** | 完全可控；易做消息流/工具卡/内联审批/上下文 chips；主题变量；适合 Claude Code 风格 | 需要自绘 UI；CSP/消息协议要设计；无障碍需认真做 | 中 | **推荐作为主方案** |
| **B. VS Code 原生 Chat Participant** | 与 Chat 面板一致；少做 UI | 外部 agent 流式/工具卡/审批定制受限；API 版本与最低 VS Code 需确认；难以完全对齐 Codex 事件 | 低-中 | 后续可选/不阻塞 |
| **C. Hybrid：Chat Participant + Webview 辅助面板** | 原生聊天 + 富信息面板 | 两套 UI/状态同步复杂 | 高 | 暂不 |
| **D. TreeView + QuickPick + OutputChannel** | 最省 | 无法做流式对话/富卡片 | 低 | 仅作为过渡保留 |

**建议：A（Webview Sidebar）作为主方案**，保留当前 OutputChannel 作为调试/降级；
不排除未来把同一 controller 接到 Chat Participant。

> VS Code 1.85 的 Chat Participant API 能力有限（部分能力后续版本才稳定）；
> Webview 在 1.85 可用，保持现有 `engines.vscode ^1.85.0` 更稳。

---

## 4. 推荐架构

```
┌──────────────────────── VS Code Extension Host ────────────────────────┐
│  ChatViewProvider (WebviewViewProvider)                                 │
│    │  postMessage / onDidReceiveMessage                                 │
│  ChatSessionController                                                  │
│    ├─ RuntimeController (现有) ── AgentRuntime ── AgentEvent            │
│    ├─ ContextBuilder（当前文件/选区/工作区/知识片段）                    │
│    ├─ ApprovalBridge（approval.request → 内联卡片 → resolveApproval）    │
│    ├─ DiffService（file.changed / tool 参数 → 原生 diff 或 patch 文本）  │
│    └─ SessionStore（workspaceState，单会话）                             │
│                                                                         │
│  Webview (media/chat.js + chat.css, vanilla TS/CSS, nonce + CSP)        │
└─────────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
                 @agentbox/runtime（不变）
```

### 4.1 关键模块

| 模块 | 职责 | 边界 |
|---|---|---|
| `ChatViewProvider` | 注册侧边栏视图、创建/恢复 webview、消息桥 | 不做业务状态 |
| `ChatSessionController` | 单会话状态机、事件 → UI 消息、命令处理 | 不直接操作 DOM |
| `ContextBuilder` | 读取 active editor/选区、拼接 context、token 预算 | 不读取密钥；不静默发送 |
| `ApprovalBridge` | 审批卡片 ↔ `resolveApproval`；扩展侧校验 | 不信任 webview 的任意输入 |
| `DiffService` | 工具卡 patch 文本；后续原生 diff | 不实现 diff 编辑器 |
| `SessionStore` | 单会话 transcript 持久化 | 不存密钥/环境变量 |

### 4.2 事件 → UI 映射

| AgentEvent | UI |
|---|---|
| `turn.start` | 新 assistant 消息/状态 running |
| `text.delta` | 追加文本（textContent，不 innerHTML） |
| `tool.start` | 工具卡片（名称、参数摘要、running） |
| `tool.end` | 卡片完成/失败、结果摘要 |
| `approval.request` | 内联 Allow/Deny 按钮；扩展侧校验 |
| `file.changed` | 文件 chip；可打开文件/diff |
| `error` | 错误卡片 + 重试入口（重试可选） |
| `turn.end` | 状态 idle/cancelled/error + 统计（steps/耗时） |

### 4.3 当前文件/选区上下文

- 监听 `window.activeTextEditor` 与 `onDidChangeTextEditorSelection`；
- 在 composer 上方显示 chips：`@file path`、`@selection Lx-Ly`；
- 打开/切换文件时默认选中当前文件；选中新的文本区间时默认选中选区；两者可点击取消；
  （2026-10-31 调整：原方案为全部显式勾选，按用户反馈改为文件和选区默认选中）；
- 发送时由 `ContextBuilder` 生成 `TurnInput.context`，按 `maxContextTokens` 截断；
- 多文件/大选区需显示 token 估算与截断提示。

### 4.4 审批

- 默认 **内联**：工具卡片上 Allow / Deny；可折叠查看参数。
- 扩展侧 `ApprovalBridge` 再次校验 turnId/callId 与当前活动 turn；
- 失败/超时回退模态 `showWarningMessage`（保持现有安全路径）；
- 不在 webview 中存密钥或自动允许策略。

### 4.5 diff

- UI-1：工具卡片展示 Codex `fileChange` 的 patch/diff 文本（`tool.start` 参数已含 changes）；
- UI-2：对 git 仓库用 VS Code 原生 `vscode.diff`；非 git 工作区用 turn 前快照；
- 不在 webview 自绘 diff 编辑器。

### 4.6 安全

- Webview CSP：`default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-...'; script-src 'nonce-...'`；
- 不加载远程资源；模型输出经 `DOMPurify` 消毒后再渲染 Markdown（禁止 `script`/`iframe`/`style` 等）；
- 消息协议带版本与 schema 校验；未知消息忽略；
- 密钥只存在 extension host / SecretStorage，永不 postMessage 到 webview；
- 外部模型告警仍由 extension host 弹出；
- 审批决定以 extension host 状态为准，webview 只是 UI。

---

## 5. 建议 UI 布局

```
┌ AgentBox ────────────────────────────────┐
│ Codex · deepseek-flash · ready      [⚙]  │
├──────────────────────────────────────────┤
│ [user] 帮我把 calculate_total 改名        │
│                                          │
│ [assistant] 我先定位调用点…               │
│  ┌ tool: commandExecution ─────────────┐ │
│  │ rg calculate_total                  │ │
│  │ ✓ 3 matches                         │ │
│  └─────────────────────────────────────┘ │
│  ┌ file: src/b.py ─────────────────────┐ │
│  │ + calculate_total → total           │ │
│  │ [Open file] [Show diff]             │ │
│  └─────────────────────────────────────┘ │
│  ┌ approval: run_shell ────────────────┐ │
│  │ Remove-Item -Recurse -Force .       │ │
│  │ [Allow] [Deny]                      │ │
│  └─────────────────────────────────────┘ │
│                                          │
├──────────────────────────────────────────┤
│ [@file app.ts ×] [@selection L10-20 ×]   │
│ ┌──────────────────────────────────────┐ │
│ │ Ask AgentBox…                    [➤] │ │
│ └──────────────────────────────────────┘ │
│ [Stop]  steps 4 · 12s · 2.7s first token │
└──────────────────────────────────────────┘
```

---

## 6. 分阶段计划

### UI-0 方案评审（本文件）

- 确定 A/B/C、最低 VS Code、单/多会话、审批形态、diff 策略、上下文默认。
- 产出：评审纪要 + 决策表。

### UI-1 Chat Sidebar MVP ✅

- WebviewViewProvider + 单会话；
- 流式文本、tool 卡片、审批内联、Stop；
- 当前文件/选区 chips + `TurnInput.context`；
- 状态栏/运行状态/错误卡片；
- 保留 OutputChannel 作为降级；
- 文件 watcher 兜底 shell 写文件不触发 `file.changed` 的情况；
- 验收：真实 Codex + DeepSeek 完成一次改文件任务；审批 Allow/Deny；Cancel；
  当前文件/选区可加入/移除；CSP 无远程资源。

### UI-2 原生体验

- `vscode.diff`（git/快照）；
- 会话历史（单会话持久化 + 清空；多会话可选）；
- 重试/错误恢复；模型/provider/Key 设置入口；
- token/耗时/首 token 展示；
- 验收：reload 后 transcript 恢复；diff 可打开；错误可重试。

### UI-3 Skill 库 / 知识面板

- Skill 列表/导入/导出/版本/权限（与下一阶段后端契约联动）；
- 知识片段引用与注入（MCP/平台 API）；
- 资产/文档入口；
- 验收：Skill 包导入后可在 composer 引用；知识注入有预算与来源展示。

---

## 7. 待评审决策

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| 1 | UI 形态 | A Webview / B Chat Participant / C Hybrid | **A** |
| 2 | 最低 VS Code | 保持 1.85 / 提升到 Chat API 稳定版本 | **保持 1.85 + Webview** |
| 3 | 会话 | 单会话 / 多会话 | **UI-1 单会话**，UI-2 再评估 |
| 4 | 审批 | 内联 / 模态 / 两者 | **内联为主，模态回退** |
| 5 | diff | patch 文本 / 原生 diff | **UI-1 patch 文本，UI-2 原生 diff** |
| 6 | 文件上下文 | 默认自动带当前文件 / 用户显式勾选 | **当前文件与新选区默认选中、可取消** |
| 7 | 前端技术 | vanilla TS/CSS / React | **vanilla（包小、CSP 简单）** |
| 8 | 会话持久化 | workspaceState / globalState / 不持久化 | **workspaceState（单会话）** |
| 9 | Skill/知识 UI 时机 | UI-1 / UI-3 | **UI-3，等后端契约** |

---

## 8. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | Webview 无障碍/键盘体验不如原生 Chat | 采用率 | 认真做 aria/键盘；保留命令入口 |
| 2 | 事件流与 UI 状态不同步 | 重复/丢消息 | 单会话状态机 + turnId 过滤 |
| 3 | 模型输出 HTML 注入 | 安全 | textContent、CSP、sanitize |
| 4 | 当前文件/选区泄露 | 保密 | 显式勾选、预览、token 预算 |
| 5 | diff 只对 git 有效 | 非 git 工作区体验 | UI-2 快照兜底 |
| 6 | 单会话限制增长 | 多任务体验 | UI-2 评估多会话 |
| 7 | VS Code 1.85 webview API 差异 | 兼容 | 只用稳定 API；CI 最低版本验证 |

---

## 9. 评审清单

- [x] 确认 UI 形态 A（Webview Sidebar）
- [x] 确认最低 VS Code 1.85
- [x] 确认 UI-1 单会话
- [x] 确认审批内联 + 模态回退
- [x] 确认 diff：UI-1 patch 文本，UI-2 原生 diff
- [x] 确认当前文件/选区上下文（文件和选区默认选中、可取消）
- [x] 确认 vanilla TS/CSS
- [x] 确认 Skill/知识面板在 UI-3
- [x] 安全评审：CSP/密钥/审批/数据出境

**评审结论（2026-10-30）**：采用 A（Webview Sidebar），保持 VS Code 1.85，
UI-1 单会话、审批内联（模态仅保留在 OutputChannel 降级路径）、
UI-1 展示 patch 文本、上下文显式勾选、vanilla TS/CSS。
界面文案使用中文；助手输出采用 `marked` + `DOMPurify` 消毒后的 Markdown。

---

## 10. UI-1 实现记录（2026-10-30，2026-10-31 调整）

**产物**：`extension@0.3.0`、`extension/agentbox-0.3.0.vsix`。

| 需求 | 实现 |
|---|---|
| 侧边栏 | `ChatViewProvider` + `agentbox.chat` webview view + 活动栏图标 |
| 配置 | 头部不显示 runtime/model；⚙ / `agentbox.configure` 在 Webview 内打开设置浮层（runtime/provider/model/baseUrl/审批/limits）；保存后重置会话 |
| 内置提示词 | 扩展默认注入工作流（先读后改/最小改动/运行验证/不加依赖/不回滚用户改动）+ Windows/PowerShell + UTF-8 + 文件卫生；`codex.extraInstructions` 可追加；runtime 通过 `thread/start.developerInstructions` 传递 |
| 项目指令 | workspace 根 `AGENTS.md`（回退 `AgentBox.md`），8k 上限；优先级内置安全规则 > 项目指令 > extraInstructions；变更后下一条 prompt 重建会话 |
| 审批文件策略 | `agentbox.files.denyWrite` 路径 deny；命令垃圾标记 deny；浏览器命令 confirm；仅在 approval.request 时生效 |
| 任务 profile | simple 8/90s、code 20/180s、research 30/300s；设置浮层切换；显式 limits 可覆盖 |
| 循环检测 | 相同 tool+args 连续失败 2 次或连续失败 4 次 → abort；成功重置 |
| 布局 | transcript/composer 左右 18px 留白；窄屏 14px；上下文改为 SVG 图标切换；输入框自动增高；发送/取消合并为右侧图标按钮 |
| 流式文本 | `text.delta` → `assistant.delta` → Markdown 增量渲染（50ms 节流） |
| 思考动画 | “思考中… / 生成中… / 执行工具…” 三点动画；状态栏运行脉冲；reduced-motion 兼容 |
| 活动时间线 | 输入框上方固定，展开 80px / 折叠 28px；思考 / 生成 / 工具三条泳道；按耗时横向铺满；失败红色；hover 摘要；点击工具 bar 定位工具卡（命令打开日志）；仅当前 turn；审批等待并入思考区间；折叠状态记忆；统计用色块+数字 |
| Token 用量 | Codex `thread/tokenUsage/updated` → `token.usage`；时间线时长旁显示本轮 / 会话总计；其他 runtime 隐藏 |
| Markdown 层级 | h1–h6 分级、strong、列表、表格、hr；用户消息右对齐、助手左对齐（无气泡），带“你”/AgentBox 标签与消息间分割线 |
| 问题导航 | 对话右侧居中圆点导航条；最多显示附近 10 个问题，随滚动滑动窗口；点击定位并高亮；hover 显示前 20 字摘要 |
| 代码复制 | Markdown 代码块右上角“复制”按钮，支持 clipboard API 与 execCommand 回退 |
| 工具卡 | `tool.start/end` → 卡片、状态；`fileChange` 显示 patch；`commandExecution` / `run_shell` 不生成卡片，只进日志 |
| 日志 | 完整 tool 参数/输出、turn、error 写入 `AgentBox Chat` 输出通道；卡片提供“查看完整日志” |
| 内联审批 | `approval.request` → 卡片 Allow/Deny；turn 结束时卡片标记“已失效” |
| Stop | 停止按钮 / `agentbox.cancelTurn` → `RuntimeController.cancel()`；启动阶段也可取消 |
| 上下文 | 当前文件与新选区默认选中、可取消；工作区外文件与选区不入上下文 |
| 文件兜底 | VS Code `FileSystemWatcher` 在 turn 运行时上报 `file.changed`，按 turn 去重 |
| 安全 | CSP + nonce；DOMPurify 白名单；外链走 `vscode.env.openExternal`；密钥不下发 |
| 降级 | 保留 OutputChannel + 模态审批；`Run Turn` 与侧栏互斥 |

**验证**：`extension` 62 个测试通过（controller 11、settings 7、chat-view 12、
timeline 5、context 5、webview-ui 5、bundle 1）；1 个真实 Codex 集成测试（`V2_E2E=1`）
在收尾时重新运行通过（Codex + DeepSeek、合成工作区、9.25s）。
VSIX 隔离安装成功。

**未纳入 UI-1（UI-2 候选）**：transcript 持久化、多会话、原生 diff、重试、
token/耗时统计、Key 设置面板。
