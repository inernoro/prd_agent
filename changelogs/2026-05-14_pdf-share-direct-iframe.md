| fix | prd-api | 网页托管分享 PDF 时后端额外返回 pdfAssetUrl 直链，避免前端走「壳子 + 嵌套 iframe」结构 |
| fix | prd-admin | ShareViewPage 检测到 PDF 包装站时直接 iframe 真实 PDF 链接（移除 sandbox），让浏览器原生 PDF Viewer 接管，修复 Chrome「此页面已被 Chrome 屏蔽」 |
