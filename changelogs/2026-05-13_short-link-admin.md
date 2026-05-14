| feat | prd-api | 新增管理员短链管控：GET /api/admin/short-links（跨用户列表 + targetType/search 筛选）、POST /admin/short-links/:seq/revoke（强制吊销，同时让 /s/{seq} 和 /s/wp/{token} 失效）、POST /admin/short-links/repair-counter（counter 同步到 max(seq)） |
| feat | prd-api | 新增 short-links.manage 管理员权限（默认 admin 角色继承） |
| feat | prd-api | ShortLinkService 增加 Seq 自愈：unique(Seq) 撞车时最多重试 16 次跳过已占用号段，仍失败则触发 counter 自动修复 |
| fix | prd-api | ShortLinkCounter._id 映射 bug（Key→Id），运维误删 counter 后能通过 RepairCounterAsync 一键恢复 |
| feat | prd-admin | 系统设置新增「分享短链」管理 Tab：表格视图（seq/类型/标题/作者/访问/浏览/创建时间/token）、按 targetType 筛选、按 seq 或 token 搜索、强制吊销、修复 counter |
| feat | prd-admin | 网页托管「分享管理」对话框每行展示 #seq 徽章（老分享显示「长链」徽章） |
