| feat | prd-admin | 新增「视觉分镜台」：想法/文章拆成电影分镜，关键帧复用视觉创作生图引擎实时生长、逐镜精修，预留 image-to-video |
| feat | prd-api | 新增视觉分镜拆镜接口 storyboard-script（visual-agent.storyboard.script::chat）：输出每镜关键帧图 prompt + 运动 prompt |
| fix | prd-api | OpenAIImageClient 支持 OpenRouter 图片生成协议（/chat/completions + modalities:[image,text]，从 message.images 取图），修复 OpenRouter 图片模型 404 |
