| feat | cds | 新增 `branch-events.ts` 进程级事件总线 (EventEmitter 单例) + 5 种事件类型 (branch.created / status / updated / removed / deploy-step),让 webhook dispatcher + deploy 流 + 手工添加 三条独立路径统一推"分支状态变了"这件事,前端通过 SSE 一条管道消费 |
| feat | cds | 新增 `GET /api/branches/stream` SSE 端点: 订阅时先推一次 snapshot (初始全量, 支持 ?project= 过滤),之后实时推 branchEvents 总线上的每条事件;10s keepalive 心跳;客户端断开自动 off 监听器不泄漏 |
| feat | cds | github-webhook-dispatcher 在 push 事件处理流末尾 emit branch.created / branch.updated,让 Dashboard 打开时能亲眼看到 GitHub push 自动创建的分支出现 |
| feat | cds | branches.ts 部署流程在状态转换点 (building 入口 + 结束时 running/error/starting) + 删除路径 + 手工创建路径 emit 对应事件,和自动触发路径统一走同一总线 |
| feat | cds | 前端 state-stream 处理扩展: 首次见到的分支 id 进 `freshlyArrived` set,renderBranches 给卡片追加 `.fresh-arrival` + (GitHub 来源时)`.fresh-gh` class;5 秒后自动清除,下次重绘回到普通卡片 |
| feat | cds | 新增 `@keyframes cds-card-arrival` (translateY + scale + opacity 滑入) + `cds-card-gh-pulse` (紫色外发光脉冲 x3),叠加勾勒出"GitHub 刚给你建的分支"视觉。遵守 prefers-reduced-motion,无动画用户不触发 |
| test | cds | 新增 tests/routes/branches-stream.test.ts 4 个用例:snapshot 事件 + branch.created 事件路由 + ?project 过滤 + 客户端断开监听器清理(防内存泄漏)。753/753 全绿 |
