| fix | cds | Redis 恢复改为「停容器 → 存当前快照 → 覆盖 → 启动」，修复关闭时的 save 覆盖刚上传快照却回「已恢复」的静默丢数据 |
| fix | cds | Redis 恢复对开启 AOF 的实例直接拒绝（启动读 AOF 不读 RDB，写了也不生效），不再给出恢复成功的假象 |
| feat | cds | Redis 恢复补上撤销快照（此前只有 mongo 有），扩展名按真实格式命名为 .rdb |
