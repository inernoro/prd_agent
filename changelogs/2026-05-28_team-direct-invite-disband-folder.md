| feat | prd-admin | 团队邀请改为直接多选添加（UserSearchSelect 风格），移除邀请链接 |
| feat | prd-admin | 团队成员新增「退出团队」按钮（非 owner 成员可自行退出） |
| feat | prd-admin | TeamScopeBar 邀请弹窗改为直接搜索+添加用户 |
| feat | prd-api | 解散团队时 owner 的托管站点自动移入「{团队名} 团队解散文件夹」 |
| fix | prd-admin | TeamSpaceHeader 移除「邀请协作（复制链接）」按钮，改为「邀请成员」直达管理面板「添加成员」tab |
| feat | prd-admin | TeamManagerPanel 支持 initialTab/initialTeamId props，外部入口可指定初始展示 |
| refactor | prd-admin | 知识库分享阅读页（/s/lib/:token）改为复用 DocBrowser，删除 1225 行重复实现的 LibraryShareReader |
| feat | prd-admin | DocBrowser 新增 sortMode prop（default/created-desc/updated-desc），分享页默认按创建时间倒序 |
| feat | prd-admin | LibraryShareViewPage 支持 URL ?entry={id} 指定默认选中，无指定时默认选最新创建条目 |
| feat | skill | 验收归档脚本生成的分享链带 ?entry={eid}，分享对象一打开就看到新报告 |
| refactor | prd-admin | 更新中心-周报 WeeklyReportsTab 改为复用 DocBrowser（appearance="cards" 保留双卡片布局），删除 ~200 行自实现的 list+content 渲染 |
| feat | prd-admin | DocBrowser 新增 appearance (inset/cards)、isEntryFresh、sidebarHeader 三个可选 prop，支持周报场景的双圆角卡片布局和自定义 NEW 徽章规则 |
