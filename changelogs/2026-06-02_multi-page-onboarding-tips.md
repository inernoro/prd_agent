| feat | prd-admin | 网页托管/视觉创作/知识库/文学创作四个页面新增右下角「小技巧」本页完整新手指引锚点（data-tour-id） |
| feat | prd-api | DailyTips 新增四条本页教程 seed（webpages/visual/document-store/literary-page-guide，8-14 步），替换三条精简旧 seed |
| feat | prd-admin | 「小技巧」入口移到右上角带文字标签的常驻 pill（不再是右下角匿名图标）；进入任一有本页教程的页面自动开讲一次，未走完（点完最后一步）跨 session 会再弹，强制人人过一遍 |
| feat | prd-admin | 新增海鲜市场/智识殿堂/作品广场三页本页教程锚点 + seed；教程入口与 Spotlight 引导上移到 App 根挂载（全局唯一、跨任意路由含全屏编辑器不卸载），删除 FullscreenTipsDock 与 AppShell 内重复挂载 |
| feat | prd-api | DailyTips 新增 marketplace/library-landing/showcase 三条 page-guide seed |
| feat | prd-admin | 视觉/文学编辑器补 data-tour-id 锚点（visual-editor-*/literary-editor-*）；TipsDrawer 自动开讲匹配器区分列表路由与编辑器深层路由，CTA 已在目标路由内不再跳走 |
| feat | prd-api | DailyTips 新增 visual-editor/literary-editor page-guide（进入项目/文章编辑器后自动开讲），列表教程「贯通」到编辑器 |
| fix | prd-admin | 修正三处反馈：①分享/落地/登录/开发页不再挂教程入口（之前 /s/* 分享页误显示）②每条教程第 1 步从整页 root 改指向具体元素（高亮框不再框整屏看不出）③入口 pill z-index 50→300，确保各页右上角都在常规内容之上可见 |
