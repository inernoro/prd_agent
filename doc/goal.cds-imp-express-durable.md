# CDS 与 IMP 极速长效联合目标 Brief

版本：v1.5；日期：2026-10-11；状态：active。

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

## P3 候选替换设计合同（待实现，不作为已通过证据）

同一交付冻结完整目标SHA、配置指纹和服务图。在线BranchEntry.services继续指向旧实例；候选使用独立容器名、端口和交付级应用网络，保持原branch/project标签并另加run/generation归属。候选服务图在私有运行上下文中解析依赖，不能将旧网络别名与新实例混用。候选记录在创建前可靠落盘，只存身份、版本引用、阶段与运行事实，不复制凭据。

切换顺序：完整制品准入→容量准入→创建候选→完整图就绪→复核租约和目标→可靠保存切换意图与恢复点→发布新路由→核验实际路由消费者已应用完整目标映射→记录切换完成→回收旧实例。publishNow返回写文件不能替代Forwarder消费者确认；Master直连也须校验实际映射。路由确认失败先恢复旧映射并核验，未确认恢复时保留实例与容量事实，不盲删候选或旧实例。

worker默认不能双实例消费；必须有可验证隔离/租约才允许并行候选，否则采用已声明的stop-and-restore约束：保留旧容器及不可变配置，短暂停旧worker后启动候选，失败恢复旧worker。固定宿主端口或独占写卷同样不承诺无中断；缺兼容性/恢复证明时准入失败，不能试运行后再猜测数据是否安全。此目标不自动授权业务库migration或真实消费测试。

取消先终止归属执行进程，再按run/generation清理实际候选容器与网络，释放真实容量；Docker客户端被终止不等于Daemon侧创建已停止，须对账后交给下一写入者。重启时读取候选/切换记录与实际容器及路由对账，未确认切换不自动将候选当运行版本。正常旧实例、其他分支、已推进协作者版本不能被候选清理器回收。

TDD先红：候选create/start/readiness任一失败旧路由仍可服务；固定端口/worker/独占卷约束；消费者未确认不得删旧；取消在create和切换前两窗口；回滚失败保留可恢复事实；执行器/Master重启未知中间态对账。真实独立验证另覆盖完整八分支和所有运行角色，不由纯函数/Mock测试继承通过。

## 验收与真实收口

严格采用计划v1.3公网和48小时门槛；八分支完整服务验收、失败保旧、取消恢复与双主题视觉证据必须同时成立。输出页面、交互、命令、权限、闭环的enumerated/mapped/executed/closed_loop_pass/failed/blocked/uncovered，不传播旧SHA结果。阶段通过不关闭原生目标，尚无线上视觉pass。

## Goal State

- Goal ID / 名称：CDS-IMP-EXPRESS-DURABLE-20261010 / CDS与IMP极速长效联合修复
- 当前阶段：implementation
- 执行坐标：`worktree=CDS:/Users/inernoro/.codex/worktrees/cds-express-durable-20261010/prd_agent,IMP:/Users/inernoro/.codex/worktrees/imp-express-durable-20261010/mdimp；branch=CDS:codex/cds-express-durable-20261010,IMP:codex/imp-express-durable-20261010；HEAD=CDS:ac86760dfdf1c51a4c9bdb4db84301b69edee261,IMP:9adbad64c9b7004de66f1f02b280249dddfc3749（实施检查点，后续计划文档提交另计）；origin/main=CDS:45533b419e1cfc54b145a545a716563617659d01,IMP:2bf49bf92a634057b65d40e0c5e9faa3ed02ae9c；ahead/behind=CDS:49/0相对origin/main,IMP:4/0相对origin/test；environment=本地独立工作树,线上只读探测；database=N/A本轮未写入；tenant=N/A平台基础设施；role=本地主进程,线上机器只读；route=https://cds.miduo.org/branches/defd4695ab5f；auth=本地无登录要求,线上现有CLI项目凭据不输出；external_ids=bootstrap dr_23b50418a7954b2a41e6f2b4(其他任务活动,不操作)`
- 写入所有权：`owner=本任务/root仅两新工作树；other_tabs=原任务工作树read-only,tail_acceptance只写仓库外账本；handoff_checkpoint=本地P1/P2/P4与IMP exact合同部分实现,已保存固定本地SHA,未发布`
- 范围账本：`goal-core=49条计划与完整极速/控制面治理；required-prerequisite=集成已有CDS修复及隔离验收依赖；environment-recovery=仅基线盘点,不重建持久数据库；successor-or-non-goal=业务流程重写,真实定时作业恢复,其他任务目标关闭`
- 已确认范围 / 非目标：两仓库技术交付目标,不扩大IMP业务分母或改CL合同。
- 当前实现事实：两独立工作树与49项双副本计划/TDD账本已建立；继承安全与状态止血基线，完成本地精确制品准入、版本引用/缓存digest校验、执行Worker/supervisor硬中断清理/ACK背压/调度与日志热点迁移、实际覆盖/黄蓝/独立版本状态、IMP13角色exact合同与权威文档校准。本批又补P3取消从租约贯穿真实命令、pull、启动信号、TCP/HTTP/重试及崩溃日志；P1新发现真实prebuilt自动填缺省新分支默认,保留明确例外与已有分支；候选替换设计合同已写；候选私有服务图/摘要身份/隔离网络/创建前归属校验与候选账本可靠保存已实现，账本仅投影运行身份，新旧端口预留跨重载及终态裁剪保留，初始存活等待可取消；尚未接入部署路由、切换、worker替换约束和Daemon对账。所有实现仍未发布；候选就绪替换、增量存储/SSE进一步治理、默认策略、辅助生命周期和完整生产证据未完成。 本批修复真实JSON落盘错误被首个flush观察者消费的缺陷，屏障结果对每个等待者保持一致，未知run状态失败关闭；新增冻结完整映射、从实际Forwarder诊断核验的有界确认组件，尚未接入部署切换。
- 证据纪元：`target_sha=CDS:ac86760dfdf1c51a4c9bdb4db84301b69edee261,IMP:9adbad64c9b7004de66f1f02b280249dddfc3749（IMP产品代码a35b160067cf2f9b7a41b5f5f2d37afb05ba8130）；tested_sha=CDS:ac86760dfdf1c51a4c9bdb4db84301b69edee261最后503终结修补77条及tsc通过,四worker全量636文件9191测试对应503补丁前;IMP:a35b160067cf2f9b7a41b5f5f2d37afb05ba8130的35条合同内容,后续IMP提交仅计划文档；deployed_sha=N/A线上运行SHA未证实；environment=本地独立工作树/自有测试进程,共享CDS只读；observed_at=2026-10-10T16:19:44Z`
- 新鲜验证证据：最后503等待终结补丁后6文件77测试及backend tsc通过；503补丁前四worker全量636文件9191测试通过、6文件19测试跳过、1既有obsolete快照提示。此前全量3失败（克隆5秒超时、20ms账户恢复时点、附件ECONNRESET）原件保留；定向原3场景绿，但主进程根目录运行导致另一个样例ENOENT不算产品证据，正确cds目录四worker全量通过，不修改断言。独立账本EISDIR多观察者/未知状态9/9复绿，初始liveness完整runService两反例旧0/2新2/2；独立ACK浅复制后12/13，503悬挂红已修,最后复核待返回。独立自有实际Forwarder文件watch、诊断与代理old→new marker已证实,进程退出；仅本地数据面，不是部署/公网/视觉/八分支。历史e5检查点635文件9180测试与tsc通过；候选16+11归属反例复绿，Daemon为模拟；失败/夹具错误/旧红均保留。
- 当前阻塞或环境限制：完整线上版本未证实、隔离压力宿主尚未核定；本机Docker CLI存在但守护进程无法连接，Colima状态不一致,未重启其他VM；原IMP索引158条超过60上限,只读reconcile无可归档终态,不猜测其他目标完成；本目标直接brief续接,索引登记待治理协调。
- 涌现决定：N/A尚无需登记的新终态机制；保留强门槛不以服务端指标替代公网。
- 下一动作与完成条件：固定ac86760dfdf1屏障与消费者确认的独立复核；继续P3实际私有服务图/worker与独占约束/可靠切换意图、路由确认、失败恢复和取消Daemon对账接线；之后推进P1剩余默认与依赖、P4增量/SSE、IMP辅助生命周期。49项正式与A01–A12真实证据未收齐，目标保持active。
- 终止/接替结论：active
