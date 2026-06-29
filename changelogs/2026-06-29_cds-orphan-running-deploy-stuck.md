| fix | cds | 修复健康分支被误报「疑似卡住 ≥1h」：从未 finalize 的孤儿 running 部署日志若已被更新的成功部署取代，不再被选为「当前部署」（前端 pickActiveDeployment 加陈旧守卫 + 后端派发收敛器 finalize 孤儿日志） |
| fix | cds | 分支卡片「上次部署 N 分钟前」标签纠正为「最近访问」：原取 lastAccessedAt（预览访问时间）却标成部署时间，导致刚打开预览被误显示成刚部署 |
| fix | cds | 陈旧 running 守卫改比「完成时间」而非「开始时间」（Bugbot Medium）：卡死的 running 若在某次已完成部署的 startedAt 之后、finishedAt 之前开始，旧逻辑仍会误选它为活跃 →「疑似卡住」复发；改用已完成部署的最晚 finishedAt 当门槛，并把 pickActiveDeployment 抽成纯函数加单测 |
| fix | cds | pickActiveDeployment 兜底也跳过僵尸 running（Codex P2）：tail 窗口过期后旧逻辑直接返回 sorted[0]，若最新一条恰是被取代的僵尸 running 会把「疑似卡住」卡片选回来；改取最新的非僵尸条目兜底 |
| fix | cds | 分支卡片成功部署不再误显示「最近访问」（Bugbot Medium）：lastAccessedAt 同时被预览访问和部署尝试盖戳，卡片优先它会把成功部署显示成预览访问；改为比较 lastDeployAt 与 lastAccessedAt，部署时间不早于访问时间即显示「部署成功」 |
