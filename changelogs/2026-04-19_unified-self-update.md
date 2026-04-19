| refactor | cds | 合并两套 CDS 系统更新弹窗 —— 新增 cds/web/self-update.js 统一模块,`window.openSelfUpdateModal()` 由 index.html 和 project-list.html 共同加载;app.js `openSelfUpdate()` 和 projects.js `cdsOpenSelfUpdate()` 都退化为 1 行 thin wrapper 调 window 入口,齿轮菜单 / topology popover / cmd-k / 项目列表设置下拉 4 个入口收敛到同一条路径 |
| feat | cds | 统一弹窗汇集两套旧版本的优点: 组合框(可搜索 + 粘贴, 原 app.js 版) + 强制同步 hard-reset 按钮(原 projects.js 版) + 粘性底部工具栏(修复 image 1 底部按钮被截断的问题) + 健康检查轮询(CDS 重启后自动 reload) |
| feat | cds | 分支列表页 header 新增独立 🔄 按钮 (#selfUpdateBtn),点击直接打开统一系统更新弹窗 —— 对应用户反馈"原来有,后来在设置里面被删除掉了"(8f85488 删的 header shortcut 恢复),齿轮菜单里的入口同步保留以兼容肌肉记忆 |
| chore | cds | 清理遗留的 openComboDropdown / filterComboItems / selectComboItem / executeSelfUpdate 等只服务于旧 self-update 弹窗的辅助函数为空壳 retire stub,防止缓存客户端残留 onclick 触发 ReferenceError |
