| perf | prd-api | 为录音分片读取、过期清理和归档租约查询补齐 MongoDB 索引 |
| docs | prd-api | 明确录音会话不使用 TTL 并保持先删分片再删会话的回收顺序 |
| fix | prd-api | 索引清单迁移旧版录音会话 TTL 后再创建普通过期查询索引 |
| test | prd-api | 增加录音上传索引目录、旧 TTL 迁移顺序与禁止 TTL 守卫 |
