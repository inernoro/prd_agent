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
| fix | cds | 修复存活探测等 body 结束导致整个监控停摆：被探服务根路径若是 SSE/持续分块输出则 end 永不到来，socket 空闲超时也不触发，runCycle 的重入锁再不解开、此后所有轮次全被跳过；改为拿到响应头即结算并拆连接 |
| fix | cds | 修复批量清理漏传 scheduler 固定名单：只配在 scheduler 那侧的 pin 挡得住降温与 janitor，却会被 /cleanup、/cleanup-orphans、cleanup-stopped 删掉 |
| fix | cds | 压测落点核对补上副本组（X-CDS-Replica-Group）：成员 id 跨 profile 会重名，只看成员 id 会把「路径解析到别的服务」误判为核对通过 |
| fix | cds | 修复缺陷转发 submit 返非 2xx 时静默报成功：单子其实还躺在草稿态，现在如实回传「可能仍是草稿态」及状态码 |
| security | cds | 缺陷本地留存补保留策略（条数上限 + 附件总量上限，超出从最旧的回收）：此前每次提交最多写 12MB 附件到数据卷且永不回收，反复调用即可写满盘，而部署侧磁盘刹车罩不到该路由 |
| security | cds | 压测占位者按项目脱敏：压测服务是全局单例，项目级 Key 此前能从列表与 409 文案里拿到别的项目的分支/服务/任务 id 与起始时刻 |
| fix | cds | 修复跨天存活历史返回一整片空桶：原始采样只留约 24h，7d/30d 改用按天聚合铺点，24h 仍走原始采样 |
| fix | cds | 修复窄屏可用率柱条只覆盖约 10.7 小时却标注「覆盖最近 24 小时」：改为按实际展示段数向服务端要桶，而不是拿 90 段砍掉最早的 50 段 |
| fix | cds | 连接重置不再当成「这不是 HTTP 服务」的证据：正在崩溃/OOM/过载的 HTTP 服务同样会重置连接，旧判定会把它永久降级为按容器状态判定，于是持续崩溃的服务一直显示绿色（假绿） |
| fix | cds | 压测落点核对改为要求全部观测身份一致：只看占比最高会放过 rs-a:90/rs-b:10 这种混流，100 个样本里混了 10 个打到别的版本仍被当成纯净落点进 A/B 指标 |
| fix | cds | 转发成功但截图未跟随/流转失败时，前端结论文案带出 degradeReason，不再只说「已提交」 |
| fix | cds | 提 bug 面板在前端就拦附件总量：四个各 5MB 单独合法但合计超后端 12MB，此前要等上传完才被整单拒绝 |
| security | llmgw | console-api 缺陷本地台账补按租户保留上限：附件 base64 直接进 Mongo 文档且无 TTL/配额/回收，反复提交可撑爆网关库 |
| fix | cds | 恢复出厂设置不再留下僵尸主干：保留分支条目却清空它依赖的构建配置/路由/环境变量/基础设施，会让主干既无法部署路由也已断，而响应仍宣称「已保留」；改为存在主干且未带 confirmTrunk 时整体拒绝并说明两条出路 |
| security | cds | 缺陷本地留存的保留策略改为按提交方项目分桶：全局一刀切会让一个吵闹的项目挤掉别的项目的本地留存，而未配置 MAP 转发时本地留存是唯一副本 |
| docs | cds | 新增发布系统改进方案 doc/plan.cds.release-system.md（生命周期与可观测性四阶段计划） |
| fix | cds | 修复内嵌 master 持有的本地分支（executorId 为 master-*）被误判为远端而永久排除出存活监控；分支归属判定收敛为唯一判定源 executor-ownership，此前散在三处内联字面量正是这次漂移的根源 |
| fix | llmgw | console-api 缺陷转发 submit 返非 2xx 时如实回传「可能仍是草稿态」，不再只记日志而让 UI 无条件说「已提交」 |
| fix | cds | 修复左下角提交记录浮层压住常驻导航栏的图标：它裸贴 left-4，而桌面常驻 rail 宽 72px，正好盖在导航图标上 |
| fix | cds | 修复右下角更新徽章压住提交缺陷入口：入口此前自成一套 fixed 定位，与右下角唯一提醒区几何重合且层级更低，被压住半句 |
| fix | cds | 修复窄视口下右下角提醒区一路铺到屏幕最左压住导航图标：宽度只减两侧留白、没有减去常驻 rail |
| refactor | cds | 底部左右两个浮层坞收敛到唯一定位者 .cds-bottom-docks：由它统一让开 rail、两侧留白并在窄视口自动折行，两个坞退化成带内 flex 项，不再各自贴角、互相不知道对方存在 |
| refactor | cds | 浮层坞元素解析抽出共享 hook lib/useOverlayDock（effect + MutationObserver），消费方不再各自内联 querySelector |
| test | cds | 新增底部浮层带守卫用例，并修正一条把缺陷写进契约的旧断言（原本要求 CommitInbox 必须自己 fixed bottom-4 left-4，那正是本次遮挡的成因） |
| fix | cds | 修复生产发布被 CDS 重启腰斩后永久锁死发布目标：run 停在 running，在途守卫据此拒绝该目标的一切新发布，只能改库才能恢复；新增执行心跳（30s 打点，覆盖 SSH 长静默阶段）+ 启动收一轮 + 每 5 分钟周期收割，与分支部署侧 15 分钟过期口径一致 |
| fix | cds | 自更新排空口径扩展到生产发布：此前只排空分支部署、压根不知道发布存在；两条生命周期的 running 语义相反（部署侧是成功终态、发布侧是在途），故 run 带 kind 区分，各走各的穷尽式终态表 |
| fix | cds | 发布状态终态判定改为穷尽式 Record：漏判会让在途守卫放行两个并发发布，改后新增状态在编译期即报错 |
| fix | cds | 发布命令补执行超时（默认 30 分钟，CDS_RELEASE_EXEC_TIMEOUT_MS 可覆盖）：SSH 的 10 秒是连接超时，远端脚本挂住时流不会 close，run 永不终态、目标被永久锁死；预检类探测另用短超时，不占 HTTP 生命周期 |
| feat | cds | 发布失败落结构化事实 failure（复用分支侧 DeploymentFailure 的 code/owner/retryable/evidenceRefs/suggestedAction，不另发明字段）；新增发布链路特有的失败规则（SSH 传输 / 健康探测 / 执行超时），其余委派给既有分类器 |
| fix | cds | 删除从未被赋值过的 ReleaseRun 状态 prechecking，并把状态联合提取为具名类型 ReleaseRunStatus |
| fix | cds | 补齐发布控制面 12 条 Activity Monitor 中文 label 的动态路由 pattern：staticMap 的 :id 条目只够启动自检，真实调用带具体 id 时整条发布链路在面板上都是裸 URL；一律用 segment-safe 匹配，子路径排在裸 id 之前 |
| test | cds | 新增发布生命周期 53 例回归：心跳过期收敛、状态怪异的存量 run 强制终态化、收割器不叠加不拖垮主流程、排空区分两条生命周期、终态表穷尽性 |
| fix | cds | 压测落点核对补上无标签样本：成功但没带 X-CDS-Replica 的响应压根不进 servedBy，等于从核对视野蒸发，却照样计入延迟/QPS/成功率——90 条带标签 + 10 条走了非副本路由仍被判为纯净落点。改为「拿到过标签的落点，其每条成功响应都必须带标签」，全无标签的落点仍走既有软档 |
| fix | cds | 修复发布启动收敛沿用周期收割的心跳阈值：进程刚起来时不可能持有任何执行体，心跳是上一个已死进程打的，用它当活性证据会让刚打过心跳就被重启的发布继续堵住目标至少 15 分钟；启动轮改为收敛全部非终态 run，周期轮保留心跳阈值以免误杀正在执行的发布 |
| fix | cds | 收割器写日志失败不再吞掉整条收敛：日志是装饰，解锁才是收割器存在的理由，一次日志异常不该让发布目标继续永久锁死 |
| fix | cds | 修复自更新排空对生产发布「建好了但没接线」：deploy-drain 早已支持发布口径，唯一调用点仍只喂部署 run，于是重启会在预览部署落地后立刻把正在跑的发布 SSH 拦腰砍断 |
| security | cds | 修复缺陷附件字节配额仍是全局公共池：条数保留已按项目分桶，字节回收却按全局时间正序删起，一个项目猛提即可删光别的项目的截图，而项目级 Key 就能触发；改为每项目上限 + 全局硬顶时总是先削当前占用最大的桶 |
| test | cds | 新增四条 P1 的回归（含逐条红绿闭环）：无标签样本拦截与软档不误伤、启动收敛 vs 周期收割语义、附件回收跨项目隔离的真实文件行为、排空调用点确实喂了发布 run |
| fix | cds | 修复取消发布后目标被提前释放：abort 只是「请你停」不是「已经停了」，最终入口探测是普通 HTTP 请求不接 abort，取消时仍在飞；此前立刻摘牌 + 把 run 打成终态，在途守卫遂认为目标空闲放行下一次发布，等老探测失败又走自动恢复把上一版本 SSH 推上去，正好盖掉刚开始的新发布。改为摘牌交给执行体真正退出时，并新增「执行体尚未退出」的占位判定 |
| fix | cds | 取消之后不再执行自动恢复：用户已经喊停，却把上一版本推回目标机器是越权副作用 |
| fix | cds | 压测落点核对不再豁免主实例：没有响应头的情况上游已挡掉，走到核对就是有头，而 forwarder 主路由明确打 replicaMemberId='primary'，有头却不是 primary 只能是钉选失效；豁免会放过「主实例被摘除、请求落到未被选中的 rs-a」而照出 A/B 结论，标签是错的 |
| fix | cds | 缺陷附件写盘失败不再静默：此前只清掉文件名就回 201 说「已记录」，用户以为截图在里面；现在 degradeReason 点名丢了哪几张，并删掉不在账本内的半截残片（否则成永久占盘的孤儿文件） |
| test | cds | 新增第四十轮四条回归（含逐条红绿闭环）：取消后目标占位与自动恢复抑制（真实 SSH 执行器 + 两段式健康检查服务器复刻「取消时探测还在飞」）、主实例身份核对、附件写盘失败如实告知 |
| security | cds | 缺陷正文补长度闸：不带附件时 description 可吃满近 24MB body 并原样写进 records.jsonl，按项目保留 200 条即可把台账推向 GB 级，且每次回收都要整文件读回解析——磁盘写满/进程 OOM 都会先于附件配额发生；改为标题 200 字、描述 2 万字、正文 4 万字截断并留明确标记（不整条拒收，用户写的复现步骤不该丢） |
| fix | cds | 修复附件写盘失败的说明没落进账本：degradeReason 是在记录 append 之后才补的，本次响应看得到、后续 GET 读回来仍是没有解释的旧值；persist 拆成 writeAttachments + appendRecord，记录定型后才落账本 |
| fix | cds | 存活监控采样容量改为按探测间隔推导：写死 1440 条时把间隔调到 10s 只剩最近 4 小时，可 summary 仍按 24 小时口径计算并标注 availability24h，前面 20 小时被当成「没有数据」既不画也不计入百分比；默认 60s 档容量不变（零回归），绝对上限封在 8640 条 |
| fix | llmgw | 补齐缺陷转发的附件上传：网关此前只 create + submit，从不把截图传到缺陷系统，MAP 收到的是「说有截图但没有截图」的单子而 UI 照报「已提交」（CDS 侧早已修，网关一直漏着）；上传失败如实降级，且不覆盖 submit 的失败说明 |
| fix | llmgw | 修复前端附件总量闸与后端不同口径：前端量解码后字节、后端量 base64 字符，差 4/3 倍——两张 5MB 图在前端按 10MB 放行，转 base64 约 13.3MB 被后端拒绝，用户挑完图等完上传才被整单拒 |
| test | cds | 新增第四十一轮五条回归（含逐条红绿闭环）：文本长度闸、降级说明落账本、采样容量随间隔、llmgw 附件上传顺序与两端口径一致的源码守卫 |
| fix | cds | 回滚补上与发布同一道并发闸：此前 startRollback 一道闸都没有（连状态在途判定也没有），取消一次发布后紧接着回滚，会和尚未退出的老执行体并发往同一台机器写 SSH，线上最终留下的是「谁后跑完」的那个版本；并发判定抽成唯一判定源 assertTargetFree，发布与回滚共用，杜绝再次只补一边 |
| fix | cds | 修复跨天可用率的天数与标签对不上：dayKey(now-7d)..dayKey(now) 在 now 不是 UTC 零点时实际跨了 8 个自然日，窗口外那半天的故障也被算进「最近 7 天」；改取 now-(N-1) 天，恰好 N 个自然日 |
| docs | cds | 状态页 7 日可用率标注为「近 7 日」并加 tooltip 说明口径是自然日（UTC，含今天）而非精确到秒的滚动窗口——跨天窗口只有按天聚合可用，标签必须说清 |
| fix | llmgw | submit 抛异常的分支同样拼接降级原因：此前只补了非 2xx 分支，submit 抛异常时用户只被告知「可能是草稿」，完全不知道截图也丢了 |
| test | cds | 新增第四十二轮三条回归（含逐条红绿闭环）：回滚过闸与并发判定唯一性、7d/30d 恰好 N 个自然日、llmgw 两个 submit 失败分支都拼接降级原因 |
| fix | cds | 自更新排空闸上移到 app 级：它此前只是 branches 路由器里的一段中间件，而生产发布在另一个路由器（/releases/*）里从不经过它——排空最后一次轮询之后仍能开启新发布，再被重启把 SSH 拦腰砍断；判定收敛为 isDrainBlockedPath 唯一源，覆盖分支部署 + 发布发起/回滚/重试，只读与 stop/cancel 等自救动作不受影响 |
| fix | cds | 历史曲线与可用率共用同一个自然日边界 calendarDayWindow：曲线侧仍在用 now-range 做起点，7d 会返回 8 个桶且首桶早于返回的 from（上一轮只修了可用率一侧） |
| security | llmgw | 网关提缺陷补文本长度闸（描述/正文/标题/环境键/附件元数据）：此前只判空不判长，多兆字节正文原样进每份 Mongo 文档，而每租户 100 条只管条数不管字节，反复提交仍能吃掉约 1GB/租户；数值与 CDS 侧逐一对齐，并加跨端一致性守卫 |
| test | cds | 新增第四十三轮三条回归（含逐条红绿闭环）：排空闸覆盖两个路由器且挂在它们之前、曲线与可用率同判定源、llmgw 文本闸与两端上限一致 |
| fix | cds | 附件删除失败时不再扣减配额账目：unlink 因只读盘/权限/瞬时 IO 失败时仍减字节并清账本引用，文件还占着盘却从所有配额计算里消失，反复失败即可同时绕过每项目上限与全局硬顶；改为只有删成功（或 ENOENT）才动账目，失败的仍留在账本里等下轮再试 |
| fix | cds | 转发成功但本地账本写入失败时不再静默返回 201：已落盘的附件不在账本里，回收永远发现不了（永久占盘的账外孤儿），用户也不知道 CDS 这边没留底；改为就地清掉这些附件并在 degradeReason 如实说明 |
| security | llmgw | 补 source 字段长度闸：只截了标题/描述/正文，source 仍原样落库，前面几个上限等于白加 |
| test | cds | 新增第四十四轮三条回归（含逐条红绿闭环）：删除失败不扣账目、账本失败如实降级并清账外附件、llmgw source 截断守卫 |
| fix | cds | 自更新排空闸补显式开闸：endSelfUpdateDrain 此前是从未被调用过的死代码，一次没真正重启进程的自更新（fast-forward / spawn 静默失败）会把部署闸晾满整个 fail-open 窗口（默认 6 分钟），期间每次 webhook 部署都拿 503 + 红灯 CI（本 PR 2026-07-28 实际中招一次）；改为 spawn 失败且不退出时立刻开闸，并加 15 秒看门狗——重启真生效时进程已退出，定时器随之消失 |
| security | cds | 缺陷环境字典补条目数上限（40 条）：只截键和值不够，几万个不同的键照样能拼出多兆字节的无附件文档，把「按条数保留」的存储上限整个架空 |
| security | llmgw | 网关同上：环境字典条目数封顶，与 CDS 侧同口径 |
| fix | llmgw | 本地台账写入失败不再覆盖前面的降级说明：截图没传上去 / 可能仍是草稿态两条会被抹掉，用户只看到「台账写入失败」 |
| fix | cds | 状态页有「待确认」目标时不再报「全部服务正常」：首轮探测中或连续失败未到去抖阈值的目标会被绿色横幅盖住，而同一张卡下面就写着「待确认 N」，自相矛盾；改为琥珀色「N 个服务状态确认中」 |
| test | cds | 新增第四十五轮三条回归（含逐条红绿闭环）：环境条目数封顶、状态横幅优先级、llmgw 台账降级不覆盖 |
