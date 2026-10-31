# AgentBox VS Code (UI-1)

> **UI-1**：侧边栏聊天面板（Webview Sidebar）+ 真实 Codex app-server。
> 流式文本、思考/生成动画、工具卡片、内联审批、Stop、当前文件/选区上下文、
> Markdown 分级渲染（标题/列表/表格）、代码块一键复制；
> 用户消息右对齐、助手回复左对齐，带角色标签与分隔线。
> 头部不显示 runtime/model；点击右上角 **⚙** 或执行 **AgentBox: Settings**
> 打开内嵌设置浮层（Runtime / Provider / 模型 / Base URL / 审批策略 / limits），不离开对话。
> 输入框自动增高，发送与取消合并为右侧同一个图标按钮。
> 输入框上方固定显示活动时间线（思考 / 生成 / 工具三条泳道，失败工具变红，可折叠）。
> 任务模式 simple / code / research 控制步数与超时；重复工具失败会自动停止本轮。
> 命令执行不进入对话，只出现在时间线；完整明细写入 **AgentBox Chat** 输出通道。
> Codex 默认附带 Windows/PowerShell 与文件卫生提示词，避免生成 patch/临时脚本/浏览器 profile。
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
npm test           # 62 个测试（controller / settings / chat-view / timeline / context / webview-ui / file-policy / project-instructions / loop-detector / task-profile / bundle）
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
| `agentbox.codex.permissions` | `:workspace` |
| `agentbox.codex.autoSetupSandbox` | `true` |
| `agentbox.codex.extraInstructions` | 空（追加到内置提示词） |
| `agentbox.files.denyWrite` | `.chrome-profile`、`*.patch`、`dom.txt`、`preview.png` 等（glob 数组） |
| `agentbox.codex.home` | 空 = 扩展 global storage |
| `agentbox.envFile` | 空 |
| `agentbox.limits.turnTimeoutMs` | 可选覆盖；空 = 使用任务 profile |
| `agentbox.limits.maxSteps` | 可选覆盖；空 = 使用任务 profile |

如果 codex 不在 PATH，把 `agentbox.codex.command` 设为绝对路径，例如：

```json
{
  "agentbox.codex.command": "D:\\path\\to\\codex.exe",
  "agentbox.limits.maxSteps": 24
}
```

> DeepSeek + Windows 下 `apply_patch` 可能多次失败，建议 `maxSteps` 设为 24–30。

### 3.2 API key

优先级：

1. `AgentBox: Set API Key`（VS Code SecretStorage，推荐）
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

- **Windows 环境**：Windows 11 + Windows PowerShell 5.1（没有 `pwsh`）；
  使用 PowerShell 命令；写文件指定 UTF-8，避免 `>` 产生 UTF-16。

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

| Profile | 适用 | maxSteps | maxToolCalls | 超时 |
|---|---|---|---|---|
| `simple` | 静态 HTML/CSS/单文件 | 8 | 10 | 90s |
| `code` | 常规编码 | 20 | 30 | 180s |
| `research` | 研究/多步任务 | 30 | 40 | 300s |

`agentbox.limits.maxSteps` / `turnTimeoutMs` 是可选覆盖；显式设置时优先于 profile。

**循环检测**：

- 相同 tool name + args 连续失败 2 次 → 停止本轮；
- 连续工具失败 4 次 → 停止本轮；
- 成功调用会重置失败计数；
- 命中后 UI 显示“检测到工具循环，已停止本轮”，runtime 走 abort/cancel。

可在设置中关闭或调整阈值。循环检测只统计 `tool.end(ok=false)`，不会因为正常重复测试而误停。

---

## 4. 使用侧边栏

1. 安装 VSIX 并重载窗口。
2. 打开一个**临时工作区**（不要用生产仓库做公网模型冒烟）。
3. 点击活动栏的 **AgentBox** 图标，或执行 **AgentBox: Open Chat**。
4. 在输入框输入任务，按 **Enter** 发送（**Shift+Enter** 换行）；输入框随内容自动增高。
5. 打开/切换文件时，**当前文件** 默认选中（带 ✓）；
   选中新的文本区间时，**选区** 也默认选中；两者都可点击取消。
6. 对话右侧中间有 **问题导航条**：每个用户问题一个圆点，点击跳转并高亮，
   hover 显示前 20 字摘要；最多只显示当前位置附近的 10 个问题，滚动时窗口自动滑动。
7. 运行时会显示 **思考中… / 生成中… / 执行工具… / 等待审批…** 指示；
   长时间思考会附加已用秒数，状态栏有脉冲点。
8. 命令执行不再进入对话流，只在输入框上方的时间线显示，完整参数/输出写入 `AgentBox Chat`；
   点击时间线上的命令 bar 可直接打开日志。文件修改等其他工具仍显示卡片。
9. 助手回复中的代码块右上角有 **复制** 按钮。
10. 遇到 `approval.request` 时在卡片上选择 **允许 / 拒绝**。
11. 运行中右下角按钮变成 **停止**（同一个按钮），也可执行 **AgentBox: Cancel Turn**。
12. 顶栏 **＋** 新建会话，**⚙** 打开内嵌设置浮层（不离开对话）。

### 4.1 设置浮层

⚙ 会弹出居中设置浮层，覆盖在对话上且不改变原布局；修改后点击 **保存**：

- Runtime：`codex` / `fake`
- 任务模式：`simple` / `code` / `research`
- Provider / 模型 / Base URL
- 审批策略：`on-request` / `untrusted` / `never`

保存会写入工作区设置并重置当前会话。API Key 仍通过命令面板
**AgentBox: Set API Key** 存入 SecretStorage，不会进入 Webview。

### 4.2 活动时间线

**输入框上方**固定显示当前 turn 的活动时间线，展开高度 80px，可折叠到 28px：

- **思考**：从 turn 开始/工具结束到首个文本 token 的区间；
- **生成**：收到 `text.delta` 后的文本输出区间；
- **工具**：每次 `tool.start → tool.end`，绿色；失败变红；
- 审批等待不单独占泳道，包含在思考区间里；
- hover 显示类型、名称/命令摘要、耗时、状态；
- 点击工具 bar：命令执行打开 `AgentBox Chat` 日志；其他工具滚动到对应工具卡并高亮；
- 右侧小按钮 **▾ / ▸** 折叠/展开，状态会记住；
- 统计区用对应颜色的色块 + 数字表示，不再写文字标签；
- 时长旁显示 token 用量 `本轮 / 会话总计`（Codex 真实用量；其他 runtime 不显示）；
- 横向按耗时比例铺满，bar 高度固定；仅保留当前 turn，下一轮开始时重置；
- turn 结束后保留最终结果，直到新建会话或设置重置。

实现：`extension/src/webview/timeline.ts`（纯模型）+ `chat.ts` 渲染，无图表库依赖。

### 4.3 如何触发审批

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
| `AgentBox: Open Chat` | 聚焦侧边栏聊天面板 |
| `AgentBox: Settings` | 打开内嵌设置浮层 |
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

- 单会话；没有 transcript 持久化，Reload 后清空（UI-2）。
- 没有多会话、历史列表、重试按钮。
- diff 仅在工具卡中展示 Codex `fileChange` 的 patch 文本；原生 diff 在 UI-2。
- shell 明细不在聊天中展开，完整参数/输出使用 **AgentBox: Show Output** 查看。
- `file.changed` 通过 VS Code watcher 兜底 shell 写文件；只覆盖当前工作区，且只在该 turn 运行时上报。
- 命令执行（`commandExecution` / `run_shell`）不生成聊天卡片，只出现在时间线和日志里。
- token 用量来自 Codex 的 `thread/tokenUsage/updated`；FakeRuntime 或其他不提供该事件的 runtime 不显示。
- 项目指令只读取 workspace 根目录，不支持嵌套 `AGENTS.md`。
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
