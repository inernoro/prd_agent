| security | prd-api | 提问配置的写路径补角色门：viewer 不能再替 owner 烧模型调用、覆盖题库 |
| fix | prd-api | 流中途的 error chunk 算作调用失败，不再把残句当正常回答并盖版本戳 |
| fix | prd-api | 这一版得不出题就清空题库，不留上一版内容写的问题 |
| fix | prd-api | 配额只退自己真扣过的那一格，Redis fail-open 时不退 |
| fix | prd-api | 站点访客数并入分享链接访问，纯分享站不再显示 0 访客 |
| fix | prd-admin | 重传时把解包进度键传下去，换 ZIP 的进度面板不再停在等待中 |
| style | prd-admin | 去掉两处 emoji（规则 #0） |
