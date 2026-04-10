| feat | prd-admin | 周报团队添加成员支持批量多选+搜索，新增 UserMultiSearchSelect 组件 |
| feat | prd-api | 周报团队新增批量添加成员 API（POST teams/{id}/members/batch） |
| fix | prd-api | AI生成周报时MAP平台工作记录严格按用户实际行为输出，零数据指标不再传入提示词 |
| fix | prd-api | 周报文档编辑统计修复用户归属：原查询遗漏UserId过滤导致统计全站文档，改用Groups.OwnerId关联，指标重命名为"创建PRD项目" |
| fix | prd-api | 周报LlmCalls自噬循环修复：排除report-agent.*的AppCallerCode，避免报告生成自身的LLM调用被统计为用户行为 |
| fix | prd-api | 周报AI生成提示词强化严格约束条款，禁止AI凭空编造、语义漂移或捏造修饰语 |
