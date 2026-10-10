# CDS 与 IMP 极速长效联合实施计划

版本：v1.34；日期：2026-10-11；状态：active。用户已批准实施与TDD驱动、创建原生目标、两份计划以及独立逐条视觉验收。目标 ID：CDS-IMP-EXPRESS-DURABLE-20261010。

本文件与另一仓库同路径内容一致，结构化任务源为 `doc/plan.cds-imp-express-durable.json`。主进程写实施状态，独立验收任务只写仓库外验收账本；只有同一条目的精确SHA证据及独立结论成立才可验收通过。代码完成不等于验收通过。

两个仓库各保存同编号副本，当前任务是新工作树唯一写入者；现有《排查 CDS 持续500问题》目标及监理不被修改或关闭。共享配置/自更新前核对并发任务和实际版本，避免两个任务同时写运行环境。

## 冻结门槛

延续既有 CDS 蓝本 A01–A12，不降低为仅服务端指标：公网每端点30分钟≥180次，P95≤1秒、P99≤2秒，无>5秒请求/超时/平台5xx；事件循环每分钟P99<200ms、最大<1秒、阻塞占比<5%；双主题首屏≤2秒、反馈≤200ms；隔离环境≥8部署、31服务、100连接；A01–A11通过后固定实际版本观察48小时。服务端指标只用于归因，不替代公网结果。

联合额外分母：至少八个分支完整目标服务图，不能用仅前端采样代替；黄闪电全实际极速，蓝闪电部分且列明例外；缺镜像不源码回退、不停旧服务。停止/等待/版本漂移单独显示。

## 逐项实施与独立验收

| 编号 | 当前实施 | 当前验收 | 工作项 |
|---|---|---|---|
| P0-01 | 本地部分实现 | 正式未执行 | 核对两仓库远端、线上 CDS 提交、现有部署与在途任务；建立上述独立工作树，记录完整 SHA。 |
| P0-02 | 本地部分实现 | 正式未执行 | 对照《排查 CDS 持续 500 问题》的现有实现，标出已完成、需继承、仍待修复项，防止重复重构。 |
| P0-03 | 本地部分实现 | 正式未执行 | 冻结至少八个验收分支及各自完整服务图；标准应用、常驻辅助服务、一次性初始化任务分别登记其实际生命周期。 |
| P0-04 | 待办 | 正式未执行 | 建立阶段耗时：CI runner 等待、CI 构建、制品等待、容量等待、拉取、启动、就绪、切换、失败收尾。 |
| P0-05 | 待办 | 正式未执行 | 保存模式覆盖、自动部署开关、路由、运行镜像与当前资源配置的可恢复快照。 |
| P0-06 | 本地部分实现 | 正式未执行 | 核对 RabbitMQ/XXL-JOB/数据库隔离前提，设计无真实业务消费与定时作业副作用的验收环境。 |
| P1-01 | 本地部分实现 | 正式未执行 | 自动、手动、单服务、整分支及集群执行器共用按精确目标 SHA 的制品检查。 |
| P1-02 | 本地部分实现 | 正式未执行 | 校验实际拉取鉴权、manifest、目标架构与镜像集合；CI 成功标志不能替代实际镜像可用。 |
| P1-03 | 本地部分实现 | 正式未执行 | 本次整分支所需制品齐备后再允许改变在线容器；单服务部署检查对应服务与必需依赖。 |
| P1-04 | 本地部分实现 | 正式未执行 | IMP 的极速部署缺制品时进入有超时、可取消的等待或明确失败，禁止隐式源码回退或混用旧镜像冒充新版本。 |
| P1-05 | 本地部分实现 | 正式未执行 | 平台新项目默认优先极速；配置不完整时明确指出缺口。已有项目显式源码例外保留并可见，不自动伪造镜像配置。 |
| P1-06 | 本地部分实现 | 正式未执行 | 修正空部署模式与模式继承，迁移前先盘点旧覆盖；所有实际部署记录保存运行模式、目标 SHA、实际镜像及摘要。 |
| P1-07 | 本地部分实现 | 正式未执行 | 用缺镜像、错误架构、鉴权失败、显式 SHA、无显式 SHA 与执行器路径做可复现红绿验证。 |
| P2-01 | 本地部分实现 | 正式未执行 | 保留 `IShellExecutor` 调用契约，使用常驻执行进程接收命令，Master 不在请求和诊断热路径直接启动每个 Docker 子进程。 |
| P2-02 | 本地部分实现 | 正式未执行 | 保留 cwd、env、stdin、流式输出、退出码、超时和取消语义；凭据不进入日志或普通状态持久化。 |
| P2-03 | 本地部分实现 | 正式未执行 | 执行队列设置上限、优先级与公平性，探活和交付不被长日志/编译任务饿死。 |
| P2-04 | 本地部分实现 | 正式未执行 | 对失败日志实行按 run 去重、限量、短时缓存；巡检批量取状态，避免同一失败引发反复诊断。 |
| P2-05 | 本地部分实现 | 正式未执行 | 执行进程崩溃后先核验任务和容器事实，再恢复；不得盲目重放非幂等命令。Master 自更新与执行进程停机有明确收尾顺序。 |
| P2-06 | 本地部分实现 | 正式未执行 | 核对所有仍在 Master 的子进程热点，测量开启前后的事件循环与普通 API 延迟。 |
| P3-01 | 本地部分实现 | 正式未执行 | 相同项目/分支/服务/目标版本请求合并；未开始的旧目标被新目标替代，同 SHA 不同服务保留。 |
| P3-02 | 本地部分实现 | 正式未执行 | 在途部署在切换前复核目标是否仍有效；取消能释放名额、停止实际进程并回收候选容器。 |
| P3-03 | 本地部分实现 | 正式未执行 | 调整顺序为制品检查、候选启动、就绪验证、路由切换、旧容器回收。旧容器清理不能早于新版本就绪。 |
| P3-04 | 本地部分实现 | 正式未执行 | 候选容器使用独立身份，明确端口、网络和路由切换的处理方式，保留切换失败恢复点。 |
| P3-05 | 本地部分实现 | 正式未执行 | 对固定端口、独占卷、不能双实例运行的服务声明替换约束，不承诺不具备条件的无中断切换。 |
| P3-06 | 本地部分实现 | 正式未执行 | 分别限制拉取、启动、就绪等待与诊断的并发；按实际容器与资源记账，不能漏掉 error 状态但仍运行的实例。 |
| P3-07 | 本地部分实现 | 正式未执行 | 提供项目公平性、等待原因、最长等待与超时机制。并发参数按宿主余量和单服务峰值校准，不以盲目加名额解决排队。 |
| P3-08 | 待办 | 正式未执行 | 验证重复推送、旧任务取消、启动失败、执行进程重启以及高负载场景。 |
| P4-01 | 本地部分实现 | 正式未执行 | 沿用并核对现有保存节流修复，将高频状态更新转为增量，避免每次在 Master 深拷贝整份状态。 |
| P4-02 | 本地部分实现 | 正式未执行 | 关键终态可靠落盘；重启后由真实容器与运行记录对账，完成记录不可丢失或倒退。 |
| P4-03 | 本地部分实现 | 正式未执行 | SSE 按项目/分支发送必要变化，合并重复事件并限制慢客户端积压；慢客户端恢复使用一致快照。 |
| P4-04 | 本地部分实现 | 正式未执行 | 分开计算配置上的极速意图、已验证制品覆盖和实际运行覆盖；旧记录缺模式时标记未知并核验，不能直接继承配置判通过。 |
| P4-05 | 本地部分实现 | 正式未执行 | 全部实际服务极速显示黄闪电；部分显示蓝闪电和明确分母/例外。未运行显示配置意图与未运行状态，不冒充实际全部极速。 |
| P4-06 | 本地部分实现 | 正式未执行 | 版本待更新独立显示；全部极速不等于已更新到目标 SHA，最终验收两项均须通过。 |
| P4-07 | 本地部分实现 | 正式未执行 | 对实时页面与后端摘要执行一致性检查，覆盖空模式、旧容器、额外服务、停止和失败状态。 |
| P5-01 | 本地部分实现 | 正式未执行 | 以 `deploy/cds/express/services.json` 为标准应用制品合同，保持 10 镜像覆盖 13 服务角色；核对八分支实际合同，避免依赖旧分支文件。 |
| P5-02 | 本地部分实现 | 正式未执行 | CI 从精确提交生成完整镜像集合与可追溯清单，明确制品失败项；新增辅助服务时同步其制品合同。 |
| P5-03 | 本地部分实现 | 正式未执行 | 保持项目默认与分支覆盖为极速，确保初始化/配置同步脚本不会改回源码模式。 |
| P5-04 | 本地部分实现 | 正式未执行 | 修正普通运行目标提交绑定，避免旧字面 SHA。正式验收精确 target_sha 守卫保留，不放宽为任意版本。 |
| P5-05 | 待办 | 正式未执行 | 对每个遗留 bootstrap 检查所属验收 run 的终结证据，再使用正确收尾流程回收容器/Profile，保留数据库与授权证据。 |
| P5-06 | 待办 | 正式未执行 | 合法常驻 RPC/辅助服务使用可追溯预构建镜像并纳入分母；一次性初始化须有明确完成和回收证据。 |
| P5-07 | 本地部分实现 | 正式未执行 | 只在受影响分支传播必要的 IMP 补丁，不把 CDS 平台代码复制进业务分支；不覆盖协作者新增提交。 |
| P6-01 | 本地部分实现 | 正式未执行 | 各批次先有针对性红绿、类型检查及模块要求的测试；前端改动补构建和真实页面验证。 |
| P6-02 | 待办 | 正式未执行 | 在独立/隔离宿主完成失败注入、执行进程崩溃、队列恢复及多 SSE 压测，再灰度一分支、两分支、八分支。 |
| P6-03 | 待办 | 正式未执行 | 每次更新共享 CDS 先核验已上线修复、在途任务、预构建产物、版本与回滚点；失败自动回滚并保存 run。 |
| P6-04 | 待办 | 正式未执行 | 在隔离验收范围恢复真实自动交付链，实际推送至少八个分支；完整服务部署包含 API、前端、worker 与合法常驻辅助服务。 |
| P6-05 | 待办 | 正式未执行 | 对协作者推进的分支以最新确认目标重新冻结，不回退到旧验收提交。每个目标保留 CI、制品和部署 run ID。 |
| P6-06 | 待办 | 正式未执行 | 采集至少 30 分钟混合部署、缺镜像、启动失败、重复目标、多 SSE 场景，并与同负载基线对比。 |
| P6-07 | 待办 | 正式未执行 | 对原来停止的验收分支按登记状态收尾；未完成时不能宣布整体通过。 |
| P6-08 | 本地部分实现 | 正式未执行 | 交付真实证据、剩余缺口与恢复手册；发布后 48 小时与一周复测列为执行任务，到期实际执行后才能勾选，不在本轮擅自创建自动提醒。 |

## TDD 与末尾任务

每条任务遵循红判据、实现、绿证据、独立复验；恢复旧实现或删除关键逻辑应使代表性判据变红。文件检查不能替代真实性能、浏览器动作或八分支部署。末尾任务逐项给预期、实际、证据纪元、判定与缺口，不接收主进程口头宣布通过。视觉证据绑定任务ID、页面、角色、SHA和时间；截图/临时报告只存仓库外。

CDS TDD先覆盖主线程执行隔离、完整制品门禁、旧版保护、队列替换、状态恢复和真实闪电；IMP覆盖制品合同、配置同步、目标SHA与初始化生命周期。正式视觉链串行执行验收设计、场景编排、真实浏览器取证及报告归档回读。

## 发布边界

当前允许实施、本地测试与目标设计基线commit；未创建PR或合并受保护分支。完成可审查实现后按已授权范围处理远端发布；若仍缺当前修复范围的发布授权，明确列出最小动作再等待，不在本地实现前反复询问。线上自更新不能覆盖未继承的已有修复，禁止为补证据在共享宿主制造故障。

## 本地阶段事实（2026-10-10，尚未固定实现SHA）

主进程状态不等于独立正式验收。结构化副本每条 `local_evidence_note` 说明已证实行为、证据限制与下一缺口；49项正式acceptance全部保留not-executed。P1/P2/P4及IMP合同已部分实现，其余完整候选替换、持久化/SSE、默认策略、辅助生命周期、八分支与生产指标仍须推进。独立账本保留每次红判据和另存复绿结果，不用文件计数或单前端部署替代完整服务验收。

## v1.9 实施检查点（2026-10-11）

CDS:532654ed9e5323bb20aaabb6dbac702991d24456; IMP:6fb843bc456040c356ca1215b3dcdce733d4ceb0（IMP产品代码a35b160；本地实施检查点，后续计划文档提交另计，非部署验收版本）。没有push、PR、自更新或共享环境写入。

两独立工作树与最新fetch基线未变化；18:00 UTC只读SSH看见共享Master cwd=/root/inernoro/prd_agent/cds、checkout=e4e0c8b6552315642c6d78a5620b5669901abd37，PID1799360未注入可验证运行SHA，不能用checkout代替运行版本；Forwarder PID1058/9090。未修改在线或其他bootstrap。

532654受控整分支实际路由已接：完整exact→prepared账本/显式容量→私有图/不可变ID/就绪→实际Forwarder消费者ACK→旧及孤儿ID回收。CDS_CANDIDATE_REPLACEMENT=1；缺绑定失败关闭，保持旧实例，不回旧破坏流程。HTTP成功与缺绑定真红绿；源模式其他入口未接，真实Daemon未证。

固定c7事务27、949边界54、dfb编排19均独立局部绿，历史源/红保留。532654整分支接线待独立复验；创建未知/事实漂移保留两图，未进入starting的prepared、无stop/create且释放快照可靠落盘可解除预留；启动后/未知/新owner仍不释放。Daemon取消/重启/网络回收未完成。

worker/推断worker/可写卷默认stop-and-restore，显式不安全parallel拒绝，角色/策略/mount/exact冻结版本，未知schema拒绝；生命周期意图在inspect后、ID命令前记录并再fence。532654恢复存活但未就绪写有界recoveryFailure阶段码及SSE，保留待对账。固定端口与真实恢复、其他入口仍待验证。

532654容量读取Daemon memory及所有实际running身份，合并所有未释放新旧图去重；不漏error仍运行/其他容器/未知创建。沿用512MiB单元与1GiB保留的规划上限，超限/未知拒绝。忽略actual或reservation两条真红绿；该规划不是实际峰值/OOM证明，分阶段并发、公平性和隔离压力仍待校准。

532654当前全量641文件9276测试通过、6文件19条跳过、1旧snapshot obsolete；相关8文件299及cds tsc通过。此前1376两次全量失败/OAuth404与bug-reports超时/ECONNRESET保留、原因未完全查明；当前通过不称已修复历史根因。新JSON allocator fixture初版让observer写同原文件导致双writer临时文件冲突，改为复制磁盘snapshot至独立文件+flush，不算产品红。正式49/视觉/8分支未执行。

真实JSON屏障和三入口终态独立30/30、8/8仅历史局部；Mongo与其他入口/实际Daemon重启未完成。新固定532654独立复验待返回，原红与全部fixture错误日志保留。所有49项正式acceptance仍not-executed，视觉N/A；本地全量和独立组件证据不继承为公网、实际Daemon或八分支通过。

## v1.10 实施检查点（2026-10-11）

CDS:f8b814f9892416f2a21baf7ebbb21a5d7de5c590; IMP:6bbf61ec5ce02934fe7aeed926ac12f1dfa4eb2e（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地实施检查点，后续文档提交另计，未部署）。主进程按同编号实施；独立末尾账本保持仓库外。

e091固定独立HTTP原11/11、扩展13/13：create原reason、startup false、真实Container readiness取消、capture原reason均内存/磁盘/SSE cancelled；lease仍current的AbortError仍failed。原532固定8/11、扩展9/13四红保留，只关闭局部取消归类红。f8启动扫描按canonical容器名/instance，同branch/profile不按行顺序选候选，失败/身份重复保持状态，等待中后继服务名不回写；4原红复绿+归属2补充。真实Daemon取消/重启/网络与完整恢复未完成。

f8通用孤儿收割保护未released记录中的serving/candidate名字，run failed/cancelled或Profile移除不解除保护；unknown candidate/protected app交不可变ID专门对账，不按名字stop。保留完整旧账本与容量事实。原误stop命令真红复绿，正式Daemon/恢复/网络待验。

f8本地4相关文件321测试及显式cds tsc通过；带HTTP/事件循环脱敏trace全量641文件9290测试通过、6文件19条跳过、1旧obsolete snapshot。此前e091首轮640文件9282测试绿/1operator-console-auth GET ops 5s超时红保留；此前1376 OAuth404/bug-report超时与ECONNRESET保留。绿色trace中operator请求<5ms，未复现首轮红，不能称根因已修复。trace只测试进程，不是公网/线上性能证据。正式49/视觉/8分支均未执行。

主HTTP夹具错误（不存在的config.stateFile、跨场景重复同SHA触发正常空转熔断）已纠正并留日志，不作为产品红。两副本49条正式状态不变；没有push/PR/共享CDS写入。

## v1.11 实施检查点（2026-10-11）

CDS:c6155ab7a3d6e736dc8d598093c0019b7c09e7f2; IMP:f69a024400c9192a6d03f8e8edaadbf04c962227（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

c615新写入准入：未released两图即使run failed/cancelled也拒绝deploy/deploy-profile/restart/delete等新租约；高优先级拒绝在撤销旧租约前，相同精确目标joined与pending合并不创建执行者，重放重查。index给共享coordinator注入实际state检查，直接candidate executor同样拒绝旧未释放图。本地coordinator/真实自有HTTP Docker模型原3红/4删除守卫红均复绿；实际Master/Daemon/全部入口独立仍待验。

e091独立取消13局部绿保留原SHA。f8独立discovery/reaper原25/25，扩展30新增5个canonical-name归属缺/错红；b988已从实际Name反向核对冻结branch/profile，unknown-present不当missing，本地5红复绿，新的独立复验待返回。实际Daemon重启/取消/网络与完整恢复未验。

c615明确stop仍可取消旧执行者/请求停止已发布图，未释放候选通过candidateReconciliationPending及待对账提示报告，不释放日志、不声称全部候选停止。本地缺字段真红复绿。普通reaper保留未释放两图与unknown candidate/protected的f8局部独立25证据不继承到新SHA；不可变ID专门reconciler待实现。

c615固定主全量641文件9306测试通过、6文件19条跳过、1旧obsolete snapshot，100.04s。相关取消/准入3文件296、owner3文件97与显式tsc绿。e091首operator-auth 5s超时红、1376 OAuth404/bug-reports超时/ECONNRESET继续保留，尚未证明根因修复；f8带脱敏trace全量9290绿属历史。主修改导入断言首次失败未写入，随后未应用代码的stop缺字段仍红，纠正导入后绿，不计新产品红。正式49/真实Daemon/视觉/八分支未执行。

本轮仍没有push、PR、自更新或共享环境写入；保持双副本49条正式状态与强验收门槛。

## v1.12 实施检查点（2026-10-11）

CDS:05857c9a5a83f9f5ef659e87040ef27a83faa233; IMP:961b1408f7af4e754a96915d37d02631088dfdfe（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

c615独立Coordinator+真实自有StateJSON21/21绿，旧f8同21仅4绿；独立自有HTTP10/10：failed/cancelled/旧worker未释放拒绝whole/profile/restart/delete，reader异常不启动；released/otherbranch控制组正常，stop报告pending并保留账本/端口。SSE拒绝按实际event:error+operationStatus rejected判定，HTTP200/ok:true不等于启动。Master真实index注入和真实Daemon未验；DirectEngine3独立待结果。

c615独立discovery/reaper扩展30/30复绿，f8原5个归属缺失/错配红关闭；首次29/30是fakeCLI只读查询并发也写同JSON造成queryfail，已修fixture且保原件，不记产品红。05857已把旧不可变ID、镜像、原运行意图与完整Config/HostConfig/Mounts SHA256摘要、各精确候选制品在stop/create前落盘；定义错误/未知代际拒绝，显式投影不存明文凭据。主扩展8真红→316绿+tsc。真实恢复、旧版本就绪、Daemon闭合和专门reconciler仍未完成。

本批05857相关5文件316测试通过及显式tsc；恢复依据首6红和扩展8红保留，本批未再跑全量。最近全量仍为c615的641文件9306绿/19跳过/6跳过文件/1旧obsolete快照；历史operator-auth超时、OAuth404/bug-reports超时/ECONNRESET未证明根因修复。49正式、视觉、真实八分支均not-executed。

没有push、PR、自更新或共享环境写入；本批局部证据不替代49项正式验收。

## v1.13 实施检查点（2026-10-11）

CDS:e16998015891569784a1bea6cb70d5e9fe30fd6d; IMP:cebe9fb83c1a515b6fc64bdce542071b8e21732f（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

c615独立原SHA归档：实际Coordinator+StateJSON22/22、真实自有HTTP+disk10/10、DirectEngine3/3、discovery/reaper30/30；旧f8红分别4/21、2/10、2/3、25/30保留。SSE拒绝是HTTP200+event:error+operationStatus rejected且ok:true，不能按HTTP码推断执行。Master index真实运行、Daemon与全部入口未验。

05857固定独立JSON22/22、Owned实际假CLI32/32、首次操作前磁盘2/2；旧c615对应2/22、27/32、0/2，命令/Env/CPU/Memory/网络漂移旧代码实际rm原ID，新代码零mutation。e169冻结原currentVersionId/版本摘要，匹配原commit/image与v1合同，恢复使用旧startupSignal/readiness；缺失/错配/未知/类型错停止前拒绝，等待漂移不重冻结，未释放版本受裁剪保护。主原7红+probe类型2红→314相关绿，真实Daemon重启/取消/网络/专门reconciler未完成。

ecc72旧路由ACK后不再提前released停止过的worker；候选清理、原ID启动、旧就绪、落盘、旧路由再ACK完成后才释放。恢复就绪/最终路由ACK失败2个真红复绿，留reconciling与端口。本批独立fixed e169待执行，不能以05857恢复依据证据替代恢复结果；网络回收与Daemon闭合仍债务。

e169主全量641文件9339测试通过、6文件19条跳过、1旧obsolete snapshot，82.16s；相关5文件314、显式tsc绿。此前全量operator-auth超时、OAuth404/bug-reports超时/ECONNRESET未证明根因修复；本次绿不能抹掉旧红。49正式、视觉、真实八分支均not-executed。

未push/PR/自更新/共享环境写入；正式49和视觉保持未执行。

## v1.14 实施检查点（2026-10-11）

CDS:733731065fcb2499781c112d9540571de76be0b8; IMP:d3465cb58（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

独立e169原版本恢复23/23绿，旧05857相同有效旧版本仅1/23；扩展24条中22绿、2个真实取消红：旧HTTP就绪与最终ACK等待期间取消仍返回candidate_switch_ack。保留红记录，733已本地修复，未独立验收前不继承通过。

逐服务创建意图及inspect确认ID/摘要在connect/start前可靠保存；同run并行写串行合并，拒绝覆盖已确认身份，后续启动失败保留ID。取消在旧就绪/最后ACK等待内发生时，于恢复返回前复核租约，归类为BranchOperationSupersededError。主相关5文件321、显式tsc绿；创建时序原4红与末尾等待取消2红均复绿。固定733独立验证待执行。

八分支最近一周源基线及每支13个标准角色已只读枚举并镜像存档于doc/cds-imp-express-eight-baselines.json（104应用实例）。cl08另有生命周期待核实的bootstrap；活跃app01属于其他任务已排除。新验收分支未创建/未推送、目标SHA未冻结，源基线不是正式完整运行图；隔离宿主和副作用前提仍未通过。

最新733全量：640文件通过、1文件失败、6文件跳过；9346通过、1失败、19跳过，81.59s。projects.test.ts非法aliasSlug预期400实际404；聚焦90/90绿，只说明未稳定重现，根因未闭合。此前e169全量9339绿作为历史保留，不能抹掉本次红或此前OAuth/超时/ECONNRESET。49正式、视觉、真实八分支均not-executed。

## v1.15 实施检查点（2026-10-11）

CDS:628e7ce140115cf2df832722c7c1f5cc59e890b5; IMP:bfc94e1da（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

733固定独立恢复24/24、实际Container→Engine→真实JSON12/12、直接Journal并行与不可覆盖16/16；旧e169恢复22/24及创建6边界0/6红保留，外部删除不可覆盖护栏14/16仅判敏感性。新628网络创建intent及实际ID/完整配置摘要在应用create前保存，禁止覆写；有端点/配置漂移/Daemon查询失败不删除网络、不恢复单消费者，空私有网络按已确认ID删除并复查消失。缺网络核验绑定的受控入口拒绝，不回落旧流程。主7文件366与显式tsc通过；Container3红、Journal2红、网络回收护栏2红、入口缺绑定1红已复绿。真实Daemon/Master、网络晚创建/重启自主reconciler尚未完成，628独立待执行。

733带安全HTTP诊断全量新增2失败9345通过：项目自动repoPath clone pending测试5s超时，下一already-ready测试socket hang up；alias400/404本轮未重现，不能宣称根因解决。保留733首轮1红9346绿与e169历史9339绿。628新产品全量当前进行中，不宣称全绿；49正式/视觉/八分支均not-executed。

## v1.16 实施检查点（2026-10-11）

CDS:c329d9a1ec1e316677b6dcc2678feab834672594; IMP:bfc94e1dae6a7006640b9fc2302463c4fdf7d3cf（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

独立628：Owned实际假CLI24/24、Journal真实JSON12/12、HTTP缺network绑定1/1、实际Container→Engine→JSON14/15；API回滚released但empty private network仍在/rm0是真红，旧733边界0/3与入口0/1保留。bb30已补本地红并修复：networkCreation.intent的回滚即使stopBeforeStart为空也延后released，Engine实际网络回收后释放。主相关367/tsc绿，独立修订复验待执行。

c329新增整分支内部恢复租约，唯一终态run/项目/精确目标/config/proof/阶段匹配后才准入；取消或取代后active为空仍登记旧执行未结束，原lease完成前拒绝恢复。复制完成及同operationId旧generation重复完成不动当前写入者或pending。旧bb合法scope7红及额外完成所有权2红复绿，直接JSON准入15含合法正例，主7文件372/显式tsc绿。初始JSON fixture缺branch13错与dr-old命名2错仅测试夹具失败保留，不算产品红。租约仅证明本进程执行结束，不证明重启或Daemon闭合；自主reconciler尚未实现。

bb30固定源码带测试HTTP诊断全量642文件9367通过、6文件19条跳过、1obsolete snapshot，81.39s。3901脱敏trace事件/669响应/349复用连接，本轮无identity mismatch或transport error。628全量2红9364绿（compose-drift ECONNRESET、detect socket hang up）及733两次红保留，根因未闭；自有子进程复现stale pooled socket+停顿→ECONNRESET且reused:true，而one-off200，仅风险复现非原失败闭因。c329新代码只372相关及tsc，不继承bb全量。49正式/视觉/实际八分支均not-executed。

## v1.17 实施检查点（2026-10-11）

CDS:2b72ab448acea5791099e34528b5409aeb89b8fa; IMP:2a8e22723eae3330d081204ba37cfe5925495777（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

2b72：原执行最后外部动作后可靠保存executorSettlement摘要；自动恢复绑定唯一终态run、控制摘要、旧图及原版本，缺回执/未知创建或网络/停止意图不齐均保留。确认旧路由后回收候选ID和私有网络ID，再原ID恢复、原版本所有原运行服务就绪、保存、final ACK、durable released。Dashboard启动及每分钟最多一条轮转已接受控开关，暂停/draining不恢复，去重有界结果事件。主11文件463及显式tsc绿；去掉收尾回执守卫2真红、去掉清理前路由ACK1真红，均还原。重读实际JSON＋假CLI局部不能替代真实Master/Daemon重启；新图已发布、无回执崩溃、未知晚创建及历史不完整仍待对账；固定2b72独立复验待执行。

独立c329固定13模块Git hashes：网络整链15/15关闭628 API回滚漏网红；CLI24、Journal12、HTTP1重跑绿，恢复门禁45＋10和自有HTTP结算6绿。旧628主22/45及结算1/6红保留；这些是组件/实际JSON/自有HTTP，不是自主恢复或Daemon通过。

只读浏览器共享IMP页面实见9分支：1出错、1运行、7未运行；app01混合13/14且属于他人任务，cl08混合13/14并11启动失败，main/app04/marketing混合待生效，四支极速待生效。截图为旧线上失败基线，不是本修订视觉验收；/Users/inernoro/.codex/visualizations/2026/10/11/cds-imp-express-main/shared-imp-baseline.jpg。共享宿主18核可用约51GiB但负载约20且CPU100%；只有一个Master执行器，无隔离验收宿主。

2b72相关11文件463/tsc通过；2b72全量正在执行，结果未到。bb30历史全量642文件9367绿不继承本修订；628和733历史全量失败及池连接复现根因未闭。49项正式not-executed，候选视觉、实际八分支、公网30分钟/48小时仍未验。

## v1.18 实施检查点（2026-10-11）

CDS:d3b7e2ad2944257beaa7d8522d3f2135cff8d1b9; IMP:2a8e22723eae3330d081204ba37cfe5925495777（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

2b72收尾回执/已核验旧图自动恢复已实现，启动与分钟tick每轮一条、轮转/去重、暂停/draining不恢复，主相关463。dc9f把组件scan也限为1：原批量放行1真红→44绿/tsc，独立2b72 scan(8)三run边界红保留，不扩张为生产tick红（它原本显式1）。2b72独立新整链复验尚未归档，不能算真实Master/Daemon、未知晚创建/无回执崩溃或新图发布对账通过。

d3b7补exact单服务的dependsOn项目内应用传递制品闭包，不包含无关服务；缺Profile/未登记running infra、跨项目、循环或非exact依赖失败。按本次target展开模板，不依赖旧/空CI缓存；依赖制品缺失前保留在线容器，不隐式重部署依赖。valid cached SHA的旧真实HTTP＋假Docker出现破坏性替换是真红；第一次空缓存仅api模板invalid是安全拒绝，不计依赖漏检红。cached/empty两场景复绿，闭包7/制品6/路由237共250与显式tsc绿。基础设施status仅用于排除应用制品集合，不证明实际健康；固定d3b独立复验和真实OCI/依赖运行待验。

2b72固定全量643文件9403通过、6文件19条跳过、1obsolete snapshot，86.40s；相关463/tsc绿。d3b最新代码仅250相关与显式tsc，dc9f另44；不继承2b72全量。历史628/733失败与池连接停顿风险复现仍保留，根因未闭。49项正式not-executed，候选视觉、实际八分支、公网30分钟/48小时仍未验。

## v1.19 实施检查点（2026-10-11）

CDS:e5fd48b3ad177cbfa834533f06033f6b02810ff4; IMP:780741929342685f8587ffc9b3d1cb1249a3faa6（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

e5fd故障诊断IO按完整容器ID及项目/分支/Profile/交付归属合并：1在途、16排队、5秒排队过期、完成后5秒/64项缓存；mutable name/短ID不缓存，启动与健康恢复使同ID旧cache失效、旧pending不重入cache。低优先级执行并在CLI侧投影inspect，不复制解析失败原文。主20事件触发40命令是真红，修后2命令且20事实/回调仍保留；malformed inspect敏感原文泄漏是真红，改有界错误后绿。缓存/归属/重建/满载/排队过期/异常等相关69、显式tsc绿。只验证IO预算，不声称异步旧事件回调顺序、批量巡检或真实事件风暴/公网性能通过；独立固定检查点待验。

2b72独立实际Container→Engine取消→收尾回执→原租约完成→真实JSON重载→Reconciler与自有HTTP探针/路由ACK共35/35，Journal收尾16/16；删receipt与前置ACK分别2红/1红，恢复3绿。scan(8)三run边界红保留，主dc9f修为只接1，固定d3b独立复验待归档。上述是假Docker/自有HTTP组件整链，不是真实共享Master/Daemon、未知晚创建或无回执崩溃、新图已发布恢复通过。

## v1.20 实施检查点（2026-10-11）

CDS:d39fdbb953ddf0197446a8ae9be947317d5ad4f4; IMP:b189c3fd6dae24af5a7f23b383399c38b4bb1cdc（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

a21生命周期状态守卫绑定不可变ID、同名代际及最新已观察事件水位；原JSON reviver source获取精确纳秒BigInt，拒绝未知/等时/历史事件回写。只保护状态，生命周期事实仍保留；历史无ID兼容不是身份通过。独立固定a21：原12+扩展8+时序14+解析25共59/59；删实际index守卫2红并还原2绿。旧e5fd异步诊断跨代际、1bab历史事件、2b95历史start夺走合法新exit与秒数溢出真红均保存，不抹掉。独立使用实际受控CLI/JSON/解析与固定index回调，不是真实Master/Daemon。

d39f分支SSE有界写入：项目/单分支及凭据范围过滤，已知branchId可解析归属；无归属事件拒绝。res.write(false)后只留重同步位、不序列化后继事件，drain发送当前snapshot+resyncRequired，页面权威GET复核。256KiB帧/512KiB积压/5秒阻塞断开，清理监听且不取消交付；服务buildLog不复制入状态帧。save清空列表cache/inflight，旧计算不能回填。原背压/branch过滤/项目密钥3真红、branch-only归属丢更新1真红复绿；HTTP测试超时拒绝不能假绿。固定相关6文件328、core/web显式tsc与Vite4.02s绿。错误cwd运行source-contract fixture ENOENT不计产品红，按正确cwd复绿。独立d39f待验，其他SSE端点/100连接/真实Master性能与候选视觉未验。

d3b固定独立实际自有Express单服务→Container→自有假Docker/git→真实StateJSON重载26/26、制品闭包13/13、单run扫描限量13/13；旧2b有效缓存但缺worker制品仍破坏在线容器是真红，空缓存invalid模板仅安全控制。2b72独立取消/receipt/租约/JSON/Reconciler自有HTTP整链35/35、Journal16/16，删receipt2红/删前置ACK1红还原3绿。均非真实Master/Daemon或生产入口通过。

1bab固定全量645文件9430通过、1文件1失败、6文件19条跳过、1旧obsolete snapshot，66.04s；user-project-access最终激活预期200实际500，20ms持久化预算根因尚未闭合。聚焦60及d39f相关同60通过不消除全量红。2b72历史9403全量绿及733/628历史400404/超时/连接失败继续保留，不继承本修订。

49项正式、视觉、实际八分支、公网30分钟/48小时仍未执行；隔离宿主信息已询问，未收到答复。不在共享宿主注入故障；目标保持active。

## v1.21 实施检查点（2026-10-11）

CDS:5f32e777fb5fcbd529b7fbb4d10279a7223ee204; IMP:bf2788b40ffd9f1a3f8bc45bc03c8f0670f12183（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

独立d39f固定HTTP18/20：事件声称项目p但State已知分支归属q，实际发送q完整分支；patch.services.buildLog仍进状态帧，两项真红。Peer11/13：已有512KiB+待写256KiB仍接受、blocked外部积压增长未检查，两项组件预算红，不扩张实际TCP超限。真实暂停TCP1/1：1740通知、慢端9次write/max180410字节、5秒清理，快端仍收到175帧；实际旧compute/save新GET竞态1/1：旧GET可返before但不污染新GET after。observer双writer/空EventEmitter error及archive cwd错误仅夹具/操作provenance，非产品红。5f32已按当前State权威校验项目/双branchId冲突，patch去日志，积压按socket+待写帧总量并在blocked复查；主HTTP原两红复绿，相关395/tsc绿。固定5f独立待验；不继承100SSE/公网/实际Master性能或候选视觉通过。

5f32 JSON慢IO只保留单在途快照、一个显式flush冻结pending和最新脏引用，跨tick普通save不累积全量字符串。held磁盘21写应2是真红，修后2；主17项包括真实磁盘重载、全等待者失败、后成功不改旧失败、后序列化错误不伤有效在途/queued屏障及未save live突变不改冻结内容。相关186及联合395/core tsc绿。仍主线程全量stringify，不是增量JSON/无阻塞/真实持久化性能通过，固定独立待验。

5f32带只记录阶段/耗时/状态的自有脱敏诊断全量647文件9466通过、6文件19条跳过、1旧obsolete snapshot，63.47s；417慢磁盘阶段/39事件循环延迟样本，仅本地测试观测。1bab原user-project-access 1红9430绿与20ms最终激活500根因未闭，聚焦60及这次全量绿不抹红；733/628历史400404/超时/连接失败仍保留。

49正式、视觉、实际八分支、公网30分钟/48小时仍not-executed；隔离宿主信息待答，继续本地实现。

## v1.22 实施检查点（2026-10-11）

CDS:a0096fe68c2d4adcb7a9279e9807573ccc8813b3; IMP:c859e5d6f85a30f62658358d956e4ebad4b38d57（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

7212独立22局部通过但真实ShellWorker固定100枚举三轮只执行[0,0,0]，连续失败饥饿0/1真红；旧5f精确同步回调真实Git0/2，cwd命令替换反例保留。a0096将同轮准入/执行改为按上次实际尝试身份循环顺序，失败推进、过期不推进、满64替换最远排队目标；主同固定枚举红复绿，100全超时轮次100身份无重复，相关66/core tsc绿，固定独立复验待验。不声称实际Master性能。

固定5f32独立60/60局部通过：HTTP20、扩展权威8、Peer13、真实暂停TCP1、旧GET/save竞态1、实际FileHandle/JSON13、并行durable终态2；原d39f四红复绿，慢IO旧21写反例0/2、新2写复绿。模块Git核对13项；不继承实际Master、100SSE、公网、视觉或8支通过。

八个隔离本地候选已从各自最新origin源提交创建，每支标准13角色合同检查及候选实际node测试通过，仅传播四个IMP制品合同路径，未复制CDS平台代码或覆盖协作者分支；104角色为静态枚举。A07文档冲突保留其独立迁移/运行期资料并定点更新exact/黄蓝/辅助合同。完整40位目标、父提交与文件hash见doc/cds-imp-express-eight-candidates.json；八支均not-pushed/not-executed。用户既有八支push授权有效，但平台修复及隔离环境准入尚未满足，不把推送到旧CDS并触发重编译当验收。

5f32历史全量647文件9466通过、6文件19条跳过、1旧obsolete snapshot（63.47s），不能继承到a0096新SHA；1bab 20ms最终激活500及733/628历史失败仍保留，后绿不抹红。

49正式、视觉、实际八支、公网30分钟/48小时仍未执行，目标active。

## v1.23 实施检查点（2026-10-11）

CDS:d786a528a9bc93c6dabbf5fe3d51068a42c8d227; IMP:59b5d6db2cfaa4464efe10d68c13eac3a2d23886（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

330ac0fc5b4272956838432ba07908d554744b94按稳定项目/分支调度身份修复新目标连续失败饥饿；固定独立29/29局部通过，真实Worker固定/变化目标、真实Git/精确index回调及100失败枚举均保原红。不继承实际Master性能。

53ce8d43e374324f5a80c6b1e35a0239be56f700旧状态流共享缓存、慢读限量并统一degraded.reasons；stream-subscribe加入在途不标脏或覆盖terminal。6c9独立17项15绿2红（冷8连接完成后compute2、普通update缺reasons）及旧terminal3红保留；53ce固定独立8/8复绿，主相关26/core tsc绿。真实TCP慢读/25秒心跳属于6c9局部历史，不传播为全部SSE/公网/正式压力通过。

2ea1c68c204da471ad06690c5af25582aa5ab5c5加入同项目/分支/Profile/完整实际固定SHA/配置目标，按范围保留pending；64每分支/512全局拒绝新范围，同范围更新不增槽；等冲突操作结束再取pending，单服务按实际URL/SHA重放。双force Profile续约不互吞，stop清全部，到期只清冲突pending。源码入口不以body SHA声明固定；joined响应追踪真实在途run。主5协议红、2实际HTTP入口红、续约1红、whole-source1红保留；相关312/312与core tsc绿。正向whole-join改为实际exact路径后，因漏配pull fixture造成一次timeout，修fixture并保原件，不算产品红。旧53ce独立27判据12绿15真红（含跨项目joined/双续约），2ea固定独立44项41绿3红（未消费续约时pending提前出队）；ec939原44及新增3共47/47局部复绿，删除Map存在守卫1真红。原3红保留；相关313/core tsc绿。；进程内合并不是durable队列或真实Daemon恢复通过。

d786a528a9bc93c6dabbf5fe3d51068a42c8d227固定全量650文件9496通过、6文件19条跳过、1旧obsolete snapshot，64.31s；包含失败才输出脱敏HTTP生命周期诊断，本次无owned-test-http错误。6c9全量649文件9480绿/bug-reports分桶socket hang up1红与旧1bab激活500、OAuth/超时/ECONNRESET均保留；本轮未复现不能称历史根因闭合。新trace独立文件，不混用5f/6c9旧追加trace统计。

八个固定本地候选清单保持不变；独立8/8候选、280 Node合同局部通过，A07独立8433跟踪blob/533migration保持；104角色仍只是静态枚举。八支not-pushed/not-deployed，原八支push授权持续有效，但旧共享CDS触发编译不能当验收。

额外只读探测mycds SSH成功（Linux16CPU/约31GiB RAM），sudo -n Docker可读，承载大量他人及IMP/MAP常驻服务；2026-10-11 05:32 CST可用628MiB、swap8191/8191MiB、load2.25/26.60/33.20，不作隔离压力宿主，不停他人服务/启新容器。本机Docker仍不可达；隔离宿主问题待用户回复。

49正式、当前修订视觉、八支完整部署、公网30分钟与48小时仍未执行，目标active。

## v1.24 实施检查点（2026-10-11）

CDS:12ad51850189e78206cab18b8b4de97b359f232e; IMP:59b5d6db2cfaa4464efe10d68c13eac3a2d23886（IMP产品a35b160067cf2f9b7a41b5f5f2d37afb05ba8130；本地检查点，后续文档提交另计，未部署）。

2ea固定独立44项41绿3红（未消费续约时pending提前出队）；ec939原44及新增3共47/47局部复绿，删除Map存在守卫1真红。原3红保留；相关313/core tsc绿。

efcdaf0dc21687fbcecb6af0b0fafaaa953fdfc0重放观察：5秒响应头、30分钟观察、256KiB帧/16KiB解码片；非2xx不读正文，complete.ok/错误/mergedjoined/unknown分别记录，只记有界枚举及合法run ID；不重试或取消实际执行。实际入站HTTP＋fake出站/Docker5旧红→5绿，观察器13及协调/路由共331局部绿、core tsc绿；efcd固定独立实际自有HTTP/native fetch23项21绿2真红（complete.ok=true却带started/rejected被误判完成）；明确cancelled被记失败也已发现。12ad新增有限状态及取消归因，主3旧红→绿，相关335/core tsc绿，固定独立待返。未改实际run，不把观察取消当Daemon闭合。 仍未实现durable pending队列，不证明实际Master/Daemon或线上通过。

ec939全量649文件9495绿/2红/6文件19跳过，97.10s；2红是user-project-access在20ms故障注入后末尾正常写入500。额外40ms正常flush确定性复现2红；9f1b仅在已恢复/解锁后的正常写入前还原原环境预算，保留全部20ms负面、409/401、补偿及真实JSON断言，完整60绿。生产默认30秒未改；这不关闭线上持续500、历史OAuth/超时/ECONNRESET或bug-reports socket hang up。9f1b固定全量651文件9516通过、6文件19条跳过、1旧obsolete snapshot，67.15s；不能继承到12ad。唯一trace路径已纠正，不与d786混合。 ec939诊断路径常量误指d786追加trace，不能用于新纪元性能统计；此次独立trace路径已纠正。

49正式、当前修订视觉、八支完整部署、公网30分钟、48小时及一周复测仍未执行，目标active。

## v1.25 最新检查点与待验

12ad固定独立自有HTTP24/24分类绿，实际Router/Coordinator/StateJSON另发现目标C的failed run误写旧B、held pull取消误报failed；真实nativeHTTP30,000小日志deadline同一promise累积29,624 reaction/GC后heap增长为真红。原件留在独立账本，均非线上压力证据。45dc526374b6ed31d7697063b338e6a0249f344d本批先复现主3红/1绿；target在artifact准入前冻结、actual租约失效归取消、pull/resolve后复核、未进入runService不清理旧容器；观察器单timer保留至多一个当前read waiter。新增worktree/artifact等待取消并真实StateJSON重载，相关340/340绿，core tsc0；固定独立复验进行中，全量尚未重跑。

49项正式验收仍全部not-executed；八候选未push/部署，已有推送授权不重复索取。候选视觉N/A，共享旧截图仅失败基线。

## v1.26 新检查点

45dc固定独立34/34局部绿：原24 HTTP分类、真实Router失败run目标2、held worktree取消2、真实fakeCLI artifact等待取消2、30,000小帧heap1、deadline/后台Node CLI继续/绝对deadline3；原12ad三类真红原件保留。主45dc固定源全量651文件9523绿、6文件19跳过、1obsolete snapshot，64.23s；不能继承至71e。

71e331682a49052ab3a8828e226ae91ec66a5850发布中心提交历史/祖先比较迁移共享Shell Worker，完整ref tip冻结、同冷签名合并、32在途/128TTL缓存、旧结果不盖新目标；整轮3秒signal、超时unknown/null无提升，targets/run元信息浅冻结。主异步2红、input冻结1红、实际HTTP移除runner接线1红保留，相关68及core tsc绿。首版HTTPfixture正则只捕获git前缀导致缺nodes，修匹配后绿，该次为夹具错误，不是产品红。固定独立复验进行中；未关闭元信息clock/磁盘/其他热点或正式Master性能。

该批不更改49条正式状态/视觉N/A，也不把源码移出同步路径等同为公网性能通过。

## v1.27 最新固定结果

71e固定独立12/16局部绿，三个缺口：warm promotion重复Git（旧已存在热点）、second caller自身取消截止被忽略、empty环境history已超时仍推荐提升；direct和实际HTTP3s均留红。主新增三个反例3/3真红→修复：位置与promotion共用完整immutable pair的512成功缓存/64pending，短SHA/null不cache；shared caller各自观察signal，second退出不取消first；已过historyDeadline任何环境都不推荐。d2713c229e0c78a57feefb10151fcb47b9c8fb9d加fd113指南v2.43，相关83/core tsc0。fd113固定全量652文件9534绿、6文件19跳过、1obsolete snapshot，65.08s；71e原全量9530绿/1红/19跳过的红是已退场sync诊断静态守卫，不算线上500，改为实际parse CPU埋点后相关诊断12绿。独立fd113原actualWorkerHTTP v3 5/5，原protocol v2 10/11：唯一false要求TTL/eviction每次5个Git，但immutable pair缓存依法复用2个；保原10/11，末尾补只判确有重算且warm0的v3与新边界，尚未冻结最终总表。

远端fetch核对基线未变；八支原推送授权继续，平台/隔离环境准入待满足。49正式与新视觉未执行，不以本地全量关闭。


## v1.28 最新本地检查点

fd113固定独立23/24局部，原三问题关闭，但history shared task保留每个已取消订阅reaction新真红：30,000次GC后heap21.97→105.60MB；追加count旧fd红22.00→90.44MB。58087508db6d1dcf7155730a801c37bb80d29636改为共享task单完成reaction与可撤销观察集合，主history/count两反例各2000reaction真红→54绿/core tsc0；初版vi.spyOn递归仅夹具错误，原件保留。580固定独立25/25局部，原history/count各30,000取消后max1reaction/heap22.61与22.73MB，actualWorkerHTTP5、protocol11、countbudget7保持；主固定全量652files9536绿/6files19skip/1obsolete snapshot/67.09s。

792baa5d597006145b7dd7f4b48ff6d22094dbf3将发布发起元信息git show移共享Shell Worker，公共runner抽独立模块保持rail出口；Router旁路void/catch不等待发布，32不同在途、同project/SHA/候选roots合并，候选共用3秒截止，不cache超时/late/失败，500台账及v1/v2/真实committer date保持。主async三反例真红→绿，移除Router注入自有HTTP接线1真红→还原；相关96/core tsc0。指南v2.44已同步；固定独立与全量进行中。同步台账文件load/persist、磁盘/启动及其他热点仍待核对；不作正式Master性能结论。

两仓库计划同副本；37partial-local/12todo，49正式全部not-executed，视觉N/A。八支既有推送授权有效，运行环境/平台准入仍待满足；没有远端发布或共享写入。

## v1.28 固定复验续记

792baa固定独立44/44局部，实际自有HTTP→ReleaseService hook→StateJSON→真实ShellWorker慢Git无Master native Git；8POST14–23ms，真实committer date保留；3秒取消owned PID已消失，不cache晚结果。固定全量653files9541绿/6files19skip/1obsolete snapshot/65.67s。

3635固定独立23/23局部：冷探测共享一次、epoch突变2红及index await突变3红保留、真实10秒截止及owned PID取消；仅自有假Docker info，未调用实际Docker。主tick13ms对旧470ms支持隔离；冷HTTP897–898ms比旧474–480ms更慢，不能声称冷请求更快。相关75/core tsc0。主3635全量652files9543绿/1权限恢复测试红/19skip，66.63s；故障20ms预算延续正常磁盘恢复触发安全重试，受控第3flush40ms复现3-vs-5红。

66fb1c9b8610ccc60d0ff575fcad0eeb7cea5761使index后台与route共用重放：原单服务错派整分支、私有错误体日志、HTTP200失败漏判、无响应无限等4真红→绿；新增整分支/受理/已删分支控制组。仅调整权限恢复夹具预算范围，另补清理超时保持409/原grant与真实JSON重载，提前放gate外部突变1红→还原。相关5files402绿/core tsc0；固定全量654files9552绿/6files19skip/1obsolete snapshot/71.27s。末尾固定独立进行中；内存pending仍非durable，不证明实际Master/Daemon/公网/视觉或八支通过。

### v1.28 重放归属独立红与修复

66fb固定独立自有nativeHTTP/StateJSON及实际index/route摘录17场景15绿2红：原项目p的branch被new-project替换仍派旧SHA、deploy-profile缺Profile扩大whole；第二仅helper合法类型允许的边界，不声称Router能产生。59d8736036cb6faa699fe73c506c5cce867eef39在派发前核原project/branch/范围，未知或漂移、缺Profile/矛盾或非部署kinddrop，日志归原来源；主3反例红→344相关绿/core tsc0。固定独立进行中，本SHA未再跑全量；66fb全量9552仅历史。

## v1.29 源码例外队列与独立复验检查点

59d固定独立59/59局部（重放原17+扩展7+observer24+实际Router失败4/取消4+观察socket外部abort后执行仍受租约控制2+真实默认5秒头budget1）；原66fb两scope红关闭。whole正例旧带Profile与State自动填legacy项目两轮夹具偏差原件保留，未放宽scope。66fb权限清理v2独立6/6：清理ACK未知memory gate/竞态更新409，磁盘若已完成cleanup则重载仅安全old=a、新b无grant，5flush确认后清账。v1要求此时磁盘仍有journal的探索红保留解释，不作越权或500修复结论。

dc2f7d0ce47584656d948e61d048f17696f0da26本地源码例外queue按冻结project轮转/同项目FIFO，匿名兼容组FIFO；默认512等待/30min上限，超量与过期明确失败且不取消运行holder，授予/取消/超时清timer/listener，onStart观察异常释放槽位。whole/profile两路实际传projectId、任何gate失败结束排队episode，日志/UI改等待总量不承诺绝对位置；tracker旧min位置断言退场并保留旧红。主5新反例真红→25 gate绿，5files288相关/core及web tsc0，固定全量655files9560绿/6files19skip/1obsolete snapshot/65.48s。独立固定复验进行中；phase公平队列、durable pending、实际Master/Daemon与公网未验。

两仓库最新fetch远端仍为CDS origin/main45533b、IMP origin/test e2fd7与origin/main2bf49；未发布、未操作共享宿主，固定八候选未变。38条partial-local/11todo，49正式not-executed、visual N/A。expected result：排队有界且跨项目不被积压垄断；current evidence：288相关、9560全量及两侧tsc0；visible result：未部署；gap：dc2f独立、真实阶段公平/持久队列/八分支/公网未验；required action：按原同编号继续实施与末尾复验，不提前关闭目标。

## v1.30 固定队列轮转、立即取消与当前缺口

4d51286ca9e0159b778bff6b854ef0a33bc28ec2以有界稳定项目环保留下一个项目的轮次，已排空组从环移除、不长期缓存项目身份；旧dc2f独立direct12/13与actualRouter7/8的三项目轮转红原件保留，主1新反例真红→289相关/core tsc0，固定全量655files9561绿/6files19skip/1旧obsolete snapshot/68.42s。末尾4d原28/28局部绿，但追加whole/profile取消100ms仍有waiter/chip的两真红，transfer时安全不能替代立即取消。

2642d388ada74e7ffe14bd7f6cfa9441602659e5将实际lease signal直接接两入口的source gate，whole合并layer signal，15s tick只兼容缺signal旧租约；主两实际HTTP/StateJSON反例在旧4d 100ms仍queued1真红，新5files291相关/core tsc0。末尾唯一31/31局部：direct13+扩展5+实际自有nativeHTTP/Router/Coordinator/gate/StateJSON v5路由12+真实whole layer abort控制1；取消100ms前后JSONcancelled、chip清、gateactive1唯一a0，尚未release其他holder，取消者不进runtime。runtime/pull/readiness仍受控替身，非真实Daemon。原4d两红与重复v4/v6控制保留、不重复计数。

2642d全量654files9562绿/1failedfile1HTTP超时/6files19skip，68.77s；uptime-agent-selfservice的无地址台账拒绝用例5秒超时，单独16/16复跑绿，根因未证明，原失败保留，不称全量绿或线上500闭合。日志/tmp/cds-express-2642d-full.log、/tmp/cds-express-2642d-uptime-recheck.log；主取消红绿/tmp/cds-source-queue-immediate-cancel-final-{red,green}.log及-tsc.log。

expected result：源例外项目轮转和立即取消不影响在途holder。current evidence：固定独立31与主291/core0、全量1未闭合超时。visible result：未部署、候选视觉N/A。gap：49正式/8支完整交付、实际Daemon/公网/双主题、持久队列与其他同步热点未验。required action：继续本地TDD消除热点、保留原失败，在隔离准入后按既有八支push/selfupdate授权执行真实验收；不提前关目标。

## v1.31 systemd启动迁移固定检查点

1f977155b354e8c89180d7ba6faf195dc86419b9将systemd发现/reload/权重/重启迁共享Shell Worker，index传现有shell并await；嵌入fallback1执行/3排队，单命令发现3秒/reload与权重10秒/restart15秒。异步前冻结原unit/install意图，同规范化installedUnit唯一写入、不同unit上限32、无重放；备份及reload失败恢复旧文件，首次安装失败移除本次文件。小unit文件仍同步，实际自更新未执行。

主共享executor接线4真红、actual index移除inject1红/仅去await1红、异步目标变化1红、并发writer1红保留并复绿；原index夹具直接执行TS的SyntaxError原件保留为夹具错误，transpile后反例才是真红。新增11判据及原模板/真实自有ShellWorker隔离控制共4files51绿/core tsc0；不调用宿主systemctl/写etc。固定全量656files9574绿/6files19skip/1旧obsolete snapshot/70.16s。原2642d HTTP5秒超时本次正常，但未改其测试或生产，不证明历史HTTP/线上500根因关闭。

固定1f977独立复验进行中；P2剩余热点只读清单在仓库外p2-native-hotspots-1f977-local.json，仍有clock同步load/persist、janitor statfs与Docker native execFile、启动端口execSync、特殊tar/数据库/SSH流native spawn。不能用异步API或本次51/9574绿声称所有Master热点闭合。

expected result：启动命令不在Master native执行，完整维护旧顺序和单写入归属。current evidence：8类主局部真红演练、51相关/core0与9574全量，固定独立待返。visible result：未部署、视觉N/A。gap：49正式/8分支/实际Daemon/公网/双主题与其他实施条目仍未完成。required action：末尾固定复验，有红继续原夹具修复；主继续同编号剩余有界实施，隔离宿主准入后按既有push/selfupdate授权执行真实交付与视觉。不提前收口。

## v1.32 实际unit单写入恢复审计

1f977固定独立20/21：14协议+3自有真实ShellWorker/fake systemctl/nativeHTTP+3actual index接线通过；同一实际unit的符号链接别名竞争写1真红。真实Worker控制轻HTTP5ms/76tick、Master native spawn/execSync0；自有12秒fake reload在10028ms被10秒deadline终止、PID消失、旧unit恢复。原2642d同步假CLI阻塞834ms保留。以上都不是实际宿主systemctl或正式公网性能。

80e9414691adefa602551541ba25a1e7d531e46e用真实path和dev/ino共同锁定实际文件；未创建按真实父目录/basename解析末级悬空链接，32容量按写入调用计数。首次await冻结实际写入目标，创建后补inode锁；写入前和reload完成后核原请求路径绑定，未知或改向返回error，不更新权重或restart其他服务，回滚只触及冻结目标。linked unit保持原服务名字，不能把路径外目标basename当systemctl名字；硬链接锁共享文件不等于不同Daemon服务实例。主旧1f源8反例真红→20新判据及原12模板/11Shell/17隔离共4files60绿，core tsc0；固定全量656files9583绿/6files19skip/1旧obsolete snapshot/66.64s。日志/tmp/cds-systemd-physical-owner-final-{red,green,tsc}.log、/tmp/cds-express-80e941-full.log。固定新SHA独立复验进行中，不传播原1f的full到新源。

expected result：别名不能绕过实际unit单写入，等待中改向不修改或重启其他目标。current evidence：原独立1真红及主8真红，当前60相关/core0/full9583，固定独立待返。visible result：未部署、visual N/A。gap：49正式/八分支完整交付、真实Daemon/公网/双主题仍未执行；clock同步文件、janitor statfs及其他热点、durable pending/阶段公平、P4其余流、IMP辅助终结receipt继续实施。required action：末尾原fixture固定源复验；主同步计划并继续有界TDD，隔离准入后依既有八支push/selfupdate授权完成真实验收。38partial-local/11todo保持，目标active。

## v1.33 回滚归属与最终结果恢复审计

80e941固定独立29/35局部：原20控制及原symlink1绿，扩展物理身份8/14，六真红：reload等待后同path替代inode或指向foreign的symlink被backup回滚覆盖；首次安装同path替代inode被rm清掉；no-drift未核改向；权重和restart等待后改向却仍报已应用。原1f与80e所有反例、固定源hash与自有Worker/HTTP控制均保留，不传播到生产。

d1a56ac49b4117eef0e832a0dc6074ff23cc50f0在no-drift前复核；回滚/首次失败移除仅冻结实际路径仍canonical同path且当前dev/ino属于原writer，未知或已替换则保留备份/error，不覆盖或删除foreign。权重/restart await结束及最终fixed返回前复核；检测到改向不报告runtimeWeightsApplied/restarted true，已发命令不能撤回，真实Daemon结果未知须另对账。主固定旧80e源六真红→4files66绿/core tsc0，日志/tmp/cds-systemd-rollback-owner-final-{red,green,tsc}.log。固定新SHA全量与独立复验进行中；80e历史full9583与原2642d HTTP超时单独保留，不能继承为新源结果。

expected result：回滚只写本次owned inode，所有成功终结绑定实际目标。current evidence：旧源六主/独立真红、当前66相关/core0；新源full和独立待返。visible result：未部署、visual N/A。gap：49正式/八分支/实际Daemon/公网/双主题与其余计划条目仍未完成。required action：末尾原六反例固定源复验，有红继续修；主继续其余本地有界实施，隔离准入后依既有授权真实八支交付与正式视觉。38partial-local/11todo、49not-executed保持，目标active。

## v1.34 固定独立闭合与回收草案否决

d1a56固定独立37/37局部：原14协议、3actual ShellWorker/fake systemctl/own nativeHTTP、3actual index、原symlink1、原physical v2十四项、backup失败与错误后锁释放2。80e六红原fixture/期望不变复绿，历史29/35及原1f20/21保留。完整四源Git hash一致，source-manifest与evidence-summary在独立账本目录，epoch checkpoint-d1a56-systemd-physical-local-37green。主66相关/core0，固定全量656files9589绿/6files19skip/1旧obsolete snapshot/65.44s（/tmp/cds-express-d1a56-full.log）；原2642d HTTP超时与线上500根因仍未证明关闭。

P2后续直接把janitor rmSync/stat改fs.promises的草案已否决：初始6files97/core0后，ownFS held rm→同path重建→释放清理会误删新owner，1可复现真红。草案/测试/hash和/tmp/cds-janitor-async-removal-replacement-draft-red.log保存在仓库外janitor-async-removal-rejected-draft.*；跟踪janitor精确还原d1a56，草案未提交/发布。此是被否定局部设计，不是d1a56新增产品红，也不能把草案97绿计入固定源。后续先设计独占path/实际身份与可恢复回收，再迁移递归删除；主负责，同编号P2-06，不为异步API丢掉安全护栏。

expected result：systemd本地身份漂移不伪报成功；后台回收不删新worktree。current evidence：前者37固定独立、66相关/core0/full9589；后者否决草案1真红，未采用。visible result：本候选未部署/视觉N/A。gap：49正式全部not-executed，八支完整交付、隔离宿主、实际Daemon/公网/双主题、durable pending/阶段公平、P4其余流、IMP辅助terminal receipt仍待完成。required action：主继续安全回收设计及其他计划实施，末尾按新固定源逐项复验；准入后依既有push/selfupdate授权运行完整验收。38partial-local/11todo保持，active，不宣称全部黄闪电或不卡。
