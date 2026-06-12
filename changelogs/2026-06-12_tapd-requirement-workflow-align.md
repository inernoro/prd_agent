| refactor | prd-api | 需求默认工作流对齐 TAPD 米多需求收集工作流（7 状态 + 流转矩阵 + 遗留状态迁移 + 导入映射） |
| refactor | prd-api | 流程定义增加 SeedRevision/IsUserCustomized：仅初始化写入 TAPD 种子，管理员保存后不再覆盖 |
| docs | prd-api | 新增 tapd-requirement-workflow.seed.json 作为 TAPD 工作流初始化 SSOT |
| fix | prd-api | 修正需求状态排序与 TAPD 一致：已上线/已拒绝在已排期之前（seed_revision=3） |
| refactor | prd-api | TapdRequirementWorkflow 重命名为 RequirementWorkflowCatalog：运行时 SSOT 为 MongoDB 流程定义，Catalog 仅种子/迁移 |
| refactor | prd-api | 流转/标签解析改为 workflowDef 优先，支持用户自定义状态；MapImportedStatusLabel 仅 import 路径 |
| docs | prd-api | requirement-workflow.seed.json 替代 tapd-requirement-workflow.seed.json（MAP 内置种子文档） |
| refactor | prd-admin | requirementWorkflowCatalog + utils：工作流 API 优先，内置目录仅兜底 |
| polish | prd-admin | 需求模块去外部品牌：RTF 导入/字段/列表/详情统一为 MAP 原生文案与命名 |
| refactor | prd-admin | tapdRtf* 重命名为 requirementRtfImport*；sourceSystem 新写入 rtf |
| test | prd-admin | requirementWorkflowUtils 单元测试 |
| test | prd-api | RequirementWorkflowCatalog 单元测试（31 边、短标签、workflowDef 优先解析） |
| polish | prd-api | 跨产品 overview/requirements 返回 stateLabel；存量状态 Key 幂等规范化迁移 |
| fix | prd-admin | 需求详情移除属性栏重复状态（state_N），顶部 WorkflowBar 用导入快照兜底展示中文状态 |
| feat | prd-api | Wave3：流转 AllowedRoles/RequiredFieldKeys 校验 + ProductWorkflowTransitionGuard |
| feat | prd-api | 流转到已上线默认限制 product_admin/owner；种子 revision 升至 5 |
| feat | prd-admin | WorkflowTransitionDialog 替代 window.prompt；WorkflowBar/看板按权限过滤 |
| feat | prd-admin | 设置页流转编辑支持角色多选与必填字段配置 |
| test | prd-api | ProductWorkflowTransitionGuard 单元测试 |
| test | prd-admin | workflowTransitionGuard 单元测试 |
| feat | prd-api | Wave4：已立项/已排期/已上线闸门 + 立项/上线通过自动流转需求状态 |
| feat | prd-api | 流转支持 versionIds/initiationId/releaseId；已排期种子必填归属版本 |
| feat | prd-admin | 流转弹窗支持选择立项单、上线单、归属版本 |
| test | prd-api | RequirementWorkflowTransitionGates 单元测试 |
| refactor | prd-admin | 流程模板从「设置」拆至主页「应用」菜单独立入口 |
