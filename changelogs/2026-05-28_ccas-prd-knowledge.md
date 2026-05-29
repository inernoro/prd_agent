| feat | prd-admin | 赋码采集关联智能体 PRD Tab 增加「上传 .md/.txt 文件」按钮（FileReader 浏览器端读入，单文件 ≤ 2MB） |
| feat | prd-admin | 赋码采集关联智能体 PRD Tab 增加「引用知识库」抽屉：复用 document-store API（按 appKey=ccas-agent 优先排序），多选条目（上限 20 条 / 24K 字符），含 token 预算条 |
| feat | prd-api | CcasAgentController.GeneratePrdStream 增加 referenceEntryIds 字段：从 document-store 读条目内容，按 8K / 24K 字符预算注入到 system prompt 末尾「## 领域参考资料」段，权限只允许引用自己的或公开的空间，新增 reference SSE 事件回报实际注入数 / 跳过原因 |
