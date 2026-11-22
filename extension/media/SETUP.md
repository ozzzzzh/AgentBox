# AgentBox 安装与配置指引

> AgentBox VSIX 包含 Code agent 的 **adapter**，但不包含 Codex CLI 本体。
> 还需要单独安装 Codex，并配置模型 API。

## 1. 配置 LLM Provider 与 API Key

打开 AgentBox Chat，点击右上角 **⚙** → **模型**：

- Provider：例如 `deepseek`
- 模型：例如 `deepseek-flash`
- Base URL：OpenAI-compatible 地址
- API Key：只写入 VS Code SecretStorage

保存后，AgentBox 会使用该 provider 启动 Codex。

## 2. 安装 Code agent（Codex CLI）

当前兼容基线：

```text
codex-cli 0.165.0
```

### Windows

```powershell
npm install -g @openai/codex@0.165.0
codex --version
```

如果 `codex` 不在 PATH，把完整路径填入：

```json
{
  "agentbox.codex.command": "C:\\path\\to\\codex.exe"
}
```

### macOS

```bash
npm install -g @openai/codex@0.165.0
codex --version
```

Homebrew / npm 常见路径：

```text
/opt/homebrew/bin/codex
/usr/local/bin/codex
~/.npm-global/bin/codex
```

如果不在 PATH：

```json
{
  "agentbox.codex.command": "/opt/homebrew/bin/codex"
}
```

## 3. 自动检测 Codex 路径

执行 **AgentBox: Detect Codex CLI**，或在 AgentBox Chat 顶栏点击 **?** 查看本指引。

扩展会搜索 PATH 和常见安装目录，并自动写入 `agentbox.codex.command`。

手动验证：

```bash
codex --version
codex app-server --listen stdio://
```

第二条命令应停在等待 stdin 的状态；如果立即退出，复制错误信息排查。
Windows 下如果 `codex` 是 npm 全局安装，路径通常是 `codex.cmd`。

## 4. 可选：Skill / Knowledge Server

Skill 和 Knowledge 服务不打包在 VSIX 中，需要单独启动：

```bash
cd skill-server
npm run dev:seed

cd knowledge-server
npm run dev
```

扩展设置 → Skill / 知识中填写对应 URL。
本地 Knowledge 可以不启动 server，使用扩展 globalStorage。

## 5. 新设备快速检查

- `codex --version` 正常；
- VS Code 在安装 Codex 后已 Reload/重启；
- `agentbox.codex.command` 指向真实可执行文件；
- LLM API Key 已保存；
- 首次 Windows 运行可能需要 Codex sandbox 初始化。

如果出现：

```text
failed to write json-RPC request process is not running
```

通常是 Codex CLI 未安装、路径错误、版本不兼容，或 Remote/WSL 环境里没有安装 Codex。
