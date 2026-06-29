| fix | cds | 修复健康分支被误报「疑似卡住 ≥1h」：从未 finalize 的孤儿 running 部署日志若已被更新的成功部署取代，不再被选为「当前部署」（前端 pickActiveDeployment 加陈旧守卫 + 后端派发收敛器 finalize 孤儿日志） |
| fix | cds | 分支卡片「上次部署 N 分钟前」标签纠正为「最近访问」：原取 lastAccessedAt（预览访问时间）却标成部署时间，导致刚打开预览被误显示成刚部署 |
| fix | cds | 陈旧 running 守卫改比「完成时间」而非「开始时间」（Bugbot Medium）：卡死的 running 若在某次已完成部署的 startedAt 之后、finishedAt 之前开始，旧逻辑仍会误选它为活跃 →「疑似卡住」复发；改用已完成部署的最晚 finishedAt 当门槛，并把 pickActiveDeployment 抽成纯函数加单测 |
