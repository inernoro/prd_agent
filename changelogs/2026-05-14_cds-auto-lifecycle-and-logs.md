| feat | cds | 项目设置新增「运行生命周期」面板：「运行满 N 分钟自动切发布版」「运行满 N 分钟自动停止」两个独立开关，默认关闭、可配置 1~1440 分钟；以容器进入 running 时打的 lastReadyAt 戳为计时锚点（HTTP 流量不参与刷新），新增 AutoLifecycleService 30s tick。auto-publish 全自动「停源码→重建发布版」（先后替换，无需人工）——复用内部 /deploy 自调（走 resolveEffectiveProfile，不动懒唤醒热路径），失败回滚 override；auto-stop 到点停容器回收 |
| feat | cds | BranchEntry 新增 lastReadyAt 字段（reconcileBranchStatus 在状态切到 running 时打戳），供项目级生命周期调度使用 |
| feat | cds | GitHub Webhook 日志 ring buffer 上限从 200 提升到 1000；分支抽屉的 Webhook 日志 tab 支持「加载更早 20 条」分页（每页 20，累计可读到全部 1000） |
| feat | cds | 分支抽屉「部署」tab 重排版面：容器日志作为一等公民提到顶部（宽屏左、窄屏上），阶段树退居次位（宽屏右、窄屏下）；容器日志面板支持多容器 tab 切换 + 一键最大化（跳到「日志 → 容器日志」） |
| docs | cds | 新增 doc/debt.cds-state-json.md 登记 state.json 影子存储债务，规划 4 阶段拆分到 mongo collection |
