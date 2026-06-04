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
