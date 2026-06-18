| feat | prd-admin | 视觉分镜台新增关键帧模型选择器：不再硬绑首个模型池，单一 OpenRouter 出图模型偶发 404 时可一键切换到其他可用出图模型（仅一个模型时自动隐藏选择器） |
| fix | prd-api | LlmGateway 原始响应二进制识别补齐 video/* 与 image/*：图生视频（Wan 2.6 等）下载 video/mp4 时此前被当文本读取，导致「视频下载失败: HTTP 200」，视频产物无法落 COS |
