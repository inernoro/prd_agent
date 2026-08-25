| feat | prd-admin | 知识库顶部新增「最近」标签（在「我的收藏」左侧）：跨知识库的内容时间线，按今天/昨天/更早分组，每条带所属知识库与「新增」标，点一条直接落到那篇内容 |
| feat | prd-api | 新增 GET /api/document-store/entries/recent：按「我的空间 ∪ 团队空间」作用域返回最近新增或修改的文档条目，新增与改动的判据在服务端给出 |
| chore | prd-admin | 新增录音交付页开发期对照台 mock.html：无后端渲染生产组件本体 + mock 数据，用于与设计稿逐屏比对 |
| fix | prd-admin | 知识库同步守卫用例改为按语义断言，不再逐字要求整段 StoreTab 联合类型（加一个新标签就误红） |
| docs | doc | debt.knowledge-base 记录录音交付页与设计稿 v2 的十条偏差、核对方式与未决取舍 |
| ops | scripts | mongodb-indexes 登记 document_entries 的 StoreId+UpdatedAt 索引，支撑「最近」时间线与卡片预览 |
