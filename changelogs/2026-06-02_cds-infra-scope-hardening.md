| fix | cds | 基础设施数据端点(query/init-sql)补项目级鉴权:项目级 key 跨项目访问数据库返回 403 project_mismatch,杜绝跨租户数据泄露 |
| fix | cds | 数据备份端点(backup/restore/backup-history)同步补项目级鉴权,堵住整库 dump 的跨项目越权(纵深防御) |
| fix | cds | infra-presets 应用预设端点补 assertProjectAccess,项目级 key 不得跨项目生成基础设施 |
| fix | cds | 数据面板 MongoDB 连接到应用配置库(svc.dbName/MONGO_INITDB_DATABASE)而非 admin,查询/初始化作用于用户自己的数据 |
| fix | cds | 数据面板 Redis 支持 requirepass:从 REDIS_PASSWORD 读取密码并以 -a + --no-auth-warning 传入,密码值脱敏 |
| fix | cds | 单例型基建(Kafka/RabbitMQ/NATS 等非数据库)禁止同类型多实例(覆盖重复调用 infra-presets 路径),仅可命名库的数据库预设允许多实例,避免容器自我广播地址串号 |
| test | cds | 新增 infra-data-scope 测试(8 例,跨项目 403/owner 409/admin no-op)+ buildInfraDataExec mongo 库名/redis 密码用例 + 单例守卫与数据库多实例回归(共 +13 例) |
