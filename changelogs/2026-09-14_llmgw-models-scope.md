| fix | llmgw | GET /v1/models 的权限判反：列模型是读不是调用，改判 route:read |
| docs | llmgw | 新增模型概念收敛活看板，四个阶段各带 blocker、下一步与验收证据 |
| test | prd-api | 补守卫：/v1/models 必须在落到 invoke 兜底前判成 route:read |
