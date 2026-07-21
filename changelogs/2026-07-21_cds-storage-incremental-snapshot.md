| perf | cds | mongo-split 存储层增量快照重构：save() 支持脏范围 hint，同 tick 全带 hint 时只克隆被点名的 kind/实体，不再对整个 state 做 structuredClone |
| perf | cds | mongo-split 持久化改按实体 id 缓存上次落库的 stableJson 字符串，diff 只 stringify 当前侧；删除 persistedCache 整份 state 的第二次 structuredClone，消灭每周期约 4 遍全量序列化 |
| perf | cds | 部署 run 事件 append/心跳、发布日志、服务部署日志等高频写路径带上实体级/global 脏 hint；部分写失败自动全量重同步兜底，flush/generation/启动恢复语义不变 |
