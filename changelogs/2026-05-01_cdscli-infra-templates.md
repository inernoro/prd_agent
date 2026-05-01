| feat | cds-skill | cdscli scan 加 12 种基础设施模板(Railway-style):mongodb / redis / postgres / mysql / sqlserver / clickhouse / rabbitmq / elasticsearch / minio / nats / memcached / nginx。命中 image 时自动:(1) 切换到推荐 stable image (2) 加初始化 env(account/password 引用 ${VAR})(3) 用 secrets.token_urlsafe(16)+! 生成强随机密码 (4) 把账号密码 + 连接串(MONGODB_URL/DATABASE_URL/REDIS_URL/...)写到 x-cds-env,让基础设施容器和应用容器共享同一连接串 |
| fix | cds-skill | docker-compose 优先级排序 bug:无后缀 docker-compose.yml 被错排到最后。改为先剥 .yml/.yaml 再剥 docker-compose 前缀,正确取 stem |
| fix | cds-skill | docker-compose `build: ./api` 简写形式被误当作 dict 导致 AttributeError 静默 fall through 到 monorepo-scan。加 isinstance(build, str) 分支处理简写 |
| docs | cds-skill | x-cds-env 文案改为"项目级环境变量(本项目独占,不会跨项目泄漏 / 污染其它项目)",彻底去掉"全局共享"的误导 |
