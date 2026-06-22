| feat | prd-api | 知识库双向同步新增「后台自动同步」：PeerSyncScheduleWorker 按周期复用最近一次同步的对端+方向自动 push/pull/both（非破坏性，绝不删条目），默认每小时、下限 5 分钟 |
| feat | prd-api | 新增 POST /api/peer-sync/auto-sync 端点开关单库自动同步（仅 document-store，须先手动同步过一次） |
| refactor | prd-api | 抽出 IPeerSyncTransferService（per-item 同步核心 + 网络/台账/归属辅助）为 SSOT，手动 transfer 与自动同步 worker 共用同一条路径，杜绝逻辑漂移 |
| feat | prd-api | DocumentStore 新增自动同步字段（PeerSyncAutoEnabled/IntervalMinutes/AutoLastAt + 分布式租约 LeaseOwner/ExpiresAt），共享 Mongo 多容器下同库同刻仅一容器同步，防请求风暴 |
| feat | prd-admin | 同步中心弹窗新增「后台自动同步」开关 + 周期选择（每15分/小时/6小时/天），未手动同步过的库禁用并提示 |
| test | prd-api | 新增 PeerSyncScheduleTests 守卫到期判定（未开启/无对端/进行中/周期内/周期下限夹紧不误触发） |
