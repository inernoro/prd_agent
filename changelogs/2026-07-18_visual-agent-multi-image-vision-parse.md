| fix | prd-api | 多图生图修复:通用Vision分支响应解析兼容message.images[]数组与多模态content数组,消除「Vision API 响应格式不支持」误报 |
| test | prd-api | 新增VisionResponseImageExtractionTests覆盖images[]/字符串content/多模态content数组/纯文本/空choices等全部响应形态 |
