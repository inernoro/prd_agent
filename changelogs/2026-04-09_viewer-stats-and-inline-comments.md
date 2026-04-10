| feat | prd-api | 知识库新增观察者统计：`document_store_view_events` 集合 + 埋点端点（log/leave/list），支持同一用户多次访问、匿名访客 session token、停留时长 |
| feat | prd-api | 知识库新增划词评论：`document_inline_comments` 集合 + CRUD 端点；文档正文更新时基于 SelectedText + 上下文前后 50 字的重锚定算法（active / orphaned 状态） |
| feat | prd-admin | 新增 `useViewTracking` hook：进入文档时埋点 + visibilitychange/beforeunload 发 sendBeacon 补时长，作用于 DocBrowser 和 LibraryDocReader 两个 viewer |
| feat | prd-admin | 知识库详情页新增「访客」按钮，打开 ViewersDrawer 显示总访问量 / 独立访客 / 总停留时长 + 最近 50 条访问时间线 |
| feat | prd-admin | DocBrowser 文档阅读时支持划词评论：选中正文后浮现"添加评论"按钮，点击打开 InlineCommentDrawer，支持发表评论、定位引用原文、删除评论；文档更新后失锚评论单独分组展示 |
