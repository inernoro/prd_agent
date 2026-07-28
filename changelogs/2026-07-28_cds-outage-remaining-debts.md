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
