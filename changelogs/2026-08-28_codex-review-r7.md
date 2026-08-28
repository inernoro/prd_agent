| fix | prd-api | 存量站点 owner 手写的开场问题不再被自动生成冲掉（AskQuestionsSource 缺字段时按手写处理） |
| fix | llmgw | 批量能力维护传了 modelIds 但一项都不合法时直接拒绝，不再静默扩成整个平台全刷 |
| refactor | llmgw | modelIds 归一化与校验下沉到 GatewayConfigurationProvisioning，可被直接测 |
