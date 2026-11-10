# AgentBox VS Code (UI-1)

> **UI-1**：侧边栏聊天面板（Webview Sidebar）+ 真实 Codex app-server。
> 流式文本、思考/生成动画、工具卡片、内联审批、Stop、当前文件/选区上下文、
> Markdown 分级渲染（标题/列表/表格）、代码块一键复制；
> 用户消息右对齐、助手回复左对齐，带角色标签与分隔线。
> 头部不显示 runtime/model；点击右上角 **⚙** 或执行 **AgentBox: Settings**
> 打开内嵌设置浮层（模型 / Skill / 高级三个 Tab），不离开对话。
> 输入框自动增高，发送与取消合并为右侧同一个图标按钮。
> 输入框上方固定显示活动时间线（思考 / 生成 / 工具三条泳道，失败工具变红，可折叠）。
> 顶部会话标签栏支持多会话：新建、切换、长按关闭；每个会话保留独立上下文和 transcript。
> 每个会话各自启动一个 Codex app-server 进程；顶栏 **⧉** 或右下角状态栏 **AgentBox** 可把聊天打开为编辑器标签页，像文件一样拖动/拆分布局。
> 支持本机 Skill 与团队 HTTP Skill Registry：本地固定目录创建/编辑，远程上传审批、required 下发、同步缓存。
> 顶栏 **✦** 打开技能抽屉，用勾选启用/停用 local/optional skill；required 默认勾选且不可取消。
> 任务模式 simple / code / research 控制超时；推理强度 low / medium / high 控制 thinking 成本；重复工具失败会自动停止本轮。
> Codex reasoning 会以可折叠“思考”块显示：优先 summary，provider 不提供时回退 raw reasoning（仅 UI，不写日志）。
> 命令执行以 `工具 PowerShell` 摘要进入处理过程；点击可打开临时编辑器标签查看完整命令/输出，同时写入 **AgentBox Chat** 日志。
> Codex 在 Windows 上使用 PowerShell 5.1；Git Bash 尝试已回退（Codex Windows sandbox 与 MSYS2 不兼容），详见 HANDOFF PENDING-1。
> 保留 `agentbox.runtime = "fake"` 用于无模型的 UI 冒烟。
> 旧的 `OutputChannel + 模态审批` 路径保留为降级/调试入口。

---

## 1. 前置条件

| 项 | 值 |
|---|---|
| Node（开发/构建） | 24 |
| VS Code | 1.85+（扩展宿主 Node 18） |
| Codex CLI | 已在机器上安装并 pin 版本；VSIX 不打包二进制 |
| 模型 | DeepSeek `deepseek-flash`（Responses API）或内网 OpenAI-compatible |
| 网络 | 公网模型会把 prompt/tool 输出发到外部；秘密级数据禁止 |

本地探测用的 Codex 在 `../agent-runtime/.probe/tools`（gitignored），也可以使用你自己的安装。

---

## 2. 安装与构建

```powershell
cd extension
npm install
npm run build      # 构建 runtime + typecheck + esbuild（extension + webview）
npm test           # 95 个测试（controller / settings / chat-view / timeline / context / webview-ui / file-policy / project-instructions / loop-detector / task-profile / skills-* / bundle）
npm run verify
```

打包：

```powershell
npm run package
# 产物：extension/agentbox-0.3.0.vsix
```

安装：

```powershell
code --install-extension agentbox-0.3.0.vsix
```

---

## 3. 配置

### 3.1 模型 provider

| 设置 | 默认值 |
|---|---|
| `agentbox.runtime` | `codex` |
| `agentbox.taskProfile` | `code`（simple / code / research） |
| `agentbox.loopDetection.enabled` | `true` |
| `agentbox.loopDetection.maxRepeatedFailures` | `2` |
| `agentbox.loopDetection.maxConsecutiveFailures` | `4` |
| `agentbox.codex.command` | `codex` |
| `agentbox.codex.model` | `deepseek-flash` |
| `agentbox.codex.provider` | `deepseek` |
| `agentbox.codex.baseUrl` | `https://api.deepseek.com` |
| `agentbox.codex.apiKeyEnv` | `DEEPSEEK_API_KEY` |
| `agentbox.codex.scope` | `external` |
| `agentbox.codex.approvalPolicy` | `on-request` |
| `agentbox.codex.reasoningSummary` | `auto`（按模型返回的思考摘要展示；`none` 关闭） |
| `agentbox.codex.reasoningEffort` | `medium`（low / medium / high） |
| `agentbox.codex.permissions` | `:workspace` |
| `agentbox.codex.autoSetupSandbox` | `true` |
| `agentbox.codex.extraInstructions` | 空（追加到内置提示词） |
| `agentbox.files.denyWrite` | `.chrome-profile`、`*.patch`、`dom.txt`、`preview.png` 等（glob 数组） |
| `agentbox.skills.enabled` | `[]`（启用的 local/optional skill id；required 不可关闭） |
| `agentbox.skills.disabled` | `[]`（显式停用的 local/optional skill id） |
| `agentbox.skills.localDir` | 空 = `~/.agentbox/skills/local` |
| `agentbox.skills.serverUrl` | 空（HTTP Skill Registry） |
| `agentbox.skills.autoSync` | `true` |
| `agentbox.skills.requiredMissing` | `warn`（可选 `block`） |
| `agentbox.codex.home` | 空 = 扩展 global storage |
| `agentbox.envFile` | 空 |
| `agentbox.limits.turnTimeoutMs` | 可选覆盖；空 = 使用任务 profile |

如果 codex 不在 PATH，把 `agentbox.codex.command` 设为绝对路径，例如：

```json
{
  "agentbox.codex.command": "D:\\path\\to\\codex.exe"
}
```

### 3.1.1 Windows Shell 说明

Codex CLI 在 Windows 上使用 **Windows PowerShell 5.1**（本机没有 `pwsh`）。
Git Bash 尝试已回退：Codex 的 Windows sandbox 使用 restricted token，MSYS2
启动时需要创建 signal pipe，会被拒绝；因此不再提供 `agentbox.codex.shell`
切换，也不注入 Git Bash PATH。

后续若需要 bash-capable runtime，见 `agent-runtime/docs/HANDOFF.md`
§10 PENDING-1（暂缓，先完成 Skill Server / KB）。

### 3.2 API key

优先级：

1. 设置浮层里的 **API Key**（VS Code SecretStorage，推荐）
   兼容旧命令 `AgentBox: Set API Key`
2. 扩展宿主进程的 `agentbox.codex.apiKeyEnv` 环境变量
3. `agentbox.envFile` 指向的 `.env`（本地测试用，支持 `${workspaceFolder}`）

示例工作区 `.vscode/settings.json`：

```json
{
  "agentbox.runtime": "codex",
  "agentbox.codex.command": "D:\\expirmentalArea\\agentBox\\agent-runtime\\.probe\\tools\\node_modules\\.bin\\codex.cmd",
  "agentbox.codex.model": "deepseek-flash",
  "agentbox.codex.provider": "deepseek",
  "agentbox.codex.baseUrl": "https://api.deepseek.com",
  "agentbox.codex.apiKeyEnv": "DEEPSEEK_API_KEY",
  "agentbox.codex.scope": "external",
  "agentbox.envFile": "${workspaceFolder}/../agent-runtime/.env"
}
```

> 生产不要依赖 `.env`；用 SecretStorage 或受控环境变量。

### 3.3 外部模型告警

当 `agentbox.codex.scope = "external"` 时，首次运行会弹窗提示：

> prompts 和 tool 输出会发送到外部 provider；不要发送秘密级数据。

取消则不会启动 runtime；选择 Continue 后按 provider+baseUrl 记住。

### 3.4 Windows sandbox

CodexRuntime 启动时读取 `windowsSandbox/readiness`：

- `ready` → 继续；
- `notConfigured` 且 `autoSetupSandbox=true` → 自动执行
  `windowsSandbox/setupStart({mode:"unelevated"})`，然后**重启 app-server**；
- 失败 → 报错，不静默运行。

`agentbox.codex.home` 建议指向持久目录（默认扩展 global storage），避免每次启动重复 setup。

### 3.5 内置提示词（环境与文件卫生）

每次 `thread/start` 会附带一段 `developerInstructions`（追加到 Codex 内置指令，不替换）：

**工作流**

- 先搜索/阅读相关文件，再修改；不要凭猜测改 API。
- 只改任务相关代码；不做无关重构/格式化。
- 修改后运行最小相关测试/构建；没有运行不要声称通过。
- 不新增依赖；不回滚用户未提交的改动。
- 最终回复包含：改动、验证结果、剩余风险；不粘贴大段文件内容。

**环境**

- **Windows 环境**：使用 Windows PowerShell 5.1（没有 `pwsh`）；使用 PowerShell
  cmdlet，不假设 bash/POSIX 工具可用。写文件指定 UTF-8，避免 `>` 产生 UTF-16。

**文件卫生**

- 只创建任务需要的文件；除非用户明确要求，不创建
  `*.patch`、`apply*.py`、`dom.txt`、`len-test*.txt`、`patch-test*.txt`、
  `preview.png`、`.chrome-profile`、`.tmp` 等文件。
- **HTML/CSS/JS 任务**：直接写目标文件（如 `index.html` + 必要资源），
  不启动浏览器、不截图、不创建浏览器 profile。
- `apply_patch` 失败时改用直接写文件，不生成一串辅助脚本；临时文件要清理。
- 保持最小改动，不添加无关依赖或文件。

可通过 `agentbox.codex.extraInstructions` 追加项目/团队规则。
这是**软约束**，不能替代沙箱与审批；高风险操作仍建议使用 `untrusted` 审批策略。

### 3.6 项目指令文件（AGENTS.md）

在 workspace 根目录放置 `AGENTS.md`（或 `AgentBox.md`），内容会自动加入 Codex 的 developer instructions：

- 优先读取 `AGENTS.md`，不存在时回退 `AgentBox.md`；
- UTF-8；单文件上限 **8,000 字符**，超出截断并在 `AgentBox Chat` 记录；
- 优先级：内置安全/工作流规则 > 项目指令 > `agentbox.codex.extraInstructions`；
- 项目指令可以补充命令、目录约定、do-not-touch，但不能覆盖安全/审批/文件卫生规则；
- 指令内容参与会话签名；文件变化后，**下一条 prompt** 会重建会话并生效；
- 当前只读取 workspace 根目录，不支持嵌套 `**/AGENTS.md`。

示例：

```md
# AGENTS.md

## Commands
- install: npm ci
- test: npm test
- build: npm run build

## Conventions
- TypeScript strict；不要新增 any
- 新增 API 必须补测试

## Do not touch
- generated/
- vendor/

## Done criteria
- 相关测试通过
- build 通过
```

### 3.7 文件写入策略（审批阶段）

当 Codex 发起 `approval.request` 时，扩展会先做一次文件策略检查：

- 路径命中 `agentbox.files.denyWrite` 的 `fileChanges` / `applyPatch` / `grantRoot` → **直接拒绝**；
- 命令包含 `.chrome-profile`、`preview.png`、`dom.txt`、`len-test`、`patch-test` 等标记 → **直接拒绝**；
- 浏览器/截图类命令（`chrome`、`msedge`、`playwright`、`puppeteer`、`headless`、`screenshot`）→ 审批卡片显示警告，由你确认。

默认 deny 列表：

```json
[
  "**/.chrome-profile/**",
  "**/*.patch",
  "**/dom.txt",
  "**/preview.png",
  "**/len-test*",
  "**/patch-test*",
  "**/apply-*.py",
  "**/.tmp/**"
]
```

限制：

- 策略只在 Codex **请求审批**时生效；`on-request` 下如果 Codex 不询问，策略无法拦截。
- shell 命令可能间接写文件，静态检查不是 100% 覆盖；真正的硬限制需要沙箱/ACL。
- 需要更强约束时，把审批策略设为 `untrusted`，并保持默认 deny 列表。

### 3.8 任务 profile 与循环检测

**任务 profile**（设置浮层「任务模式」或 `agentbox.taskProfile`）：

| Profile | 适用 | 超时 |
|---|---|---|
| `simple` | 静态 HTML/CSS/单文件 | 90s |
| `code` | 常规编码 | 180s |
| `research` | 研究/多步任务 | 300s |

`agentbox.limits.turnTimeoutMs` 是可选覆盖；显式设置时优先于 profile。

不再按 `maxSteps` / 工具调用数硬中断；依赖超时、工具循环检测和推理强度控制成本。超时中断会同步发送 Codex `turn/interrupt`，避免 UI 已超时但 Codex 继续运行。

**循环检测**：

- 相同 tool name + args 连续失败 2 次 → 停止本轮；
- 连续工具失败 4 次 → 停止本轮；
- 成功调用会重置失败计数；
- 命中后 UI 显示“检测到工具循环，已停止本轮”，runtime 走 abort/cancel。

可在设置中关闭或调整阈值。循环检测只统计 `tool.end(ok=false)`，不会因为正常重复测试而误停。

### 3.9 Skill（本地 / 远程）

**本地 Skill**：

- 固定目录 `~/.agentbox/skills/local/<id>/`，不写入 workspace；
- 只需要 `SKILL.md` 也能被识别：没有 `skill.json` 时从目录名/标题/YAML frontmatter 推导 manifest；
- `AgentBox: Create Skill` 创建 `skill.json` + `SKILL.md`；
- `AgentBox: Open Skills Folder` 打开目录；
- `AgentBox: Validate Skill` 校验；
- `AgentBox: Skills` 查看/启用/停用/上传/删除；
- 本地 `activation=always` 或 `skills.enabled` 中的 skill 会注入；
- 输入框输入 `@` 会弹出 Skill 补全；`@skill-id` 只在当前 prompt 注入，不改变持久勾选；
- required/always 已经被动注入的 skill 不会因 `@` 重复注入。

**远程 Skill**：

- 设置 `agentbox.skills.serverUrl`；
- 生产环境在设置浮层填 **Server Token**（SecretStorage）；本地 loopback dev server 可匿名读取；
- `AgentBox: Sync Remote Skills` 拉取 approved + required，校验 hash / id / version 后缓存；
- `AgentBox: Upload Skill` 上传本地 skill，服务端进入 `pending`；
- required skill 不可关闭，始终注入；
- 设置 → Skill → Skill Groups 可多选申请加入组；需要 server admin 审批；
- 只有已加入组的 skill 才会同步；未分组 skill 不受组限制；
- 同步失败默认使用缓存并警告；`skills.requiredMissing=block` 可阻断。

本地联调：

```powershell
cd skill-server
npm run dev:seed
```

它会写入 4 个示例 skill + 3 个分组，并启动 server。管理页
`http://127.0.0.1:4770/admin` 自动登录；扩展只需要：

```json
{ "agentbox.skills.serverUrl": "http://127.0.0.1:4770" }
```

然后执行 `AgentBox: Sync Remote Skills`。本地 loopback dev server 允许匿名读取，
不需要 token；生产环境才需要设置 token。

**注入优先级**：

```text
内置安全/工作流
  > remote required
  > 项目 AGENTS.md
  > local / optional
  > extraInstructions
```

**Skill Registry**：实现和使用见仓库根目录的 `skill-server/README.md`。

---

## 4. 使用聊天

1. 安装 VSIX 并重载窗口。
2. 打开一个**临时工作区**（不要用生产仓库做公网模型冒烟）。
3. 执行 **AgentBox: Open Chat** 默认打开编辑器标签页；点击活动栏的 **AgentBox** 图标
   则打开侧边栏视图，执行 **AgentBox: Focus Sidebar** 可回到侧边栏。
4. 在输入框输入任务，按 **Enter** 发送（**Shift+Enter** 换行）；输入框随内容自动增高。
5. 打开/切换文件时，**当前文件** 默认选中（带 ✓）；
   选中新的文本区间时，**选区** 也默认选中；两者都可点击取消。
6. 对话右侧中间有 **问题导航条**：每个用户问题一个圆点，点击跳转并高亮，
   hover 显示前 20 字摘要；最多只显示当前位置附近的 10 个问题，滚动时窗口自动滑动。
7. 运行时会显示 **思考中… / 生成中… / 执行工具… / 等待审批…** 指示；
   长时间思考会附加已用秒数，状态栏有脉冲点。
8. 命令执行以一行 `工具 PowerShell` 进入处理过程，不再把完整命令/输出塞进对话；
   点击该行会在临时编辑器标签中打开命令和输出，同时写入 `AgentBox Chat`。
   文件修改等其他工具仍显示可展开卡片。
9. 助手回复中的代码块右上角有 **复制** 按钮。
10. 遇到 `approval.request` 时在卡片上选择 **允许 / 拒绝**。
11. 运行中右下角按钮变成 **停止**（同一个按钮），也可执行 **AgentBox: Cancel Turn**。
12. 顶栏 **＋** 新建会话，**⚙** 打开内嵌设置浮层（不离开对话）。
13. 顶栏下方是 **会话标签栏**：点击切换会话；**长按标签上的 `×` 约 0.65 秒**，
    按钮外圈会走一圈进度，松手前完成才会关闭。每个会话有独立 transcript、token 统计、
    Codex thread 和独立的 `codex app-server` 进程。同一时刻只允许一个会话运行，
    切换前需先停止当前 turn。会话保留在扩展内存中，Reload 窗口后清空。
14. 顶栏 **⧉**、视图标题栏菜单或命令 **AgentBox: Open in Editor** 把同一个聊天
    打开为编辑器标签页；编辑器标签页可以像普通文件一样拖动、拆分到其他编辑器组。
15. 顶栏 **✦** 打开技能抽屉：左侧按“全部 / 本地 / 服务器 · 分组”分类，右侧勾选 local/optional skill，required 默认勾选且不可取消；
    抽屉底部可直接 **新建 / 打开目录 / 上传 / 同步远程**，不离开对话。变更在下一条 prompt 生效。

### 4.1 设置浮层

⚙ 会弹出固定高度的设置浮层，左侧为竖向分类菜单（模型 / Skill / 高级），右侧内容独立滚动；修改后点击 **保存**：

- Runtime：`codex` / `fake`
- 任务模式：`simple` / `code` / `research`
- Provider / 模型 / Base URL / API Key
- 推理强度：`low` / `medium` / `high`
- 审批策略：`on-request` / `untrusted` / `never`
- Skill Server：URL / Token / 自动同步 / required 缺失策略 / 本地目录
- Advanced：Codex 命令 / 额外指令

保存会写入工作区设置并重置当前会话。

- **API Key** / **Server Token** 只写入 SecretStorage，不会回传到 Webview；
- 留空表示保持已保存的值；点 **清除** 后保存会删除；
- 旧命令 `AgentBox: Set API Key` / `AgentBox: Set Skill Server Token` 仍保留为兼容入口。

### 4.2 活动时间线

**输入框上方**固定显示当前 turn 的活动时间线，展开高度 80px，可折叠到 28px：

- **思考**：从 turn 开始/工具结束到首个文本 token 的区间；
- **生成**：收到 `text.delta` 后的文本输出区间；
- **工具**：每次 `tool.start → tool.end`，绿色；失败变红；
- 审批等待不单独占泳道，包含在思考区间里；
- hover 显示类型、名称/命令摘要、耗时、状态；
- 点击工具 bar：滚动到对应处理步骤并高亮；命令步骤可再点击打开临时编辑器标签；
- 右侧小按钮 **▾ / ▸** 折叠/展开，状态会记住；
- 统计区用对应颜色的色块 + 数字表示，不再写文字标签；
- 时长旁显示 token 用量 `本轮 / 会话总计`（Codex 真实用量；其他 runtime 不显示）；
- 横向按耗时比例铺满，bar 高度固定；仅保留当前 turn，下一轮开始时重置；
- turn 结束后保留最终结果，直到新建会话或设置重置。

实现：`extension/src/webview/timeline.ts`（纯模型）+ `chat.ts` 渲染，无图表库依赖。

### 4.3 处理过程与思考

assistant 消息按时间顺序显示 **处理过程**：思考、工具、中间生成会放在同一个过程容器里；
最终回答单独放在容器下方并保持展开。

**思考** 区块：

- 优先使用 `item/reasoning/summaryTextDelta`（summary）；
- provider 不返回 summary 时，回退到 `item/reasoning/textDelta`（raw），并标记“原始”；
- 推理期间展开，流式显示纯文本（不跑 Markdown 渲染）；
- 推理完成或首个正文 token 到达后自动折叠为 `思考 · 12.3s · 1.2k 字`；
- 点击标题可重新展开/折叠；
- 按 100ms 批量更新，session 事件日志只保留最终内容并限制长度；
- 可用 `agentbox.codex.reasoningDisplay = auto | summary | raw | off` 控制。

**工具** 行显示名称/摘要/耗时/状态，完成后折叠；命令执行显示为
`工具 PowerShell`，点击在临时编辑器标签中查看完整命令和输出（同时写入 `AgentBox Chat`）。  
**中间生成** 折叠为 `生成` 行；最后一个生成块作为最终回答，保持在过程下方展开。

### 4.4 如何触发审批

审批由 Codex 根据 `approvalPolicy` 发起：

1. 在设置浮层把 **审批策略** 改为 `untrusted`（每条命令都询问），保存。
2. 发送类似：`用 PowerShell 运行 Get-ChildItem，并告诉我输出`。
3. Codex 会发出 `approval.request(commandExecution)`，侧边栏出现 **允许 / 拒绝** 卡片。
4. 选择拒绝后，命令不会执行，时间线的命令 bar 会变红；选择允许则继续。

说明：

- `on-request`（默认）只在 Codex 判断需要时询问，普通工作区内编辑可能不触发。
- `never` 不发起审批。
- workspace 外写文件、需要提升权限的命令通常会触发 `commandExecution` 审批。
- 有审批时先不要关闭侧边栏；审批卡会一直等待你的决定。

### 命令

| 命令 | 作用 |
|---|---|
| `AgentBox: Open Chat` | 打开编辑器标签页（默认入口，可拖动/拆分） |
| `AgentBox: Open in Editor` | 把聊天打开为可拖动/拆分的编辑器标签页 |
| `AgentBox: Focus Sidebar` | 聚焦活动栏里的 AgentBox 侧边栏视图 |
| `AgentBox: Settings` | 打开内嵌设置浮层 |
| `AgentBox: Skills` | 查看/启用/停用/上传/删除 Skill |
| `AgentBox: Create Skill` | 创建本地 Skill 模板 |
| `AgentBox: Open Skills Folder` | 打开本地 Skill 固定目录 |
| `AgentBox: Validate Skill` | 校验本地 Skill |
| `AgentBox: Upload Skill` | 上传本地 Skill 到 Registry（pending） |
| `AgentBox: Sync Remote Skills` | 同步 approved/required 远程 Skill |
| `AgentBox: Set Skill Server Token` | 存 Skill Registry token 到 SecretStorage |
| `AgentBox: Skill Settings` | 打开 Skill 相关设置 |
| `AgentBox: Run Turn` | 降级入口：OutputChannel + 模态审批 |
| `AgentBox: Cancel Turn` | 取消侧边栏或降级入口中的活动 turn |
| `AgentBox: Show Output` | 打开 `AgentBox Chat` 日志通道（完整 tool 明细） |
| `AgentBox: Set API Key` | 存入 SecretStorage |
| `AgentBox: Clear API Key` | 清除当前 provider 的 key |
| `AgentBox: Restart Runtime` | 释放并重建 runtime（修改设置后） |

---

## 5. 安全设计

- Webview CSP：`default-src 'none'`；脚本带 nonce；样式/图片只允许扩展资源与 `data:`。
- Markdown 由 `marked` 渲染后经 `DOMPurify` 消毒，并显式禁止 `iframe/style/img/form` 等标签；
  链接只允许 `http(s)`/`mailto`，点击交给扩展宿主 `vscode.env.openExternal`。
- 密钥只存在于扩展宿主 / SecretStorage，永不下发到 webview。
- 审批卡只是 UI；最终 `resolveApproval` 由扩展宿主按当前活动 turn 校验。
- 工具完整参数/输出只写入本地 `AgentBox Chat` 输出通道，webview 只显示摘要。
- 文件 chip 只能打开工作区内的相对路径；`..`、绝对路径、符号链接逃逸被拒绝。
- 文件 watcher 只在 turn 运行时上报 `file.changed`，并忽略 `.git`、`node_modules`、`dist`、`.probe`。

---

## 6. 已知限制（UI-1）

- 支持多会话切换/新建/关闭，但会话仅保存在扩展内存中；Reload 后清空，没有历史列表/重试按钮（UI-2）。
- 每个会话各自持有一个 `codex app-server` 进程；会话未首次发送 prompt 前不会启动进程，关闭会话或所有 webview 都关闭时释放。
- 大量会话会增加内存占用；每个会话会保存 UI 事件用于切换/编辑器面板回放，长会话回放会变慢。
- 同一时刻只允许一个会话运行；切换会话前必须停止当前 turn。
- 编辑器标签页与侧边栏共享同一个会话和事件流；关闭所有 webview（侧边栏和编辑器标签页）会释放 runtime，重新打开时 transcript 可回放，但模型 thread 上下文需要重新建立。
- diff 仅在工具卡中展示 Codex `fileChange` 的 patch 文本；原生 diff 在 UI-2。
- shell 明细不在聊天中展开，完整参数/输出使用 **AgentBox: Show Output** 查看。
- `file.changed` 通过 VS Code watcher 兜底 shell 写文件；只覆盖当前工作区，且只在该 turn 运行时上报。
- 命令执行（`commandExecution` / `run_shell`）不生成聊天卡片，只出现在时间线和日志里。
- token 用量来自 Codex 的 `thread/tokenUsage/updated`；FakeRuntime 或其他不提供该事件的 runtime 不显示。
- 项目指令只读取 workspace 根目录，不支持嵌套 `AGENTS.md`。
- Skill 的 on-demand 触发（路径/关键词）尚未实现；目前按 `activation=always` 或 `skills.enabled` 注入。
- 远程 Skill 在扩展激活/手动同步时拉取；同步后需要下一条 prompt 才重建会话并生效。
- Skill Registry MVP 使用静态 token + 文件系统存储；生产应换 OIDC、TLS、备份和审计轮转。
- 文件策略只在审批阶段生效；不请求审批的命令无法被拦截，仍需沙箱/ACL 做硬限制。
- 循环检测只基于工具失败；不检测“成功但低效”的重复调用。
- 任务 profile 是静态预算；不会根据任务复杂度自动切换，需要手动选择或在设置中覆盖 limits。
- 时间线只保留当前 turn；LLM 区间是按工具调用空档推导的，不是模型 API 的精确调用边界。
- 时间线使用 Webview 收到的消息时间，和 runtime 内部时间可能有毫秒级差异。
- 固定第一个 workspace folder；切换工作区会重建会话并清空面板。
- 上下文按字符预算截断（文件 12k、选区 8k），不是精确 token 计数。
- 进程崩溃后不自动重连；执行 **Restart Runtime** 或重新发送。
- M7（OpenCode）暂缓；`agentbox.runtime` 只有 `codex`/`fake`。
- 公网模型属于显式 opt-in；生产应使用内网模型并做数据分级/审计。
