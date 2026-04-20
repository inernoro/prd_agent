| feat | prd-api | ChangelogReader 拉取 CHANGELOG.md 的 GitHub commit 历史（单次 commits API 调用），按日期聚合，给每个 day 块附上该日最晚一次 commit 的秒级 UTC 时间 |
| feat | prd-api | ChangelogDayDto 新增 commitTimeUtc 字段（ISO 8601），供前端渲染秒级时间 |
| perf | prd-admin | 筛选 chip 增加图标（feat→Sparkles、fix→Wrench、perf→Gauge 等 11 类），条目内模块/类型徽章同步带 icon 更易识别 |
| perf | prd-admin | 条目右侧时间升级为 "YYYY-MM-DD HH:mm:ss"（基于 GitHub commit 时间，tabular-nums 等宽），降级到纯日期时保留 tooltip 说明 |
