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
