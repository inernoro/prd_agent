| refactor | prd-api | 需求默认工作流对齐 TAPD 米多需求收集工作流（7 状态 + 流转矩阵 + 遗留状态迁移 + 导入映射） |
| refactor | prd-api | 流程定义增加 SeedRevision/IsUserCustomized：仅初始化写入 TAPD 种子，管理员保存后不再覆盖 |
| docs | prd-api | 新增 tapd-requirement-workflow.seed.json 作为 TAPD 工作流初始化 SSOT |
| fix | prd-api | 修正需求状态排序与 TAPD 一致：已上线/已拒绝在已排期之前（seed_revision=3） |
| refactor | prd-api | TapdRequirementWorkflow 重命名为 RequirementWorkflowCatalog：运行时 SSOT 为 MongoDB 流程定义，Catalog 仅种子/迁移 |
| refactor | prd-api | 流转/标签解析改为 workflowDef 优先，支持用户自定义状态；MapImportedStatusLabel 仅 import 路径 |
| docs | prd-api | requirement-workflow.seed.json 替代 tapd-requirement-workflow.seed.json（MAP 内置种子文档） |
| refactor | prd-admin | requirementWorkflowCatalog + utils：工作流 API 优先，内置目录仅兜底 |
| polish | prd-admin | 全局需求状态展示统一：Overview/看板/详情/RTM/图谱使用 TAPD 对齐标签；流转按钮短文案 |
| test | prd-admin | requirementWorkflowUtils 单元测试 |
| test | prd-api | RequirementWorkflowCatalog 单元测试（31 边、短标签、workflowDef 优先解析） |
| polish | prd-api | 跨产品 overview/requirements 返回 stateLabel；存量状态 Key 幂等规范化迁移 |
