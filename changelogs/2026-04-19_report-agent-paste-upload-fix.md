| fix | prd-admin | 周报日常记录/富文本编辑器粘贴图片压缩目标留 512KB 缓冲，避免 multipart 请求体超过 Kestrel 5MB 限额 |
| fix | prd-admin | 周报图片上传 service 抽共享 helper，按 HTTP 状态码映射清晰错误文案（413/415/5xx），Toast 不再显示孤立的"上传失败" |
| fix | prd-api | ReportAgentController 两处图片上传 RequestSizeLimit 由 5MB 放宽到 6MB（业务层仍强制 5MB 用户可见上限） |
