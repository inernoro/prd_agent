| security | prd-api | HttpLlmGatewayClient 不再回退众所周知占位 key（dev-llmgw-serve-key）：http 模式未配 LlmGwServe:ApiKey 时用空串让密钥门 401 响亮失败，而非用可预测共享密钥静默通过（Cursor Bugbot） |
| fix | prd-api | LlmShadowComparison/ResolveSnapshot/FieldMismatch 补 [BsonIgnoreExtraElements]，未来加字段/手工文档多余字段不致读端点反序列化失败（Cursor Bugbot 学习规则） |
| fix | cds | 命名子域分支内唯一：PUT extra-services 拒绝重复 subdomain + forwarder 数据面对同 subdomain 去重，消除同 host 不同端口撞车路由（Cursor Bugbot） |
| fix | cds | 命名子域 master 兜底要求服务有 hostPort（可路由）才命中，与 forwarder「只发可路由服务」口径对齐，避免停止/缺端口 profile 被强制命中拿不到上游（Cursor Bugbot） |
| security | cds | llmgw-serve 与 llmgw console 同处理：CDS 预览删 `cds.path-prefix:/gw/v1/` 改 no-http-readiness，关闭已知 M2M key 的公开 /gw/v1/send 路由（防无鉴权 LLM 调用烧额度）；ApiKey 改 `${LLMGW_SERVE_API_KEY:-内网fallback}` 非仓库默认（Cursor Bugbot High） |
| fix | prd-llmgw-web | dev 代理默认指向独立网关 console（localhost:5090，docker-compose.dev 映射 5090:8090），不再误指主 API 5000——后者无 /gw/auth/login 等 console 端点，导致 pnpm dev 登录/日志 404（Codex P2） |
| fix | ops | _standalone.conf 8081 网关前端站 /gw-api/ 反代补 /gw/ 重写：proxy_pass 末尾带 /gw/ 把 /gw-api/auth/login 改写为后端认的 /gw/auth/login，修复原样透传导致的 404（Cursor Bugbot Medium） |
| fix | cds | isValidServiceSubdomain 拒绝保留伪值 null/undefined/none/true/false/nan：堵住 JSON 字符串 "null" / compose label cds.subdomain:"null" 当真子域发布 <slug>-null.<root> 伪 host（Cursor Bugbot） |
| fix | ops | docker-compose.dev.yml llmgw-web 改用 prd-llmgw-web/Dockerfile 真实构建，不再挂不存在的 ./deploy/llmgw-web/dist（空静态根导致 5590 控制台打不开）（Codex P2） |
| docs | doc | design.llm-gateway-physical-isolation 头部补「· 设计」后缀 + 状态枚举改合法值「开发中」；debt 记 subdomain 撞项目 profile 校验缺口为波3（Cursor Bugbot / Codex P2） |
| fix | prd-api | HttpLlmGatewayClient.GetAvailablePoolsAsync 非成功/异常不再静默吞成空池，改向上抛（与 inproc 一致），让 admin/smoke 区分「网关 down」与「真的没可用池」（Cursor Bugbot Medium） |
