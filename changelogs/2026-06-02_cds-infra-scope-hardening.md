| fix | cds | 基础设施数据端点(query/init-sql)补项目级鉴权:项目级 key 跨项目访问数据库返回 403 project_mismatch,杜绝跨租户数据泄露 |
| fix | cds | 数据备份端点(backup/restore/backup-history)同步补项目级鉴权,堵住整库 dump 的跨项目越权(纵深防御) |
| fix | cds | infra-presets 应用预设端点补 assertProjectAccess,项目级 key 不得跨项目生成基础设施 |
| fix | cds | 数据面板 MongoDB 连接到应用配置库(svc.dbName/MONGO_INITDB_DATABASE)而非 admin,查询/初始化作用于用户自己的数据 |
| fix | cds | 数据面板 Redis 支持 requirepass:从 REDIS_PASSWORD 读取密码并以 -a + --no-auth-warning 传入,密码值脱敏 |
| fix | cds | 单例型基建(Kafka/RabbitMQ/NATS 等非数据库)禁止同类型多实例(覆盖重复调用 infra-presets 路径),仅可命名库的数据库预设允许多实例,避免容器自我广播地址串号 |
| fix | cds | 试运行/检测仓库(validate-runtime/detect-runtime)克隆复用 Device Flow token(_injectGithubTokenIfPossible),私有 GitHub 仓库在创建项目前也能跑检测/试运行;日志脱敏 token |
| fix | cds | 后台任务(worker)BuildProfile 设 readinessProbe.noHttp,部署就绪探测跳过 HTTP 只 TCP 探活,避免活着的 worker 被 HTTP 探测超时误判失败 |
| fix | cds | 创建项目时基建连接串覆盖用户粘贴的同名环境变量不再静默:收集被覆盖 key 回传前端(infraEnvOverrides)+ console.warn |
| fix | cds | 数据备份端点解析也按 ?project= 精确定位(与 infra-data 一致):两项目同名 infra(如都叫 postgres)时,owner 用 ?project= 命中自己的库不再 403,admin 也不会误流/误恢复到别项目的库 |
| feat | cds | 基建目录新增 MariaDB 一等预设(mariadb:11,MySQL 协议兼容,自动注入 DATABASE_URL/MYSQL_URL),消除 CLI 识别 mariadb 但 catalog 缺条目的 SSOT 漂移 |
| fix | cds | 拓扑「新增基础设施」选目录预设时改用后端返回的 applied[0] 作为 serviceId:同类型已存在时创建的 postgres-2 等新实例能被"立即启动"+选中,不再误启动已有实例 |
| fix | cds | 检测/试运行(detect-runtime/validate-runtime)拒绝项目级 agent key(403):这两个接口用服务器级 GitHub 凭据克隆任意仓库+跑任意命令+回流日志,项目级 key 无可授权目标,放行等于借服务器凭据克隆并 exfil 任意私有仓库;仅管理员/控制台会话可调用 |
| fix | cds | 数据/备份端点省略 ?project= 且 id 跨多个项目存在时返回 400 要求显式指定项目,杜绝 admin 误对错误租户库执行查询/init-sql/备份/恢复 |
| test | cds | 新增 infra-data-scope 测试(11 例,跨项目 403/owner 409/admin no-op + 同名 infra ?project= 消歧)+ buildInfraDataExec mongo 库名/redis 密码 + 单例守卫/数据库多实例 + worker noHttp + customEnv 覆盖提示回归(共 +19 例) |
