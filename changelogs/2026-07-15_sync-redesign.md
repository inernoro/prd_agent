| refactor | prd-admin | 知识库「同步」与「发送到」合并为统一同步面板：方向（发送/拉回/双向）+ 自动开关一次设定长期生效，发送降级为面板内的一种方向，同一动作不再有三个入口 |
| polish | prd-admin | 知识库顶栏同步按钮文案即状态（已同步·对端 / 需要处理 / 同步中）；列表页批量入口更名「批量同步」；原发送弹窗「原时间/覆盖/重传」三个开关收敛为固定默认值 |
| refactor | prd-admin | 知识库同步面板重设计为一屏拓扑图：主视觉改为「本库⇄对端」关系图，箭头即同步方向、连线颜色与流动即状态，替代原文字表单；方向段控 + 立即同步 + 自动开关一屏完成，记录与高级对齐收进折叠 |
| feat | prd-api | 知识库跨节点同步新增「取消进行中同步」能力：PeerSyncRun 加 CancelRequested 位 + cancelled 终态，新增 POST /api/peer-sync/runs/{id}/cancel 端点（归属校验），SyncItemAsync 在 push前/push后/本地写入前/逐篇 检查点轮询取消位主动中断落 cancelled |
| refactor | prd-admin | 批量同步弹窗重写为「发起 / 历史」两视图，与单库面板同一套拓扑语言（已选N库⇄对端）；历史视图可查看全部同步台账并停止进行中的同步；砍掉旧监控面板术语与没开始就全是0的统计 |
| feat | prd-admin | 单库同步面板的进行中同步也可一键停止（进度条与记录卡的停止按钮）；新增 cancelled 状态展示（中性灰，区别于失败红） |
| fix | prd-api | 修复取消/失败的首次同步被误判为已建立关系：开启后台自动同步的门禁额外要求 status=synced（真正成功过一次），取消(cancelled)/失败(error)均不满足（Codex PR#1144 P2） |
| fix | prd-admin | 单库同步面板多对端时按 RemoteNodeId 预选已保存对端（避免已建立关系的库重开面板因 nodeId 空而主按钮禁用）；「已建立」判定收口为真正成功同步过，取消的首次同步不再显示为已同步（Codex PR#1144 P2） |
| fix | prd-api | 取消检查点 B 仅在还有 pull 阶段时才生效：避免 push-only 传输在对端已成功后被误记 cancelled 并跳过成功收尾（Codex PR#1144 P2） |
| fix | prd-api | 自动同步开启门禁改用「有过成功 outgoing run」判定，而非最后一次 status：修复之前成功建立、最近一次同步被取消/失败的库无法重开自动同步或改周期（Codex PR#1144 P2） |
| fix | prd-admin | 单库同步面板改了方向段控但未成功同步时禁用自动开关（directionDirty），避免「header 说自动 pull、后台仍 push」的方向不一致（Codex PR#1144 P2） |
| fix | prd-api | 自动同步资格绑定当前保存对端：只认发往 store.PeerSyncNodeId 的成功 run，避免切对端 A→B 失败后 A 的旧成功误放行 B 关系（Codex PR#1144 P2） |
| fix | prd-api | 取消能力健壮性三处（Codex PR#1144 P2 第四轮）：① push 真正发送 bundle 到对端前补一个取消检查点（导出大 bundle 耗时期间点停也能拦下）；② PeerSyncRunCancelledException 下沉 Core 层，DocumentStoreSyncResource 逐条 catch 前先放行取消异常，否则写入阶段点停会被吞成 per-record failure、run 落 error 而非 cancelled；③ 自动同步 worker 每轮兜底校验 saved peer 有成功 run，避免切对端 A→B 失败后 worker 用未建立的 B 关系发流量 |
| fix | prd-api | 取消能力两处边界（Codex PR#1144 P2 第五轮）：① 强制对齐（align-remote/local）的镜像删除循环也接入取消——每次 DeleteOneAsync 前报进度触发取消检查、catch 放行取消异常，点停立即中断破坏性删除；② 自动同步资格（worker 守护 + SetAutoSync gate）除绑对端外再绑 normalized direction（对齐 run.Direction=align-* 用等价集合归一），避免 push 建立后同 peer 的 pull 失败仍放行未建立的 pull 方向 |
| fix | prd-admin | 单库同步面板多对端时选了未同步过的新对端（≠已保存 peerNodeId）也禁用自动开关（peerDirty，与 directionDirty 对称），避免「对 saved peer A 开了自动、面板却显示 peer B」的对端不一致（Codex PR#1144 P2） |
| fix | prd-api | 批量同步途中点停止时停整批：PeerItemSyncResult 加 Cancelled 标志，取消落 cancelled 后 Controller 批量 loop break，不再继续同步后续未开始的库（Codex PR#1144 P2） |
| fix | prd-admin | 「已建立关系」（everSynced）收口为「当前选中对端+方向组合成功过」，不再认「该库任意成功 run」：切对端/换方向未成功时不再误显示为已建立、不再误开自动开关（与后端 gate 同口径，Codex PR#1144 P2） |
| fix | prd-admin | 强制对齐成功后同步本地 direction（对齐归一方向），避免首次对齐后 everSynced 恒 false、面板一直说未建立/禁自动直到重开；批量弹窗改选时清掉上一轮 results，避免取消选中的行仍按旧结果显示（Codex PR#1144 P2） |
| fix | prd-api | 取消时保留 apply 已提交的部分增删改计数：PeerSyncRunCancelledException 带回本次 apply 已处理数，SyncItemAsync 累加落 cancelled run，避免 pull/align 写入一半被停时历史显示删除0/计数陈旧与实际不符（Codex PR#1144 P2） |
