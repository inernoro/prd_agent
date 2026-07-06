| feat | prd-api | 将豆包 WebSocket ASR 协议迁入 LLM Gateway raw 路径，Mode=http 时由 llmgw-serve 承载 |
| test | prd-api | 新增豆包流式 ASR 网关分派测试，验证音频经 Gateway 执行并归一为 verbose_json |
| ops | prd-api | llmgw-serve 镜像安装 ffmpeg，支持网关内 ASR 音频格式转换 |
