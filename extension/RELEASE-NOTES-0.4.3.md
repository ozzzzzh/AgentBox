# AgentBox 0.4.3 Release Notes

**产物：** `agentbox-0.4.3.vsix`

## 新增

- Webview 安装向导：
  - 首次打开时检测 API Key / Codex；
  - 引导配置 LLM API；
  - 显示平台对应的 Codex 安装命令；
  - 自动检测并设置 Codex CLI 路径；
  - 完整安装文档入口。
- 顶栏 **?** 打开安装向导；**AgentBox: Setup Guide** 可重新打开。
- **AgentBox: Detect Codex CLI**：搜索 PATH / Homebrew / npm 常见路径。
- Knowledge 使用改为输入框 **知识** 勾选激活，默认关闭，避免不必要的 token 消耗。
- Knowledge 提案审核可选择 **发布到本地** 或 **发布到 Server**。
- 知识面板增加 **提案 / 本地知识 / Server 知识** 三个 Tab。
- 已拒绝的知识提案支持删除。
- Skill server 离线时跳过所有 remote skill（包括 cached required），仅使用 local skill。

## 修复

- 点击 Webview 输入框不再取消当前文件/选区上下文。
- 本地 Knowledge 可在不启动 server 的情况下发布和检索。

## 文档

- macOS 安装说明合并进根目录 `README.md`。
- 新增 `media/SETUP.md`，随 VSIX 提供安装与排查指引。
- 根 README 精简，架构调整为快速开始之后。
- 根 README 预留架构图占位，待补充最终架构图。

## 安装

```bash
code --install-extension agentbox-0.4.3.vsix --force
```

## 已知限制

- Remote 知识 proposal/review API 仍待实现。
- Knowledge 暂无 per-collection ACL 和 embedding/hybrid。
- Codex app-server 仍为 experimental，需 pin 兼容版本（当前基线 0.165.0）。
