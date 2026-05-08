| feat | prd-admin | 海报编辑页新增「新建自动发布」入口：选工作流 + 填变量（博主id/视频个数）+ 选 presentationMode/templateKey/品牌色，支持立即执行 / 定时一次 / 循环 (Cron) 三种调度 |
| feat | prd-api | 新增 `/api/workflow-agent/schedules` CRUD 端点 + `WorkflowScheduleWorker` 后台轮询，按 once/cron 触发工作流；内置极简 5 字段 Cron 解析器 |
| feat | prd-api | WeeklyPosterPublisher capsule 的 templateKey/presentationMode/accentColor 现在支持 `{{var}}` 模板和 variables 兜底，让海报页对话框不必改工作流配置即可覆盖版式 |
| fix | prd-api | WeeklyPosterPublisher 找不到 items 字段时新增 TikHub raw 响应路径兜底（data.aweme_list / itemList / list / vlist 等），并在错误信息里列出顶层字段帮助用户排查 |
| feat | prd-admin | 横屏视频卡尺寸放大约 17%（feed-card 16:9 920→1100、ad-4-3 960→1120），并在 feed-card 模式给视频卡加 accent 色描边 + 顶部 4px 品牌色细带 + 有色光晕，让短视频卡看起来像「海报里嵌的视频」而不是「光秃秃的视频」 |
