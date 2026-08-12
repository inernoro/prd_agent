| fix | prd-admin | 站点卡「更多设置」补上提问设置入口，此前只有大预览顶栏齿轮一处，列表里找不到 |
| fix | prd-admin | PDF 包装站大预览改走后端已算好的 pdfAssetUrl 直连原生阅读器，不再空白 |
| fix | prd-api | PDF 壳子加载 PDF.js 增加超时兜底，CDN 挂起时降级为下载链而不是永久转圈 |
| test | prd-admin | 新增 sitePreviewSource 判定源 + 两条接线守卫（PDF 直连、提问设置入口） |
| fix | prd-api | 站内列表下发 pdfAssetUrl，此前只有分享视图有，站内大预览的绕壳分支永远走不到 |
| fix | prd-admin | 原生 PDF 阅读器可用性改接响应式信号，移动端仍走壳子 |
| fix | prd-api | PDF 壳子的超时闹钟改罩整条初始化链，worker 挂起时也能降级 |
