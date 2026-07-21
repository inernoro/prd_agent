| perf | cds | 修复接口持续排队(3.7s 攀升至 40s+)的两个高置信根因之一:部署卡死看门狗的 execSync(git diff) 幂等判断前置 + 按不可变 sha 对记忆化,stale 分支不再每 5 分钟重复同步阻塞事件循环 |
| perf | cds | 项目列表页轮询从裸 setInterval 改为自调度循环:等上一轮返回再排下一轮(天然 in-flight 去重)、页面隐藏暂停、回前台立即刷新;并消除每轮重复请求两次 /api/pending-imports;资源用量弹窗 5s 轮询同改 |
| test | cds | 新增回归测试:已告警分支跳过 diffRuntimePaths(锁定幂等前置的性能语义) |
