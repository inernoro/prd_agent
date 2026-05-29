| feat | prd-api | 网页托管团队共享细分 owner/editor/viewer 三角色：viewer 只读、editor 可编辑/重传/建分享、删除收敛到文件夹 owner 或站点创建者（细化决策10「成员全员平等」，知识库不受影响） |
| feat | prd-api | 新增 WebHostingPermission 纯策略类（角色继承解析 + 跨团队取最宽松 + 能力矩阵）+ TeamMember.WebHostingRole 字段 + TeamService.GetMyWebHostingTeamRolesAsync |
| test | prd-api | 新增 WebHostingPermissionTests，纯单测覆盖角色继承/取最宽松/站点角色解析(隔离)/能力矩阵 |
| feat | prd-api | 团队成员网页托管角色管理端点 PUT /api/teams/{id}/members/{userId}/web-hosting-role（仅团队管理员，团队创建者恒 owner）；GET /api/teams/{id} 返回 webHostingRoles 映射 + myWebHostingRole；web-pages 团队列表返回 myWebHostingRole |
| feat | prd-admin | 团队管理面板新增成员「网页托管角色」选择器（owner/editor/viewer）；网页托管团队视图按角色隐藏 viewer 的编辑/删除/分享/设公开入口 + 批量操作门控 + 顶部「我的权限」角标 |
