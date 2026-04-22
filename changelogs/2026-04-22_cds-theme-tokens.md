| fix | cds | Agent Key modal 代码块在白天模式不再纯黑（走 --bg-terminal token 而非硬编码 #0b0b10 fallback） |
| fix | cds | self-update modal 输入框/进度日志在白天模式正确显示（删除所有 var(--bg-base, #darkColor) 硬编码 fallback，token 在两个主题统一定义） |
| fix | cds | self-update 分支下拉点击不消失的 bug —— 选中后 input.focus() 触发 focus 监听重新展开，加 _suppressFocusOpen 标志拦截 |
| fix | cds | CDS 重启 overlay z-index 从 9000 提到 10050，不再被 self-update modal 遮挡 |
| fix | cds | 分支列表加载图标从左上角改为页面居中（grid-column: 1/-1 + min-height: 50vh） |
| docs | rules | 新增 .claude/rules/cds-theme-tokens.md，规定 token 必须双主题同步 + 禁止暗色 fallback + z-index 分层表 |
