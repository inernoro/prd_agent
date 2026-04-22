| fix | prd-admin | 修复周报 Agent「团队周报」从详情页返回时周次/团队/视角被重置为当前周的问题（改用 URL search params 做 SSOT） |
| feat | prd-admin | 周报 Agent 详情页新增左侧本周成员列表，支持在不返回列表的情况下高效切换查看同团队同周的其他周报 |
| feat | prd-api | 周报评论新增编辑接口 PUT /reports/:id/comments/:commentId，作者或管理员可改 |
| feat | prd-admin | 周报评论支持作者/管理员直接编辑（悬停笔形图标内联改、⌘↩ 保存、已编辑角标） |
| fix | prd-api | 修复周报模板管理严重的数据隔离缺陷：列表/详情按可见性过滤（系统 ∪ 自己 ∪ 所在团队），更新/删除强制作者权属校验；系统模板不可修改 |
| feat | prd-api | 周报模板"默认"概念拆解：IsDefault 仅保留系统级语义，新增个人偏好集合 user_report_template_preferences + GET/PUT/DELETE my-default 接口；seed 接口支持一键迁移历史 IsDefault=true 到对应用户偏好 |
| feat | prd-admin | 周报模板管理 UI 重做：scope 徽章（系统/我创建/团队/其他）、创建人展示、非作者隐藏编辑删除、每卡片"设为我的默认"、新建周报时自动预填个人默认模板 |
| feat | prd-api | 周报模板支持多团队关联 + 团队默认：ReportTemplate 新增 TeamIds / DefaultForTeamIds；一个团队全局只能被一个模板关联（写入时静默接管）；新增 GET /templates/team-default?teamId=X；seed 接口叠加单字段 TeamId → 多字段迁移 |
| fix | prd-api | 模板管理权限收窄：只有任一团队的 Leader/Deputy 可创建/修改/删除；系统权限 ReportAgentTemplateManage 不再提供跨团队后门；系统模板不可改 |
| feat | prd-admin | 模板管理入口收窄：SettingsPanel 对非 Leader/Deputy 隐藏"模板管理"菜单；Dialog 改为多团队多选 chips + 每团队星标切换为该团队默认；新建周报时选团队后联动拉取团队默认模板（优先级：团队默认 > 我的默认 > 系统默认） |
