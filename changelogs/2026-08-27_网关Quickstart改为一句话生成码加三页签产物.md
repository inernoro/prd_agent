| feat | llmgw | Quickstart 第一屏改为全屏一个输入框「我想做什么」，提交后由网关自己的模型推导 appCallerCode，SSE 边推边渲染 |
| feat | llmgw | console-api 新增 POST /gw/app-callers/draft：调 serving 兼容端点推导两段码，未配置或调不通时返回明确的不可用码 |
| feat | llmgw | 产物屏改为三页签：接入信息（地址/密钥/用途码）、cURL（含一键试跑）、提示词（系统提示词 / Agent Skill / 客户端配置） |
| refactor | llmgw | 「怎么接进去」不再作为创建步骤问用户，收进产物屏的提示词页签；创建线收敛为「说清用途 → 看码 → 算谁的」三屏 |
| feat | llmgw | 意图关键词表补「智能硬件」调用方与「指令解析」场景——用户真实输入两段都认不出来，模型不可用时靠它兜底 |
| test | llmgw | e2e 补模型推导、降级到本地判定、三页签互斥、系统提示词不含密钥明文等断言，共 81 条全绿 |
| test | prd-api | GatewayDataDomainGuardTests 钉住推导端点接线、来源标记与提示词不带密钥明文 |
| fix | llmgw | 推导请求不再发 temperature：真实打网关实测被上游 400 回「temperature does not support 0 with this model」，确定性改由提示词约束 |
| fix | llmgw | 推导提示词补「两段禁止出现中文」硬约束与两个中文输入的示例——实测同一句话会随机返回中文段，落到本地兜底 |
