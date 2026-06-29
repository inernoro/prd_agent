| fix | cds | 修复健康分支被误报「疑似卡住 ≥1h」：从未 finalize 的孤儿 running 部署日志若已被更新的成功部署取代，不再被选为「当前部署」（前端 pickActiveDeployment 加陈旧守卫 + 后端派发收敛器 finalize 孤儿日志） |
| fix | cds | 分支卡片「上次部署 N 分钟前」标签纠正为「最近访问」：原取 lastAccessedAt（预览访问时间）却标成部署时间，导致刚打开预览被误显示成刚部署 |
