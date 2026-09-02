| fix | prd-admin | 首页带图进画板时第一次生成会丢掉参考图（setCanvas 未刷新，解析器在旧画布里找不到），改为把刚加的元素直接递给发送路径 |
| test | prd-admin | 新增 mergeSendCanvas 纯函数用例与接线守卫，复现「旧画布 → 零引用」的退化 |
