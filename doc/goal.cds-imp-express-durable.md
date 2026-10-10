# CDS 与 IMP 极速长效联合目标 Brief

版本：v1.27；日期：2026-10-11；状态：active。

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
- 执行坐标：`worktree=CDS:/Users/inernoro/.codex/worktrees/cds-express-durable-20261010/prd_agent,IMP:/Users/inernoro/.codex/worktrees/imp-express-durable-20261010/mdimp；branch=CDS:codex/cds-express-durable-20261010,IMP:codex/imp-express-durable-20261010；HEAD=CDS:fd1135f7b36b9f2b013648850de4975c415ab9d0,IMP:cc70154e5209a4917499a32e2bef89ca7d22d5d7（计划文档）（实施检查点，后续计划文档提交另计）；origin/main=CDS:45533b419e1cfc54b145a545a716563617659d01,IMP:2bf49bf92a634057b65d40e0c5e9faa3ed02ae9c；ahead/behind=CDS:124/0相对origin/main,IMP:22/0相对origin/test；environment=本地独立工作树,线上只读探测；database=N/A本轮未写入；tenant=N/A平台基础设施；role=本地主进程,线上机器只读；route=https://cds.miduo.org/branches/defd4695ab5f；auth=本地无登录要求,线上现有CLI项目凭据不输出；external_ids=bootstrap dr_23b50418a7954b2a41e6f2b4(其他任务活动,不操作)`
- 写入所有权：`owner=本任务/root仅两新工作树；other_tabs=原任务工作树read-only,tail_acceptance只写仓库外账本；handoff_checkpoint=本地P1/P2/P4与IMP exact合同部分实现,已保存固定本地SHA,未发布`
- 范围账本：`goal-core=49条计划与完整极速/控制面治理；required-prerequisite=集成已有CDS修复及隔离验收依赖；environment-recovery=仅基线盘点,不重建持久数据库；successor-or-non-goal=业务流程重写,真实定时作业恢复,其他任务目标关闭`
- 已确认范围 / 非目标：两仓库技术交付目标,不扩大IMP业务分母或改CL合同。
- 当前实现事实：两独立工作树与49项双副本计划/TDD已建立。P1精确制品/版本引用/cache digest及新发现真实prebuilt缺省默认部分实现；P2执行Worker/supervisor硬中断、ACK背压/调度和日志热点迁移部分实现；P3取消贯穿租约、Shell、pull、run、启动信号、TCP/HTTP/retry/日志，私有候选身份/网络/账本、全部运行事实冻结、实际Forwarder ACK、切换/失败回滚、worker/可写卷停止恢复约束、版本字段冻结和整分支受控入口已接本地代码。P4真实JSON多等待屏障、durable run暂存及空清单/整分支/单服务可靠终态，实际覆盖/黄蓝/独立版本状态部分实现；普通删除失败保留身份、版本与端口。IMP13角色exact合同及权威文档已校准。本地取消终态归类修复已独立13/13；启动/自动重启按canonical身份扫描，通用reaper保护未released两图与candidate/protected；canonical-name未知归属不报告missing；未released新写入准入已接coordinator/index与直接候选编排，stop显式待对账。所有改动仍未发布；P3其他入口、Daemon取消/重启/网络回收与恢复协调、P1旧默认迁移/依赖、P4增量/SSE与Mongo、IMP辅助生命周期及完整生产证据未完成。
- 本批实现检查点：2ea固定独立44项41绿3红（未消费续约时pending提前出队）；ec939原44及新增3共47/47局部复绿，删除Map存在守卫1真红。原3红保留；相关313/core tsc绿。 efcdaf0dc21687fbcecb6af0b0fafaaa953fdfc0重放观察：5秒响应头、30分钟观察、256KiB帧/16KiB解码片；非2xx不读正文，complete.ok/错误/mergedjoined/unknown分别记录，只记有界枚举及合法run ID；不重试或取消实际执行。实际入站HTTP＋fake出站/Docker5旧红→5绿，观察器13及协调/路由共331局部绿、core tsc绿；efcd固定独立实际自有HTTP/native fetch23项21绿2真红（complete.ok=true却带started/rejected被误判完成）；明确cancelled被记失败也已发现。12ad新增有限状态及取消归因，主3旧红→绿，相关335/core tsc绿，固定独立待返。未改实际run，不把观察取消当Daemon闭合。 仍未实现durable pending队列，不证明实际Master/Daemon或线上通过。 八候选固定清单未变，独立8/8与280合同局部绿，104角色仅静态枚举，未push/未部署。
- 证据纪元：`target_sha=CDS:fd1135f7b36b9f2b013648850de4975c415ab9d0,IMP:cc70154e5209a4917499a32e2bef89ca7d22d5d7；tested_sha=CDS:12ad主335/core tsc局部及固定独立待返；9f1b全量9516历史；efcd独立23中2红；ec939独立47局部与全量2红；330独立29与53ce独立8为历史；IMP:八候选280静态见清单；deployed_sha=N/A候选未部署；environment=本地独立工作树/自有进程,共享CDS与mycds只读；observed_at=2026-10-10T22:25:12+00:00`
- 新鲜验证证据：ec939全量649文件9495绿/2红/6文件19跳过，97.10s；2红是user-project-access在20ms故障注入后末尾正常写入500。额外40ms正常flush确定性复现2红；9f1b仅在已恢复/解锁后的正常写入前还原原环境预算，保留全部20ms负面、409/401、补偿及真实JSON断言，完整60绿。生产默认30秒未改；这不关闭线上持续500、历史OAuth/超时/ECONNRESET或bug-reports socket hang up。9f1b固定全量651文件9516通过、6文件19条跳过、1旧obsolete snapshot，67.15s；不能继承到12ad。唯一trace路径已纠正，不与d786混合。 ec939诊断路径常量误指d786追加trace，不能用于新纪元性能统计；此次独立trace路径已纠正。 d786650文件9496全量绿为历史，不赋予新SHA通过；所有旧红原件保留。49正式、视觉、八支完整部署仍未执行。
- 当前阻塞或环境限制：完整线上版本未证实、隔离压力宿主尚未核定；本机Docker CLI存在但守护进程无法连接，Colima状态不一致,未重启其他VM；本机16GiB已大量压缩/交换，不在其上新增压力VM冒充隔离验收宿主；原IMP索引158条超过60上限,只读reconcile无可归档终态,不猜测其他目标完成；本目标直接brief续接,索引登记待治理协调。 额外只读探测mycds SSH成功（Linux16CPU/约31GiB RAM），sudo -n Docker可读，承载大量他人及IMP/MAP常驻服务；2026-10-11 05:32 CST可用628MiB、swap8191/8191MiB、load2.25/26.60/33.20，不作隔离压力宿主，不停他人服务/启新容器。本机Docker仍不可达；隔离宿主问题待用户回复。
- 涌现决定：N/A尚无需登记的新终态机制；保留强门槛不以服务端指标替代公网。
- 下一动作与完成条件：固定fd113三个历史查询反例与新边界独立复验，71e原红保留；之后继续元信息clock及剩余既定范围；继续durable pending/分阶段公平队列、P2其余Master热点、P4增量/其他SSE、P3实际Daemon对账及IMP辅助生命周期；隔离宿主问题待答。平台/制品准入后依既有授权实际push八支完整部署，再按49项及真实视觉、公网/恢复、48小时/一周任务收口。
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
