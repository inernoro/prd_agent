| feat | prd-api | AI 摘要服务端缓存(product_item_summaries)：同一需求/功能/缺陷只在首个打开者触发 LLM 生成并落库，其他人读缓存不重复调用；summary?force=true(重新摘要)才重算覆盖 |
| feat | prd-admin | 图谱抽屉 AI 摘要走缓存：自动摘要读缓存(无则首个人生成)，「重新摘要」force 覆盖；显示「由 X 生成」 |
