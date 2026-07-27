| feat | cds | 新增自建存活监控探测器：周期直连容器宿主端口探测每个 running 分支服务，记录时序采样、连续失败去抖判故障、按天聚合可用率，环形缓冲与天数均有硬上限；探测绕开预览代理，不刷新分支的空闲降温时间 |
| feat | cds | 新增存活监控只读接口 GET /api/uptime/summary、/api/uptime/targets/:id/history、/api/uptime/incidents，时序输出统一降采样并有点数上限 |
| feat | cds | 新增状态页 /status（Uptime Kuma 形态）：整体状态横幅、每服务 90 段可用率柱条、24h 可用率与平均响应、故障时间线；双主题可读、柱条带斜纹不只靠颜色区分、手机端减段并横向滚动、加载走柱条骨架屏、空状态给首批数据预计时间 |
| test | cds | 新增 uptime-metrics 与 uptime-monitor-cycle 两套 vitest：可用率计算、连续失败去抖、环形缓冲不溢出、降采样点数上限、探测不刷新 lastAccessedAt、降温不计故障、监控可关闭 |
| fix | cds | 修复存活监控把非 HTTP 服务（gRPC / 纯 worker / 裸 TCP 端口）永久误报为故障：新增 CDS_UPTIME_EXCLUDE 排除名单逃生阀（支持通配，命中标「未纳入监控」不计故障、并收尾已开事件），并对「从未答过 HTTP 且连续收到协议层错误」的目标自动降级为容器状态判定；连接被拒 / 超时 / 5xx 仍按真故障处理 |
| fix | cds | 修复状态页首次加载失败时同时显示错误横幅与永久骨架屏的矛盾态：拆成加载 / 有数据 / 失败三态，失败且无数据时改渲染带具体原因与「重新加载」的引导式错误卡片，不再让读屏用户一直听到「正在读取存活监控数据」 |
| test | cds | 新增排除名单、自动降级、探测失败分类、状态页三态判定与源码契约的回归用例 |
| docs | cds | 新增 doc/debt.cds.uptime-monitor.md 债务台账（探测口径假定 HTTP 的已知边界、缓解手段与后续可补项），并同步登记 doc/index.yml 与 doc/guide.list.directory.md |
