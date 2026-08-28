| fix | prd-api | GPT-5 家族的 max_tokens 收编下沉到限流函数内部，Exchange 原始请求路径不再同时带两个字段被上游拒 |
| fix | prd-api | 收编时保留调用方原本的较小值，不再按「目标字段不存在」把上限整个塞进去 |
| fix | ops | 每日验收找站点改用服务端 keyword 过滤（原先传的 pageSize 被忽略，只拿回 50 条，会重复建同名站点） |
