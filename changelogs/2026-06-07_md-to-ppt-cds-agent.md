| feat | prd-api | MD 转网页 PPT 后端改用 CDS Agent 会话（IInfraAgentSessionService）生成 reveal.js HTML，支持 SSE 流式推送 delta/done/error 事件，会话出现在 CDS 控制台 Sidecar Pool 列表 |
| fix | prd-api | MD转PPT 走 CDS Agent 的 convert/patch SSE 补 keepalive 心跳(每~10s),根治 agent 慢/思考期间无数据导致的 Cloudflare HTTP 524 超时(server-authority 规则#4 子智能体漏了) |
