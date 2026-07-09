| feat | prd-admin | 更新中心新增「热修复」子 tab，专列为他人上报缺陷所做的修复，含缺陷编号（可点击进缺陷详情）、修复 commit/PR、发布状态与验收链接 |
| feat | prd-api | ChangelogController 新增 GET /api/changelog/github-hotfixes，基于 DefectResolutionTrace 全历史返回热修复列表 |
| fix | prd-api | 热修复发布状态：短 commit sha 追踪先解析为完整 sha 再比对部署历史，避免短 sha 记录恒判为 unknown |
| fix | prd-api | 热修复发布状态：修复提交仍在 open PR（未进部署历史）且带 PR 号时按 pending 呈现，不再落灰色 unknown |
| fix | prd-admin | 缺陷详情 markdown 渲染修复溢出：长 URL/表格/代码块横向换行或滚动，不再撑破弹窗 |
| fix | prd-admin | 缺陷详情/评论超链接补 accent 颜色 + 下划线并在新标签安全打开（此前链接与正文同色不可辨） |
