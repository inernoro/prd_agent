| fix | cds | 关系型隔离支持 jdbc: 复合 scheme 连接串：Java/Spring 项目（SPRING_DATASOURCE_URL 等）此前解析失败导致静默不改写，隔离在这类项目上仍是假的 |
| fix | cds | 镜像回收把「被容器引用故按住不删」与「删除失败」分开计数：failed/errors 不再恒为 1，真故障不被常亮红灯淹没 |
| fix | cds | 预构建镜像缺失时先复用「组件未变更的上一版镜像」，只有该组件确实有代码改动才回落宿主源码构建（宕机的临门一脚） |
| feat | cds | janitor 新增孤儿 worktree 对账：磁盘有目录、台账无分支即回收，带「够老 + 无容器挂载 + 单轮上限」三重护栏，查不到挂载情况整轮只报不删 |
| fix | cds | 部署 run 的 commitSha 改在 pull 后 HEAD 刷新之后再盖，不再记触发时缓存的旧 sha（排障时曾据此误判 worktree 没拉新代码） |
| feat | cds | 新增全局回收互斥：CDS 侧回收路径同一时刻只允许一个，拿不到锁跳过本轮不排队；持锁超时视为泄漏可被接管 |
| security | cds | 关键容器打 cds.protected=true（CDS 状态库 mongo + 全部 infra），孤儿收割器按标记豁免，运维安全清理命令可据此过滤 |
| fix | cds | CDS 状态库 mongo 容器补日志限额（全仓唯一漏网的 docker run） |
| fix | cds | 启动期 mongo 不可用改为退避重试（约 90s 忍耐窗口）而非一次失败即退出，消除 systemd 重启风暴；放弃前做磁盘诊断直指真凶 |
| docs | cds | 宕机债务台账逐条标注偿还状态，补「安全的 Docker 清理命令」运维须知 |
| fix | cds | 隔离支持引擎中立库名 key（DB_NAME / DATABASE_NAME），引擎从同 env 的关系型 URL scheme 读；Spring 风格项目此前隔离入口即不可用 |
| fix | cds | 孤儿 worktree 的挂载枚举改走 docker inspect：docker ps 的 .Mounts 是字符串，对它 range 会让命令失败，导致对账永远降级成只报不删（生产实测 66 个孤儿一个没删） |
| fix | cds | 隔离不可用时的原因改为可诊断：报出疑似数据库变量名与引擎能否从连接串推断，不再只留一句「没有数据库名」 |
| feat | cds | 隔离可用性接口额外返回「将改写哪些变量」（引擎 + 库名 key + 连接串 key，只报名不报值），点之前就知道会动什么 |
| fix | cds | 挂载枚举容忍「容器在 ps 与 inspect 之间消失」导致的非零退出：只要拿到输出就用，全空才降级；此前生产上恒定降级、孤儿回收一直停在 0/66 |
| fix | cds | 挂载枚举模板改用 {{println}}：原 {{"\n"}} 在 TS 单引号串里被转义成真换行，Go 模板解析失败且无输出，是挂载枚举一直返回 null 的真凶 |
| fix | cds | 状态库 handle 连接失败后复位实例：此前先赋值再连，失败后重试被 if (client) return 短路，启动期退避重试形同虚设 |
| fix | cds | 镜像复用的等价性改为对着「本次要部署的目标 commit」比对，不再对着 worktree HEAD：锁定版本部署时，改了又被更晚 HEAD revert 的组件会被误判为未变更 |
| fix | cds | 启动重试的等待定时器不再 unref：事件循环空转时进程可能在重试到期前直接退出，忍耐窗口白设 |
| ops | cds | 复用已有状态库容器时体检保护标记与日志限额，缺失则打印可直接粘贴的重建命令（docker 无法给存量容器补 label / 改日志限额，现网容器至今仍是裸的） |
| fix | cds | 孤儿 worktree 只在已知项目桶下枚举：迁移自扁平布局的存量部署里，顶层遗留 worktree 曾被当成项目桶，其源码子目录会被当孤儿递归删除（三道护栏均拦不住） |
| fix | cds | 孤儿判定加血缘兜底：候选若是台账在用目录的上级或子目录一律保留，只有毫无包含关系才算孤儿 |
| fix | cds | 关系型 URL 的引擎探测与库名改写合并为同一条 scheme SSOT：此前 jdbc:mariadb / jdbc:postgres 能判引擎却不进改写集合，这类 Java 服务隔离后流量仍打源库而控制面报成功 |
| fix | cds | 镜像复用的等价性改比 CI 构建输入范围（新增 buildScope，对齐工作流 path-filter），不再比运行时挂载目录：compose 里服务普遍挂整仓 `.`，旧口径等于比整个仓库，复用一次都不会触发，本次止损点在真实配置下形同虚设 |
| feat | cds | cds-compose 支持 `x-cds-deploy-modes.<svc>.<mode>.buildScope` 声明 CI 构建输入路径；未声明即不复用（fail-closed），新增 CI filter 对拍守卫测试防两处漂移 |
| fix | cds | 删项目时落 worktree 桶墓碑：项目 id 从台账消失后，其桶不再被孤儿对账枚举，里面无人认领的 worktree 会永久占盘；墓碑并入白名单，桶清空后自动摘除 |
| fix | cds | 库名 key 取用加优先级：引擎中立的 DB_NAME 只在没有自带引擎的 key 时兜底，此前与 MYSQL_DATABASE 同档、退化成 env 插入顺序，项目级泛化 DB_NAME 会压过服务自己的库名导致克隆错库且连接串漏改 |
| fix | cds | 部署 run 与不可变版本改记「实际落地的 commit」：webhook 指定 A 而分支已前进到 B 时，entry.githubCommitSha 有意停在 A，run/version 却照抄它，审计挂在没被部署过的代码上，findReusable 还可能拿 A 的产物顶替 B |
| fix | cds | isSourcePull 补认 profile 级 prebuiltImage：此前只认 deployModes.prebuilt，导致 tag 锁死 sha 的镜像部署被当成源码构建、台账贴成 pull 到的 HEAD |
| chore | cds | MockShellExecutor 新增 addResponsePatternFirst（exec 首个命中即返回，用例覆盖通用桩只能插队首） |
| fix | cds | 三个 llmgw 镜像的 buildScope 补上 prd-api/**：其 CI 触发条件含 api 变更、Dockerfile 也编译 prd-api 的 Core/Infrastructure，漏声明会在拉取失败时复用含旧 Core 代码的镜像 |
| fix | cds | buildScope 对拍守卫改为解析 job 的 if 触发条件而非同名 filter：一个镜像可由多个 filter 触发，只按同名对拍会漏掉跨组件依赖 |
| fix | cds | 回收锁释放加身份令牌：超时接管后旧持有者跑完会清掉后继者的持有状态，导致第三轮回收与后继者并发跑破坏性清理 |
| fix | cds | 孤儿枚举读失败不再谎报为空：EACCES/IO 抖动会让已删项目的桶「看起来已清空」而摘掉墓碑，文件系统恢复后那些目录永远回收不了 |
| fix | cds | 迁移遗留的符号链接别名纳入回收并与真身成对判定：此前别名因 isDirectory 为假被漏掉、真身又被项目桶白名单挡住，两边都收不回；任一侧被认领或挂载则都不动，回收时一并收 |
| fix | cds | 极速版自动回退源码编译后修正落地 commit 口径：回退发生在 SHA 选定之后，不修正会把 run/version/opLog 记成镜像锁定的 sha 而非实际编译的 HEAD |
| ops | cds | 复用已存在的 infra 容器时体检日志限额，缺失则告警并给出重建指令：限额只在 docker run 路径生效，现网长生命周期的 mongo/redis 至今仍是无上限日志 |
| fix | cds | 孤儿 worktree 删除前加临删复核：判定与删除之间同 slug 分支可能被重建（create 先删残留再 checkout、落台账更在其后），拿陈旧计划会删掉刚拉出来的新工作树 |
| fix | cds | 鉴权 mongo 连接纳入启动退避重试，且失败复位 handle：标准安装下状态库与鉴权指向同一个 mongo，此前后者一次失败即退出，忍耐窗口形同虚设 |
| fix | cds | 事件日志库与 HTTP 日志库同样修掉「先赋值再连」：连接或建索引失败后 init 被永久短路，日志静默死掉再也不会自愈 |
| test | cds | 新增 lint 守卫：禁止 this.x = new MongoClient(...) 先赋值再连，并要求失败路径 close 半开连接（同一个坑已出现 5 次） |
| fix | cds | 孤儿别名与真身成对回收改为先删真身后删别名：真身在顶层不被枚举，别名是它唯一的可发现入口，先删别名再删真身失败就永久漏盘；真身失败时保留别名留待下轮 |
| fix | cds | 中立库名 key 的引擎判定先按 profile 的 dependsOn 收敛：多引擎项目里项目级 customEnv 灌下全部引擎连接串，全局 URL 判不出唯一引擎，DB_NAME 会在下游消歧跑到之前就被过滤掉，隔离入口对这类服务恒不可用 |
| fix | cds | 日志库连上即可用：索引建立失败只告警不再把库判死，且后续 init 会重试索引；改保留天数导致的 ttl 索引选项冲突走 drop 再建对账，一条索引失败不掩盖其余 |
| fix | cds | 库名 key 取用改为来源层级优先（profile > 分支 > 项目），同层再比引擎专属度：此前一律降档中立 key，导致项目级 MYSQL_DATABASE 压过服务自己的 DB_NAME，克隆 infra 默认库而应用连接串原地不动 |
| docs | cds | 复制集债务台账补两条已知边界：同层多库名 key 无归属信息可判、多引擎项目中立 key 依赖 dependsOn 声明 |
| fix | cds | 启动退避实际窗口对齐承诺的 90s：N 次尝试只有 N-1 段等待，原默认 6 次只等 60s，少的正是最后那段 30s |
| fix | cds | 启动失败的磁盘诊断改量仓库盘 + docker 数据根两处：mongo 数据落在 docker 那侧，只量仓库盘会让提示恰好在真凶场景（2026-07-27 撑爆 containerd）下不出现 |
| fix | cds | 日志库索引失败改为自行排程退避重试：init 只在启动调一次，「下次 init 重试」等于永不重试；TTL 已 drop 又重建失败时保留期会一直失效到重启 |
| fix | cds | 关系型连接串改写按主机绑定到选定实例：同库名不同主机的两条 JDBC URL 此前会被一起改写，把副本指向另一台服务器上的同名隔离库；单主机时保持全收不误伤常规配置，未绑定的 key 如实报进 unboundUrlKeys |
| fix | cds | 断链的迁移别名纳入回收：成对回收「真身已删、别名删失败」会留下断链，此前 realpath 抛错即跳过，它既永远无人重试回收、又让已删项目墓碑被误摘，同 slug 重建还会撞上目标已存在 |
| fix | cds | 复用 infra 容器的体检补查 cds.protected 标记：只查日志限额会让「有限额但无保护标记」的存量容器静默通过，仍会被 label 过滤的安全清理命令误删 |
