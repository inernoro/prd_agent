| fix | prd-api | 修复知识驱动 PPT 大纲每次都报 source_plan_missing：两条大纲提示词的格式示例都没写 sourceBlockIds，模型照抄示例、Bind 阶段必然作废 |
| fix | prd-api | 修复知识驱动 PPT 大纲频繁报 source_plan_incomplete：来源块标识改用短代号 b1..bN 给模型（内容寻址 Id 仅内部使用），模型抄不全 64 位十六进制串会整轮漏块 |
| feat | prd-api | 大纲生成阶段新增确定性来源覆盖补齐：模型漏掉的来源块按原文顺序跟到相邻页，不改写事实；用户确认阶段仍保持严格校验 |
