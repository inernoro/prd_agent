| feat | prd-admin | 团队邀请改为直接多选添加（UserSearchSelect 风格），移除邀请链接 |
| feat | prd-admin | 团队成员新增「退出团队」按钮（非 owner 成员可自行退出） |
| feat | prd-admin | TeamScopeBar 邀请弹窗改为直接搜索+添加用户 |
| feat | prd-api | 解散团队时 owner 的托管站点自动移入「{团队名} 团队解散文件夹」 |
| fix | prd-admin | TeamSpaceHeader 移除「邀请协作（复制链接）」按钮，改为「邀请成员」直达管理面板「添加成员」tab |
| feat | prd-admin | TeamManagerPanel 支持 initialTab/initialTeamId props，外部入口可指定初始展示 |
| refactor | prd-admin | 知识库分享阅读页（/s/lib/:token）改为复用 DocBrowser，删除 1225 行重复实现的 LibraryShareReader |
