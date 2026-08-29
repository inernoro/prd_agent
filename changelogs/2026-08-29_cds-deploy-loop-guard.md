| feat | cds | 部署端点新增空转熔断：同一分支在 30 分钟内反复部署**同一个 commit** 达 3 次告警、达 6 次拒绝（429），拒绝时活动流留一条可回读的记录，说清是哪个分支、哪个提交、已重复几次 |
| fix | cds | 补上一处真实盲区：CDS 此前对「串行空转部署」完全无感——branch-operation-coordinator 只防并发撞车，而这种环每轮都等上一轮结束才起，协调器从未触发；build-activity-tracker 记了次数却只喂资源面板展示，没有任何判定 |
| refactor | cds | build-activity-tracker 的事件补记 commitSha，并新增 assessDeployLoop 作为该判定的唯一来源；判据按「分支 + 提交」计数，推一个新提交即自动解除 |
| test | cds | 新增 16 条用例：复现事故节奏到 trip、正常连推十次（每次新 SHA）永不误伤、短 SHA 与全长 SHA 视为同一提交、大小写归一、跨分支不污染、窗口外不计数、无 SHA 一律放行；另有接线守卫扫 deploy 处理器，摘掉判定或改掉 429 当场变红（已做红绿闭环） |
| docs | doc | 判据选型的取舍写进 assessDeployLoop 注释：不按 trigger 过滤——triggerFromRequest 缺头时一律回落 manual，CDS 自己的面板与一个失控脚本在该字段上完全不可区分，事故里那个自触发脚本记录下来就是 manual |
