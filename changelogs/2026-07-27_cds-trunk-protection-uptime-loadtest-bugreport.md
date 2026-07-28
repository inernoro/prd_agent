| fix | cds | 修复 janitor 把主干分支（main/master）当过期分支整条删除的 P0 事故：分支保护判定收敛为唯一 SSOT（branch-protection.ts），janitor 与 scheduler 共用同一份，不再漂移 |
| fix | cds | janitor 保护判定改为 per-project：按 branch.projectId 查项目默认分支与 gitDefaultBranch，A 项目主干不再因 B 项目配置而失去保护 |
| fix | cds | GitHub delete webhook 增加主干兜底：主干分支拒绝自动停容器与删除分支条目，只记录拒绝原因 |
| feat | cds | janitor sweep 报表与快照新增 skippedProtected（受保护而免删的过期分支 + 原因）与 protectedTrunkBranches，主干保护是否生效可见不再静默 |
| test | cds | 新增分支保护回归测试：defaultBranch 未配置时 main/master 受保护、多项目隔离、普通分支仍正常回收、webhook 主干拒删 |
| fix | cds | 补齐用户一键触发的删分支路径的主干保护：POST /cleanup、POST /cleanup-orphans、POST /branches/cleanup-stopped 一律先过 branch-protection SSOT，不再只比对全局 state.defaultBranch，多项目下点一次清理不会再删掉项目主干 |
| fix | cds | cleanup-orphans 增加 fetch 异常守卫：远端分支集合为空时判定为 fetch 异常并中止该项目清理，杜绝「远端一个分支都没有」被解释成「本地全都是孤儿」而整批删除 |
| fix | cds | 恢复出厂设置默认保留各项目主干分支，需显式 confirmTrunk=1 才连主干一并清除；两种情况都在 SSE 与响应里逐条列明保留/删除的主干 |
| feat | cds | 清理类接口回传 skippedProtected（保住了谁、凭什么保住），与 janitor 报表同口径，保护可见 |
| perf | cds | janitor 保护跳过日志改为仅状态变化时输出，主干等永久受保护分支不再每轮 sweep 复读同一行淹没有效信号 |
| test | cds | 新增一键清理路径主干保护回归（cds/tests/routes/trunk-protection-cleanup.test.ts，10 例事故值用例）与 janitor 日志去噪回归 |
| fix | cds | 修复 scheduler 的固定名单没传进 janitor：按文档 pin 住的非主干分支只挡得住降温，TTL 到期仍被 janitor 删除，两套保护看似统一实则漏一半 |
| feat | cds | 新增自建存活监控探测器：周期直连容器宿主端口探测每个 running 分支服务，记录时序采样、连续失败去抖判故障、按天聚合可用率，环形缓冲与天数均有硬上限；探测绕开预览代理，不刷新分支的空闲降温时间 |
| feat | cds | 新增存活监控只读接口 GET /api/uptime/summary、/api/uptime/targets/:id/history、/api/uptime/incidents，时序输出统一降采样并有点数上限 |
| feat | cds | 新增状态页 /status（Uptime Kuma 形态）：整体状态横幅、每服务 90 段可用率柱条、24h 可用率与平均响应、故障时间线；双主题可读、柱条带斜纹不只靠颜色区分、手机端减段并横向滚动、加载走柱条骨架屏、空状态给首批数据预计时间 |
| test | cds | 新增 uptime-metrics 与 uptime-monitor-cycle 两套 vitest：可用率计算、连续失败去抖、环形缓冲不溢出、降采样点数上限、探测不刷新 lastAccessedAt、降温不计故障、监控可关闭 |
| fix | cds | 修复存活监控把非 HTTP 服务（gRPC / 纯 worker / 裸 TCP 端口）永久误报为故障：新增 CDS_UPTIME_EXCLUDE 排除名单逃生阀（支持通配，命中标「未纳入监控」不计故障、并收尾已开事件），并对「从未答过 HTTP 且连续收到协议层错误」的目标自动降级为容器状态判定；连接被拒 / 超时 / 5xx 仍按真故障处理 |
| fix | cds | 修复状态页首次加载失败时同时显示错误横幅与永久骨架屏的矛盾态：拆成加载 / 有数据 / 失败三态，失败且无数据时改渲染带具体原因与「重新加载」的引导式错误卡片，不再让读屏用户一直听到「正在读取存活监控数据」 |
| test | cds | 新增排除名单、自动降级、探测失败分类、状态页三态判定与源码契约的回归用例 |
| docs | cds | 新增 doc/debt.cds.uptime-monitor.md 债务台账（探测口径假定 HTTP 的已知边界、缓解手段与后续可补项），并同步登记 doc/index.yml 与 doc/guide.list.directory.md |
| fix | cds | 修复状态页首屏被 100+ 个「已暂停/暂无数据」空行霸占：目标按展示优先级排序（故障 > 待确认 > 正常 > 已暂停 > 已排除），同档内才按名字，首屏留给真正在跑的服务 |
| test | cds | 新增展示排序回归：含生产事故值（103 暂停 vs 36 正常）断言首屏全是有数据的目标 |
| fix | cds | 存活监控默认只监控主干分支（CDS_UPTIME_SCOPE=all 可恢复全量）：特性分支天然大量处于降温态，全量纳入会把状态页变成一屏噪声，真故障被淹没 |
| fix | cds | 修复集群下远端 executor 的分支被用协调端 127.0.0.1 探测：会误判 down，更糟的是可能撞上本机复用同端口的无关容器报出假绿；改为不纳入监控并注明原因 |
| security | cds | 修复项目级 Key 可枚举全实例每个项目的存活状态（分支名/服务名/故障原因/时间线）：summary 按项目收窄并重算总览计数，incidents 先过滤再截断，单 target 详情判归属否则 403 |
| feat | cds | 复制集延伸出压测能力：主实例与各副本同一入口同时加压，逐秒 QPS/延迟曲线实时生长，结束给出 A/B 对比结论 |
| feat | cds | 压测四端点（发起/查询/取消/列表）挂在复制集路由，目标由服务端从分支状态解析并用 __rs 钉选 |
| security | cds | 压测执行器只连本机 forwarder，Host 必须命中本分支已发布域名白名单，杜绝借授权压别的项目 |
| ops | cds | 压测硬闸：并发/时长/总请求数/落点数上限 + 同时只允许一个任务 + 磁盘冻结档拒绝发起 + 心跳收割僵尸闸位 |
| test | cds | 新增压测回归：分位数边界、硬上限、SSRF 白名单、并发闸、取消时效、心跳收割、A/B 结论、曲线计算 |
| docs | cds | 新增 design.cds.replica-loadtest 设计说明并同步 doc 索引 |
| fix | cds | 修复压测报告在大样本下 500：指标聚合改为 O(1) 记账 + 定长桶直方图，不再对 20 万条采样做 Math.min/push 展开调用（V8 展开实参上限约 12.5 万，超过即抛 RangeError，曲线断掉且整个分支的压测列表持续报错） |
| perf | cds | 压测运行时不再保留原始延迟数组：每目标 331 槽直方图（1324 字节），单次压测常驻内存 < 2.6MB；跑完冻结成报告快照并释放直方图，历史记录不再拖着秒级采样 |
| test | cds | 新增大样本回归：跑满 20 万条采样仍能出报告且 count/min/max/avg/分位数正确，并锁住直方图的精度代价与定长内存 |
| fix | cds | 修复压测路径已带 __rs 时被追加第二个值：forwarder 只认第一个，会让所有 A/B 落点实际打到调用方钉的同一个副本，却仍按不同成员出「谁更快」的对比结论（假对比）；改为解析后替换 |
| feat | cds | 新增全局快捷提 bug（Ctrl+B / Command+B + 右下角常驻入口），自动带入页面地址/路由/主题/视口/浏览器信息，支持粘贴与拖拽截图 |
| feat | cds | 新增 POST/GET /api/bug-reports：配置 MAP 缺陷系统凭据时由服务端带凭据转发（create + submit），未配置或转发失败则本地留存并如实告知未同步 |
| feat | llmgw | 网关控制台新增同款全局快捷提 bug 面板，走 theme.css token 双主题适配 |
| feat | llmgw | console-api 新增 POST/GET /gw/bug-reports：支持转发到 MAP 缺陷系统，未配置时落 llmgw_bug_reports 集合并回报降级原因 |
| test | cds | 新增快捷键判定/环境采集/payload 组装（cds 与 llmgw 两份实现同组断言）与 /api/bug-reports 路由契约测试 |
| fix | cds | 修复截图附件在生产必然 413：全局 100kb JSON 解析器新增 /api/bug-reports 跳过，路由自挂 24mb 解析器（覆盖 12MB 附件经 base64 膨胀后的体积），超限回中文 JSON 而不是 HTML |
| fix | cds | 修复复制集压测四个端点缺 Activity Monitor 中文 label（发起压测/列出压测记录/取消压测/查看压测报告），cancel 排在单段 runId 之前不被吞 |
| fix | cds | 修复右下角提交缺陷 pill 压住页面操作反馈 toast：新增共享安全偏移 lib/overlayOffsets，pill 与六个页面的 toast 共用同一份几何常量 |
| fix | cds | 修复提 bug 转发超时预算：create 与 submit 由各 10s 改为共用 10s 总预算，兑现前端「超过 10 秒转本地留存」文案 |
| fix | llmgw | 修复 POST /gw/bug-reports 违反 server-authority：转发与落库改用与请求生命周期解耦的独立超时/CancellationToken.None，用户切页不再导致 MAP 已建缺陷而网关无记录 |
| fix | llmgw | 修复附件可能顶穿 MongoDB 16MB 单文档上限：总量闸改按 base64 字符长度计，并给 InsertOneAsync 套 try/catch，失败返回中文原因而不是裸 500 |
| test | cds | 新增生产同款 body 解析装配的 413/大附件用例、压测端点 label 守卫、右下角浮层不重叠守卫、llmgw 提 bug 端点源码守卫 |
| security | cds | 修复项目级 Key 可读取全部项目缺陷台账（正文含页面地址与 query、提交人、环境信息）：缺陷是 CDS 系统级数据且无项目维度可过滤，按既有约定拒绝项目级凭据 |
| fix | cds | 修复转发到缺陷系统时截图从未上传：此前只 create+submit，正文里仅有文件名，UI 却报「已提交」；改为 submit 前逐个上传附件，部分失败如实回传而非谎报成功 |
| polish | cds | 验收报告改版为米多刊系检验档案版：补齐期号 dateline、栏目眉、刊尾 colophon、语义色指标条与双框验定印章 |
| feat | cds | 验收报告正文证据升级为档案图版（图号 + 图注 + 状态标签 + 放大入口），截图填满画布并支持大图灯箱（方向键翻页 / ESC 关闭 / 无 JS 退化为打开原图） |
| fix | cds | 修复验收报告失败与风险证据的红黄标签渲染成空色块（data-label 挂在 banner 上、伪元素却挂在段落上，取不到文案） |
| fix | cds | 修复验收报告重点卡泄漏原始 markdown 链接语法，并去掉与标题重复的单元格 |
| perf | cds | 验收报告工具条吸顶并显示命中计数，筛选同时作用于表格、证据卡与重点卡；新增回到顶部与阅读位置高亮 |
| fix | cds | 修复验收报告在 CDS 内嵌窄视口下锚点跳转被吸顶导航遮挡 |
| test | cds | 补 reports 准入用例：改版后的检验档案骨架仍通过 acceptance_html_template 血统校验 |
| fix | cds | 压测出对比结论前先核实落点：观测到的 X-CDS-Replica 与期望副本不符、或两个落点被同一实例服务时拒绝出结论（否则是拿同一版本跟自己比还贴标签）；一条标识都没观测到时数据照给但标注未核实 |
| fix | cds | 压测请求补挂钟死线：http.request 的 timeout 是 socket 空闲超时，压 SSE/持续分块端点时对端定期发字节即可让它永不触发，请求 Promise 永久挂起、占住全局唯一压测槽位 |
| fix | cds | 修复状态页在 React.StrictMode 下永远停在骨架屏：mounted ref 只在 cleanup 置 false，第二次 setup 没置回 true，所有响应被丢弃 |
| chore | cds | 按「同一 PR 一个碎片文件」的规则把本 PR 的五个 changelog 碎片合并为一个 |
