| fix | cds | 修复落地页底部 chips 手机端参差换行：改为整齐两列卡片网格 + 信任行竖排 |
| fix | cds | 修复左下角更新徽章长文案在手机端溢出屏幕、操作按钮够不到：限宽 + 文案截断 + min-w-0 链 |
| fix | cds | 修复数据库工作台（MySQL/Mongo 的 ResourceWorkbenchModal）手机端窗格重叠、结果区塌陷：< lg 切换 flex 自然流堆叠 + 模态 body 可竖滚，desktop 保持填满布局 |
| fix | cds | 修复加载页（LoadingPagesTab）固定两列网格在窄屏溢出：手机单列、`lg:` 恢复两列 |
| fix | cds | 修复项目列表卡片底部状态行在手机端裁切（容器在线/构建率被截）：手机隐藏 production 前缀与「次构建/时」，保「运行中·容器在线·CPU」完整 |
| polish | cds | 项目设置/系统设置的横向 tab 条手机端加右侧渐隐，提示可横滑（替代下一个 tab 被硬切） |
| polish | cds | 项目卡片技术栈图标 dock 手机端缩小节点 + `safe center`/可滑，修复第 5 个图标被切半 |
| rule | cds | 新增 `mobile-layout-fallback.md`：desktop-fill 必须配 mobile-flow 兜底，归因并防止富面板手机端不可用 |
