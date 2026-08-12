| fix | llmgw | 删 appCaller 连带删提示词策略前要求 config:write：该端点只要 app-caller:write，而策略的读/写/回滚都要 config:write，内置 Developer 角色恰好有前者没后者，级联下去能抹掉自己看不到的治理配置；有策略要连带删时改为 403 并说清找谁 |
| fix | prd-admin | 录音词典读失败不再是死胡同：原先失败后 lexicon 恒为 null，fail-closed 让加词按钮永远点不动且无任何提示，现在明说读失败原因并给重试按钮 |
| test | prd-api | 补 appCaller 级联删的权限闸守卫（判据必须早于删除、且按「真有策略」判定，避免收走 Developer 的正常删除权） |
