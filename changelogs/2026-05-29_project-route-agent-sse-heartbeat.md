| fix | prd-api | 项目路由智能体 AnalyzePlanStream 增加 SSE 心跳（每 8s 写 `: keepalive`），对齐 server-authority 规则 #4，防止 LLM/克隆耗时超过 60s 时被 nginx/CDN 默认 idle timeout 断流 |
