| fix | prd-admin | GitHub 目录同步中自动轮询条目列表，长任务不再停在「同步中」要人手动刷新 |
| fix | prd-admin | 连点两个仓库时丢弃过期的分支响应，不再把上一个仓库的分支灌进选择器 |
| fix | prd-api | 批量订阅写入阶段改用服务端令牌，浏览器中途关闭不再留下条目与偏小的空间计数 |
| fix | prd-api | GitHub 限额判据收敛成 GitHubRateLimit 唯一定义，403 限额耗尽不再被说成「拒绝访问」 |
