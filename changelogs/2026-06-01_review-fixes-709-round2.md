| fix | prd-api | DocumentSyncWorker 自愈分支不更新 LastChangedAt：源内容未变，仅重建被误删 Document → 避免 DocBrowser NEW 徽标误亮（Bugbot Low） |
| fix | prd-api | DocumentStore 导入复用同名库时也合并 TagColors（白名单 sanitize），不再静默丢失跨环境同步的颜色（Bugbot Low） |
| fix | prd-admin | tag 颜色保存改 single-flight 队列，latest-write-wins，老请求成功不再覆盖新意图（Codex P2） |
