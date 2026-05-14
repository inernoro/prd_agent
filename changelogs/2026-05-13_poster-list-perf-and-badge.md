| perf | prd-api | 周报海报列表接口排除 TranscriptCues 字段，响应从 5MB 降至预期 |
| fix | prd-admin | 海报页面侧边栏"已完成"状态改用实心 Check icon 替代文字 badge |
| fix | prd-admin | 海报设计页过滤 URL 污染的字面量 "undefined"/"null"，加载失败时清理 search param，避免反复 404 |
| fix | prd-api | autopilot SSE 流改用 Connection:close + Response.CompleteAsync，解决流结束后代理复用脏连接导致的 400 |
| fix | prd-api | 海报列表投影加兜底全量查询，防止 BsonSerializationException 被 ExceptionMiddleware 转为 400 |
| fix | prd-admin | refreshList 失败时 console.error 完整诊断信息，便于排查 400 根因 |
| fix | prd-api | autopilot SSE Emit 显式 camelCase 序列化（默认 JsonSerializer 是 PascalCase，导致前端 poster.id 为 undefined → ?id=undefined / 漏图 / 重复检测错误） |
| fix | prd-admin | autopilot onDone 显式校验 poster.id，缺失时报错并打印诊断信息 |
| fix | prd-api | autopilot ParseAccumulatedContent：PageHeaderPattern 颜色值改为可选，兼容省略颜色的模型输出 |
| fix | prd-api | autopilot max_tokens 从 2400 提升至 4000，避免 6 页内容被截断 |
| fix | prd-api | autopilot 解析失败时日志记录模型名、text chunk 数量、完整输出前 1000 字；空输出与格式错误分开报告 |
| fix | prd-admin | 删除 public/thirdparty/ref 断链符号（Docker 构建失败根因：../../../thirdparty/ref 在容器内超出文件系统根） |
