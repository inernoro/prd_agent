| perf | prd-api | 周报海报列表接口排除 TranscriptCues 字段，响应从 5MB 降至预期 |
| fix | prd-admin | 海报页面侧边栏"已完成"状态改用实心 Check icon 替代文字 badge |
| fix | prd-admin | 海报设计页过滤 URL 污染的字面量 "undefined"/"null"，加载失败时清理 search param，避免反复 404 |
| fix | prd-api | autopilot SSE 流改用 Connection:close + Response.CompleteAsync，解决流结束后代理复用脏连接导致的 400 |
| fix | prd-api | 海报列表投影加兜底全量查询，防止 BsonSerializationException 被 ExceptionMiddleware 转为 400 |
| fix | prd-admin | refreshList 失败时 console.error 完整诊断信息，便于排查 400 根因 |
