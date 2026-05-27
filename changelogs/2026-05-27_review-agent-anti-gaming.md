| feat | prd-api | 产品评审 Agent 加入三层兜底（evidence gate / 数据密度封顶 / summary 一致性闸），杜绝 LLM 把非清单维度全填满凑 99 分的钻空子路径 |
| refactor | prd-api | 评审默认权重调整：清单维度 30→20，10 分按 +2 平均分摊到 consistency/problem_quality/user_value/feasibility/testability 五个高风险维度 |
| feat | prd-admin | 评审结果页新增「系统兜底调整记录」展示区，触发 guardrail 时显示原分→新分及调整原因 |
| test | prd-api | 新增 ReviewAgentScoringGuardrailsTests 覆盖三层兜底的触发与不触发场景 |
