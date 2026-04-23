| fix | prd-api | 新增 ExpectedModelRespectingResolver 装饰器（Api.dll，能正常部署），包裹 Infrastructure.dll 里"改了无法生效"的 ModelResolver。所有 ResolveAsync 调用先在 Api 层做 Tier1/2/3 匹配（精确 ModelId → 前缀 → 池名/Code），命中就返回 FromPool，未命中才委派内部老 resolver。解决 Round 6 遗留的"OpenAIImageClient 内部调度仍然换模型"问题 |
| feat | prd-api | 新增 /api/debug/resolver/test 调试端点：不跑生图，直接接收 {appCallerCode, modelType, expectedModel}，返回候选池快照 + 每档匹配过程 + 实际 resolver 返回值。让"选 A 给 B"问题可独立、快速、反复测试，不用每次都跑真实生图 |
| feat | prd-api | 配套 /api/debug/resolver/inspect 只读端点：列出某 AppCaller 的绑定池、健康状态、模型列表（健康状态整数值也一并返回便于排查） |
