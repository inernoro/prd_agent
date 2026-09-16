| ops | llmgw | chat 的默认从 `default-chat`（169 条能接线路、127 条是 OpenRouter 全量导入、第 2-8 位全是 gpt-3.5 全系与 gpt-4 初代）改指新的旗舰梯队：gpt-5.6-sol 直连 → 同模型异上游 → sol-pro → terra → 5.5 → claude-opus-5 → claude-sonnet-5，七条里没有任何 mini/nano/lite/flash/haiku 便宜档 |
| ops | llmgw | 老的 `default-chat` 原地保留为归档（描述里写清为什么），回退就是把默认指回来。数据面改动，正式环境要另做一次 |
| feat | prd-api | 生图模型契约可以配在控制台、不用改代码不用发版：新增 `GatewayImageModelConfig` 实体与 `llmgw_imagegen_model_configs` 集合，`ImageGenModelAdapterRegistry.TryMatch` 内部先查覆盖表再回落到代码内置那 19 条（纯增量：库里一行都没有时行为逐字节不变） |
| feat | prd-api | 新增 `ImageGenModelConfigSyncWorker`：每 60 秒整表原子替换覆盖表，拉取失败保留上一版快照不清空；并在启动时把代码内置那份发布进 `llmgw_imagegen_builtin_catalog`，供控制台显示与「照这条建一份」 |
| feat | llmgw | 控制台上游页新增「生图契约」一段：列表、增删改、看内置那 19 条、照内置那条建一份；界面如实写明「保存后最长 60 秒生效」 |
| test | prd-api | 新增 `ImageGenConfigOverrideGuardTests` 七条：覆盖真的赢过内置（红绿闭环验证过）、空覆盖回到内置、没人绕过唯一判定入口、实体每个字段都真的接进运行时、控制台词表与运行时常量一致、内置清单由运行时发布而非手抄、刷新器接上线且失败不清空 |
| refactor | prd-api | 「数据行 ↔ 运行时配置」的翻译从 Api 的 worker 搬进 `PrdAgent.Infrastructure/LLM/ImageGenConfigTranslation.cs`——守卫项目不引用 Api，留在 worker 里「漏接一个字段」这种静默坏法没有任何东西够得着 |
