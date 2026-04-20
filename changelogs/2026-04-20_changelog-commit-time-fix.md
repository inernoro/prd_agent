| fix | prd-api | ChangelogReader 的 commit 时间归属逻辑改为「近似向后匹配」：按 CN(UTC+8) 计算 commit 的日期，为每个 ### YYYY-MM-DD 段找「首个 commit.cnDate >= 段日期」的 commit。解决历史 CHANGELOG 段日期和 commit 日期几乎从不相等、导致秒级时间永远不生效的问题 |
| feat | prd-admin | 历史发布条目接入 NEW 徽章（复用更新中心 lastSeenAt 的 cutoff）：entry.commitTimeUtc > endOfDay(lastSeenAt) 时在行首展示绿色 NEW，位置在类型徽章之前 |
