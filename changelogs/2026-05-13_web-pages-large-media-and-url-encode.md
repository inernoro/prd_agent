| fix | prd-api | 网页托管：HostedSiteService.MaxExtractedSize 由 200MB 提到 500MB，与控制器 MaxSingleFileSize 一致；之前 200-500MB 的视频/PDF 上传过得了控制器但被服务层解压时拒掉 |
| fix | prd-api | 网页托管：视频/PDF wrapper 的 `<source src>` / `<iframe src>` / `<a href>` 改用 Uri.EscapeDataString 百分号编码资产文件名，修复含 `#` `?` 等 URL 元字符的文件名（如 `demo#1.pdf`）预览被浏览器解读成 fragment/query 而 404 |
