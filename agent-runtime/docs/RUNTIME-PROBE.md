# Phase 0：运行时探测清单

> 目标：在写 adapter 之前，把 Codex/OpenCode 的版本、协议、事件、配置、遥测**实测一遍**。
> 把结果填回本文件；下一阶段的 adapter 以本文件为准，不靠猜测。

---

## 0. 环境记录

| 项 | 值 |
|---|---|
| 日期 | |
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.14.1 |
| 工作目录 | `D:\Tools\agentBox\agent-runtime` |
| Codex 版本 | |
| OpenCode 版本 | |
| LiteLLM baseURL | `http://172.22.26.117:8085/v1` |
| 模型 | `Qwen3-235B-A22B-Instruct-2507` / Qwen3-Coder（待确认） |

---

## 1. Codex app-server

### 1.1 安装与版本

```powershell
codex --version
codex --help
codex app-server --help
```

记录：

- 安装方式（npm / 二进制 / 其他）：
- 版本号：
- `app-server` 是否存在、是否标注 experimental：
- LICENSE/NOTICE 位置：

### 1.2 启动与握手

```powershell
codex app-server
```

记录：

- 传输方式（stdio / TCP）：
- 第一条消息/握手方法：
- 初始化参数：
- 会话创建方法：
- 发送用户消息方法：
- 中断方法：
- 关闭方法：

### 1.3 事件形状

跑一个最小任务（例如"读取 README.md 并总结"），记录原始通知：

- 文本增量：
- 工具调用开始/结束：
- 文件变更：
- turn 结束：
- 错误：
- 审批请求：

把**原始 JSON 样例**贴到下面（脱敏）：

```json
// 示例
```

### 1.4 模型配置（LiteLLM + Qwen）

记录配置文件位置与内容：

- `CODEX_HOME` / `config.toml` 路径：
- `model_provider`：
- `model_providers.<id>`：`base_url` / `env_key` / `wire_api`：
- 模型 id：
- 是否需要 `wire_api = "chat"`：
- 能否完全离线（除 LiteLLM）：

```toml
# 示例（以实际版本为准）
```

### 1.5 沙箱 / 审批

- 支持的模式（read-only / workspace-write / full-access）：
- 审批请求的触发条件：
- 审批响应格式：
- 默认值是否安全：

### 1.6 遥测 / 更新 / 登录

- 是否有遥测：
- 是否有自动更新检查：
- 是否要求登录/云账号：
- 关闭方式（配置/环境变量/防火墙）：
- 断网验证结果：

---

## 2. OpenCode server

### 2.1 安装与版本

```powershell
opencode --version
opencode --help
opencode serve --help
```

记录：

- 安装方式：
- 版本号：
- `serve` 参数（hostname/port）：
- LICENSE/NOTICE：

### 2.2 启动与健康检查

```powershell
opencode serve --hostname 127.0.0.1 --port 4096
```

记录：

- 默认端口：
- health endpoint：
- 是否只绑 localhost：
- 启动日志/就绪标志：

### 2.3 API / 事件

记录：

- 创建会话：
- 发送 prompt：
- 事件流（SSE / WebSocket / 轮询）：
- 事件类型/形状：
- 中断：
- 关闭：
- SDK（`@opencode-ai/sdk`）版本与用法：

原始样例（脱敏）：

```json
// 示例
```

### 2.4 模型配置（LiteLLM + Qwen）

记录：

- 配置文件位置（`opencode.json` / 环境变量）：
- provider 配置（`@ai-sdk/openai-compatible`）：
- baseURL / apiKey / model id：
- 工具调用是否正常：
- 能否完全离线（除 LiteLLM）：

```json
// 示例（以实际版本为准）
```

### 2.5 权限 / 审批

- 文件/命令权限模型：
- permission request 的形状：
- 响应方式：
- 默认值是否安全：

### 2.6 遥测 / 更新

同 Codex：记录遥测、更新检查、云登录、关闭方式、断网验证。

---

## 3. 模型冒烟（两个 runtime 都做）

任务：在临时目录放一个 `hello.txt`，要求 agent：

1. 读取文件；
2. 追加一行 `agent-ok`；
3. 运行 `git diff` 或 `Get-Content hello.txt`；
4. 用一句话总结。

记录：

| 指标 | Codex | OpenCode |
|---|---|---|
| 是否完成 | | |
| tool-call 合法率 | | |
| 步数 | | |
| 首 token 延迟 | | |
| 总耗时 | | |
| token（输入/输出） | | |
| 是否卡住/死循环 | | |
| 是否越权/意外命令 | | |
| 断网可运行 | | |

---

## 4. 决策门

- [ ] Codex 主、OpenCode 备维持不变
- [ ] 主备互换（原因：__________）
- [ ] 暂停 adapter，先解决模型（原因：__________）

结论：

```
（填写）
```

---

## 5. 待解问题

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | Codex app-server 是否 stable | adapter 维护成本 | |
| 2 | Codex + Qwen tool calling 是否可用 | 主备选择 | |
| 3 | OpenCode server API 是否稳定 | adapter 维护成本 | |
| 4 | 遥测能否完全关闭 | 保密合规 | |
| 5 | 内网是否有 Qwen3-Coder | 编码质量 | |
