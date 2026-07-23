| feat | prd-admin | 录音期间实时展示转写原文，并保留本机保险箱与服务端分片双重保护 |
| feat | prd-api | 新增带会话归属校验的实时 ASR WebSocket 中继与转写结果持久化 |
| feat | llmgw | 新增模型池多候选实时 ASR 网关端点，异常时自动降级到批处理转写 |
| ops | prd-api | 正式 Nginx 与 CDS 预览代理支持实时转写 WebSocket 升级 |
| test | prd-admin | 补充 PCM 降采样、帧协议、实时状态与降级体验测试 |
| test | prd-api | 补充实时音频顺序、候选策略、WebSocket 鉴权与批处理兜底测试 |
