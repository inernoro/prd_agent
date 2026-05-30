| feat | prd-api | MarkdownSectionExtractor 加 maxScanChars 参数（默认 6000，约 100-150 行），限定只扫方案 md「文档头」抽应用/业务模块章节原话，避免抓到正文中后段的同名章节 |
| feat | prd-admin | 「我的最近方案」每条卡片加垃圾桶删除按钮；点击后 window.confirm 二次确认（带方案标题 + 提交时间），确认后调 DELETE /api/project-route-agent/plans/{id}；删除当前选中方案会同步清空右侧分析视图 |
