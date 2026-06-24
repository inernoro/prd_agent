| feat | prd-api | 知识库双向同步新增「后台自动同步」：PeerSyncScheduleWorker 按周期复用最近一次同步的对端+方向自动 push/pull/both（非破坏性，绝不删条目），默认每小时、下限 5 分钟 |
| feat | prd-api | 新增 POST /api/peer-sync/auto-sync 端点开关单库自动同步（仅 document-store，须先手动同步过一次） |
| refactor | prd-api | 抽出 IPeerSyncTransferService（per-item 同步核心 + 网络/台账/归属辅助）为 SSOT，手动 transfer 与自动同步 worker 共用同一条路径，杜绝逻辑漂移 |
| feat | prd-api | DocumentStore 新增自动同步字段（PeerSyncAutoEnabled/IntervalMinutes/AutoLastAt + 分布式租约 LeaseOwner/ExpiresAt），共享 Mongo 多容器下同库同刻仅一容器同步，防请求风暴 |
| feat | prd-admin | 同步中心弹窗新增「后台自动同步」开关 + 周期选择（每15分/小时/6小时/天），未手动同步过的库禁用并提示 |
| test | prd-api | 新增 PeerSyncScheduleTests 守卫到期判定（未开启/无对端/进行中/周期内/周期下限夹紧不误触发） |
| fix | prd-api | 自动同步 worker：因「不到期/已关」提前返回时不再推进 PeerSyncAutoLastAt，避免把未真跑的尝试记成满周期延后下次同步（Bugbot） |
| fix | prd-admin | 同步中心方向标签去除天平/箭头等符号字形，改纯文本（CLAUDE.md §0 禁 emoji，Codex P1） |
| fix | prd-admin | 同步中心交互草图(assets/prototypes)清除全部 emoji 图标，改纯文本（CLAUDE.md §0，Codex P1） |
| fix | prd-admin | 知识库卡片「更多」菜单补 onMouseDown stopPropagation，修复菜单项点击前被 document mousedown 卸载（Bugbot/Codex） |
| fix | prd-admin | 知识库置顶保存失败时回滚到操作前集合（原 prev2=>prev2 空操作不撤销乐观更新，Bugbot） |
| docs | prd-api | spec.knowledge-base.transfer-protocol H1 补 · 规格 后缀 + 版本/日期/状态 标准头（doc-naming，Codex） |
| fix | prd-api | 自动同步 worker 释放租约按 owner 限定（仅 PeerSyncLeaseOwner==本实例才清），避免超时被接管后误清新持有者租约放行第三次并发同步（Bugbot High） |
| fix | prd-api | 同步 apply 的廉价跳过纳入 sortOrder/category 比较，修复仅排序/分类变化被漏同步（Bugbot） |
| fix | prd-admin | 同步台账轮询加发号器 stale-response 守卫（DocumentStorePage + SyncCenterDialog），防慢响应覆盖新状态 |
| fix | prd-api | 手动 transfer 与自动 worker 共用库级互斥租约（TryAcquireStoreSyncLeaseAsync），手动同步进行中 worker 抢不到、反之手动撞上自动直接跳过，杜绝同库并发同步（Bugbot 复发项） |
| fix | prd-api | 自动同步 worker 补防自指守卫（对端 RemoteNodeId==selfNodeId 跳过），与手动 transfer 同口径，治共享 Mongo 预览自我同步（Bugbot） |
| fix | prd-api | BuildActorAsync 恢复权限兜底：GetEffectivePermissions 瞬时失败时退回调用方传入的 JWT claims 权限，避免 super 用户被误降级（Bugbot） |
| fix | prd-api | IsDue 不再用 PeerSyncStatus==syncing 判在途（崩溃残留 syncing 会永久禁用该库自动同步），改由租约承担互斥+在途检测（有 TTL 自愈）（Bugbot High） |
| fix | prd-api | 库级同步互斥租约 TTL 10min→30min 并 worker/手动共用同一常量，覆盖大库最坏同步耗时防超时被并发抢锁；>30min 超大库的心跳续租列入 debt.platform.peer-sync（Bugbot High） |
| fix | prd-admin | 详情页同步按钮「进行中」只认近 30 分钟内的 syncing 运行（与租约 TTL 同口径），不再叠加可能陈旧的 store.peerSyncStatus，避免崩溃后永久脉冲（Bugbot） |
| fix | prd-api | 自动同步 worker 成功通信后 bump 对端 PeerNode.LastContactAt（与手动 transfer 同口径），修复纯后台同步部署「最近通信」长期陈旧（Bugbot） |
| fix | prd-api | 同步 apply 文件夹 upsert 纳入 SortOrder/Category 比较与写入，修复目录手动排序/分类漂移被漏同步（Codex） |
| docs | prd-api | spec.knowledge-base.transfer-protocol 去除星标记字形，改 (v1.1) 纯文本（CLAUDE.md §0，Codex P1） |
| fix | prd-admin | 同步中心面板「进行中」判定同样加 30 分钟新鲜窗口（头部转圈/tab 计数/2s 轮询），与详情页一致，陈旧 syncing 台账不再永久脉冲（Bugbot） |
| fix | prd-admin | 同步台账卡片(RunCard)对陈旧 syncing 行(超30min)显示为中性「未完成」而非金色脉冲，与进行中判定一致（Bugbot） |
| fix | prd-api | 同步完成（手动/自动）终态回写一并重置 PeerSyncAutoLastAt，避免手动同步一个已到期库后 worker 约 1 分钟内又自动跑一遍（Bugbot） |
| fix | prd-admin | 知识库排序保存失败时回滚 defaultSortMode（同置顶回滚），避免侧栏排序与服务端不一致（Bugbot） |
| fix | prd-api | 自动同步 worker 每次尝试用唯一租约持有者（实例id+guid），杜绝下一扫描周期因「同 owner 可重入」在同实例叠开同库第二个同步（Bugbot High） |
| fix | prd-api | 漂移签名 ComputeSignature 纳入 sortOrder/category/defaultSortMode，避免仅排序/分类变化时签名不变、漂移检测误报已同步（Codex） |
| fix | prd-api | 自动同步 sourceBaseUrl 兜底取 config["ServerUrl"]（worker 无 Request），反代部署未设 PEER_SELF_BASE_URL 时图片本地化不再降级（Codex） |
| fix | prd-admin | 知识库置顶写入串行化（合并为最新一次、单请求在途、失败拉服务端权威值），杜绝快速连点乱序丢项 + 陈旧回滚丢新选择（Codex） |
| fix | prd-admin | 同步中心自动同步开关跟随 props 更新（onAfterSync 重载后不再与服务端不一致，Bugbot） |
| fix | prd-admin | 置顶写入失败且在途又有新点击时继续发最新意图（不再 return 致最新选择不落库；无 pending 才拉服务端纠正），Codex |
