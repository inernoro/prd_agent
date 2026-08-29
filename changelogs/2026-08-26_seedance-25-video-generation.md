| feat | prd-admin | 视频创作高级模型列表新增 OpenRouter Seedance 2.5 |
| fix | prd-api | 按实时能力约束 Seedance 2.5 的时长与分辨率 |
| fix | prd-api | 视频生成调用统一切换到 LLMGW 权威路由 |
| fix | llmgw | appCaller 自助创建支持 video-gen 等全部网关模型类型 |
| fix | prd-api | HTTP LLMGW 发送阶段锁定首次解析的视频模型，避免二次解析漂移到其他 Provider |
| fix | prd-api | 视频下载在 HTTP LLMGW 模式下通过网关安全注入密钥并返回成片 |
