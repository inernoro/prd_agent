| fix | prd-api | 修复识图不准根因：LLMAttachment 新增 Detail 字段，GatewayLLMClient 构建 image_url 时透传 detail 并默认 "high"，避免 7 条走 LLMAttachment 的视觉路径丢 detail 导致上游降级到 "auto" 低保真 |
| docs | prd-api | 修订决策一：删掉"协议全归一"，改为"下沉 + 协议原生处理器 + 透传保真 + 按模态契约"，识图不准作为拍平有损反例固化 |
