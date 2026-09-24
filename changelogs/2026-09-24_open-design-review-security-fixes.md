| security | prd-api | 设计运行时回调（结果提交与模型代理）先校验票据再读请求体，未授权请求不再被读进内存 |
| security | prd-admin | 执行器实时预览的 CSP 以 default-src 'none' 起步，只放行内联与 data/blob 资源，禁止外链资源外传预览内容 |
| security | prd-api | PPT 发布先校验目标团队权限再建站，越权返回 403，不再留下孤儿站点或反复 503 |
| security | prd-api | OpenDesign 失败文案不再直接展示远端原始诊断，改为按错误码给人话原因与下一步，原文进服务端日志 |
| perf | prd-api | PPT 发布的团队预检对整批目标团队只加载一次成员关系（新增 GetTeamsNotPublishableAsync，与单个判定共用同一条判据），不再每个团队全量重查一次 |
| fix | prd-api | 设计任务执行失败时把完整异常链写进服务端日志，OpenDesign 远端原始诊断确实可在日志中查到，兑现用户文案里「原文已记入服务端日志」的承诺 |
