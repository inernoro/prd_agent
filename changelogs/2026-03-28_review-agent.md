| feat | prd-api | 新增产品评审员 Agent（review-agent）后端：ReviewAgentController、ReviewSubmission/ReviewResult/ReviewDimensionConfig 模型、7 维度默认评审配置、SSE 流式评审输出、评审完成通知 |
| feat | prd-api | 新增 review-agent 权限常量（use/view-all/manage）及 AppCallerCode 注册 |
| feat | prd-api | MongoDbContext 注册 review_submissions、review_results、review_dimension_configs 三个集合 |
| feat | prd-admin | 新增产品评审员前端：ReviewAgentPage（列表）、ReviewAgentSubmitPage（上传提交）、ReviewAgentResultPage（SSE 实时评审结果）、ReviewAgentAllPage（全部提交，权限门控） |
| feat | prd-admin | toolboxStore.ts 首页新增"产品评审员"卡片（第三排第二位），authzMenuMapping.ts 注册三个权限点 |
