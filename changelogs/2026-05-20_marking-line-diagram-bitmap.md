| feat | prd-api | 赋码产线新增 POST /api/marking-line-agent/diagram/image 文生图位图接口，注册 MarkingLineDiagramImageService |
| feat | prd-admin | 赋码产线页增加「生成示意图（位图）」与进度提示、预览与下载 |
| chore | prd-admin | apiRequest 支持 AbortSignal，赋码产线路由补充 X-App-Name |
| fix | prd-admin | isApiResponseLike 兼容省略 data 的失败 JSON，避免误报「HTTP 502」泛型文案 |
| fix | prd-api | AppJsonContext 注册赋码产线生图 DTO；生图默认 1024x1024；INVALID_FORMAT 走 400 |
