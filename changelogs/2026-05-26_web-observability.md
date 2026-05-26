| feat | prd-api | 网页托管新增访客痕迹审计：SiteViewEvent 记录登录访客ID快照 + WebPageAnalyticsController（record-view + owner查访客名单，owner或团队成员可见） |
| feat | prd-api | 新增高级权限 web-pages.viewAll + AdminWebPagesController：跨用户查看全部托管网页、阅读量与访客记录 |
| feat | prd-api | 网页文件夹绑生成器 WebFolder + WebFolderController/Service：给文件夹绑定 Markdown 模板一键生成网页/知识库条目（skill 生成因依赖 LLM 调用链暂缓，先支持 Markdown 即时生成） |
| feat | prd-admin | 网页托管接入：卡片「访客」抽屉、工具栏「文件夹」管理器、访问即记录访客；新增「全部网页（高级）」审计页 /admin-web-pages |
| feat | prd-admin | 网页托管新增 data-tour-id 锚点（文件夹按钮/阅读量/卡片）+ 入库 onboarding 小技巧，进页面即可弹出教学 Tour |
| refactor | prd-api,prd-admin | 「分类」概念并入既有「文件夹」（Folder）：WebCategory→WebFolder、/api/web-categories→/api/web-folders、CategoryManager→FolderManager，消除分类与文件夹双概念冗余 |
