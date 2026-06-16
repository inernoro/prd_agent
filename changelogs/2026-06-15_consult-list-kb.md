| feat | prd-api | 营销问策列表分页+筛选：GET /api/product/consult 支持 page/pageSize/keyword/customerId/verdict/template，返回{items,total,page,pageSize}；MarketingConsultReport 加 Verdict 字段并生成时落库（旧数据回退解析） |
| feat | prd-api | 问策知识库端点：GET consult/knowledge(列表)、GET consult/knowledge/{id}(全文)、POST consult/knowledge(添加，需管理权限)，复用 find-or-create 问策库 |
| feat | prd-admin | 营销问策子模块重做为「列表→详情」：分页+搜索+客户/判定/模版筛选+「问策」按钮；详情聚合同一客户的其他问策；compose 自由文本/可选客户一键问策 |
| feat | prd-admin | 设置「问策知识库」改为文档列表展示：点击查看（Markdown 渲染）+「添加资料」扩充 |
