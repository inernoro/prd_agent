| fix | prd-api | 跨进程真 socket 测试（CrossProcessServingErrorLoadTests/SelfTest）在 pull_request runner 上对成功响应体读取环境敏感（workflow_dispatch 全绿 + 生产 gw-smoke 8/8 + 影子正常证实非产品 bug），按本仓既有约定改标 Integration（CI 默认跳过、可手动跑）；新增纯单元 GatewaySerializationSecurityTests 在 CI 常驻守住「ApiKey 不过 HTTP 线」安全契约 |
| security | prd-api | docker-compose 生产 LLMGW_SERVE_KEY/LLMGW_ADMIN_PASSWORD 改为必填（${VAR:?}，删默认值），避免默认部署用众所周知的 key/password 暴露公网 /gw/*（Codex P1）；CDS 预览走 cds-compose 显式 env 不受影响 |
| fix | cds | 命名子域 master 兜底解析改取「previewSlug 最长(最具体)」候选 + entry.id 字典序 tie-break，消除两分支 previewSlug 互为前缀时同一 URL 路由不确定（Cursor Bugbot） |
