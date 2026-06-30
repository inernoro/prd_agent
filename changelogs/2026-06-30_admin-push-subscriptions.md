| feat | prd-api | 新增管理员通知外部推送订阅配置、Bark 协议投递、模板投递与去重日志 |
| feat | prd-admin | 在左下角用户通知中新增推送订阅页签，支持 Bark 协议、URL/Webhook/企业微信/飞书/钉钉模板 |
| test | prd-admin | 新增用户通知推送模板选择行为测试 |
| fix | prd-api | 将管理员推送投递移入后台扫描任务，避免通知列表请求阻塞并修复重复投递、失败重试和 Bark 查询参数编码 |
| fix | prd-admin | 为推送订阅加载流程增加过期响应保护 |
| test | prd-api | 新增管理员推送后台投递、失败重试和 Bark 查询参数回归测试 |
| feat | prd-api | Bark 协议补充 image 推送图片参数，支持从通知图片附件填充占位符 |
| feat | prd-admin | 推送订阅 Bark 协议新增图片 URL 模板配置 |
| feat | prd-api | 新增推送 appname 资源目录，为缺陷、预警、站内信、服务器到期、用户之声和 API 请求问题提供独立 icon |
| feat | prd-admin | 推送订阅面板展示 appname 图标资源清单 |
| feat | prd-api | 缺陷管理员通知携带用户上传图片附件，Bark 推送可直接展示问题截图 |
