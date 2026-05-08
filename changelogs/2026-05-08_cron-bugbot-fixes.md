| fix | prd-api | CronEvaluator dom/dow 改为 Vixie/POSIX OR 语义 — `0 9 1 * 5` 现在按"每月 1 号 OR 每周五 9 点"匹配（之前是 AND，要求同时满足，导致漏触发）(Bugbot Low) |
| fix | prd-api | CronEvaluator 跳过 DST spring-forward gap — `tz.IsInvalidTime(t)` 命中时 skip 这一分钟而不是抛 ArgumentException（避免 worker 永久禁用调度 + controller 误报"Cron 不合法"）(Bugbot Medium) |
| test | prd-api | 新增 5 个 CronEvaluator 单元测试：timezone 转换、UTC 默认、dom/dow OR 语义、DST gap 不抛、字段校验 |
