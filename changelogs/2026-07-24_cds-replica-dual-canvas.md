| feat | cds | 复制集模式 MVP-1：单服务粒度多版本并排（BranchEntry.replicaSets + ReplicaSetService，成员从保留不可变镜像秒起、禁源码回退，分支停止/删除级联收割） |
| feat | cds | forwarder 复制集分流：路由组 replicaGroup + 权重加权随机 + 粘性（query __rs / header x-cds-replica / cookie cds_rs），成员直达子域 <slug>-<memberId>.<root> |
| feat | cds | 分支抽屉新增「复制集」页签（版本并排/权重/直达链/提升/一键退回普通模式）；资源卡对复制集化服务加堆叠徽章特殊标识 |
| feat | cds | 复制集 REST API：/api/branches/:branchId/replica-sets 系列端点 + Activity Monitor 中文 label 全量登记 |
| docs | doc | 新增 design.cds.replica-set 设计文档（四条硬要求 + 边界决策 + 一键隔离数据库 MVP-2 规划） |
| test | cds | 新增 route-resolver 复制集分流单测 + forwarder-route-publisher 复制集路由契约测试 |
| feat | cds | 复制集 MVP-2 一键隔离数据库（保留）：replica-db-clone 三引擎整库克隆（mongo/mysql/postgres），成员启动前先克隆再切库；隔离库快照台账 + UI 数据快照列表 + 手动删除 drop |
| feat | cds | 复制集添加成员支持「共享主库 / 一键隔离库」选择；成员行显示隔离库徽标；远端执行器分支明确拒绝复制集化 |
| polish | cds | 复制集「一个 + 号」简化（对标 Railway）：+ 副本一键把当前版本再起同版本实例并自动均分流量，历史版本并排降级为次级入口 |
| docs | doc | design.cds.replica-set 增补波4「数据库保护罩」（盾形按钮 + 分阶段真实进度 + 一致性校验）与波5「数据回写」（binlog/oplog/逻辑复制槽）设计规划 |
| polish | cds | 复制集 Railway 式芯片交互：资源卡每个应用芯片右上角「+」小按钮 + 数量菜单（1/2/3 个副本确认即成），芯片显示 xN 实例数、启动中光环脉冲；分支列表卡新增「复制集 xN」发光标识（配置仅存分支、删分支即消失） |
| feat | cds | 复制集可观测/可校验（用户五诉求）：成员命名规范化 res-N；每个复制集响应带 X-CDS-Replica / X-CDS-Replica-Group 标记头；副本容器注入 CDS_REPLICA_ID / CDS_REPLICA_INSTANCE 实例指纹；面板「分流实测」按钮走服务端真实入口探测并按响应头统计落点分布 |
| fix | cds | 分流实测改原生 http.request（fetch 静默丢 Host 头导致误记 100% 主版本的真 bug） |
| polish | cds | 复制集面板布局收紧：成员行信息与操作紧邻成组左对齐，废除左右两端拉开 |
| feat | cds | 数据库保护罩：数据库芯片锁按钮一键克隆隔离副本（异步 + 进度轮询 + 芯片环绕动画），副本入数据快照台账保留 |
| fix | cds | 验收 P1 双修：分流实测 path 由后端按服务 pathPrefixes/api-convention 推导（此前写死 / 打在前端容器永远 100% 主版本）；芯片「+」数量菜单 createPortal 挂 body（此前被芯片行 overflow 裁剪不可见） |
| feat | cds | 复制集面板全量重设计：方案A 行式视图（每服务一行：服务名/实例块/流量条/加号，次要操作收进「管理」展开）+ 方案B 流量舞台拓扑（点阵网格、入口-实例层-数据层自上而下、贝塞尔曲线连线、基础设施虚线边） |
| feat | cds | 复制隔离数据库（profile 级）：连接线上「复制隔离」按钮两步动画（第1步克隆入保护罩框、主库不动；第2步副本整体切至隔离库），旧连线灰色留影加断开标记，「回切主库」可逆且快照保留 |
| feat | cds | 后端 isolateProfile/revertProfile API（POST /replica-sets/:profileId/isolate 与 /revert-db）：guard-N 命名单次克隆 + 逐成员重物化换库，ProfileReplicaSet.isolated 台账 |
| polish | cds | 新增副本走灰卡渐显可撤回；「退回普通模式」更名「关闭复制集」；分流实测升级串流模式（逐请求服务端往返）+ 实时日志 + 终局环形仪表盘 |
| fix | cds | 验收 P1 双修：复制隔离识别 .NET 框架风格库名 key（MongoDB__DatabaseName / MySql__Database 等，此前只认白名单家族一点即 409）；同引擎值不同的 key 不再一起覆写 |
| fix | cds | 验收 P1 双修：副本健康实测（服务端 TCP 直连宿主端口）——死副本不再显示绿色运行中，面板红色「不可达」告警 + 舞台红卡提示下线；无 X-CDS-Replica 头的响应不再伪装成主实例落点 |
| polish | cds | 分流实测支持指定探测路径；非 2xx 业务响应中性展示（落点以 X-CDS-Replica 头为准），仪表盘补充说明避免误读 |
| fix | cds | 复验 R2-P1：隔离库名生成归一非法字符（guard-N/res-N 连字符转下划线），此前生成名被自家白名单拒绝导致复制隔离 100% 失败于第 1 步；回归测试绑定真实生成格式 |
| fix | cds | 复验 R2-P2：隔离失败不再静默——舞台 error 副本红卡显示失败原因、行式折叠态红字告警行、成员转 error 即 toast |
| fix | cds | 复验 R3-P0：整库克隆改独立限额辅助容器（docker run 同镜像 + 内存/CPU 硬上限 + 共享 DB 网络命名空间 + dump/restore 单并发限流）——此前 dump 管道在数据库容器同 cgroup 内跑，内存压力实测把共享生产 mongod 打崩 |
| fix | cds | 复验 R3-P1/P2：克隆失败自动 DROP 半成品残留库（清不掉则明示手动路径）；runDockerExec stderr 改头尾双段保留，进度日志不再把致命错误挤出缓冲 |
| fix | cds | 复验 R3-P3：流量舞台多服务时提供切换器，「+副本」不再默认打到字母序首个服务 |
| fix | cds | 复验 R4-P0：克隆期临时收紧 mongod WT cache 至 2G（运行时 setParameter，克隆结束恢复、mongod 重启自动回默认）——辅助容器只保住客户端，被宿主 OOM 杀的是无内存上限的 mongod 本体 |
| fix | cds | 复验 R4-P1：失败残留清理加 20s x5 延迟重试——失败最常见场景是主库崩溃恢复中，立刻 DROP 必失败 |
| fix | cds | 复验 R5-P0：WT cache 收紧此前从未生效——mongosh 对 int64 输出 Long('...') 致 Number 解析 NaN、保护静默跳过后克隆裸奔；读值改脚本内 Number 强转 + 正则提数兜底，并改 fail-closed：保护建不起来直接中止克隆，禁止裸奔打主库 |
| fix | cds | 复验 R5-P1：profile 级隔离克隆透传 onOutput——克隆保护/进度写进成员 statusMessage（UI 可见）+ 服务端日志，「受保护克隆」与「未受保护」从此可区分 |
| security | cds | 复验 R6 熔断闸门：mongo 整库克隆前预检源库 dataSize，超 CDS_REPLICA_CLONE_MAX_MB（默认 512MB）拒绝并明示原因——大库克隆在共享宿主上六轮验收四次打崩生产 mongod（WT cache 收紧实证生效仍崩，方案假设证伪），小库隔离不受影响 |
| docs | doc | debt.cds.replica-set 补录 #16-#18：大库克隆无安全路径熔断台账（含四次崩溃时间线与三条根治候选）、崩溃现场不可追溯、mysql/pg 闸门待推广 |
| feat | cds | infra 生命周期取证器（债务 #17）：常驻 docker events 监听 oom/die/kill/start，区分 cgroup OOM / 外部 SIGKILL(137 无 oom) / 进程自身退出，事件入服务器日志 + GET /api/infra/:id/lifecycle-events 回看——mongod 四次 unclean shutdown 的凶手下次可直接定性 |
| perf | cds | mongo 克隆两阶段读写错峰：dump gzip 落盘（宿主临时目录挂载）确认完整后再 restore，消除读写叠加峰值与管道 broken pipe 失败模式，阶段间留回写喘息 |
| feat | cds | mongo 复制隔离改「专用隔离实例」通道（终局方案）：dump 只读共享库落盘 → docker run 独立 mongo 实例（默认 mongo:7.0、内存 1.5G/WT cache 1G 上限）→ restore 写入专用实例；副本经连接串覆写直连新实例——共享 mongod 从此零写入风险（八轮取证：8.0.20 凡大批量写随机 SIGSEGV/139，纯读从未崩），隔离升级为实例级 |
| feat | cds | 快照台账支持专用实例（dedicatedContainer/dedicatedHostPort）：删除快照 = 整容器移除含数据卷；UI 快照行标注「专用隔离实例」；失败善后无残留库问题 |
| fix | cds | 终验 R9-P3 健壮性双修：正被活跃隔离引用的快照拒绝删除（409 提示先回切）；末位成员下线联动清除悬挂的 isolated 标志 |
| docs | doc | debt.cds.replica-set 收口：#16 大库克隆熔断解除（专用隔离实例根治）、#17 崩溃取证器落地，新增 #19 分支删除后 rsdb 容器清理路径 |
| feat | cds | 复制集改草稿-保存执行模型：舞台唯一视图（行式页签删除），所有操作先进「变更清单」可排序草稿，保存后走后端执行计划串行执行；执行中可调序/跳过/取消剩余；失败策略可选「仅停止 / 停止并回滚已完成步骤」；执行记录持久留存（含失败原因与回滚日志） |
| feat | cds | 后端 ReplicaPlan 执行引擎：6 类步骤（加副本/下线/权重/隔离/回切/关闭）逐步等真实终态，同分支互斥，记录 cap 20；单测 7 条覆盖校验/串行/stop/rollback/顺序控制 |
| feat | cds | 数据层双框表达：左框共享基础设施、右框隔离区；复制隔离时小库卡从左框动画转移进右框，完成后左侧主库上锁置灰（副本请求已转移一眼可见），回切解锁 |
| docs | doc | 债务台账补录：分支卡复制集徽章实时刷新（R10 P3）、整组复制「隐藏影子分支」方向定案（波 6） |
| fix | cds | 用户反馈三修：隔离区空态整块可点击（无副本时提示可同计划先加副本再隔离）；变更清单悬浮右下角「保存执行」按钮（执行中显示进度 N/M）；更新徽章取消置顶后收成小圆钮不再残留宽空按钮 |
| security | cds | 执行计划启动收敛：CDS 自更新/重启打断的 running 计划开机标记为中断（步骤明示原因、pending 取消），杜绝「更新 CDS 导致的不一致」僵尸态 |
| docs | doc | 债务台账 #22：两页签重构定案（容器级=全容器调用关系纵览各自加副本；项目级=整组影子容器不隐藏带特殊标记 + 基础设施隔离统一战线） |
| feat | cds | 容器级视图落地（用户拍板两页签之一）：废除服务下拉框，一屏纵览全部容器自上而下调用关系（入口 → 每容器一行实例组 → 数据层双框），每容器行内独立加副本/调权重/复制隔离/回切/关闭/实测；项目级整组页签（影子容器带标记 + 隔离统一战线）留波 6 |
| fix | cds | 纠偏重做两页签（用户指正「说的对做的错」）：恢复被误删的好看单容器舞台为「容器级」页签（下拉框换容器胶囊切换），新增「项目级」页签（整组加副本/整组复制隔离统一战线/整组回切，草稿同入变更清单）；丑陋的全行铺开版废弃 |
| fix | cds | 芯片快捷加副本改走执行计划（消灭绕过变更清单的隐形执行通道，有记录可回溯）；隔离区空态恢复可点击（唯一候选直加草稿，多候选/零候选给指引） |
| feat | cds | 复制集两页签重构为统一节点卡画布：容器级一屏展示全部容器调用关系（边由环境变量引用 + depends_on 服务端推导，只暴露键名），每容器独立加副本/权重/下线/分流实测 |
| feat | cds | 项目级画布保持原版舞台形态（入口 → 全部容器 → 基础设施），副本以「复制集成员 · 已负载」叠卡特殊标记不隐藏，整组加副本一键进清单 |
| feat | cds | 数据隔离统一战线升级到分支级：隔离区一键覆盖所有有副本的服务切同一专用隔离实例，部分隔离黄牌提示「统一战线未对齐」并可一键补齐 |
| feat | cds | 新增 service-graph 服务：GET /api/branches/:id/replica-sets 返回调用关系图（最长 id 优先主机名匹配 + CDS_<INFRA>_PORT 模板 + depends_on，环路兜底分层） |
| feat | cds | 复制集管理模式二选一：分支级 replicaMode 首次保存计划钉住，另一页签上锁，副本清零自动解除；后端 409 拦截跨模式计划 |
| feat | cds | 容器级画布改「展开的容器盒」：主实例/副本/草稿收纳盒内，加号就地可点，连线盒对盒不再遮挡 |
| feat | cds | 项目级画布改三节点（入口 → 项目 → 基础设施）：整组副本 = 项目节点右侧长出的节点（放不下换行），每组带全容器状态点/整组权重/整组下线 |
| feat | cds | 分支卡复制集徽章改每容器专属色 chip + xN（替代易误读的合计「复制集 xN」），颜色与画布一致 |
| refactor | cds | 复制集不再单独占抽屉顶级页签，并入「部署」子页签（发布 / 复制集） |
| fix | cds | 复制集悬浮「保存执行」按钮上移（bottom-24），不再与底部 GitHub 新 commit 通知 pill / toast 重叠 |
| fix | cds | 复制集执行按钮改到面板右上角常驻（废除悬浮按钮），与一键还原并排，彻底不与底部通知/自更新 pill 重叠 |
| polish | cds | 容器盒内改 Railway 风简洁行（细分隔线，无边框小盒），加号/历史版本/分流实测挪到盒外右侧小圆钮 |
| feat | cds | 新增一键还原：全部容器关闭复制集进变更清单，保存后回到普通模式（隔离库转快照保留） |
| feat | cds | 右上执行区新增「放弃变更」：只丢弃本页未保存草稿、不执行任何操作，与「一键还原」（业务性关闭复制集）明确分离 |
| polish | cds | 盒外加号/历史版本按钮提示写明白：加副本=再起一个当前版本实例按权重分流；历史版本=旧版本并排跑（新旧对比/灰度回退） |
| feat | cds | 生命周期取证器扩展到复制集成员容器（cds-*-res-N）：副本死亡留下 oom/die/exitCode 证据，「副本为什么失败」下次可尸检 |
| feat | cds | 草稿按用户操作聚合：一次手势（整组副本/统一战线隔离/一键还原）= 一条草稿，保存时才展开为步骤；新增「撤销上一步」（按手势回退，置于放弃变更左侧） |
| feat | cds | 复制隔离草稿预期管理：主库置灰预览上锁 + 隔离区复制一张同样式黄色副本库卡 + 黄色预连线，保存执行 = 黄转常色 |
| feat | cds | 整组副本幽灵节点改全样式拷贝（与真节点同结构的黄色卡，带撤销钮）；容器盒草稿行也带单条撤销减号 |
| polish | cds | 模式切换按钮并入画布头一行压缩纵向空间；项目节点容器 chips 与分支卡同视觉语言（含端口）；部署子页签重排为「复制集（默认）/ 部署」 |
| feat | cds | 复制集升顶级页签「运行」（默认直开），与「部署」（不可变部署版本+部署事实账本）同级；删除子页签 |
| polish | cds | 分支状态条并入抽屉标题行（状态/commit/服务数紧凑 chips），origin/推送/部署次数等次要信息按拍板丢弃，「上次停止」告警保留 |
| feat | cds | 画布连线全部加流动动画（虚线流向目标）；隔离区改为左框镜像——预览时复制整套基础设施元素（mongodb+redis 一一对位），原件全部置灰上锁 |
| feat | cds | 项目级副本节点改为项目节点的同样式同尺寸拷贝，命名「项目-复制集-N」；幽灵草稿同结构黄色拷贝（每容器行标「待建」） |
| feat | cds | 隔离不再强制先有副本：零副本可先建隔离库并钉住隔离态，之后新副本自动连隔离库；同源库多服务隔离复用同一专用实例（修掉统一战线各克隆一份的数据分叉隐患） |
| feat | cds | 历史版本选择与分流实测改弹窗；分流实测按钮常驻每容器、项目级页脚也有入口（模式钉住时不再失踪） |
| feat | cds | 画布节点可点选：高亮与之相连的线段、其余变淡；基础设施连线提亮、数据层拉高减少重叠 |
| polish | cds | 副本专属色调色板去红去黄（红色专属出错、黄色专属草稿），健康复制集不再让人恐惧；分支卡 chip 仅副本真出错才转红 |
| feat | cds | 容器日志囊括副本成员容器：container-logs 端点接受 memberId，日志页签 chips 行列出全部副本容器（靛蓝区分，项目级/容器级兼容） |
| feat | cds | 项目级复制集在分支列表显形：main-replicaset-N 派生卡紧随主分支卡右侧（成员端口 chips + 预览本组 __rs 粘性直达 + 打开详情），主卡改标「已复制」不再列 xN |
| fix | cds | 孤儿容器收割器认领复制集成员容器：res-N 副本容器此前不在认领清单，过 30 分钟宽限期即被当孤儿优雅停掉（真实事故：5 个 running 副本被误杀，state 仍标运行，入口 50% 请求 503） |
| feat | cds | 副本容器真身对账三道防线：启动即对账 + 每分钟周期对账 + 生命周期取证器 die 事件秒级摘流——任何原因死亡的副本标 error 并自动退出入口分流（路由发布器 2s 收敛） |
| feat | cds | 隔离 MECE 审计：五面实测（意图/配置/实例/数据/边界），配置面逐容器 docker inspect 真实 env、数据面双向金丝雀真写真查（隔离库写入不见于主库、主库写入不见于隔离库），边界面显式列出主实例仍连主库、redis 未隔离、同库其他服务未隔离 |
| feat | cds | 隔离可观测性：画布「隔离审计」入口（隔离区卡 + 页脚常驻），未隔离时退化为逐容器连接观测——每个容器真正连的库不再是黑盒 |
| fix | cds | 副本容器日志「看不了/分不清」修复：选中副本后旧代码兜底到第一个服务导致身份校验失败、日志加载成功却显示「暂无容器日志」；现副本合成独立日志目标直出正文 |
| polish | cds | 日志页签容器选择器分组：主容器 / 副本容器分两行带组标签（不再 10 个 chip 挤一条横滚行把副本遮住），日志面板标题亮明身份（副本带「复制集副本」靛蓝徽章 + 容器名） |
| polish | cds | 分支卡构建进度簇挪到右下角：构建中状态 + 计时 + 模式/净耗时/预计/细进度条并入 footer 右侧，顶部 chips 行构建期间保持端口/容器信息不动 |
| feat | cds | 调度器降温提示条悬浮显示「设置降温条件」：就地改 CDS 系统设置的空闲阈值 + 自动降温开关（PUT /api/scheduler/config，调度器每 tick 读配置，保存即刻生效） |
| refactor | cds | 分支抽屉按方案 A「六问」分类收敛 9 到 6 页签：总览(并入指标) / 运行 / 部署(构建日志内联到每条部署，不再跳页签) / 日志(移除构建模式，只留容器/系统/Webhook/HTTP 持续流) / 配置(生效变量+配置检查器+分支设置三分区) / 资源 |
| feat | cds | forwarder 被动健康摘除（debt #12 偿还）：连接级死亡信号（ECONNREFUSED/EHOSTUNREACH/ENOTFOUND）连续 2 次临时摘除、指数退避冷却、半开试探、一次成功回池；被摘成员退出粘性与加权，全组皆摘回落主成员；诊断端点 /__forwarder/replica-health |
| feat | cds | 隔离审计数据面金丝雀补齐 mysql/pg：共享实例通道建 canary 表真写真查（正/反双向），测完 DROP 不留残渣 |
| polish | cds | 部署页签子模块置顶：进行中/历史部署卡（含分阶段容器日志）放在部署事实账本与版本账本之上 |
| polish | cds | 入口卡入画布：抽屉头部「应用已上线」大卡只留总览页签，运行画布入口节点右侧挂同组入口直达链——其余页签各腾出约 180px |
| polish | cds | 窄卡（<640px）构建进度簇只留净耗时，预计值与进度条收进 sm: 以上防 footer 拥挤 |
| feat | cds | 总览页签重建为仪表盘并坐回第一号位（打开抽屉默认总览）：入口卡置顶 + 八块仪表（状态/服务/复制集/版本/CPU/内存/网络/入口）+ 监控图表——总览像个总览，不再是文字堆砌；运行画布入口节点直达链保留 |
| polish | cds | 卡片 footer 构建簇去冗余：独立「构建中 + 计时」chip 删除（耗时在进度 pill 已有且会挤压遮挡 commit sha），状态由 pill 内脉冲色点 + tooltip 承载 |
| fix | cds | 分支重启级联拉起复制集副本容器（Codex P1：此前停止/降温后副本分流永久消失，成员记录空占上限且无路径复原） |
| fix | cds | 调度器降温级联停复制集副本容器（此前主容器停了、副本还挂权重接分流，且降温分支的副本白占资源） |
| fix | cds | 删分支级联 drop 隔离库与专用隔离实例容器（Codex P1：rsdb 容器无 cds.branch.id label，台账删除后彻底无主、永久漏跑） |
| fix | cds | 主容器不可路由时仍发复制集成员路由与直达子域（Codex P1：此前整组蒸发，单服务分支 host 直接消失） |
| fix | cds | forwarder 复制集粘性 cookie 与上游 Set-Cookie 合并下发（Codex P1：登录响应带 cookie 时 cds_rs 被覆盖，登录后立刻横跳版本） |
| fix | cds | 删项目级联清理复制集成员容器与专用隔离实例（Codex P1：rsdb 容器无归属 label，项目删除后永久漏跑） |
| fix | cds | 成员物化加三道在册栅栏（Codex P2：克隆/启动期间成员被移除会起台账外幽灵容器、追加无主快照） |
| merge | cds | 同步主分支（codex SSO 安全收紧 + 分支卡动作层级 + 生图长超时），文本零冲突；语义冲突一处：replica-sets 路由补登记进 Agent 能力目录（守卫测试） |
| security | cds | mongo 专用隔离实例启用认证（复用源库 root 凭据，不落盘新密钥；旧无认证实例带标记区分不误发凭据），治宿主全网卡裸端口暴露生产派生克隆（Codex P1） |
| fix | cds | 隔离库名/专用实例容器名加分支哈希段，治跨分支 guard-1 同名互杀（第二分支克隆 rm -f 摧毁第一分支在用隔离库，Codex P1） |
| fix | cds | 隔离目标解析合入分支级环境变量（与部署路径同优先级），治分支覆写库名/连接串时克隆到项目级默认库（Codex P1） |
| fix | cds | promote 改终态门：部署 run 成功终态才解散复制集，失败/取消保留作回退出口，治派发受理瞬间拆掉唯一健康出口（Codex P1） |
| security | cds | forwarder /__forwarder/replica-health 诊断端点补 loopback 门禁，与相邻 routes/stats/active 同姿态（Codex P2） |
| fix | cds | 复制集粘性 cookie 改组作用域（cds_rs_<组哈希>），治同 host 多复制集 profile 时 res-1 跨组误钉/cookie 互相覆写（Codex P1） |
| fix | cds | 成员直达子域带 profile 段（<slug>-<profile>-<成员>），治两个服务同名 res-1 撞同一 host 路由互相覆盖（Codex P1，前端直达链同步） |
| fix | cds | 隔离快照复用增加同源实例判定（infraContainer 必须一致），治同引擎双实例同名库时把 A 实例克隆错发给连 B 实例的服务（Codex P1） |
| fix | cds | 多实例同引擎且未声明 dependsOn 时按 CDS_<实例>_PORT/HOST 模板关联定位，无法唯一定位 fail-closed 拒绝，治盲选第一个实例克隆错库（Codex P1） |
| security | cds | 隔离审计金丝雀表/集合改每次运行唯一命名，治固定名撞上应用同名表时 finally DROP 连业务数据一起删（Codex P1） |
| fix | cds | 隔离克隆加在途闸（分支+实例+源库串行化），治并发隔离选同 guard-N 后 mongo 幂等 rm -f 互相摧毁对方成功实例（Codex P1） |
| fix | cds | 分支停止/降温把无容器的 provisioning 成员也标 stopped + 物化栅栏按状态放弃，治分支已 idle 后后台任务仍把副本容器起出来（Codex P1） |
| fix | cds | 删分支清理专用隔离实例失败时写墓碑交收割器持续重试，治瞬时 Docker 故障后 rsdb 容器永久无主（Codex P2） |
| fix | cds | auto-lifecycle 自动停止级联复制集副本（此前只停主服务，"已停止"分支经成员兜底路由仍公网可达且占资源，Codex P1） |
| fix | cds | 隔离目标引擎判定去顺序依赖：多引擎项目按 dependsOn/CDS_<实例> 模板收敛，多义 fail-closed（此前首个 env key 定引擎会克隆错引擎的生产数据，Codex P1） |
| fix | cds | 克隆完成时分支已删的归属复查：就地 drop 刚克隆的隔离库/专用实例（此前 requireBranch 抛错后产物永久无主，Codex P1） |
| fix | cds | 服务调用关系图合入项目级/分支级生效 env（此前只看 profile.env，自动供给项目推不出服务到基础设施的边，画布拓扑残缺，Codex P2） |
| fix | cds | promote 终态清理加代际栅栏：当前成员非派发时子集则跳过 dissolve（防部署期间重建的新副本被旧 watcher 连锅端，Codex P2） |
| fix | cds | 隔离克隆期间禁加成员（在途闸扩展）：治克隆中途加入的成员连共享库、切换循环碰不到它、隔离态却声称生效（Codex P1） |
| fix | cds | 计划回滚失败不再谎报成功：removeMember 抛错不吞、任一步失败计划终态 error + 回滚日志说明现场未还原（Codex P1） |
| fix | cds | 「预览本组」链接带每个 profile 的成员 id（__rs 多值），forwarder 一次导航种齐各组组作用域 cookie，治项目级整组预览混入他组加权流量（Codex P1） |
| fix | cds | 被动健康半开改单探针占位：冷却到期只放行一个请求试探（10s 超时接棒），治高流量下死成员每个退避周期挨一波真实 503（Codex P2） |
| fix | cds | 生命周期取证器 error/close 汇入单一重连闸，治 spawn 失败双定时器成倍繁殖 watcher、生命周期记录与死亡回调翻倍（Codex P2） |
| fix | cds | 隔离库名哈希段升级为分支+profile 双身份、快照 id 加 profile 段：治同分支两个服务的 res-1 同名互杀专用实例、快照 id 重复误删台账（Codex P1） |
| fix | cds | 命名子域路由走复制集展开：治 llmgw 类命名入口 100% 流量打主容器、分流权重失效且绕过被动健康（Codex P1） |
| fix | cds | isolate-db 回滚谓词实证回切结果：成员 error 即抛、超时上抛，不再把重物化失败谎报成 rolled-back（Codex P1） |
| fix | cds | 隔离前置全员运行态检查：存在 stopped/error/provisioning 副本时拒绝隔离（否则重启会按共享库 env 复活它们、控制面却声称已隔离，Codex P1） |
| fix | cds | 计划回滚遇不可还原的破坏性步骤（remove-member/dissolve）不再整体标 rolled-back，终态 error 如实告知现场未复原（Codex P1） |
| fix | cds | mongoAdminEval/dropReplicaDb 的 mongo 连接串凭据 percent-encode，治密码含 @ : / # 时体积预检和清理全部失败（Codex P2） |
| fix | cds | 删 build-profile 级联收割其复制集（成员容器 + 配置），发布器另加数据面保险：profile 不在生效清单即整组跳过——治被删服务经成员兜底继续公网可达（Codex P1） |
| fix | cds | 隔离/回切三条过渡循环加停止栅栏：逐成员复查停止态，不再把 stopped 成员改回 provisioning 亲手擦掉停止栅栏（Codex P1） |
| fix | cds | WebSocket 升级结果接入被动健康：握手成功回池、连接错误上报摘除，治 WS-only 服务端口死亡永不被摘、半开探针走 WS 永不回池（Codex P2） |
| fix | cds | 隔离审计基线对照源库：空源库的空克隆判 pass，不再把合法空库误判 broken（Codex P2） |
| fix | cds | 回切/复用隔离改「先全员摘流后翻标记」：治过渡期第一个成员已切、其余成员仍按旧库接加权流量，写入被劈到两个库（Codex P1） |
| fix | cds | 保护罩多库歧义拒绝：同实例多 profile 各用不同库时列候选拒绝，不再按遍历顺序静默保护错库（Codex P2） |
| security | cds | 分流实测 host 必须属于本分支已发布域名（previewSlug/子域派生/别名/自定义域），治跨项目内网请求探针（Codex P2） |
| fix | cds | promote 代际栅栏加持久 token（rs.createdAt）：治解散重建后 res-N 同名新集通过成员子集检查被旧 watcher 误解散（Codex P2） |
| fix | cds | mysql/pg 克隆改两阶段 dump 落盘再导入：治管道退出码只看末端 client、dump 半路失败被记成克隆成功、副本对空库跑实验（Codex P1） |
| fix | cds | 整组预览钉选升级 profile 作用域条目（profileId:memberId）：治各 profile 成员数组错位时裸 id 列表把 B 组钉到 A 组的 res-N（Codex P1） |
| chore | cds | 本 PR changelog 碎片收敛为一个（并入 07-23 碎片、删除与 main 重复的 image-timeout 碎片，Codex P1） |
| fix | cds | 被动健康 key 纳入上游端口 + 闲置条目清理：治重部署换端口/解散重建后旧摘除窗压住全新健康实例 15-120 秒（Codex P2） |
| fix | cds | 回切前置全员可切换检查（与隔离入口对称）：stopped/provisioning 副本存在时拒绝回切，治重启复活的容器继续写隔离库而控制面宣称已共享（Codex P1） |
| fix | cds | 分支重启级联副本改就绪实证：TCP/HTTP 探测通过才恢复分流（60s 上限），治慢启动/就绪失败副本被立刻发回加权路由持续吐失败（Codex P1） |
| fix | cds | 成员直达域 profile 段 DNS 清洗（发布器与前端同款算法，撞名跳过并 warn），治 profile id 含下划线/点时直达链接全废（Codex P2） |
| fix | cds | forwarder __rs 改 URLSearchParams 完整解析，治含点/百分号编码的作用域钉选条目被字符类正则截断静默失效（Codex P2） |
| fix | cds | 复制集分支重启级联就绪判定复用成员版本快照的 readinessProbe/startupSignal 契约（noHttp 后台副本、自定义健康路径、启动信号成员按各自契约实证，快照不可得才退默认探测） |
| fix | cds | 隔离审计 D1 克隆基线改真对照：两侧基线必须可读且克隆集合/表数不少于源库才 pass，半截克隆与源库基线读取失败不再静默放行 |
| fix | cds | 复制集成员直达子域 DNS 段防撞：profile id 清洗有损时追加确定性短哈希（api_v2 与 api.v2 不再同归一段），发布器与前端直达链接同款算法 |
| docs | doc | design.cds.replica-set 与 debt.cds.replica-set 补标准文档头部（H1 类型后缀 + 版本/日期/状态元数据） |
| fix | cds | promote 整分支回滚显式化：提升成员会连带改动其他服务时逐 profile 对照当前版本并 409 列出影响面，要求 confirmWholeBranch 显式确认，不再静默把 web/worker 拉回历史版本 |
| fix | cds | 复制隔离克隆阶段失败不再毒化健康成员：容器未动时恢复隔离前状态回到分流（只留失败说明），切换阶段中途失败才如实标 error |
| fix | cds | 项目级复制集画布并入全量服务清单：无可复用版本快照的服务不再从画布消失；整组副本要求覆盖项目全部服务，缺快照/达上限时显式阻断并说明，不再静默发起残组 |
| fix | cds | promote 影响面对照扩到 materializeProfiles 恢复的全部运行时契约字段（workDir/pathPrefixes/subdomain/dependsOn/readinessProbe/startupSignal/deployedMode），仅探针或路由前缀不同的历史契约不再被静默重放 |
| fix | cds | 分支删除置 deleting 栅栏：在途克隆完成回调（隔离/保护罩/成员物化）看到标记即自弃并清掉刚克隆的库，封死「台账已扫过后追加快照」的永久无主库窗口 |
| fix | cds | forwarder 半开探针改「选中者才占位」：isEjected 纯查询化 + reserveProbe 由 resolver 在最终选中后调用，低权重半开成员不再被落选请求烧掉探针名额拖慢回池 |
| fix | cds | 隔离/回切与分支停止重叠时强制退役 stopped 成员容器（移除旧容器 + 清 containerName），封死「重启原地复活带旧库 env 写错库」的一致性分叉；回切侧同步清成员隔离元数据 |
| fix | cds | 栅栏克隆清理失败不再静默丢弃：drop 失败时分支在世则快照入台账（可见可手删）、分支已删则专用实例写 teardown 墓碑（收割器兜底）、共享实例克隆留 error 日志给出库名，三处栅栏（成员物化/复制隔离/保护罩）统一接线 |
| fix | cds | 副本直达链接超 63 octet DNS 标签时回落主入口 ?__rs= 作用域钉选深链，不再展示发布器已跳过的不存在 host |
| fix | cds | 分支隔离完成态以全量有效服务为分母：零成员/无复制集条目的服务不隔离不算统一战线对齐，多服务计划中途失败不再误报 done |
| fix | cds | 分流探测 path 强校验（仅可打印 ASCII）+ probeOnce 捕获 http.request 同步抛错，封死 ERR_UNESCAPED_CHARACTERS 经未处理拒绝拖垮 CDS 进程的通道 |
| fix | cds | 复制集对账收敛孤儿 provisioning 成员：在途操作进程内登记（物化/隔离切换/回切全链路），不在登记表的 provisioning 即上一进程遗留——拆容器 + 标 error 指引重建，不再永久占位转圈 |
| fix | cds | service-graph 边键的字面 NUL 字节改用 unicode 转义序列（运行时语义不变），文件不再被 git 判成二进制、恢复文本 diff 可审 |
| fix | cds | 专用隔离实例容器名揉入 CDS 实例段 + cds.instance label，多 master 共宿主管同一分支不再同名互杀；幂等清理前按 label 验归属，异实例容器拒删 |
| fix | cds | 分流探测 host 改全量对照：域名后缀必须命中 CDS 根域（缺配置退分支 previewUrl 实际后缀）+ 单标签 slug/别名匹配，别家自定义域首标签碰巧带本分支 slug 前缀不再被放行 |
| fix | cds | cdscli 能力契约测试的版本期望改为从源码解析 VERSION 常量（治 main 上 bump 0.12.1 未同步硬编码 0.12.0 导致的主干红灯，未来 bump 免疫） |
| fix | cds | 隔离审计金丝雀清理失败不再静默：两侧 drop 带一次重试并记 D4 检查项，清理不净时 overall 判 broken，不许残渣留在生产库还报 effective |
| fix | cds | 项目级整组改持久化组身份：整组手势生成 projectGroupId 贯穿计划/addMember 落到成员，面板项目舞台与分支整组卡按 id join（存量成员按位兜底），部分失败/单侧下线的数组错位不再拼出假组被钉选放大 |
| fix | cds | 分流探测自动推导 path 前先过 resolveEffectiveProfile（与发布器同口径），分支级 pathPrefixes 覆写不再拿旧前缀探测出误导分布 |
| fix | cds | WebSocket 升级握手回种复制集组作用域亲和 cookie（HTTP/WS 共用同一收集函数），WS-first 客户端重连不再重新掷签横跳版本 |
| fix | cds | 隔离库快照删除门收紧：任何在册成员（含 stopped/error）仍挂该库名即拒删——停了的容器配置仍指向隔离库，重启复活会连已 drop 的库 |
| fix | cds | mongo 克隆暂存目录按 CDS 实例分段，共宿主双 master 并发克隆同名目标不再互相覆写/误删 dump 归档 |
| fix | cds | 专用隔离实例连接串凭据改容器活取（inspect env，失败退 infra 现值）：源库轮换 root 密码后，新增副本/重物化不再拿新密码连按旧凭据初始化的老实例 |
| fix | cds | mongo 克隆 dump 归档改 docker 托管卷承载并在 daemon 命名空间清理：容器化 master 走宿主 socket 时宿主 bind 路径跨命名空间失真，生产派生归档不再滞留宿主 /tmp |
| fix | cds | 隔离审计对专用实例的认证同样改容器活取凭据（与成员复用路径同款），源库轮换密码后健康隔离不再被审计误报 broken |
| fix | cds | 执行计划回滚补偿失败步骤自身残留：add-replica 半程入册的成员清理、isolate-db 半程隔离回切、set-weight 恢复原值，破坏性/单向步骤失败如实保持 error 不谎报 rolled-back |
| fix | cds | 副本身份响应头以路由为唯一权威：复制集路由强制覆写 X-CDS-Replica*、非复制集路由删净，应用/历史版本自发同名头不再伪造分流探测统计 |
| fix | cds | 共享实例隔离库 DROP 失败入 pendingReplicaDbDrops 台账（分支删除/栅栏清理两路），复制集对账循环持续重试补删；承载 infra 消亡时出队，不再只留一行日志失踪 |
| fix | cds | isRemoteBranch 判定与部署路径同口径：executorId 非 master- 前缀即远端，注册表查不到时保守视为远端，离线执行器的分支不再被 master 本机错网络物化副本 |
| fix | cds | 端口分配器把复制集成员与专用隔离实例的 hostPort 计入保留集，stopped/provisioning 成员端口不再被绕回序列判给新部署导致重启启动失败 |
| fix | cds | 复制集副本就绪失败后停止容器：此前只标 error 却留容器活着，共享库模式下它仍跑后台任务读写主库并白占端口 |
| fix | cds | 复制集统一战线隔离排除无状态服务：后端按 resolveReplicaDbTarget 输出 dbIsolatable，前端据此收敛目标与已隔离分母，避免必败步拖垮后续服务 |
| fix | cds | 复制集计划步数上限提到 60 并前端预检：服务数超限的项目此前整组副本按钮可点但保存必被拒，现加草稿前即给出可读提示 |
| fix | cds | 复制集重启路径就绪失败后停止副本容器：与首次物化同纪律，避免半死副本继续读写主库 |
| fix | cds | infra 取证器关联 OOM 事件：cgroup OOM 的 oom + die(137) 不再留下两条互相矛盾的判定 |
| fix | cds | 服务调用关系图节点 id 分命名空间：服务与基础设施同名时不再丢边、不再重复 id 覆盖 |
| feat | cds | janitor 新增部署镜像定向回收：按版本台账保留最近 N 代，回收 CDS 自产的 per-SHA 镜像（悬空 prune 够不到的那部分） |
| feat | cds | 磁盘分档刹车：75/85/90 三档，freeze 档拒绝新部署派发并收紧镜像保留代数 |
| feat | cds | 所有托管容器统一日志限额 50m x 3，容器日志从无界变有界 |
| fix | cds | 复制集三处后台事务补 catch：分支删除时的抛出不再冒泡成未捕获拒绝（Node 20 下会终止进程） |
| fix | cds | 磁盘刹车自带测量：读数缺失或过期时部署闸门就地重测，不再依赖 janitor 的启停与一小时节奏 |
| fix | cds | 镜像回收限定本实例部署过的仓库：共享 docker daemon 的多 master 不再互删回滚镜像 |
| fix | cds | 成员直达路由带上副本身份，直达链接可正常返回 X-CDS-Replica |
| fix | cds | 磁盘刹车改为路由器级守卫：按服务重部署与强制重建两个入口此前不受冻结约束 |
| fix | cds | 磁盘探测同时量 worktree 与 docker 数据目录，取最紧张者判档 |
| fix | cds | janitor 调度与 enabled 解耦并在启动后跑首轮：重启后不再整整一小时不回收 |
| fix | cds | promote 终态清理改用不可复用的成员身份栅栏，不再误删同 id 的替身成员 |
| feat | cds | janitor 快照带上最近一轮 sweep 摘要（磁盘档位/删除分支数/镜像回收与截断数），回收结果从只打日志变为外部可核 |
| perf | cds | 镜像回收单轮上限随磁盘档位放大（40/100/200/400）：生产实测积压 4598 个，固定 40 追不上存量 |
| fix | cds | sweep 不再用 worktree 单盘读数覆盖多文件系统档位：docker 盘吃紧时闸门不会被每轮重新打开 |
| fix | cds | sweep 并发合并成同一次：周期定时器/启动首轮/手工触发不再叠加抢 docker daemon |
| fix | cds | sweep 摘要在 TTL 清理关闭时同样记录：janitor 关掉后回收仍留证，不再恒为 null |
