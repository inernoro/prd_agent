| perf | prd-api | 更新中心 `GET /api/changelog/releases` 默认 limit 从 20 降到 8，首屏 JSON 体积大幅缩小 |
| perf | prd-admin | 更新中心首屏只拉 8 个版本，1.5s 空闲后台补到 50 个，用户滚动到底前已备好，消除首屏卡顿 |
| perf | prd-admin | GitHub 实时日志 35s 轮询改为按需启动（仅当用户进入「实时日志」tab 时），不再抢首屏主线程 |
| refactor | prd-api | 删除 `MergeChangelogMarkdownIntoCurrentWeek` 死代码（从未被调用） |
| fix | prd-admin | 「待发布」chip 增加 hover tooltip，显示碎片文件数 + 合并方式提示，避免数字过大产生不切实际的错觉 |
