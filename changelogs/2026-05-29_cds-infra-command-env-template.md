| fix | cds | infra 服务的 yaml command/entrypoint 里的 ${VAR} 引用现在用项目 customEnv 做模板替换,避免被 host shell 展开成空(以前 redis-server --requirepass ${CDS_REDIS_PASSWORD} 会让 redis FATAL 无限重启) |
