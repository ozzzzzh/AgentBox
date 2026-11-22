# AgentBox 0.4.5 Release Notes

**产物：** `agentbox-0.4.5.vsix`

## 图标

- 活动栏视图容器图标改为 `media/icons/agentbox.svg`；
- 编辑器标签页（Open in Editor / 拖动聊天面板）补上 `iconPath`，不再显示默认文件图标；
- 新标记为低饱和冷色系「石墨灰工具盒 + 蓝/青/浅灰三块拼图」，替代原对话气泡；
- 盒体为深石墨灰，配钢灰盒沿与青色细线，避免玩具感；
- 图标为多色 SVG，编辑器标签页按原色显示；
- 视图 `Chat` 的图标同步指向新文件；
- 移除旧的 `media/agentbox.svg`。

## 安装

```bash
code --install-extension agentbox-0.4.5.vsix --force
```

## 已知限制

- 活动栏图标的最终显示效果取决于 VS Code 主题渲染；编辑器标签页保留彩色。
- 如需替换，直接覆盖 `extension/media/icons/agentbox.svg` 后重新打包。
