| security | prd-api | 设计运行时回调（结果提交与模型代理）先校验票据再读请求体，未授权请求不再被读进内存 |
| security | prd-admin | 执行器实时预览的 CSP 以 default-src 'none' 起步，只放行内联与 data/blob 资源，禁止外链资源外传预览内容 |
| security | prd-api | PPT 发布先校验目标团队权限再建站，越权返回 403，不再留下孤儿站点或反复 503 |
| security | prd-api | OpenDesign 失败文案不再直接展示远端原始诊断，改为按错误码给人话原因与下一步，原文进服务端日志 |
