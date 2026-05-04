| fix | cds | 修复 BranchDetailDrawer metrics tab 网络速率永远为 0:setInterval 闭包捕获首次 loadMetrics 引用,state 更新后新闭包不会被定时器调用,改用 useRef 同步保存上次响应快照 |
| fix | cds | 修复 GlobalUpdateBadge "有更新"角标永远不亮:server.ts 顶层 /api/self-status handler 无条件抢答 router 版,带 ?probe=remote 时下放给 branches.ts 完整版做 git fetch + ahead 计算,前端轮询切到 ?probe=remote |
| fix | cds | 修复 Variables tab 项目级覆盖被误判为全局:env-classifier 用值比较 rawGlobal[k] !== v 推断 source,当项目 override 写入和全局相同的值时被错误归类为 global,改用 getCustomEnvScope(projectId) 直接读 raw bucket |
