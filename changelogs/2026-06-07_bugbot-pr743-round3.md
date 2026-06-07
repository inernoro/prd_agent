| fix | prd-admin | 铃铛 openPopover 不再 force=true：原本会清空更新中心页 loadMoreFragments 累积的尾部日期组，让正打开页面的用户瞬间「列表变短」；SWR 5min 新鲜度足够 |
| fix | prd-admin | 已发布列表上限从 8 改为 100：原本若 CHANGELOG 版本 > 8 则永远看不到更老版本，chip 与列表数字会对不齐。summary 模式下 100 个版本元数据仍 < 10kB，几乎零成本 |
| fix | prd-api | ChangelogRefreshWorker 的 ReleasesLimit 从 20 改为 100，与 controller 总是读 releases:100 cache key 对齐，避免 worker 预热的快照永远命中不到前端读取的 key |
