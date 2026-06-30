| security | prd-api | HttpLlmGatewayClient 不再回退众所周知占位 key（dev-llmgw-serve-key）：http 模式未配 LlmGwServe:ApiKey 时用空串让密钥门 401 响亮失败，而非用可预测共享密钥静默通过（Cursor Bugbot） |
| fix | prd-api | LlmShadowComparison/ResolveSnapshot/FieldMismatch 补 [BsonIgnoreExtraElements]，未来加字段/手工文档多余字段不致读端点反序列化失败（Cursor Bugbot 学习规则） |
| fix | cds | 命名子域分支内唯一：PUT extra-services 拒绝重复 subdomain + forwarder 数据面对同 subdomain 去重，消除同 host 不同端口撞车路由（Cursor Bugbot） |
| fix | cds | 命名子域 master 兜底要求服务有 hostPort（可路由）才命中，与 forwarder「只发可路由服务」口径对齐，避免停止/缺端口 profile 被强制命中拿不到上游（Cursor Bugbot） |
