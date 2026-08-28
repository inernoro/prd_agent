| fix | llmgw | intent 池成员资格判据改读 Capabilities，修掉「批量导入模型永远进不了意图池」的死锁 |
| refactor | llmgw | intent 兼容判据收敛为唯一一份 GatewayModelPoolTypeRegistry.IsIntentCapable，Program.cs 的拷贝改为委托 |
| feat | llmgw | 模型能力维护支持 modelIds 精确圈定，不必按平台整片刷 |
| docs | doc | debt.web-hosting #64 结清：意图池判据死锁的根因、修法与实测证据 |
