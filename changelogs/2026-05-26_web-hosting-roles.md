| feat | prd-api | 网页托管团队共享细分 owner/editor/viewer 三角色：viewer 只读、editor 可编辑/重传/建分享、删除收敛到文件夹 owner 或站点创建者（细化决策10「成员全员平等」，知识库不受影响） |
| feat | prd-api | 新增 WebHostingPermission 纯策略类（角色继承解析 + 跨团队取最宽松 + 能力矩阵）+ TeamMember.WebHostingRole 字段 + TeamService.GetMyWebHostingTeamRolesAsync |
| test | prd-api | 新增 WebHostingPermissionTests，纯单测覆盖角色继承/取最宽松/站点角色解析(隔离)/能力矩阵 |
