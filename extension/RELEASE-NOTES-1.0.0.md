# AgentBox 1.0.0 Release Notes

**产物：** `agentbox-1.0.0.vsix`

首个 `1.0.0` 整合包，汇总 `0.4.4` → `0.4.5` 的更新内容。功能与 `0.4.5` 一致，版本号按整合发布提升。

## 0.4.4：Webview 布局

- 移除顶部独立 Header 和 “AgentBox” 文字，品牌标记合并到会话标签栏；
- 会话标签栏上移到最顶部，**新建会话** 放在顶部同一行；
- 移除“在编辑器中打开”按钮（命令与状态栏入口保留）；
- 移除底部“空闲 / 运行中”状态文字；
- 发送/停止按钮合并到 Chat 输入框同一栏；
- 活动时间线默认折叠；
- 会话标签支持**双击重命名**。

## 0.4.5：图标

- 活动栏视图容器图标改为 `media/icons/agentbox.svg`；
- 新标记为低饱和冷色系「石墨灰工具盒 + 蓝/青/浅灰三块拼图」，替代原对话气泡；
- 盒体为深石墨灰，配钢灰盒沿与青色细线，避免玩具感；
- 编辑器标签页（Open in Editor / 拖动聊天面板）设置 `iconPath`，不再显示默认文件图标；
- 视图 `Chat` 图标同步指向新文件；
- 根 README 顶部加入同一图标作为项目 Logo（96×96）；
- 移除旧的 `media/agentbox.svg`。

## 安装

```bash
code --install-extension agentbox-1.0.0.vsix --force
```

安装后执行 **Developer: Reload Window**；活动栏图标有进程级缓存，必要时完全退出 VS Code 再启动。

## 已知限制

- 会话 transcript 仅保存在扩展内存，Reload 后清空；
- 重命名只修改当前会话标题，不影响 Codex thread；
- Remote knowledge proposal/review API 仍待实现；
- Activity Bar 图标的最终显示效果取决于 VS Code 主题渲染，编辑器标签页保留彩色；
- Knowledge 暂无 per-collection ACL 和 embedding/hybrid。
