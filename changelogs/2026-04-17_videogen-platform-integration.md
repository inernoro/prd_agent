| feat | prd-api | VideoGen 加入 BaseTypes（四大分类 → 五大基础类型）|
| feat | prd-api | 新增 AppCallerRegistry.VideoAgent.VideoGen.Generate = "video-agent.videogen::video-gen" |
| refactor | prd-api | OpenRouterVideoClient 改走 ILlmGateway.SendRawAsync，API Key 从平台管理读取，不再依赖 OPENROUTER_API_KEY 环境变量 |
| refactor | prd-api | VideoGenRunWorker.ProcessDirectVideoGenAsync 调用新 client 签名（AppCallerCode 驱动）|
| feat | prd-admin | 模型选择模态框新增「视频」tab，Film 图标，点击过滤出视频生成模型 |
| feat | prd-admin | cherryStudioModelTags 新增 isVideoGenModel 判定 + video_generation tag |
| feat | prd-admin | VideoGenDirectPanel 模型下拉新增「自动（由模型池决定）」选项 |
