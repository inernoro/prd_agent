| feat | prd-api | 知识库双向同步新增「后台自动同步」：PeerSyncScheduleWorker 按周期复用最近一次同步的对端+方向自动 push/pull/both（非破坏性，绝不删条目），默认每小时、下限 5 分钟 |
| feat | prd-api | 新增 POST /api/peer-sync/auto-sync 端点开关单库自动同步（仅 document-store，须先手动同步过一次） |
| refactor | prd-api | 抽出 IPeerSyncTransferService（per-item 同步核心 + 网络/台账/归属辅助）为 SSOT，手动 transfer 与自动同步 worker 共用同一条路径，杜绝逻辑漂移 |
| feat | prd-api | DocumentStore 新增自动同步字段（PeerSyncAutoEnabled/IntervalMinutes/AutoLastAt + 分布式租约 LeaseOwner/ExpiresAt），共享 Mongo 多容器下同库同刻仅一容器同步，防请求风暴 |
| feat | prd-admin | 同步中心弹窗新增「后台自动同步」开关 + 周期选择（每15分/小时/6小时/天），未手动同步过的库禁用并提示 |
| test | prd-api | 新增 PeerSyncScheduleTests 守卫到期判定（未开启/无对端/进行中/周期内/周期下限夹紧不误触发） |
| fix | prd-api | 自动同步 worker：因「不到期/已关」提前返回时不再推进 PeerSyncAutoLastAt，避免把未真跑的尝试记成满周期延后下次同步（Bugbot） |
| fix | prd-admin | 同步中心方向标签去除 ⚖/箭头字形，改纯文本（CLAUDE.md §0 禁 emoji，Codex P1） |
| fix | prd-admin | 知识库卡片「更多」菜单补 onMouseDown stopPropagation，修复菜单项点击前被 document mousedown 卸载（Bugbot/Codex） |
| fix | prd-admin | 知识库置顶保存失败时回滚到操作前集合（原 prev2=>prev2 空操作不撤销乐观更新，Bugbot） |
| docs | prd-api | spec.map-kb-transfer-protocol H1 补 · 规格 后缀 + 版本/日期/状态 标准头（doc-naming，Codex） |
| fix | prd-api | 自动同步 worker 释放租约按 owner 限定（仅 PeerSyncLeaseOwner==本实例才清），避免超时被接管后误清新持有者租约放行第三次并发同步（Bugbot High） |
| fix | prd-api | 同步 apply 的廉价跳过纳入 sortOrder/category 比较，修复仅排序/分类变化被漏同步（Bugbot） |
| fix | prd-admin | 同步台账轮询加发号器 stale-response 守卫（DocumentStorePage + SyncCenterDialog），防慢响应覆盖新状态 |
