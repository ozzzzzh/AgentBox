# AgentBox

AgentBox 是一个面向团队知识沉淀的 VS Code coding agent：

- **VS Code Webview Chat**：多会话、流式输出、工具卡片、内联审批、Stop；
- **Codex Runtime**：通过 `codex app-server` 执行编码任务；
- **Skill Registry**：团队 Skill 的上传、审批、required、分组和客户端同步；
- **Knowledge Base**：workspace / 团队知识检索，top-k 注入与引用跳转；
- **Knowledge Capture**：从对话中压缩出知识提案，用户审核后发布。

产品判断：**知识资产层是护城河，coding agent 是可替换引擎。**

---

## 1. 当前状态

| 模块 | 版本/状态 | 说明 |
|---|---|---|
| `extension/` | 0.4.0 | VS Code 侧边栏/编辑器聊天、Skill/Knowledge UI |
| `agent-runtime/` | 0.1.0 | Codex app-server adapter、统一 AgentEvent |
| `skill-server/` | 0.1.0 | Skill Registry、审批、required、groups |
| `knowledge-server/` | 0.1.0 | Node 24 + SQLite FTS5、upsert/search/citations |
| OpenCode adapter | 暂缓 | `AgentRuntime` 契约已预留 |
| Runtime 解耦 | 暂缓 | 见 [HANDOFF](agent-runtime/docs/HANDOFF.md) PENDING-1 |

默认运行环境：Windows 11 + PowerShell 5.1；Codex runtime 不使用 Git Bash。

---

## 2. 架构要点

完整架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

### 2.1 分层

```text
知识资产层
  Skill Server / Knowledge Server
        ↑
产品体验层
  VS Code Webview / 会话 / 审批 / 引用 / 提案
        ↑
运行时层
  AgentRuntime / Codex / OpenCode（暂缓）/ Fake
        ↑
模型与执行环境
  LiteLLM / DeepSeek / Qwen / PowerShell / Codex sandbox
```

### 2.2 组件关系

```text
VS Code Webview
      │
      ▼
ChatViewProvider
  ├─ ContextAssembler
  │    ├─ mention skill
  │    ├─ <knowledge> top-k
  │    └─ 当前文件/选区
  ├─ RuntimeController ──▶ AgentRuntime (Codex app-server)
  ├─ SkillClient ──HTTP──▶ skill-server :4770
  ├─ KnowledgeClient ─HTTP▶ knowledge-server :4771
  └─ Knowledge Capture
       └─ LLM proposal ──▶ 本地 pending proposal ──▶ 用户审核
```

### 2.3 关键边界

- UI/Controller 只依赖 `AgentRuntime` + `AgentEvent`，不直接依赖 Codex 私有类型；
- Knowledge 只进入 `TurnInput.context`，**不写入 `developerInstructions`**；
- 上下文顺序：内置安全/工作流 > required skill > `AGENTS.md` > optional skill >
  `<knowledge>` > 当前文件/选区 > 用户 prompt；
- Skill 是程序性规则，Knowledge 是事实性参考资料；
- 密钥只在 Extension Host / SecretStorage，Webview 不接触 token；
- 默认内网/localhost；公网模型必须显式 opt-in、告警、审计；
- 文件操作限制在 workspace；shell 走审批和 Codex sandbox；
- `agent-runtime/src` 不 import `vscode`。

### 2.4 一次 Chat Turn

```text
用户 prompt
  → 读取 Skill / 检索 Knowledge
  → 组装 context
  → RuntimeController.runTurn()
  → Codex app-server
  → AgentEvent 流
  → Webview 渲染文本/工具/审批
  → 回答 + [K1] citations
```

### 2.5 本地 Knowledge Capture

```text
Webview「知识」按钮
  → Capture Knowledge
  → 独立临时 runtime 压缩当前 turn
  → 本地 pending proposal
  → 用户编辑 / 通过 / 拒绝
  → approve 后以 source=conversation 发布到 knowledge-server
```

Local 由当前用户自己审核；Remote proposal 的客户端/provider 接口已定义，
服务端 proposal/review API 待实现。

---

## 3. 目录结构

```text
agentBox/
├─ README.md                 # 本文件
├─ ARCHITECTURE.md           # 系统架构
├─ extension/                # VS Code 扩展（Webview + host）
├─ agent-runtime/            # AgentRuntime / AgentEvent / Codex adapter
│  └─ docs/                  # HANDOFF / MODULES / KNOWLEDGE-BASE / SKILL-*
├─ skill-server/             # Skill Registry HTTP 服务
└─ knowledge-server/         # Knowledge Base HTTP 服务
   └─ docs/CONTRACT.md       # Knowledge API/schema/chunk 契约
```

各子目录是独立 npm package，没有根 workspace。

`skill-server/` 和 `knowledge-server/` **不会打包进 VSIX**；它们是独立进程，
需要单独启动或部署。VSIX 只包含扩展宿主代码、Webview 资源和媒体文件。

---

## 4. 前置条件

| 项 | 要求 |
|---|---|
| OS | Windows 11（当前主要开发环境） |
| Node | 扩展/runtime 开发 Node 18+；`knowledge-server` 必须 **Node 24+** |
| VS Code | 1.85+ |
| Codex CLI | 已安装并 pin 版本；VSIX 不打包二进制 |
| 模型 | DeepSeek 或内网 OpenAI-compatible provider |
| 网络 | 默认 localhost/内网；公网模型需显式配置 |
| Shell | Codex 使用 PowerShell 5.1；Git Bash 已回退 |

`knowledge-server` 使用 Node 24 内置 `node:sqlite`，启动时会有
`ExperimentalWarning`，属正常现象。

---

## 5. 快速开始

### 5.1 安装依赖并构建 runtime

```powershell
cd agent-runtime
npm install
npm run build
```

### 5.2 启动 Skill Server（可选）

只有使用远程 Skill 时才需要；本地 Skill 不依赖该服务。

```powershell
cd skill-server
npm install
npm run dev:seed
```

- 地址：`http://127.0.0.1:4770`
- 管理页：`http://127.0.0.1:4770/admin`，开发模式自动登录
- 扩展本地 loopback 读取可匿名；上传/审批需要 `dev-author` / `dev-admin`

### 5.3 启动 Knowledge Server（使用知识库时需要）

`agentbox.knowledge.serverUrl` 为空时知识检索关闭；不影响普通聊天。

```powershell
cd knowledge-server
npm install
npm run dev
```

- 地址：`http://127.0.0.1:4771`
- dev token：`dev-author`（写入/发布）、`dev-reader`、`dev-admin`
- 数据目录：`.knowledge-data/`

### 5.4 构建并安装扩展

```powershell
cd extension
npm install
npm run package
code --install-extension "agentbox-0.4.0.vsix" --force
```

产物：`extension/agentbox-0.4.0.vsix`。安装后 Reload Window。
Codex 二进制不打包在 VSIX 中，需要在本机单独安装或配置绝对路径。

### 5.5 配置扩展

打开 AgentBox Chat，点击右上角 **⚙**，在设置浮层中配置：

- **模型**：Runtime、Provider、模型、Base URL、API Key；
- **Skill**：Skill Server URL、Token、自动同步、required 策略、本地目录；
- **知识**：Knowledge Server URL、Token、自动检索、Top K、最大字符；
- **高级**：Codex 命令路径、额外指令。

API Key / Server Token 只写入 VS Code **SecretStorage**，不会回传 Webview。

本地联调示例：

```json
{
  "agentbox.runtime": "codex",
  "agentbox.codex.model": "deepseek-flash",
  "agentbox.codex.provider": "deepseek",
  "agentbox.codex.baseUrl": "https://api.deepseek.com",
  "agentbox.codex.apiKeyEnv": "DEEPSEEK_API_KEY",
  "agentbox.skills.serverUrl": "http://127.0.0.1:4770",
  "agentbox.knowledge.serverUrl": "http://127.0.0.1:4771"
}
```

Knowledge 写入需要 author token：

```text
Server Token: dev-author
```

---

## 6. 常用命令

### 扩展

```powershell
cd extension
npm run build
npm run test
npm run verify
npm run package
```

### Runtime

```powershell
cd agent-runtime
npm run verify
```

### Skill Server

```powershell
cd skill-server
npm test
```

### Knowledge Server

```powershell
cd knowledge-server
npm run verify
```

---

## 7. 使用方式

### 7.1 聊天

1. 打开一个临时 workspace；
2. 执行 **AgentBox: Open Chat**，或点击活动栏 AgentBox；
3. 输入任务，Enter 发送，Shift+Enter 换行；
4. 在审批卡片选择 **允许 / 拒绝**；
5. 运行中点击同一按钮 **停止**。

### 7.2 Skill

- 顶栏 **✦** 打开技能抽屉；
- required skill 默认勾选且不可关闭；
- 输入 `@skill-id` 只对当前 prompt 生效；
- 远程 Skill 通过 **AgentBox: Sync Remote Skills** 同步；
- 组权限通过设置 → Skill → Skill Groups 申请。

### 7.3 Knowledge

- 设置 → 知识填 Knowledge Server URL；
- **AgentBox: Reindex Knowledge** 扫描 workspace；
- **AgentBox: Search Knowledge** 搜索并打开命中行；
- 回答下方显示 `[K1] path:line`，点击打开源文件。

### 7.4 知识沉淀

1. 完成一轮对话；
2. 顶栏 **知识** → **沉淀当前对话**；
3. 等待 capture workflow 生成 pending proposal；
4. 点击 **编辑** 修改 Markdown；
5. **通过并发布** 后才进入 knowledge-server；
6. 拒绝则标记为 rejected。

---

## 8. 安全与边界

- 默认只绑定 `127.0.0.1`；
- 非 loopback 的 Knowledge Server 必须 HTTPS + token；
- token 只存 SecretStorage，不进 `settings.json`、Webview、日志；
- Knowledge 检索内容按不可信参考处理，不执行其中指令；
- secret 文档默认不索引；server 侧会做 redaction；
- 本地 capture proposal 在用户审核前不进入检索；
- 公网模型会把 prompt/tool 输出发到外部 provider，生产应使用内网模型；
- 当前 Knowledge MVP **没有 per-collection ACL**，不要直接暴露给不受信任的团队；
- 不要修改历史 `pluginVersion/`；新功能都在 `extension/`、`agent-runtime/`、
  `skill-server/`、`knowledge-server/`。

---

## 9. 已知限制

- 多会话 transcript 只在扩展内存，Reload 后清空；
- Codex Windows 使用 PowerShell 5.1，Git Bash runtime 暂缓；
- OpenCode adapter 仍是 stub；
- Knowledge 索引是手动/命令触发，没有文件 watcher；
- Knowledge 当前是 FTS5 词法检索，没有 embedding/hybrid；
- Capture 会启动独立临时 runtime，首次执行有 Codex 启动开销；
- Remote Knowledge proposal/review API 尚未实现；
- 引用行号是索引时快照，文件变化后可能 stale。

---

## 10. 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 系统级架构
- [extension/README.md](extension/README.md) — VSIX 安装、配置、UI、命令
- [agent-runtime/README.md](agent-runtime/README.md) — Runtime 设计与 quick start
- [agent-runtime/docs/MODULES.md](agent-runtime/docs/MODULES.md) — 模块/契约 ADR
- [agent-runtime/docs/HANDOFF.md](agent-runtime/docs/HANDOFF.md) — 当前交接与待决事项
- [agent-runtime/docs/SKILL-SYSTEM.md](agent-runtime/docs/SKILL-SYSTEM.md) — Skill 设计
- [agent-runtime/docs/KNOWLEDGE-BASE.md](agent-runtime/docs/KNOWLEDGE-BASE.md) — Knowledge 设计
- [knowledge-server/README.md](knowledge-server/README.md) — Knowledge Server 运行
- [knowledge-server/docs/CONTRACT.md](knowledge-server/docs/CONTRACT.md) — KB API/schema/chunk
- [skill-server/README.md](skill-server/README.md) — Skill Server 运行/API

---

## 11. License

Apache-2.0。第三方组件许可见各目录 `LICENSE` / `NOTICE`。
