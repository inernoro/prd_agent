| feat | prd-admin | 更新中心新增「热修复」子 tab，专列为他人上报缺陷所做的修复，含缺陷编号（可点击进缺陷详情）、修复 commit/PR、发布状态与验收链接 |
| feat | prd-api | ChangelogController 新增 GET /api/changelog/github-hotfixes，基于 DefectResolutionTrace 全历史返回热修复列表 |
| fix | prd-api | 热修复发布状态：短 commit sha 追踪先解析为完整 sha 再比对部署历史，避免短 sha 记录恒判为 unknown |
| fix | prd-api | 热修复发布状态：修复提交仍在 open PR（未进部署历史）且带 PR 号时按 pending 呈现，不再落灰色 unknown |
| security | prd-api | 热修复列表沿用缺陷可见性口径：无缺陷管理权限者只见自己提交/被指派缺陷的热修复，避免泄露他人缺陷编号/标题/提交人/验收链接 |
| fix | prd-api | 热修复判定为已发布时同步写回 DefectResolutionTrace.PublishStatus/NotifyStatus，让提交人复验通知能正常排队 |
| security | prd-api | 热修复端点补缺陷模块门：无 defect-agent.use（且非 manage/super）者返回空，不得绕过缺陷模块读取数据 |
| fix | prd-api | 热修复 pending 判定仅限仍 open 的 PR，避免已 merge/close 且 commit 超出日志窗口的旧追踪被误判为待发布 |
| fix | prd-admin | 缺陷详情 markdown 渲染修复溢出：长 URL/表格/代码块横向换行或滚动，不再撑破弹窗 |
| fix | prd-admin | 缺陷详情/评论超链接补 accent 颜色 + 下划线并在新标签安全打开（此前链接与正文同色不可辨） |
