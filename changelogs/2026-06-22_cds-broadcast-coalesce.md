| perf | cds | 状态广播（state-stream SSE）改为前沿即时+尾沿合并节流，构建期 deploy-log 追加风暴不再每次全量序列化整个 state，消除构建时仪表盘与所有 /api/* 集体卡死 |
