# Skill 系统方案（Skill Library）

> **状态：✅ S1–S6 MVP 已实现（2026-11-02）。**
> 关联：[MODULES.md](MODULES.md)、[HANDOFF.md](HANDOFF.md)、[UI-PROPOSAL.md](UI-PROPOSAL.md)。
> Knowledge Base 只保留边界和接口预留，不在本阶段实现。
> 实现位置：`extension/src/skills/*`、`extension/src/skill-commands.ts`、`skill-server/`。
> 验证方案：[SKILL-VERIFICATION.md](SKILL-VERIFICATION.md)。

---

## 1. 背景与目标

当前 AgentBox 的上下文注入只有三层：

1. 内置 developer instructions（Windows/PowerShell、文件卫生、工作流）；
2. workspace 根目录 `AGENTS.md` / `AgentBox.md`；
3. `agentbox.codex.extraInstructions`。

问题：

- 团队编码规范、业务规则、评审习惯散落在文档和个人 prompt 里；
- 每个项目重复写 `AGENTS.md`；
- 没有版本、审批、强制下发和本地沉淀机制；
- 本地试验和团队基线混在一起，无法区分“可选”与“必须”。

目标：

- **Local skill**：个人/本机沉淀，可选、可编辑、可删除；
- **Remote skill**：团队维护，走 HTTP 服务，可审批、可设必选、版本化；
- **Skill 创建、本地存储、远端上传、审批、必选、同步、注入**形成闭环；
- 后续 Knowledge Base 复用同一套 remote/local 模型，但独立检索和注入。

---

## 2. 范围

### 2.1 本阶段（Skill MVP）

- Skill 包格式与校验；
- 本地固定目录存储与创建/编辑/删除；
- HTTP Skill Registry：上传、列表、下载、审批、必选策略；
- 客户端同步、缓存、版本锁定；
- Required skill 注入 developer instructions；
- 本地/远端 skill 的启用、选择、预算、优先级；
- 最小 UI：命令 + 会话内 skill chips + 简单管理入口；
- 审计记录：哪一轮注入了哪些 skill/version/hash。

### 2.2 非目标

- Knowledge Base 检索、向量库、文档索引（下一阶段）；
- Skill 脚本执行、模板运行、任意代码执行；
- Marketplace、多租户计费、公开注册；
- 自动从对话生成正式 skill（可做“生成草稿”，但必须人工编辑/审批）；
- 二进制资产、超大文件、Skill 依赖解析；
- 多 agent 并发、Skill 互调。

---

## 3. 概念模型

| 概念 | 定义 |
|---|---|
| Skill | 一段“怎么做”的程序性指导：流程、约束、检查清单、反模式、验证方式 |
| Skill package | 一个目录：`skill.json` + `SKILL.md` + 可选 `references/`、`templates/` |
| Local skill | 用户本机固定目录中的 skill，默认可选 |
| Remote skill | 团队 HTTP Registry 中的 skill，有版本、审批、必选策略 |
| Required skill | 服务端标记为必选，客户端不能关闭；注入优先级高于项目指令 |
| Activation | `always` / `on-demand` / `manual` |
| Review | 上传后进入待审批，审批通过才可被客户端使用 |
| Lock | 记录某 workspace 使用的远程 skill 版本和 hash，保证可复现 |

### 3.2 Skill Group（管理层次）

Server 侧增加 `group` 作为组织层，用于把 skill 按团队/领域分组：

```json
{
  "id": "backend",
  "name": "Backend",
  "description": "Backend and data skills",
  "skillIds": ["team-encoding", "sql-etl"]
}
```

- 存储：`data/groups.json`；
- API：`GET /v1/groups`、`PUT /v1/groups/:id`、`DELETE /v1/groups/:id`；
- 管理页新增“分组”视图，可创建/编辑/删除分组并勾选成员；
- `/v1/skills` 的 summary 增加 `groups`（分组名称）；
- 客户端缓存/index 保留 groups，技能抽屉显示所属分组；
- Group 只是组织层，不改变 required/enabled 语义；required 仍由 skill policy 控制。

**客户端加入组（成员审批）**

- 每个 AgentBox 安装生成稳定 `clientId`（globalState），请求时通过
  `x-agentbox-client` / `x-agentbox-client-name` 传给 server；
- 客户端在 Settings → Skill → Skill Groups 多选组，提交申请；
- server 存 `data/memberships.json`，状态 `pending / approved / rejected`；
- admin 页面在“分组”视图看到“加入申请”，可通过/拒绝；
- 只有 `approved` 组的 skill 会出现在客户端的 approved/required 结果中；
- 未加入组的 grouped skill 对客户端不可见；
- 不属于任何组的 skill 仍对所有客户端可见；
- required skill 仍受 policy 控制，但必须同时满足组审批。

### 3.1 来源 × 激活方式

不要把“remote”直接等同于“每轮都注入”：

| 来源 | 激活方式 | 典型用途 |
|---|---|---|
| local | always / on-demand / manual | 个人习惯、试验中的规则 |
| remote | **required + always** | 编码格式、安全、提交规范 |
| remote | approved + on-demand / manual | 业务域流程、框架用法 |
| remote | pending / rejected | 不可注入，只在管理界面可见 |

---

## 4. 关键决策（建议）

| # | 决策 | 理由 |
|---|---|---|
| **S1** | Local skill 固定存 `~/.agentbox/skills/local/`，不写 workspace | 用户本机沉淀，跨项目复用；不会污染仓库 |
| **S2** | Remote skill 缓存到扩展 globalStorage 的固定目录，不写 workspace | 机器管理、不可变缓存，和用户本地 skill 分离 |
| **S3** | Remote 传输使用 JSON 包（manifest + 文件内容 map），MVP 只允许文本文件 | 避免 zip/multipart 解析和路径穿越；先跑通闭环 |
| **S4** | 版本不可变；上传即生成 `pending`，审批通过后才可用 | 可审计、可回滚、可复现 |
| **S5** | `required` 只能由服务端 admin 设置；客户端不可关闭 | 团队基线必须可控 |
| **S6** | 注入优先级：内置安全 > remote required > 项目 `AGENTS.md` > local/optional > `extraInstructions` | 安全最高；团队必选高于项目局部约定 |
| **S7** | Required 缺失默认“使用缓存 + 警告”；可配置为 `block` | 避免离线时完全不可用；合规场景可强制失败 |
| **S8** | MVP 不执行 skill 内脚本；只注入 Markdown/文本 | 降低远程代码执行风险 |
| **S9** | MVP 服务端用文件系统 + JSON 元数据；后续再上 SQLite/对象存储 | 先验证产品闭环，降低运维成本 |
| **S10** | 服务端 token 存 SecretStorage，不进 webview、不进 settings | 现有密钥边界一致 |

---

## 5. Skill 包格式

### 5.1 目录结构

```text
team-encoding/
  skill.json
  SKILL.md
  references/
    naming.md
  templates/
    api-handler.md
```

- `skill.json`：机器可读元数据；**本地目录可省略**，客户端会从目录名、`SKILL.md` 标题/YAML frontmatter 推导默认 manifest；
- `SKILL.md`：注入给模型的正文；
- `references/`：静态参考，MVP 不自动注入，只作为内容组织；
- `templates/`：文本模板，MVP 不执行，只作为内容组织；
- 可选 `evals/`：后续 skill 回归用例。

### 5.2 `skill.json`

```json
{
  "schemaVersion": 1,
  "id": "team-encoding",
  "name": "团队编码规范",
  "version": "1.0.0",
  "description": "TypeScript/Python 命名、错误处理和文件组织约束",
  "owner": "platform-team",
  "activation": "always",
  "appliesTo": {
    "languages": ["typescript", "python"],
    "paths": ["**/*.ts", "**/*.py"]
  },
  "triggers": {
    "keywords": ["命名", "encoding", "error handling"],
    "paths": ["src/**"]
  },
  "priority": 100,
  "budget": {
    "maxChars": 2000
  },
  "required": false
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | MVP 固定 `1` |
| `id` | 是 | `^[a-z0-9][a-z0-9._-]{2,63}$`，全局唯一 |
| `name` | 是 | 展示名 |
| `version` | 是 | semver；本地可编辑，上传后不可变 |
| `description` | 是 | 列表/检索用，不直接注入 |
| `owner` | 是 | 负责人/团队 |
| `activation` | 是 | `always` / `on-demand` / `manual` |
| `appliesTo` | 否 | 语言/路径过滤 |
| `triggers` | 否 | 关键词/路径触发，Phase 2 使用 |
| `priority` | 否 | 冲突排序，默认 50 |
| `budget.maxChars` | 否 | 该 skill 注入上限 |
| `required` | 否 | 仅服务端有效；客户端上传值忽略 |

### 5.3 `SKILL.md`

建议固定结构，便于 review 和后续 eval：

```md
# 何时使用

# 步骤

# 反模式

# 示例

# 验证方式

# 关联知识
```

要求：

- 开头不写 YAML frontmatter（元数据统一放 `skill.json`）；
- 不包含密钥、内网地址、个人隐私；
- 不写“忽略之前指令”这类越权内容；
- 引用模板/文档用相对路径，不依赖执行。

### 5.4 校验与 hash

- 校验 JSON Schema、id/version、文件数量、单文件和总大小、路径安全；
- 禁止绝对路径、`..`、符号链接、隐藏文件；
- MVP 只允许 `.md`、`.txt`、`.json`、`.yaml`、`.yml`；
- 计算 canonical hash：按相对路径排序，拼接路径 + 内容 hash；
- 客户端下载后重新计算并比对，不匹配则拒绝。

---

## 6. 本地存储

### 6.1 固定目录

```text
%USERPROFILE%\.agentbox\skills\local\<id>\
```

- 默认 `~/.agentbox/skills/local`；
- 可选设置 `agentbox.skills.localDir` 覆盖，但仍不允许指向 workspace；
- 由 `AgentBox: Open Skills Folder` 打开；
- 不写入 `.vscode/` 或仓库。

### 6.2 Remote 缓存

```text
<globalStorage>/agentbox/skills/remote/<serverHash>/<id>/<version>/
<globalStorage>/agentbox/skills/remote/<serverHash>/index.json
<globalStorage>/agentbox/skills/state/<workspaceHash>.json
```

- `serverHash` 由 server URL 哈希，避免多个 registry 冲突；
- 远程缓存不可编辑，只能同步覆盖/删除；
- `state/<workspaceHash>.json` 记录 required 版本、上次同步时间、ETag。

### 6.3 本地生命周期

| 操作 | 行为 |
|---|---|
| 创建 | 生成目录、`skill.json`、`SKILL.md` 模板，打开 `SKILL.md` |
| 编辑 | 直接用 VS Code 编辑文件 |
| 校验 | 保存/上传/启用前校验；错误在 Problems/Output 显示 |
| 启用/停用 | 只影响本机；写入扩展 globalState/settings |
| 删除 | 二次确认（长按/模态），删除目录 |
| 上传 | 读取目录 → 校验 → POST 到 registry → 记录 pending 状态 |

本地 skill 不能设置 `required=true`；即使写了，客户端也忽略。

---

## 7. 远端 HTTP 服务

### 7.1 定位

独立服务，建议放到仓库外或 `services/skill-registry/`，不与 VS Code 扩展打包。

实际 MVP 技术栈：

- Node 24 + TypeScript；
- 原生 `node:http`（无框架），手写路由、JSON body、静态 admin 页面；
- 文件系统存储 + JSON 元数据；
- 反向代理负责 TLS（nginx/Caddy），服务本身只监听内网端口；
- 后续可替换 Fastify/SQLite/Postgres + S3。

### 7.2 角色与权限

| 角色 | scope | 能力 |
|---|---|---|
| reader | `skill:read` | 查看已审批 skill、下载、同步 required |
| author | `skill:write` | 上传新版本、查看自己的 pending |
| reviewer | `skill:review` | 审批/拒绝、查看 diff |
| admin | `skill:admin` | 设置 required、撤销版本、管理目标范围 |

MVP 可用静态 token 映射角色；生产建议 OIDC/SSO。上传者不能审批自己（服务端强制）。

### 7.3 状态机

```text
upload -> pending
pending -> approved | rejected
approved -> revoked
rejected -> (new version) pending
```

- 同一 `id + version` 不可重复上传；
- 只有 `approved` 可被客户端下载/注入；
- `required` 只能指向 `approved` 版本；
- 撤销 required 后，客户端回退到上一个 approved 版本；没有则警告/阻断。

### 7.4 API（MVP）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/healthz` | - | 健康检查 |
| GET | `/v1/skills` | reader | 列表，支持 `status`、`required`、`q`、分页 |
| GET | `/v1/skills/:id` | reader | 元数据 + 版本列表 |
| GET | `/v1/skills/:id/:version` | reader | 下载 JSON 包（manifest + files） |
| GET | `/v1/required` | reader | required skill 列表；可带 workspace/team |
| POST | `/v1/skills` | author | 上传新版本，创建 pending |
| POST | `/v1/skills/:id/:version/approve` | reviewer | 审批通过 |
| POST | `/v1/skills/:id/:version/reject` | reviewer | 拒绝，附 comment |
| POST | `/v1/skills/:id/:version/revoke` | admin | 撤销已批准版本 |
| PUT | `/v1/skills/:id/policy` | admin | 设置 required/目标范围/固定版本 |
| GET | `/v1/audit` | admin | 审计日志 |

上传 payload：

```json
{
  "manifest": { "schemaVersion": 1, "id": "team-encoding", "version": "1.0.0" },
  "files": {
    "SKILL.md": "# ...",
    "references/naming.md": "..."
  }
}
```

约束：

- 单包 ≤ 1 MB，文件数 ≤ 50；
- 只允许文本扩展名；
- `manifest.id/version` 必须与路径一致；
- 服务端重新计算 hash，不接受客户端 hash 作为唯一依据。

### 7.5 Required 策略

```json
{
  "required": true,
  "version": "1.0.0",
  "target": "all",
  "updatedBy": "admin",
  "updatedAt": "2026-11-02T00:00:00Z"
}
```

- `target`：MVP 支持 `all` / `team:<id>`；后续 `workspace:<hash>`；
- `version` 固定，避免“最新版”静默变化；
- required 列表按 manifest priority 排序；
- 冲突检测：同一 `appliesTo` 下 required 规则矛盾时，服务端/客户端都要告警。

### 7.6 最小 Admin UI

建议服务端自带一个无构建的静态管理页：

- 登录（token）；
- pending 列表、内容预览、与上一 approved 版本的 diff；
- 通过/拒绝（comment）；
- required 开关/目标/版本；
- 审计列表。

MVP 可以先用 API + curl，但审批体验会差；建议至少提供只读 + approve/reject 的简单 HTML 页面。

### 7.7 存储与运维

```text
data/
  skills/<id>/<version>/skill.json
  skills/<id>/<version>/SKILL.md
  skills/<id>/<version>/files...
  index.json
  policies.json
  audit.jsonl
```

- 原子写：临时目录 → rename；
- 版本目录不可变；
- 备份 `data/`；
- 限制上传大小/速率；
- 日志脱敏，不记录 token；
- 反向代理 TLS + 内网访问控制。

---

## 8. 客户端同步与注入

### 8.1 同步

- 启动/手动 `AgentBox: Sync Remote Skills`；
- `GET /v1/required` + `GET /v1/skills?status=approved`；
- 按需下载缺失版本，校验 hash 后写入缓存；
- 使用 ETag/Last-Modified 减少重复传输；
- 同步失败：使用已校验缓存；无缓存时按 `requiredMissing` 策略警告或阻断。

### 8.2 解析顺序

```text
1. 内置安全/工作流规则
2. remote required（按 priority，固定版本）
3. 项目 AGENTS.md / AgentBox.md
4. local always / 当前启用的 optional
5. on-demand / @skill 选中的 skill
6. extraInstructions
```

- required 不能被本地关闭；
- local skill 不能覆盖 required/安全规则；
- 同 id 的 local/remote 冲突：remote required 优先；非 required 时提示用户；
- 记录冲突和截断。

### 8.3 注入方式

- **required + always**：拼进 `developerInstructions`，作为独立 section；
- **optional + always**：拼进 `developerInstructions`；
- **on-demand/manual**：拼进 `TurnInput.context`，并标注来源；
- 每个 section 带 `id@version` 便于审计；
- `TurnInput.metadata` 写入 `skills: [{id, version, hash, source}]`（可 JSON 序列化，不含密钥）。

### 8.4 预算

建议默认值（可配置）：

- required 合计 ≤ 4,000 字符；
- 单个 optional ≤ 8,000 字符；
- 所有 skill 合计 ≤ 12,000 字符；
- 超出按 priority 截断，按 section 边界，不截断代码块中间；
- UI 显示“已截断”警告。

### 8.5 UI / 命令

命令：

| 命令 | 行为 |
|---|---|
| `AgentBox: Skills` | QuickPick：required / local / remote approved；查看、启用、停用 |
| `AgentBox: Create Skill` | 在本地固定目录创建模板并打开 |
| `AgentBox: Open Skills Folder` | 打开本地 skill 目录 |
| `AgentBox: Validate Skill` | 校验当前/选中的 skill |
| `AgentBox: Upload Skill` | 选择本地 skill → 上传 → 显示 pending |
| `AgentBox: Sync Remote Skills` | 同步 required/approved 列表 |
| `AgentBox: Set Skill Server Token` | SecretStorage |
| `AgentBox: Skill Server Settings` | server URL、autoSync、requiredMissing |

Webview：

- composer 上方显示当前注入的 skill chips：`@team-encoding 1.0.0`；
- 点击 chip 查看正文/来源/版本；
- 本地 skill 可选 `@` 引用；
- 状态栏/通知显示同步失败、required 缺失、待审批上传。

---

### 8.6 主动调用与被动调用

| 模式 | 入口 | 生效范围 |
|---|---|---|
| 强制被动 | server `required` | 每一轮，不可关闭 |
| 被动可选 | 技能抽屉勾选 / `activation=always` | 后续每一轮 |
| 主动调用 | 输入框 `@skill-id` | **仅当前一轮** |

- 抽屉勾选是“持久启用”，不是单轮调用；
- `@skill-id` 从当前已加载的 local/remote skill 中查找，只把该 skill 注入当前 turn 的 context；
- 已经在被动注入中的 skill 不会因 `@` 重复注入；
- 主动调用可以覆盖本地 `disabled`（显式意图优先），但不能绕过内置安全规则或 required；
- 输入 `@` 时 composer 显示补全列表；`Enter/Tab` 选择，`Esc` 关闭。

---

## 9. 安全

### 9.1 威胁

| 威胁 | 影响 | 缓解 |
|---|---|---|
| 恶意 remote skill | 诱导模型执行危险操作 | 审批、reviewer、required 受控、审计 |
| 路径穿越/符号链接 | 覆盖本机文件 | 禁止绝对路径/`..`/symlink；只写缓存目录 |
| 供应链替换 | 注入被篡改内容 | 版本不可变 + hash 校验；后续签名 |
| token 泄露 | 未授权上传/审批 | SecretStorage、TLS、短期 token、审计 |
| 本地 skill 覆盖安全规则 | 绕过团队约束 | 优先级固定；required 不可关闭 |
| 团队知识发给公网模型 | 数据泄露 | 沿用 `scope=external` 告警；required skill 标记 sensitivity；后续 allowlist |
| 脚本执行 | RCE | MVP 禁止脚本；模板只作为文本 |

### 9.2 审计

每次 turn 记录：

- 注入的 skill id/version/hash/source；
- 被截断/冲突/缺失的 skill；
- required 是否满足；
- 使用的 server URL（不含 token）。

---

## 10. 可观测性 / 产品指标

- 本地 skill 创建数、启用数；
- 远程上传数、pending 数、平均审批时长；
- required 覆盖率（有 required 的 workspace 比例）；
- 注入字符/token 成本；
- skill 使用次数（按 turn metadata 统计）；
- 同步失败率、required 缺失次数；
- 上传被拒绝原因分布。

---

## 11. 需求拆解

### Epic S1：Skill 包与本地存储

- S1-1 定义 `skill.json`/`SKILL.md` 规范与 JSON Schema；
- S1-2 固定本地目录与 remote 缓存目录；
- S1-3 校验器：id/version/路径/大小/扩展名/hash；
- S1-4 本地创建/编辑/删除/打开目录命令；
- 验收：创建模板、编辑后校验通过、非法路径被拒绝、目录不在 workspace。

### Epic S2：本地 skill 注入

- S2-1 读取 local always/optional；
- S2-2 与内置规则、AGENTS.md、extraInstructions 合并；
- S2-3 预算/截断/冲突提示；
- S2-4 turn metadata 记录；
- 验收：required/local/项目指令顺序正确；超预算截断有提示；日志可追溯。

### Epic S3：HTTP Skill Registry

- S3-1 服务骨架、配置、healthz；
- S3-2 文件系统存储、索引、原子写；
- S3-3 上传/列表/下载 API；
- S3-4 token/角色校验；
- S3-5 最小 admin 页面；
- 验收：author 上传 pending；reader 只能看 approved；包 hash 一致。

### Epic S4：审批与必选

- S4-1 pending/approved/rejected/revoked 状态机；
- S4-2 reviewer 审批/拒绝 + comment；
- S4-3 admin 设置 required/版本/目标；
- S4-4 审计日志；
- S4-5 禁止自审；
- 验收：未审批不可下载/注入；required 客户端不可关闭；撤销后回退/告警。

### Epic S5：客户端同步与上传

- S5-1 server URL/token 设置（SecretStorage）；
- S5-2 required/approved 同步、ETag、缓存校验；
- S5-3 `Upload Skill` 命令与 pending 状态；
- S5-4 required 缺失策略（warn/block）；
- S5-5 同步状态 UI；
- 验收：断网使用缓存；篡改缓存被拒绝；上传后显示 pending。

### Epic S6：UI 与可观测性

- S6-1 composer skill chips；
- S6-2 `AgentBox: Skills` QuickPick；
- S6-3 冲突/截断/同步错误提示；
- S6-4 管理页 review diff；
- 验收：用户能看到本轮注入了什么；required 不可关闭；reviewer 能看到版本差异。

### Epic KB（后续）

- Knowledge Base 独立文档：来源、切块、索引、检索、引用、敏感级别；
- 与 Skill 共用 remote/local 基础设施，但生命周期/注入路径不同。

---

## 12. 里程碑建议

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **S0** | 本文档 + `skill.json` schema + API 契约评审 | 无 |
| **S1** | 本地 skill：创建/校验/存储 + 注入 + 预算 | S0 |
| **S2** | HTTP registry：上传/列表/下载 + 客户端同步 | S1 |
| **S3** | 审批 + required + 审计 + 最小 admin UI | S2 |
| **S4** | UI chips/QuickPick、错误提示、运维加固 | S3 |
| **KB-1** | 知识库索引与检索（独立） | S4 |

建议先做 S1：即使没有服务端，也能验证“skill 包格式 + 注入优先级 + 预算”是否正确；S2 再引入网络和审批，降低联调风险。

---

## 13. 待确认

1. **本地目录**：`~/.agentbox/skills` 还是扩展 globalStorage？建议前者，便于用户编辑/备份。
2. **服务端形态**：Fastify 独立服务，还是先写零依赖 `node:http`？建议 Fastify，省路由/校验/静态页工作。
3. **审批 UI**：MVP 是否要最小 admin 网页？建议要，否则审批只能靠 curl。
4. **认证**：MVP 静态 token 是否够？建议先 token，生产 OIDC。
5. **必选缺失**：默认缓存 + 警告，还是直接阻断？建议默认警告，配置可阻断。
6. **优先级**：remote required 是否高于项目 `AGENTS.md`？建议高于；如果项目需要覆盖，后续加 `allowProjectOverride`。
7. **包传输**：MVP JSON 文本包是否够？建议够；后续再支持 zip/二进制。
8. **Knowledge Base**：是否与 Skill 共用同一个 HTTP 服务？建议共用服务、分开 API/索引，避免两套运维。

**MVP 已采用**：`~/.agentbox/skills/local`；`node:http` + 文件存储；静态 token；required 缺失默认 warn；remote required 高于项目 AGENTS.md；JSON 文本包。

---

## 14. 实现记录（S1–S6）

| 模块 | 实现 |
|---|---|
| S1 包与本地存储 | `extension/src/skills/model.ts`：manifest 校验、路径/大小/扩展名、canonical hash；`store.ts`：`~/.agentbox/skills/local`、remote cache、scaffold/read/delete |
| S2 注入 | `skills/injection.ts`：required/local/optional、优先级、预算截断、冲突告警；`settings.ts` 按 内置 > required > AGENTS.md > local > extra 注入 |
| S3 HTTP Registry | `skill-server/`：Node HTTP、文件系统存储、JSON 包上传/下载、列表/required、admin 页面 |
| S4 审批/必选 | pending/approved/rejected/revoked、self-review 限制、required policy、revoke、audit.jsonl |
| S5 客户端同步 | `skills/client.ts`：approved 同步、hash 校验、upload、autoSync（激活时）、requiredMissing warn/block；SecretStorage token |
| S6 UI/可观测性 | 命令：Skills/Create/Open Folder/Validate/Upload/Sync/Set Token；顶栏 **✦** 技能抽屉（勾选启用/停用，required 默认勾选且不可取消）；composer skill chips；`AgentBox Chat` 输出注入列表和 warning；turn metadata 带 skills |

验证：

- extension：**95 passed / 1 skipped**（含 skills-model/store/injection/catalog/mentions/client）
- skill-server：**5 passed**
- E2E smoke：upload → approve → required → sync → hash 校验通过
- VSIX 打包与隔离安装见 `extension/README.md`。

已知限制（MVP）：

- on-demand 触发（路径/关键词）未实现，先按 `always`/`skills.enabled`；
- 远程同步是启动时/手动，不是后台实时；
- Registry 使用静态 token、单进程文件存储；
- 不支持脚本执行、二进制资产、skill 依赖。

