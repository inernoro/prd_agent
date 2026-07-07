| feat | prd-api | 将豆包 WebSocket ASR 协议迁入 LLM Gateway raw 路径，Mode=http 时由 llmgw-serve 承载 |
| refactor | prd-api | 将 API 层图片生成依赖收口到生图网关接口，避免业务层直接持有 OpenAIImageClient |
| test | prd-api | 新增豆包流式 ASR 网关分派测试，验证音频经 Gateway 执行并归一为 verbose_json |
| test | prd-api | 新增图片直连棘轮守卫，阻止 API 层重新依赖具体生图上游客户端 |
| test | prd-api | 新增 OpenRouter 视频网关路径测试，覆盖 submit、status、download 均经 Gateway raw |
| test | prd-api | 新增视频直连棘轮守卫，阻止 API 层重新依赖具体视频上游客户端 |
| ops | prd-api | llmgw-serve 镜像安装 ffmpeg，支持网关内 ASR 音频格式转换 |
