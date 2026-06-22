| perf | cds | GET /api/branches 列表加短 TTL 缓存（默认 1s）+ 同 key 并发去重 + 并行解析各分支资源，10+ 并发从"各算一遍串行排队 5s+"降为"只算一次"，显著提升高并发吞吐 |
| perf | cds | GET /api/branches 命中缓存的 dashboard 请求改发预序列化 JSON 串（widget 请求仍走 res.json 过滤），10+ 并发不再每请求重复全量序列化 |
