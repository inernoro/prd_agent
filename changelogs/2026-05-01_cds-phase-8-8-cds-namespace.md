| feat | cds-skill | Phase 8.8 命名规范 — cdscli 自动生成的所有 env 一律 CDS_* 前缀(参考 Railway 的 RAILWAY_*),12 类 infra 模板全量改名:CDS_MONGO_USER / CDS_MONGO_PASSWORD / CDS_MONGODB_URL / CDS_POSTGRES_USER / CDS_POSTGRES_PASSWORD / CDS_DATABASE_URL / CDS_MYSQL_* / CDS_SQLSERVER_* / CDS_CLICKHOUSE_* / CDS_REDIS_* / CDS_RABBITMQ_* / CDS_AMQP_URL / CDS_ELASTIC* / CDS_S3_* / CDS_NATS_URL / CDS_MEMCACHED_URL / CDS_JWT_SECRET。容器内部 env 名(MONGO_INITDB_ROOT_USERNAME / POSTGRES_USER 等)不变,只是 value 引用从 ${MONGO_USER} 改为 ${CDS_MONGO_USER},容器行为零变化 |
| feat | cds-skill | _rewrite_env_value_with_infra_aliases 改用 CDS_MONGODB_URL / CDS_DATABASE_URL / CDS_REDIS_URL / CDS_AMQP_URL,docker-compose 里硬编码连接串自动重写为 ${CDS_*} 引用 |
| feat | cds-skill | AI_ACCESS_KEY 保留无前缀(用户必填,且 cdscli 直接读此名做认证) |
| test | cds-skill | test_scan_phase3 / test_env_meta_phase8 同步断言 CDS_* 前缀,20 个 pytest 全绿 |
| test | cds | tests/integration/phase6-yaml-contract.smoke.test.ts 断言 CDS_DATABASE_URL,951 vitest 全绿 |
