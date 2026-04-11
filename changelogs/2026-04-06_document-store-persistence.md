| feat | prd-api | 文档空间文件上传存盘：串联 IAssetStorage + FileContentExtractor + DocumentService，文件真实存储到 COS/本地 |
| feat | prd-api | 文档空间内容读取 API：从 ParsedPrd 或 Attachment.ExtractedText 获取文档文本 |
| feat | prd-api | 文档订阅源：支持添加 RSS/网页 URL 作为订阅，设定同步间隔 |
| feat | prd-api | DocumentSyncWorker 后台同步引擎：PeriodicTimer 扫描到期条目，自动拉取外部 URL 内容 |
| feat | prd-api | DocumentEntry 新增同步字段：SourceUrl、SyncIntervalMinutes、LastSyncAt、SyncStatus、SyncError |
| feat | prd-admin | 文档上传改用真实 multipart 上传端点（文件落盘，不再只存元数据） |
| feat | prd-admin | 文档详情面板增加「查看文档内容」预览功能 |
| feat | prd-admin | 新增订阅源对话框（输入 URL + 选择同步间隔） |
| feat | prd-admin | 订阅源条目用 RSS 图标区分，详情面板显示同步状态 + 手动同步按钮 |
