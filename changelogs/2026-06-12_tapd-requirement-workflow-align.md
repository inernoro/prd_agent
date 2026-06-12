| refactor | prd-api | 需求默认工作流对齐 TAPD 米多需求收集工作流（7 状态 + 流转矩阵 + 遗留状态迁移 + 导入映射） |
| refactor | prd-api | 流程定义增加 SeedRevision/IsUserCustomized：仅初始化写入 TAPD 种子，管理员保存后不再覆盖 |
| docs | prd-api | 新增 tapd-requirement-workflow.seed.json 作为 TAPD 工作流初始化 SSOT |
| fix | prd-api | 修正需求状态排序与 TAPD 一致：已上线/已拒绝在已排期之前（seed_revision=3） |
| refactor | prd-admin | 新增 tapdRequirementWorkflow 状态标签常量与 TAPD 后端 Key 对齐 |
| polish | prd-admin | 全局需求状态展示统一：Overview/看板/详情/RTM/图谱使用 TAPD 对齐标签；流转按钮短文案 |
| test | prd-admin | requirementWorkflowUtils 单元测试 |
| test | prd-api | TapdRequirementWorkflow 补充 31 边与短标签断言 |
| polish | prd-api | 跨产品 overview/requirements 返回 stateLabel；存量状态 Key 幂等规范化迁移 |
