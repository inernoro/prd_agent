| refactor | prd-api | LLM 网关 P1 协议下沉：LLMModel/ModelGroupItem 新增可空 Protocol 字段，resolver 按 item??model??platform 计算并透传到 Resolution，全向后兼容（null⇒平台 PlatformType，路由不变） |
| feat | prd-api | LlmRequestLog 新增 Protocol/ResolutionReason 字段（仅追加），解析协议与原因可观测 |
| test | prd-api | 新增注册表黄金快照护栏（反射 153 个 appCallerCode + ModelTypes，新增/改名即红）+ 解析黄金集成测试（Category=Integration，比对 153 code 解析底片） |
| fix | prd-api | 止血：deepseek-v4-flash chat 默认池陈旧 Unavailable 健康标记已重置为 Healthy，53 个 chat code 停止静默 fallback |
| refactor | prd-admin | 模型池管理类型筛选 chip 改为"配置才出现"：ModelTypeFilterBar 新增可空 availableTypes，只渲染已有池的 modelType，不再预铺 14 个空类目（OpenRouter 心智，向后兼容） |
| refactor | prd-api | P3 删死策略引擎：移除 5 个非 FailFast 策略类(Race/RoundRobin/WeightedRandom/Sequential/LeastLatency)+ 调度预测端点/工具，池调度化简为只有 FailFast；保留 PoolStrategyType 枚举+StrategyType 字段(数据兼容,无 DB 迁移)；serving 路径零影响 |
| refactor | prd-admin | P3 删调度预测 UI：移除 PoolPredictionDialog + predictNextDispatch service + 池编辑表单策略选择器，对齐"只有 FailFast" |
| feat | prd-api | 新增只读端点 GET /api/mds/model-groups/health-overview：聚合各池健康(healthy/degraded/unavailable)+ 近 N 天按 modelType 的 fallback 率 + 死池/高fallback 一级告警，全只读不碰 serving/DB |
| feat | prd-admin | 模型池管理页顶部新增"健康总览"告警卡(PoolHealthOverview)：死池/高fallback 红色一级告警可点击定位 + 近7天 fallback 率迷你列表，把静默降级一眼暴露 |
| feat | prd-api | P3 删 legacy 前置(生产配置,行为保持):chat 默认池补 deepseek-v4-pro 池内兜底(取代 step7 legacy 容灾)、解绑 ccas 死 auto 专属池使其落到 generation 默认池;实测全 153 code 零 actualModel 变化、零 code 仍走 Legacy |
| refactor | prd-api | P3 删 legacy 解析层：ModelResolver 删第四步 legacy 解析 + 第七步 legacy 兜底 + FindLegacyModelAsync，池全不可用改返回 NotFound(容灾已下沉到池内兜底)；保留 IsMain/IsVision/IsIntent/IsImageGen 字段及其它消费方(P4 再清)。前置已证 153 code 零走 legacy，删码为行为 no-op |
| refactor | prd-admin | 应用模型池管理页类型筛选 chip 同步"配置才出现"：ModelTypeFilterBar 传入应用实际用到的 modelType(来自 modelRequirements)，不再预铺 14 个空类目 |
