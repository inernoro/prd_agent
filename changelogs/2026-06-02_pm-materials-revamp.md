| feat | prd-admin | 项目「资料」三模块改版为全宽卡片列表页：周报(关键词/来源/作者/排序筛选)、会议纪要(关键词/时间范围/参会人/排序筛选)、知识库分「知识文档/成员作品」子视图；卡片含摘要/徽章/相对时间，点击进详情，编辑保留原 Markdown 编辑器 |
| feat | prd-admin | 成员网页托管作品列表：封面/可见性徽章(公开·未公开)/浏览数/成员/相对时间，支持按成员·可见性·关键词筛选，点击新标签打开访问 |
| feat | prd-api | 项目成员作品聚合放开可见性限制：新增 IHostedSiteService.ListAllByUserIdAsync(公开+私有)，member-sites 端点改用之并纳入观察者，返回 visibility/cover/viewCount/tags/updatedAt —— 成员未公开的托管站点在项目空间内也可见可访问(站点文件按 URL 直达，Visibility 仅控制公开页是否列出) |
