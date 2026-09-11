| fix | prd-api | 逻辑模型 Offering 熔断后补上冷却与半开租约，不再永久出局 |
| fix | prd-api | 失败计数与健康状态改为原子自增加单调升级，并发下断路器不再迟迟不跳 |
| fix | prd-api | 隔离路径清掉半开租约与人工恢复标记，坏成员不再每轮抢占首发名额 |
| refactor | prd-api | 熔断阈值与冷却租约收敛为 GatewayCircuitBreakerPolicy 唯一判据源 |
| feat | llmgw | 新增手工恢复上游线路端点，恢复语义为授予半开资格而非直接放回健康 |
| test | prd-api | 新增熔断守卫 14 条，覆盖判据单调性、原子写口径与半开接线 |
| docs | llmgw | 台账记入调度器死配置、探针从未启用、流中断不切换、调度空壳四条已知边界 |
