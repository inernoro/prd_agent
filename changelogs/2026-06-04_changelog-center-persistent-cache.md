| feat | prd-api | 更新中心数据终身存储到 MongoDB（changelog_snapshots），加载只读存量绝不空白 |
| feat | prd-api | 更新中心后台固定周期自动刷新（默认 4h，Changelog:RefreshIntervalHours 可配），与用户访问解耦 |
| feat | prd-api | 更新中心新增 SSE 推送端点 /api/changelog/stream，后台刷新有更新时主动推到页面 |
| feat | prd-admin | 更新中心头部展示「更新时间 + 更新规则（每 N 小时自动刷新·终身缓存）+ 实时同步状态」 |
| feat | prd-admin | 更新中心订阅 SSE，服务器有更新自动推送并静默重读存量，无需手动刷新 |
| fix | prd-api | 更新中心冷实例 hydrate 到陈旧快照时也后台静默 revalidate，与热缓存路径对称（修复重启后首请求停在旧快照需等 Worker 周期的不对称） |
| fix | prd-api | 更新中心快照 GetAsync 改按 UpdatedAt 倒序取最新；登记 changelog_snapshots.Key 唯一索引（防多实例并发 upsert 重复行） |
| fix | prd-admin | 更新中心 GitHub 日志在途刷新期间到达的 SSE update 改 trailing-edge 补跑，不再被吞 |
| fix | prd-admin | 更新中心 SSE 流干净结束时也清掉「实时同步」徽标并触发重连，不再虚标连接健康 |
| fix | prd-admin | 更新中心 loadCurrentWeek/loadReleases 冷加载在途时也 trailing-edge 补跑 SSE 重读，避免页面停在旧快照 |
| fix | prd-admin | 更新中心 trailing-edge 补跑保留 force 意图，避免冷加载在途时用户硬刷新被降级为只读重读 |
| fix | prd-api | 更新中心快照 UpsertIfChangedAsync 比对读也按 UpdatedAt 倒序，与 GetAsync 一致，重复行下不比错行 |
| fix | prd-api | 更新中心快照写入改为定向更新最新行(按 Id)，变化检测/写入/hydrate 三者命中同一记录 |
| fix | prd-admin | 更新中心 store 加单调请求号 stale-response 守卫，丢弃乱序旧响应，防旧拉取覆盖 SSE 新数据 |
| fix | prd-api | 更新中心 GitHub 路径区分「拉取失败」与「目录确实为空」：空目录落库+推送清空待发布列表，不再永远 hydrate 旧非空快照 |
| fix | prd-api | 更新中心 GitHub 待发布：碎片全部 raw 拉取失败致空时标记不可用，避免假空覆盖好快照 |
