| feat | prd-api | 知识库跨节点同步新增「取消进行中同步」能力：PeerSyncRun 加 CancelRequested 位 + cancelled 终态，新增 POST /api/peer-sync/runs/{id}/cancel 端点（归属校验），SyncItemAsync 在 push前/push后/本地写入前/逐篇 检查点轮询取消位主动中断落 cancelled |
| refactor | prd-admin | 批量同步弹窗重写为「发起 / 历史」两视图，与单库面板同一套拓扑语言（已选N库⇄对端）；历史视图可查看全部同步台账并停止进行中的同步；砍掉旧监控面板术语与没开始就全是0的统计 |
| feat | prd-admin | 单库同步面板的进行中同步也可一键停止（进度条与记录卡的停止按钮）；新增 cancelled 状态展示（中性灰，区别于失败红） |
