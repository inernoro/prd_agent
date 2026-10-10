# CDS 与 IMP 极速长效联合目标 Brief

版本：v1.34；日期：2026-10-11；状态：active。

Goal: 完成共享CDS的可响应、可恢复极速交付，并使IMP完整服务实际极速；原生目标已创建，无用户未指定的预算。
Target brief: 本文件，两仓库同副本；逐项任务与实施状态见 `plan.cds-imp-express-durable.md/json`，独立验收账本在仓库外。
D-Ready: Passed（本地设计基线、TDD与独立工作树实施）；生产验收准入尚未通过，精确运行SHA、完整服务图和隔离负载宿主必须补证。
Baseline decision: CDS从已有运行修复分支4b2a91ff6集成origin/main 95a64076c；IMP从最新origin/test e2fd7c8f5检出，保留原目录未提交改动；不修改既有任务或监理状态。
First execution step: 冻结49条任务与独立红绿账本，完成集成基线验证，然后编写执行隔离红测。

## 经营目标、对象与责任

降低开发等待与中断风险。管理对象为交付目标、任务、制品、运行容器、路由和验收证据；平台操作者判定等待原因、取消过期目标、部署、验证和回滚。管理闭环为目标提交→完整制品→准入→就绪切换→真实入口与版本→验收归档。责任主体以可验证来源身份记录，未知不猜测。证据资产为精确SHA、run、镜像摘要、阶段耗时和可回读报告。

不改变IMP产品标识、业务角色或CL业务合同；CL编号=N/A（技术交付与运行保障，不重定义经营业务命令）。适用工程依据：IMP `10-可观测性架构.md` v1.60及极速制品合同；CDS既有长期治理蓝本A01–A12、生产发布安全规则。正式IMP业务回归如涉及CL命令，则验收设计按当前检出合同另行绑定版本，不从技术目标推导业务pass。

## 当前能力与反审查

保留现有Forwarder、增量存储接口、执行器、就绪/版本检查、鉴权、分支隔离和已上线止血修复。旧实现只作事实：Master native spawn、整份状态复制、全局订阅、配置型闪电和过早删旧容器需要按证据重构。API路径和权限尽量保持兼容；任务状态/镜像事实的增量字段和错误语义须先写本目标契约并配兼容测试。不扩大成员权限、不开放凭据。

旧业务/DDD主事实无变化；旧指标需拆开构建与各类等待，不能用source gate为零证明不卡；旧页面需从真实模式、分母与目标漂移给出可操作结果。菜单位置不改变，用户在现有项目→分支→详情/部署页完成判断与动作。

## 数据、设计和边界

不新增或改动IMP Flyway迁移，不重建共享/持久库，不在生产注入OOM/失败风暴。不激活真实XXL定时作业或共享消息消费以凑覆盖。完整worker验收须先证明隔离依赖；若需要数据库写入使用现有run-scoped资源合同。一次性bootstrap先验证所属run结束证据再回收，不能隐藏分母或用整分支删除代替。

潜在涌现观察点：可复用制品集合证据、阶段等待责任、单写入运行坐标和实际服务分母。仅采纳的终态规则或有责任的backlog登记；不为已修一次性细节增设治理条款。

## P3 候选替换设计合同（本地部分实现，不作为已通过证据）

同一交付冻结完整目标SHA、配置指纹和服务图。在线BranchEntry.services继续指向旧实例；候选使用独立容器名、端口和交付级应用网络，保持原branch/project标签并另加run/generation归属。候选服务图在私有运行上下文中解析依赖，不能将旧网络别名与新实例混用。候选记录在创建前可靠落盘，只存身份、版本引用、阶段与运行事实，不复制凭据。

切换顺序：完整制品准入→容量准入→创建候选→完整图就绪→复核租约和目标→可靠保存切换意图与恢复点→发布新路由→核验实际路由消费者已应用完整目标映射→记录切换完成→回收旧实例。publishNow返回写文件不能替代Forwarder消费者确认；Master直连也须校验实际映射。路由确认失败先恢复旧映射并核验，未确认恢复时保留实例与容量事实，不盲删候选或旧实例。

worker默认不能双实例消费；必须有可验证隔离/租约才允许并行候选，否则采用已声明的stop-and-restore约束：保留旧容器及不可变配置，短暂停旧worker后启动候选，失败恢复旧worker。固定宿主端口或独占写卷同样不承诺无中断；缺兼容性/恢复证明时准入失败，不能试运行后再猜测数据是否安全。此目标不自动授权业务库migration或真实消费测试。

恢复依据必须在stop/create前可靠保存：旧容器的不可变ID、镜像ID、原运行意图与完整运行配置的不可逆摘要，以及候选的精确目标SHA/镜像ID；摘要包含归属、端口与挂载变化，账本不复制挂载选项明文或环境凭据。缺少或未知代际的历史恢复依据不能用于自动恢复/回收，须保留待核对。停止消费者前另冻结匹配其实际提交、镜像及合同分代的旧部署版本ID和摘要；恢复使用原版本启动信号与就绪探测，未released引用保护其免于历史裁剪。旧映射ACK不能替代旧worker恢复完成；实际候选清理、原ID启动、原就绪、持久化及旧路由再ACK完成前，不得释放回滚预留。

取消先终止归属执行进程，再按run/generation清理实际候选容器与网络，释放真实容量；Docker客户端被终止不等于Daemon侧创建已停止，须对账后交给下一写入者。重启时读取候选/切换记录与实际容器及路由对账，未确认切换不自动将候选当运行版本。正常旧实例、其他分支、已推进协作者版本不能被候选清理器回收。未进入starting、没有stop/create且归属/旧图保持冻结的本地prepared拒绝，可在释放快照可靠落盘后释放预留；其他未知状态仍须Daemon对账。恢复阶段失败以有界阶段码保存并显示待对账，存活不能替代就绪。

候选创建时序须把逐服务创建意图先落盘；Daemon创建返回后，实际inspect确认的不可变ID与配置摘要须在连接共享网络或启动前落盘。并行服务以同一run的串行持久化边界合并，不丢失已确认身份。后续连接/启动失败不能丢掉已创建ID；取消后未确认的创建结果仍须保留，客户端结束和缺失快照不能替代Daemon闭合证据。

TDD先红：候选create/start/readiness任一失败旧路由仍可服务；固定端口/worker/独占卷约束；消费者未确认不得删旧；取消在create和切换前两窗口；回滚失败保留可恢复事实；执行器/Master重启未知中间态对账。真实独立验证另覆盖完整八分支和所有运行角色，不由纯函数/Mock测试继承通过。

私有网络创建意图先落盘，实际inspect确认的网络ID和完整配置摘要在应用create前持久化，不存IPAM/Options明文。失败回收按原网络ID核对归属、配置与实际端点，不能删除仍占用/未知网络，也不强行断连；实际删除并复查消失后才继续旧消费者恢复。网络晚创建或重启未知状态仍保留待Daemon对账。受控整分支入口缺网络核验绑定时失败关闭。

恢复写入须独占整分支并绑定唯一终态未释放run，取消或取代后旧执行的等待仍受跟踪；原执行用原租约真正完成前，不因active空或后继stop完成而开始恢复。旧generation重复完成或复制lease不能撤销后继。该内存租约门禁不能在重启后或Daemon晚创建情况下作为闭合证据。私有网络回滚，即使未停止worker，也须在实际网络回收后才released。

自动恢复只接受原执行在最后一个候选外部动作结束后可靠保存的收尾回执，回执绑定候选冻结事实摘要；原进程崩溃且没有回执、创建意图没有确认ID、网络意图没有确认ID、停止意图没有确认停止，均保留待对账，不以进程消失或名字暂时不存在推断成功。已确认身份的失败旧图恢复按独占租约核对旧图、原版本和停止控制摘要，先回收候选及私有网络，再恢复原消费者、原就绪、持久化和路由ACK，最后可靠保存released。用户/调度器停止、旧图推进、新图已发布、未知历史记录不得自动恢复旧图。自动恢复入口串行有界扫描，失败保留预留并输出有界原因；真实重启/Daemon验证仍须另行验收。

精确单服务部署先检查声明dependsOn的项目内应用传递制品闭包，基础设施仅从应用制品集合排除；Profile缺失、跨项目、依赖循环、非exact预构建依赖都失败关闭。以本次目标展开模板，旧CI缓存或首次空缓存不能改变制品目标。此检查不隐式重部署依赖，也不让制品通过替代依赖真实就绪。自动恢复组件每次扫描同样最多一条，不开放批量恢复入口。

## P2 故障诊断有界合同

e5fd故障诊断IO按完整容器ID及项目/分支/Profile/交付归属合并：1在途、16排队、5秒排队过期、完成后5秒/64项缓存；mutable name/短ID不缓存，启动与健康恢复使同ID旧cache失效、旧pending不重入cache。低优先级执行并在CLI侧投影inspect，不复制解析失败原文。主20事件触发40命令是真红，修后2命令且20事实/回调仍保留；malformed inspect敏感原文泄漏是真红，改有界错误后绿。缓存/归属/重建/满载/排队过期/异常等相关69、显式tsc绿。只验证IO预算，不声称异步旧事件回调顺序、批量巡检或真实事件风暴/公网性能通过；独立固定检查点待验。 该临时实施说明在P2-04真实报告及自动门禁接管后退场。

Docker生命周期诊断异步完成后，状态回调另带不可变容器ID与本监视器启动代际资格。create/start/restart/unpause或健康恢复推进同名/同ID代际，旧等待的事件仍归档但不得再改状态；已发布服务具有不可变ID时，异ID或未知ID事件不能修改后继服务。历史无ID服务仍保留旧读取兼容，不把它算作不可变身份守卫通过。该局部门禁不能替代重启后Daemon对账或真实事件风暴验证；P4真实报告与自动门禁接管后退场临时实施说明。

分支SSE支持项目及单分支订阅，项目密钥强制限定所属项目，未知归属不向有范围的连接发送；权限仍逐事件检查。慢连接的res.write返回false后不再序列化或写后继事件，不保存逐事件积压，只记需要重同步；drain后发送当前范围的同步快照及resyncRequired，页面另取权威GET复核，不把原始快照直接当完整列表替换。单帧上限256KiB、socket积压与待写帧合计上限512KiB，持续阻塞5秒或越界即清理监听并断开；客户端断开不取消交付。已知分支按State核验归属，冲突事件拒绝；服务buildLog不复制入状态帧或增量patch；save清空列表cache/inflight，旧计算不能回填；详情重同步GET不卸载当前页面。此通道不是审计事件回放，关键历史仍以run记录为准。只实现分支流不能宣布其他SSE端点、100连接故障负载或公网性能通过；P4-03真实报告及自动门禁接管后退场临时实施说明。

JSON持久化在慢IO期间只保留一个在途不可变快照、至多一个显式flush冻结的待写快照及最新脏引用，不为跨tick普通save累积全量字符串队列。flush冻结当时内容并绑定逻辑代次，较新完整快照可覆盖中间代次；已失败的等待者不得被后来成功改写为通过，较晚序列化失败不得使已有有效在途/待写边界失败。主文件tmp/fsync/rename、权限与备份合同不变。此限量不等于JSON增量格式、后台序列化或主线程无阻塞；这些仍须P4-01实际性能与持久化分母验证。自动门禁及正式P4报告完整接管后退场临时实施状态。

卡死巡检的运行差异查询不得在Master同步execSync。只对完整40位提交对做只读git查询，工作目录以exec cwd传递；一个低优先级任务在途、至多64个去重目标，排队及执行各有5秒边界。不可变提交对成功结果最多缓存512项，失败不缓存；查询未知期间不伪造运行差异告警，后续巡检使用已取得的证据。 同轮枚举后按上次实际尝试身份循环准入和执行，失败也推进，未执行过期不推进；满载保留轮转最近目标。此迁移不证明所有子进程热点或公网延迟已解决；P2-06正式实际Master性能门禁接管后退场临时实施说明。

兼容self-status流另接共享selfStatusCache，不为每个连接重复Git查询；首屏缓存和去重后台refresh；订阅读取加入在途不标脏、不覆盖pending terminal；snapshot/update/drain保留degraded.reason/message/reasons及drain最新快照、帧/总积压/5秒截止与断开不取消任务均按前述状态流合同验证。统一bus与命令流仍须另验，不继承正式性能通过。P4-03正式压力门禁接管后退场本临时实施说明。

## P3 请求范围和合并合同

按实际同项目/分支/服务范围、完整固定目标与配置加入在途；源码入口不以请求SHA声明固定。待执行目标按范围保留最新版本，64每分支/512全局；同范围替换不占新槽，超限明确拒绝。完成仅取无冲突在途或未消费force-rebuild续约的目标，到期清理后确认该pending仍存在；单服务重放保留服务URL与请求SHA。手动单服务无完整目标/配置或携版本/一次性选项保持拒绝，不自动在stop后重启。force-rebuild续约按范围保存原operationId，stop清全部，到期只清冲突范围。重放按有界观察合同记录完成/失败/受理/未知，超时或断流不自动重试，不取消执行或释放预留；观察不复制凭据。进程内协调不替代durable队列与真实Daemon恢复。P3正式自动门禁及报告接管后退场临时实施状态说明。

## 验收与真实收口

严格采用计划v1.3公网和48小时门槛；八分支完整服务验收、失败保旧、取消恢复与双主题视觉证据必须同时成立。输出页面、交互、命令、权限、闭环的enumerated/mapped/executed/closed_loop_pass/failed/blocked/uncovered，不传播旧SHA结果。阶段通过不关闭原生目标，尚无线上视觉pass。

## Goal State

- Goal ID / 名称：CDS-IMP-EXPRESS-DURABLE-20261010 / CDS与IMP极速长效联合修复
- 当前阶段：implementation
- 执行坐标：`worktree=CDS:/Users/inernoro/.codex/worktrees/cds-express-durable-20261010/prd_agent,IMP:/Users/inernoro/.codex/worktrees/imp-express-durable-20261010/mdimp；branch=CDS:codex/cds-express-durable-20261010,IMP:codex/imp-express-durable-20261010；HEAD=CDS:d1a56ac49b4117eef0e832a0dc6074ff23cc50f0,IMP:35d1581566f4ac45c6a0406f073b9742a5ba5d50（计划文档）（实施检查点，后续计划文档提交另计）；origin/main=CDS:45533b419e1cfc54b145a545a716563617659d01,IMP:2bf49bf92a634057b65d40e0c5e9faa3ed02ae9c；ahead/behind=CDS:141/0相对origin/main,IMP:27/0相对origin/test；environment=本地独立工作树,线上只读探测；database=N/A本轮未写入；tenant=N/A平台基础设施；role=本地主进程,线上机器只读；route=https://cds.miduo.org/branches/defd4695ab5f；auth=本地无登录要求,线上现有CLI项目凭据不输出；external_ids=bootstrap dr_23b50418a7954b2a41e6f2b4(其他任务活动,不操作)`
- 写入所有权：`owner=本任务/root仅两新工作树；other_tabs=原任务工作树read-only,tail_acceptance只写仓库外账本；handoff_checkpoint=本地P1/P2/P4与IMP exact合同部分实现,已保存固定本地SHA,未发布`
- 范围账本：`goal-core=49条计划与完整极速/控制面治理；required-prerequisite=集成已有CDS修复及隔离验收依赖；environment-recovery=仅基线盘点,不重建持久数据库；successor-or-non-goal=业务流程重写,真实定时作业恢复,其他任务目标关闭`
- 已确认范围 / 非目标：两仓库技术交付目标,不扩大IMP业务分母或改CL合同。
- 当前实现事实：两独立工作树与49项双副本计划/TDD已建立。P1精确制品/版本引用/cache digest及新发现真实prebuilt缺省默认部分实现；P2执行Worker/supervisor硬中断、ACK背压/调度和日志热点迁移部分实现；P3取消贯穿租约、Shell、pull、run、启动信号、TCP/HTTP/retry/日志，私有候选身份/网络/账本、全部运行事实冻结、实际Forwarder ACK、切换/失败回滚、worker/可写卷停止恢复约束、版本字段冻结和整分支受控入口已接本地代码。P4真实JSON多等待屏障、durable run暂存及空清单/整分支/单服务可靠终态，实际覆盖/黄蓝/独立版本状态部分实现；普通删除失败保留身份、版本与端口。IMP13角色exact合同及权威文档已校准。本地取消终态归类修复已独立13/13；启动/自动重启按canonical身份扫描，通用reaper保护未released两图与candidate/protected；canonical-name未知归属不报告missing；未released新写入准入已接coordinator/index与直接候选编排，stop显式待对账。所有改动仍未发布；P3其他入口、Daemon取消/重启/网络回收与恢复协调、P1旧默认迁移/依赖、P4增量/SSE与Mongo、IMP辅助生命周期及完整生产证据未完成。 systemd命令共享Worker、实际path/inode唯一writer、回滚归属与最终结果fence已固定本地实现，独立37/37；直接异步递归回收草案因新owner误删真红已否决并还原，不作完成。
- 本批实现检查点：2ea固定独立44项41绿3红（未消费续约时pending提前出队）；ec939原44及新增3共47/47局部复绿，删除Map存在守卫1真红。原3红保留；相关313/core tsc绿。 efcdaf0dc21687fbcecb6af0b0fafaaa953fdfc0重放观察：5秒响应头、30分钟观察、256KiB帧/16KiB解码片；非2xx不读正文，complete.ok/错误/mergedjoined/unknown分别记录，只记有界枚举及合法run ID；不重试或取消实际执行。实际入站HTTP＋fake出站/Docker5旧红→5绿，观察器13及协调/路由共331局部绿、core tsc绿；efcd固定独立实际自有HTTP/native fetch23项21绿2真红（complete.ok=true却带started/rejected被误判完成）；明确cancelled被记失败也已发现。12ad新增有限状态及取消归因，主3旧红→绿，相关335/core tsc绿，固定独立待返。未改实际run，不把观察取消当Daemon闭合。 仍未实现durable pending队列，不证明实际Master/Daemon或线上通过。 八候选固定清单未变，独立8/8与280合同局部绿，104角色仅静态枚举，未push/未部署。
- 证据纪元：`target_sha=CDS:d1a56ac49b4117eef0e832a0dc6074ff23cc50f0,IMP:35d1581566f4ac45c6a0406f073b9742a5ba5d50；tested_sha=CDS:d1a56主66/core0/full9589,固定独立37/37；80e941独立29绿6物理归属红/full9583仅历史；1f977独立20绿1物理别名红仅历史；2642d独立31及full9562绿1HTTP超时仅历史；IMP:八候选280静态见清单；deployed_sha=N/A候选未部署；environment=本地独立工作树/自有进程,共享CDS与mycds只读；observed_at=2026-10-10T23:51:00.355904+00:00`
- 本批新增恢复事实：66fb固定独立自有nativeHTTP/StateJSON及实际index/route摘录17场景15绿2红：原项目p的branch被new-project替换仍派旧SHA、deploy-profile缺Profile扩大whole；第二仅helper合法类型允许的边界，不声称Router能产生。59d8736036cb6faa699fe73c506c5cce867eef39在派发前核原project/branch/范围，未知或漂移、缺Profile/矛盾或非部署kinddrop，日志归原来源；主3反例红→344相关绿/core tsc0。固定独立进行中，本SHA未再跑全量；66fb全量9552仅历史。
- 新鲜验证证据：59d固定独立59/59局部（重放原17+扩展7+observer24+实际Router失败4/取消4+观察socket外部abort后执行仍受租约控制2+真实默认5秒头budget1）；原66fb两scope红关闭。whole正例旧带Profile与State自动填legacy项目两轮夹具偏差原件保留，未放宽scope。66fb权限清理v2独立6/6：清理ACK未知memory gate/竞态更新409，磁盘若已完成cleanup则重载仅安全old=a、新b无grant，5flush确认后清账。v1要求此时磁盘仍有journal的探索红保留解释，不作越权或500修复结论。 dc2f7d0ce47584656d948e61d048f17696f0da26本地源码例外queue按冻结project轮转/同项目FIFO，匿名兼容组FIFO；默认512等待/30min上限，超量与过期明确失败且不取消运行holder，授予/取消/超时清timer/listener，onStart观察异常释放槽位。whole/profile两路实际传projectId、任何gate失败结束排队episode，日志/UI改等待总量不承诺绝对位置；tracker旧min位置断言退场并保留旧红。主5新反例真红→25 gate绿，5files288相关/core及web tsc0，固定全量655files9560绿/6files19skip/1obsolete snapshot/65.48s。独立固定复验进行中；phase公平队列、durable pending、实际Master/Daemon与公网未验。 原3635全量1红与受控3-vs-5夹具红、66fb9552绿各按固定源保留；所有正式49/视觉/8支仍未执行。
- 当前阻塞或环境限制：完整线上版本未证实、隔离压力宿主尚未核定；本机Docker CLI存在但守护进程无法连接，Colima状态不一致,未重启其他VM；本机16GiB已大量压缩/交换，不在其上新增压力VM冒充隔离验收宿主；原IMP索引158条超过60上限,只读reconcile无可归档终态,不猜测其他目标完成；本目标直接brief续接,索引登记待治理协调。 额外只读探测mycds SSH成功（Linux16CPU/约31GiB RAM），sudo -n Docker可读，承载大量他人及IMP/MAP常驻服务；2026-10-11 05:32 CST可用628MiB、swap8191/8191MiB、load2.25/26.60/33.20，不作隔离压力宿主，不停他人服务/启新容器。本机Docker仍不可达；隔离宿主问题待用户回复。
- 涌现决定：N/A尚无需登记的新终态机制；保留强门槛不以服务端指标替代公网。
- 下一动作与完成条件：固定d1a56局部独立37与full9589已闭合，本目标其余同步文件/磁盘热点、durable pending/阶段公平、P4增量/其他SSE、IMP辅助terminal receipt仍须同编号实施。直接异步递归删除草案新owner误删真红已否决，先做独占path与可恢复回收设计。原2642d HTTP超时未证明根因闭合；隔离宿主问题待答。准入后依既有授权push八支完整交付，按49项与双主题视觉、公网/恢复、48小时/一周门槛收口。
- 终止/接替结论：active

## v1.25 实际路由与长日志反例恢复审计

12ad固定独立自有HTTP24/24分类绿，实际Router/Coordinator/StateJSON另发现目标C的failed run误写旧B、held pull取消误报failed；真实nativeHTTP30,000小日志deadline同一promise累积29,624 reaction/GC后heap增长为真红。原件留在独立账本，均非线上压力证据。45dc526374b6ed31d7697063b338e6a0249f344d本批先复现主3红/1绿；target在artifact准入前冻结、actual租约失效归取消、pull/resolve后复核、未进入runService不清理旧容器；观察器单timer保留至多一个当前read waiter。新增worktree/artifact等待取消并真实StateJSON重载，相关340/340绿，core tsc0；固定独立复验进行中，全量尚未重跑。

expected result：失败/取消属于本次目标、旧运行实例保留、消息增加不累积截止反应。current evidence：主340/core tsc局部绿。visible result：新修订未部署、视觉N/A。gap：固定45dc独立复验及实际Master/Daemon/八分支/公网均未执行。required action：末尾原fixture复验，有红继续修；独立宿主准入后按原49条正式判据执行。

## v1.26 发布历史热点与固定复验

45dc固定独立34/34局部绿：原24 HTTP分类、真实Router失败run目标2、held worktree取消2、真实fakeCLI artifact等待取消2、30,000小帧heap1、deadline/后台Node CLI继续/绝对deadline3；原12ad三类真红原件保留。主45dc固定源全量651文件9523绿、6文件19跳过、1obsolete snapshot，64.23s；不能继承至71e。

71e331682a49052ab3a8828e226ae91ec66a5850发布中心提交历史/祖先比较迁移共享Shell Worker，完整ref tip冻结、同冷签名合并、32在途/128TTL缓存、旧结果不盖新目标；整轮3秒signal、超时unknown/null无提升，targets/run元信息浅冻结。主异步2红、input冻结1红、实际HTTP移除runner接线1红保留，相关68及core tsc绿。首版HTTPfixture正则只捕获git前缀导致缺nodes，修匹配后绿，该次为夹具错误，不是产品红。固定独立复验进行中；未关闭元信息clock/磁盘/其他热点或正式Master性能。

剩余：release-commit-clock发起时仍同步Git，systemd/startup/disk-root冷探测等需逐个核对；不能声称全部Master热点已迁移。49正式、八支完整部署和视觉仍未执行；既有推送授权保持，隔离宿主问题待用户回复。

## v1.27 三个历史查询缺口恢复审计

71e固定独立12/16局部绿，三个缺口：warm promotion重复Git（旧已存在热点）、second caller自身取消截止被忽略、empty环境history已超时仍推荐提升；direct和实际HTTP3s均留红。主新增三个反例3/3真红→修复：位置与promotion共用完整immutable pair的512成功缓存/64pending，短SHA/null不cache；shared caller各自观察signal，second退出不取消first；已过historyDeadline任何环境都不推荐。d2713c229e0c78a57feefb10151fcb47b9c8fb9d加fd113指南v2.43，相关83/core tsc0。fd113固定全量652文件9534绿、6文件19跳过、1obsolete snapshot，65.08s；71e原全量9530绿/1红/19跳过的红是已退场sync诊断静态守卫，不算线上500，改为实际parse CPU埋点后相关诊断12绿。独立fd113原actualWorkerHTTP v3 5/5，原protocol v2 10/11：唯一false要求TTL/eviction每次5个Git，但immutable pair缓存依法复用2个；保原10/11，末尾补只判确有重算且warm0的v3与新边界，尚未冻结最终总表。

最新fetch完成，origin/main(CDS)=45533b419e1cfc54b145a545a716563617659d01，origin/test(IMP)=e2fd7c8f5ebaed2561229a7864835949d1ce0904及origin/main(IMP)=2bf49bf92a634057b65d40e0c5e9faa3ed02ae9c未变化。未修改共享运行时、未推送候选、无新视觉；原生目标active，49正式未执行。


## v1.28 取消观察及元信息旁路检查点

fd113固定独立23/24局部，原三问题关闭，但history shared task保留每个已取消订阅reaction新真红：30,000次GC后heap21.97→105.60MB；追加count旧fd红22.00→90.44MB。58087508db6d1dcf7155730a801c37bb80d29636改为共享task单完成reaction与可撤销观察集合，主history/count两反例各2000reaction真红→54绿/core tsc0；初版vi.spyOn递归仅夹具错误，原件保留。580固定独立25/25局部，原history/count各30,000取消后max1reaction/heap22.61与22.73MB，actualWorkerHTTP5、protocol11、countbudget7保持；主固定全量652files9536绿/6files19skip/1obsolete snapshot/67.09s。

792baa5d597006145b7dd7f4b48ff6d22094dbf3将发布发起元信息git show移共享Shell Worker，公共runner抽独立模块保持rail出口；Router旁路void/catch不等待发布，32不同在途、同project/SHA/候选roots合并，候选共用3秒截止，不cache超时/late/失败，500台账及v1/v2/真实committer date保持。主async三反例真红→绿，移除Router注入自有HTTP接线1真红→还原；相关96/core tsc0。指南v2.44已同步；固定独立与全量进行中。同步台账文件load/persist、磁盘/启动及其他热点仍待核对；不作正式Master性能结论。

expected result：取消立即释放等待闭包、元信息不阻塞发布且仍是实际提交来源。current evidence：580独立25及全量9536；792baa主96/core tsc0。visible result：当前候选未部署、视觉N/A。gap：792baa固定独立和全量待返，所有正式运行门槛未执行。required action：按原反例逐条复验、继续既定实现并补隔离宿主；不能用本地通过关闭目标。

## v1.28 固定复验续记

792baa固定独立44/44局部，实际自有HTTP→ReleaseService hook→StateJSON→真实ShellWorker慢Git无Master native Git；8POST14–23ms，真实committer date保留；3秒取消owned PID已消失，不cache晚结果。固定全量653files9541绿/6files19skip/1obsolete snapshot/65.67s。

3635固定独立23/23局部：冷探测共享一次、epoch突变2红及index await突变3红保留、真实10秒截止及owned PID取消；仅自有假Docker info，未调用实际Docker。主tick13ms对旧470ms支持隔离；冷HTTP897–898ms比旧474–480ms更慢，不能声称冷请求更快。相关75/core tsc0。主3635全量652files9543绿/1权限恢复测试红/19skip，66.63s；故障20ms预算延续正常磁盘恢复触发安全重试，受控第3flush40ms复现3-vs-5红。

66fb1c9b8610ccc60d0ff575fcad0eeb7cea5761使index后台与route共用重放：原单服务错派整分支、私有错误体日志、HTTP200失败漏判、无响应无限等4真红→绿；新增整分支/受理/已删分支控制组。仅调整权限恢复夹具预算范围，另补清理超时保持409/原grant与真实JSON重载，提前放gate外部突变1红→还原。相关5files402绿/core tsc0；固定全量654files9552绿/6files19skip/1obsolete snapshot/71.27s。末尾固定独立进行中；内存pending仍非durable，不证明实际Master/Daemon/公网/视觉或八支通过。

expected result：两个重放来源维持原范围且观察有界，权限恢复确认前保持关闭。current evidence：402局部/9552全量及独立历史44/23。visible result：候选未部署、视觉N/A。gap：66fb独立复验及49正式运行判据未执行。required action：末尾固定复验、继续范围内修复并补隔离宿主，不用本地结果关闭目标。

### v1.28 重放归属独立红与修复

66fb固定独立自有nativeHTTP/StateJSON及实际index/route摘录17场景15绿2红：原项目p的branch被new-project替换仍派旧SHA、deploy-profile缺Profile扩大whole；第二仅helper合法类型允许的边界，不声称Router能产生。59d8736036cb6faa699fe73c506c5cce867eef39在派发前核原project/branch/范围，未知或漂移、缺Profile/矛盾或非部署kinddrop，日志归原来源；主3反例红→344相关绿/core tsc0。固定独立进行中，本SHA未再跑全量；66fb全量9552仅历史。

## P3-07 源码例外队列的有界公平合同

此门禁只服务显式源码模式与允许源码回退的项目；IMP exact 极速不进入源码队列，不能以此改进代替实际制品交付验收。相同项目FIFO、不同项目轮转，匿名旧调用保持同一兼容组FIFO；整分支与单服务入口均传实际projectId，不从分支名称猜项目。此前“前面N个”仅为等待总量，不能继续当绝对顺序承诺。

不提高构建并发；沿用宿主负载准入和原子槽位转移。等待上限默认30分钟（CDS_BUILD_QUEUE_TIMEOUT_MS有效10ms至6h），队列默认512条（CDS_MAX_QUEUED_BUILDS有效1至4096）；超限或过期明确失败，过期不是用户取消。不移除或停止持有者，超时/取消/授予时释放该等待者timer与listener。排队身份取入队冻结副本，状态下发原因、deadline、实际等待及配置上限；正常开始回调异常也不得泄漏已授予槽位。

先红判据：一个项目积压不能压住另一项目；队列满仍继续受理、无槽等待超时仍留队、来源被调用者后改、开始回调异常占槽均失败。固定容量/负载/取消/动态上限控制需保持原行为。此局部源码队列不是pull/start/readiness阶段队列、durable pending或生产性能通过；独立实际宿主仍按原49条验证。

## v1.29 源码例外队列与独立复验检查点

59d固定独立59/59局部（重放原17+扩展7+observer24+实际Router失败4/取消4+观察socket外部abort后执行仍受租约控制2+真实默认5秒头budget1）；原66fb两scope红关闭。whole正例旧带Profile与State自动填legacy项目两轮夹具偏差原件保留，未放宽scope。66fb权限清理v2独立6/6：清理ACK未知memory gate/竞态更新409，磁盘若已完成cleanup则重载仅安全old=a、新b无grant，5flush确认后清账。v1要求此时磁盘仍有journal的探索红保留解释，不作越权或500修复结论。

dc2f7d0ce47584656d948e61d048f17696f0da26本地源码例外queue按冻结project轮转/同项目FIFO，匿名兼容组FIFO；默认512等待/30min上限，超量与过期明确失败且不取消运行holder，授予/取消/超时清timer/listener，onStart观察异常释放槽位。whole/profile两路实际传projectId、任何gate失败结束排队episode，日志/UI改等待总量不承诺绝对位置；tracker旧min位置断言退场并保留旧红。主5新反例真红→25 gate绿，5files288相关/core及web tsc0，固定全量655files9560绿/6files19skip/1obsolete snapshot/65.48s。独立固定复验进行中；phase公平队列、durable pending、实际Master/Daemon与公网未验。

两仓库最新fetch远端仍为CDS origin/main45533b、IMP origin/test e2fd7与origin/main2bf49；未发布、未操作共享宿主，固定八候选未变。38条partial-local/11todo，49正式not-executed、visual N/A。expected result：排队有界且跨项目不被积压垄断；current evidence：288相关、9560全量及两侧tsc0；visible result：未部署；gap：dc2f独立、真实阶段公平/持久队列/八分支/公网未验；required action：按原同编号继续实施与末尾复验，不提前关闭目标。

## v1.30 固定队列轮转、立即取消与当前缺口

4d51286ca9e0159b778bff6b854ef0a33bc28ec2以有界稳定项目环保留下一个项目的轮次，已排空组从环移除、不长期缓存项目身份；旧dc2f独立direct12/13与actualRouter7/8的三项目轮转红原件保留，主1新反例真红→289相关/core tsc0，固定全量655files9561绿/6files19skip/1旧obsolete snapshot/68.42s。末尾4d原28/28局部绿，但追加whole/profile取消100ms仍有waiter/chip的两真红，transfer时安全不能替代立即取消。

2642d388ada74e7ffe14bd7f6cfa9441602659e5将实际lease signal直接接两入口的source gate，whole合并layer signal，15s tick只兼容缺signal旧租约；主两实际HTTP/StateJSON反例在旧4d 100ms仍queued1真红，新5files291相关/core tsc0。末尾唯一31/31局部：direct13+扩展5+实际自有nativeHTTP/Router/Coordinator/gate/StateJSON v5路由12+真实whole layer abort控制1；取消100ms前后JSONcancelled、chip清、gateactive1唯一a0，尚未release其他holder，取消者不进runtime。runtime/pull/readiness仍受控替身，非真实Daemon。原4d两红与重复v4/v6控制保留、不重复计数。

2642d全量654files9562绿/1failedfile1HTTP超时/6files19skip，68.77s；uptime-agent-selfservice的无地址台账拒绝用例5秒超时，单独16/16复跑绿，根因未证明，原失败保留，不称全量绿或线上500闭合。日志/tmp/cds-express-2642d-full.log、/tmp/cds-express-2642d-uptime-recheck.log；主取消红绿/tmp/cds-source-queue-immediate-cancel-final-{red,green}.log及-tsc.log。

expected result：源例外项目轮转和立即取消不影响在途holder。current evidence：固定独立31与主291/core0、全量1未闭合超时。visible result：未部署、候选视觉N/A。gap：49正式/8支完整交付、实际Daemon/公网/双主题、持久队列与其他同步热点未验。required action：继续本地TDD消除热点、保留原失败，在隔离准入后按既有八支push/selfupdate授权执行真实验收；不提前关目标。

## P2-06 systemd 启动子进程迁移合同

现有root/已安装或允许安装/模板存在/完整node-pnpm-npx路径准入保持；备份、daemon-reload失败恢复旧文件、master只热应用权重、Forwarder只在reload成功后重启的顺序保持。把command -v与systemctl命令交给已共享Shell Worker，发现单命令3秒、reload/权重10秒、restart15秒边界；启动装配await完成，不后台无序重启。嵌入调用使用有界共享fallback（1执行/3排队），不直接native execSync，不把未成功命令算已应用。文件读取/备份/小unit写入仍同步，不能称所有文件热点已迁移。 异步等待期间同一实际unit（已存在文件的真实路径及dev/ino；未创建文件的真实父目录及basename，含末级悬空链接）只允许一个写入者，竞态明确返回error而不覆盖在途unit；进程内最多32个不同unit同步，无排队或自动重放，结束才释放。首次await前冻结实际目标，systemctl保留linked unit的原请求名，写入前及reload完成后复核原名字仍绑定冻结实际目标，检测到改向即error且禁止后续动作；已发出命令不能撤回，结果未知不报告权重或restart已应用，需宿主对账；写入前复核并在新文件创建后登记inode，未能核身份明确error不启动命令。这个内存边界不替代重启后宿主对账。

先红判据：注入共享executor时旧实现仍native调用；reload尚未返回不能报告fixed或重启；reload失败必须恢复原unit并留备份；热权重/重启失败维持既有返回语义。测试只允许自有临时文件与假命令、不调用宿主systemctl，不用局部启动检查代替真实自更新或公网性能。此临时实施合同在P2-06正式报告及自动门禁完整接管后退场。

## v1.31 systemd启动迁移固定检查点

1f977155b354e8c89180d7ba6faf195dc86419b9将systemd发现/reload/权重/重启迁共享Shell Worker，index传现有shell并await；嵌入fallback1执行/3排队，单命令发现3秒/reload与权重10秒/restart15秒。异步前冻结原unit/install意图，同规范化installedUnit唯一写入、不同unit上限32、无重放；备份及reload失败恢复旧文件，首次安装失败移除本次文件。小unit文件仍同步，实际自更新未执行。

主共享executor接线4真红、actual index移除inject1红/仅去await1红、异步目标变化1红、并发writer1红保留并复绿；原index夹具直接执行TS的SyntaxError原件保留为夹具错误，transpile后反例才是真红。新增11判据及原模板/真实自有ShellWorker隔离控制共4files51绿/core tsc0；不调用宿主systemctl/写etc。固定全量656files9574绿/6files19skip/1旧obsolete snapshot/70.16s。原2642d HTTP5秒超时本次正常，但未改其测试或生产，不证明历史HTTP/线上500根因关闭。

固定1f977独立复验进行中；P2剩余热点只读清单在仓库外p2-native-hotspots-1f977-local.json，仍有clock同步load/persist、janitor statfs与Docker native execFile、启动端口execSync、特殊tar/数据库/SSH流native spawn。不能用异步API或本次51/9574绿声称所有Master热点闭合。

expected result：启动命令不在Master native执行，完整维护旧顺序和单写入归属。current evidence：8类主局部真红演练、51相关/core0与9574全量，固定独立待返。visible result：未部署、视觉N/A。gap：49正式/8分支/实际Daemon/公网/双主题与其他实施条目仍未完成。required action：末尾固定复验，有红继续原夹具修复；主继续同编号剩余有界实施，隔离宿主准入后按既有push/selfupdate授权执行真实交付与视觉。不提前收口。

## v1.32 实际unit单写入恢复审计

1f977固定独立20/21：14协议+3自有真实ShellWorker/fake systemctl/nativeHTTP+3actual index接线通过；同一实际unit的符号链接别名竞争写1真红。真实Worker控制轻HTTP5ms/76tick、Master native spawn/execSync0；自有12秒fake reload在10028ms被10秒deadline终止、PID消失、旧unit恢复。原2642d同步假CLI阻塞834ms保留。以上都不是实际宿主systemctl或正式公网性能。

80e9414691adefa602551541ba25a1e7d531e46e用真实path和dev/ino共同锁定实际文件；未创建按真实父目录/basename解析末级悬空链接，32容量按写入调用计数。首次await冻结实际写入目标，创建后补inode锁；写入前和reload完成后核原请求路径绑定，未知或改向返回error，不更新权重或restart其他服务，回滚只触及冻结目标。linked unit保持原服务名字，不能把路径外目标basename当systemctl名字；硬链接锁共享文件不等于不同Daemon服务实例。主旧1f源8反例真红→20新判据及原12模板/11Shell/17隔离共4files60绿，core tsc0；固定全量656files9583绿/6files19skip/1旧obsolete snapshot/66.64s。日志/tmp/cds-systemd-physical-owner-final-{red,green,tsc}.log、/tmp/cds-express-80e941-full.log。固定新SHA独立复验进行中，不传播原1f的full到新源。

expected result：别名不能绕过实际unit单写入，等待中改向不修改或重启其他目标。current evidence：原独立1真红及主8真红，当前60相关/core0/full9583，固定独立待返。visible result：未部署、visual N/A。gap：49正式/八分支完整交付、真实Daemon/公网/双主题仍未执行；clock同步文件、janitor statfs及其他热点、durable pending/阶段公平、P4其余流、IMP辅助终结receipt继续实施。required action：末尾原fixture固定源复验；主同步计划并继续有界TDD，隔离准入后依既有八支push/selfupdate授权完成真实验收。38partial-local/11todo保持，目标active。

回滚归属补充：backup恢复及首次失败remove前复核冻结路径仍绑定本writer登记inode；替代inode或symlink未知时不覆盖或删除，保留备份和error。这个结束fence不能撤回在途systemctl，也不能当真实Daemon应用或恢复证据。P2-06正式自动门禁接管后该临时说明退场。

## v1.33 回滚归属与最终结果恢复审计

80e941固定独立29/35局部：原20控制及原symlink1绿，扩展物理身份8/14，六真红：reload等待后同path替代inode或指向foreign的symlink被backup回滚覆盖；首次安装同path替代inode被rm清掉；no-drift未核改向；权重和restart等待后改向却仍报已应用。原1f与80e所有反例、固定源hash与自有Worker/HTTP控制均保留，不传播到生产。

d1a56ac49b4117eef0e832a0dc6074ff23cc50f0在no-drift前复核；回滚/首次失败移除仅冻结实际路径仍canonical同path且当前dev/ino属于原writer，未知或已替换则保留备份/error，不覆盖或删除foreign。权重/restart await结束及最终fixed返回前复核；检测到改向不报告runtimeWeightsApplied/restarted true，已发命令不能撤回，真实Daemon结果未知须另对账。主固定旧80e源六真红→4files66绿/core tsc0，日志/tmp/cds-systemd-rollback-owner-final-{red,green,tsc}.log。固定新SHA全量与独立复验进行中；80e历史full9583与原2642d HTTP超时单独保留，不能继承为新源结果。

expected result：回滚只写本次owned inode，所有成功终结绑定实际目标。current evidence：旧源六主/独立真红、当前66相关/core0；新源full和独立待返。visible result：未部署、visual N/A。gap：49正式/八分支/实际Daemon/公网/双主题与其余计划条目仍未完成。required action：末尾原六反例固定源复验，有红继续修；主继续其余本地有界实施，隔离准入后依既有授权真实八支交付与正式视觉。38partial-local/11todo、49not-executed保持，目标active。

## v1.34 固定独立闭合与回收草案否决

d1a56固定独立37/37局部：原14协议、3actual ShellWorker/fake systemctl/own nativeHTTP、3actual index、原symlink1、原physical v2十四项、backup失败与错误后锁释放2。80e六红原fixture/期望不变复绿，历史29/35及原1f20/21保留。完整四源Git hash一致，source-manifest与evidence-summary在独立账本目录，epoch checkpoint-d1a56-systemd-physical-local-37green。主66相关/core0，固定全量656files9589绿/6files19skip/1旧obsolete snapshot/65.44s（/tmp/cds-express-d1a56-full.log）；原2642d HTTP超时与线上500根因仍未证明关闭。

P2后续直接把janitor rmSync/stat改fs.promises的草案已否决：初始6files97/core0后，ownFS held rm→同path重建→释放清理会误删新owner，1可复现真红。草案/测试/hash和/tmp/cds-janitor-async-removal-replacement-draft-red.log保存在仓库外janitor-async-removal-rejected-draft.*；跟踪janitor精确还原d1a56，草案未提交/发布。此是被否定局部设计，不是d1a56新增产品红，也不能把草案97绿计入固定源。后续先设计独占path/实际身份与可恢复回收，再迁移递归删除；主负责，同编号P2-06，不为异步API丢掉安全护栏。

expected result：systemd本地身份漂移不伪报成功；后台回收不删新worktree。current evidence：前者37固定独立、66相关/core0/full9589；后者否决草案1真红，未采用。visible result：本候选未部署/视觉N/A。gap：49正式全部not-executed，八支完整交付、隔离宿主、实际Daemon/公网/双主题、durable pending/阶段公平、P4其余流、IMP辅助terminal receipt仍待完成。required action：主继续安全回收设计及其他计划实施，末尾按新固定源逐项复验；准入后依既有push/selfupdate授权运行完整验收。38partial-local/11todo保持，active，不宣称全部黄闪电或不卡。
