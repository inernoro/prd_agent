| feat | cds | `./exec_cds.sh init` Mongo bootstrap 改造：容器名 cds-state-mongo、固定端口 27018、等待 mongosh ping healthy、写 CDS_MONGO_CONTAINER 到 .cds.env |
| feat | cds | `./exec_cds.sh start` 前新增 ensure_cds_mongo_running 函数，自动 docker start 容器 + 等 healthy，解循环依赖 |
| docs | cds | guide.cds-mongo-migration.md v1.1：三种场景分流（新装/老切/bug 受害者）+ systemd 绕过 load_env 故事 + 三种紧急回退 |
