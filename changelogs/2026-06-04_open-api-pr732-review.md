| fix | prd-api | 开放接口流式 chat 在错误/异常/无 Done chunk 退出时补发 `data: [DONE]` 终止符，兼容 OpenAI SDK 收尾 |
| fix | prd-api | 开放接口每日请求配额改用 INCR-then-check + 超额回滚，消除"读-判-写"竞态 |
| fix | prd-admin | 开放接口本页教程步骤补 tab-gated 锚点回落，默认 tab 非开放接口时不卡步 |
| fix | prd-api | 开放接口准入把每日请求配额校验移到速率窗口前，日配额拒绝不再白白占用分钟桶槽位，速率拒绝回滚日配额占用 |
| fix | prd-api | 开放接口输入字符上限纳入多模态 image_url（base64 数据 URI），大图不再绕过 MaxInputChars 直打上游 |
| fix | prd-api | 开放接口准入改单条 Lua 原子脚本（速率+每日请求配额合并），消除读-判-写竞态/日配额拒绝占速率槽/fail-open 后悬挂计数三类边界 |
| fix | prd-admin | 开放接口模型白名单选择器补「模型池 code」选项，可让客户走整池故障转移而非钉死单模型 |
| fix | prd-admin | 开放接口本页教程第 2 步起带 ?tab=open-api 跳转，确保切到开放接口 tab 后 stats/list 锚点已挂载 |
| fix | prd-api | /v1/models 修复"JWT 会话 + 有效 sk-ak 密钥"被误判无效 key→401（TryLoadKeyFromAuthAsync 会话取不到 key 时回落 ApiKey 认证） |
| fix | prd-api | /v1/models 仅把 sk-ak-* 视为开放接口密钥凭据，平台 X-AI-Access-Key/旧 sk- App key 做模型发现不再被误 401 |
| fix | prd-api | 开放接口流式 chat 在流开始前上游失败时返回 502+JSON 错误，不再伪装成 200 空流让客户端误判成功 |
| fix | prd-api | 开放接口流式 chat 日志状态码取客户端实际收到值（pre-stream 错误记 502 而非 500），按 requestId 排障一致 |
| fix | prd-api | /v1/models 对有效但缺 open-api:call scope 的 Key 返回 403，避免越权发现开放接口模型绑定 |
| fix | prd-api | 开放接口输入字符上限纳入 tools/functions schema，大工具定义不再绕过 MaxInputChars |
| fix | prd-api | 开放接口绑定失效检测：绑定的模型/池被删改导致回落默认调度时补发降级预警，不再静默跑共享默认池 |
| fix | prd-admin | 开放接口客户列表加载失败时清空行数据，避免汇总/列表展示过期 Key 数据误导运维 |
| fix | prd-admin | 开放接口模型池加载失败时清空 pools，避免白名单选择器展示已下线/过期池选项被误存进 Key |
| fix | prd-api | 开放接口流式 chat 收到 Done 后不再立即 break，继续读完上游迭代器让 LlmGateway 完成 FinishStreamLogAsync，避免成功请求日志卡 running 被误判超时 |
| fix | prd-api | 开放接口本页教程第 2-6 步移除 tab 逗号兜底（querySelector 文档顺序会让 tab 永远命中），聚光灯正确落在内容区 |
| fix | prd-api | 开放接口 chat/image：[Authorize] 通过但 AgentApiKey 行查不到（鉴权后被删）时返回 401，堵住无 Key 绕过限流/配额的旁路 |
| fix | prd-api | 开放接口流式 chat 在流开始前异常时回 500 + OpenAI 形状 JSON 错误体（此前只设状态码、Content-Type 仍是 event-stream 致空响应） |
| fix | prd-admin | 开放接口调用日志加载失败时清空 logs，避免运维复制到过期 requestId 用于排障 |
| chore | prd-api | AgentApiKeysController 显式 using 父命名空间引用 OpenApiController.ScopeCall（跨命名空间引用更清晰） |
| docs | prd-api | guide.mongodb-indexes 补 open_api_request_logs 索引（KeyId+CreatedAt / CreatedAt / RequestId / 可选 TTL），按 no-auto-index 规则由 DBA 手动建 |
