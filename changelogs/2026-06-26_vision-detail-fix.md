| fix | prd-api | 修复识图不准根因：LLMAttachment 新增 Detail 字段，GatewayLLMClient 构建 image_url 时透传 detail 并默认 "high"，避免 7 条走 LLMAttachment 的视觉路径丢 detail 导致上游降级到 "auto" 低保真 |
| docs | prd-api | 修订决策一：删掉"协议全归一"，改为"下沉 + 协议原生处理器 + 透传保真 + 按模态契约"，识图不准作为拍平有损反例固化 |
| test | prd-api | 修正视觉 detail 单测 harness：NewVisionClient 改用注册了 vision modelType 的 AppCaller(Admin.Lab.Vision)，原用 Admin.Lab.Chat 触发 CreateClient 的 modelType 校验异常导致 4 条用例全挂(CI 实测发现) |
| fix | prd-api | 协议保真 F3a：ClaudeGatewayAdapter.ConvertToClaudeFormat 不再"只抄 5 个字段"拍平采样参数，透传 Claude 原生兼容的 top_p/top_k，OpenAI 的 stop 改名为 Claude 的 stop_sequences；OpenAI 专有字段(frequency_penalty 等)按白名单挡掉避免 400。Open Platform 兼容代理路由到 Claude 池时采样参数不再静默丢失 |
