| fix | prd-admin | 修复全站返回上一页异常：手机右滑/鼠标返回不再落到奇怪的导航页，新增 useSmartBack 统一智能返回 |
| fix | prd-admin | 移动端底部 TabBar 同级 tab 互切改为 replace，不再把导航页逐条压进浏览器历史 |
| fix | prd-admin | 模型管理/设置/开放平台/海鲜市场等页 tab 与筛选切换改为 replace，返回直接离开本页 |
| fix | prd-admin | 演讲创建/评审提交成功后跳详情改为 replace，返回不再回到空表单 |
| fix | prd-admin | 视觉/文学/工作流/评审/PM/知识库/渠道等十余处左上角返回按钮统一走智能返回（有历史弹栈，深链直达走兜底） |
| fix | prd-admin | LLM 日志/模型应用组页站内跳转由整页刷新改为 SPA navigate，不再重置路由历史 |
| fix | prd-admin | 新增 useHistoryBackedView：全屏级视图切换写入浏览器历史，右滑/浏览器返回先关详情回列表而非跳出页面 |
| fix | prd-admin | 百宝箱/知识库/周报/涌现/技能/缺陷/工作流执行 七处「列表进详情」接入历史同步，详情态可刷新可分享 |
| fix | prd-admin | 缺陷与知识库深链参数不再消费后抹掉，统一规范化为详情态 SSOT |
