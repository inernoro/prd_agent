| fix | cds | 修复上手向导步骤 03 在窄屏没有前进出口——弹窗高度链在「只藏不卸」的包裹层断掉，面板长成内容自然高（1009px > 视口 844px），「确认这些技能」被裁在屏幕外且全链无可滚容器 |
| fix | cds | 窄屏底栏改两行排布，主操作独占满宽，不再被次要的「打开技能库」压过 |
| test | cds | 新增 scripts/agent-starter-mobile-probe.mjs：真浏览器量四档窄屏下向导每一步主操作的 rect，接进 cds.yml 每个 PR |
| ops | cds | cds.yml 补 Chromium 安装与窄屏可达性判据步骤 |
