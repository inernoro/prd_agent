| feat | prd-api | 产品评审 Agent 新增「未通过救机会」端点 POST /submissions/{id}/reupload-on-failure，每方案仅 1 次替换附件重评 |
| feat | prd-api | 新增 GET /submissions/{id}/results 返回该 submission 完整评审历史 |
| fix | prd-api | rerun/reupload 路径不再删除旧 ReviewResult，保留为评审历史 |
| fix | prd-api | LLM 网关 Error 后的"重新评审"重跑改用新字段 ErrorRetryCount，不污染 RerunCount，避免系统故障被错算成用户重评 |
| refactor | prd-api | 排行榜重写：先按 (submitterId, title) 聚到「方案桶」再统计；新公式「一次性通过率」= 一次过方案数 / 总方案数（非"通过的方案中无重评的占比"，修复永远 100% 的旧 bug） |
| feat | prd-admin | 评审结果页未通过状态新增「重新上传方案（剩 1 次救机会）」按钮 |
| feat | prd-admin | 评审结果页新增「评审历史」折叠区，列出该 submission 的所有评审记录（得分/通过状态/时间/兜底次数） |
| docs | prd-admin | 排行榜文案说明改为"按方案标题去重 + 系统故障重跑不计入用户重评" |
| test | prd-api | 新增 ReviewAgentLeaderboardTests 10 条单测覆盖一次过判定/桶级通过判定/同标题去重/跨用户隔离/F-2 ErrorRetryCount 不污染 RerunCount/张三全月示例端到端 |
