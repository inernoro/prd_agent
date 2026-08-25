| feat | cds | 周期备份补上 rabbitmq：definitions 导出 / 灌回 / 队列数取证，与 mysql、postgres 同一套退出码写法；下载与恢复端点不再掉进只有空壳的 tar 兜底 |
| fix | cds | 备不了的类型按桶分类，不再共用一句「暂不支持」：只有真的有东西可丢才算覆盖缺口，memcached 与未开 JetStream 的 nats 不再让备份健康位从上线那天起就永远红着 |
| feat | cds | 算缺口的那些当场说清缺的是哪一套手段：MinIO 要桶到桶复制、Kafka 要 MirrorMaker、Elasticsearch 要先注册快照仓库，SQL Server 与 ClickHouse 是有手段还没接 |
| feat | cds | rabbitmq 导出每轮报出「definitions 不含队列里的消息，默认 vhost 当前积压 N 条不会被带走」，数不出来时说数不出来而不是拿 0 顶替 |
| refactor | cds | 下载与恢复端点的「三段脚本 + 扩展名 + 计数单位」从两处三元链收敛成一张表，新增一种类型只加一行 |
| test | cds | 补 25 条覆盖面判据（含 JetStream 判据的反面对照）与 4 条 rabbitmq 真容器用例；三条既有守卫从断言源码字面量改成断言行为，路由改写不再误红 |
| docs | cds | debt.cds.md 新增 E51，记下 definitions 不含消息、import 是合并不是替换、队列数只覆盖默认 vhost 三条已知边界 |
