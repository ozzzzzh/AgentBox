# AgentBox 0.4.4 Release Notes

**产物：** `agentbox-0.4.4.vsix`

## Webview 调整

- 移除顶部独立 Header 和 “AgentBox” 文字，品牌图标合并到会话标签栏；
- 会话标签栏上移到最顶部，**新建会话**放在顶部同一行；
- 移除“在编辑器中打开”按钮（命令仍保留）；
- 移除底部“空闲 / 运行中”状态文字；
- 发送/停止按钮合并到 Chat 输入框同一栏；
- 活动时间线默认折叠；
- 会话标签支持**双击重命名**。

## 安装

```bash
code --install-extension agentbox-0.4.4.vsix --force
```

## 已知限制

- 会话仍只保存在扩展内存，Reload 后清空；
- 重命名只修改当前会话标题，不影响 Codex thread。
