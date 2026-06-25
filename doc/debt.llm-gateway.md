# LLM 网关与模型池 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-24 | **状态**：维护中
> **关联设计**：`design.llm-gateway-unification.md`（统一方案）、`design.llm-gateway.md`、`design.model-pool.md`

## 总览

当前 open: 11 / paid: 0 / 总计: 11

本台账记录"LLM 网关与模型池统一"迁移过程中已识别、但尚未在代码中偿还的边界与风险。详细方案见 `design.llm-gateway-unification.md`。

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-24-protocol-on-platform | high | 2026-06-24 | 接口模式（adapter/transformer 选择）绑在平台 `PlatformType`，模型无法覆盖；图片另起 5 分支按 apiUrl 猜 | 任何"同平台多协议"或"某模型换格式"需求 | open | 解法=Protocol 下沉到模型，提升 Transformer 为统一协议层（设计 §决策一） |
| 2026-06-24-dead-strategy-engines | medium | 2026-06-24 | 6 个策略引擎 + ModelPoolDispatcher 不在服务链路，唯一调用是管理预览；纯死复杂度 | 可删（已取证：main 17 池 100% FailFast，2026-06-25） | open | 取证已过，删除排在 P3 黄金快照建立之后 |
| 2026-06-24-legacy-flag-tier | medium | 2026-06-24 | 调度第 3 层 legacy 标记（IsMain/IsIntent/IsVision/IsImageGen）与默认池功能重叠 | 迁标记进默认池后 | open | 散落 ~15 文件，删除需全栈审计（enum-ripple-audit） |
| 2026-06-24-appcaller-sync-no-delete | low | 2026-06-24 | AppCallerRegistrySyncService 只增不删，156 条 code 越积越多 | code 降级为标签时 | open | 改对账式 + DeletedAt 软删 + 面板一键清 |
| 2026-06-24-key-descend-rotation | high | 2026-06-24 | Protocol 下沉后更多 ApiKeyEncrypted 落到模型级，密钥轮换需先解密重加密所有字段 | 任何密钥轮换 | open | 受 cross-project-isolation.md 规则 #2 约束，迁移时不放大存量债 |
| 2026-06-24-openrouter-single-point | medium | 2026-06-24 | 默认走 OpenRouter 享受统一，但 OR 故障/限流/消费上限会全系统瘫（不止宕机，throttle 也是 SPOF） | OR 不可用或被限流时 | open | 必须保留一条直连兜底，这是池不能删干净、只能缩短的原因 |
| 2026-06-24-protocol-drift-3-places | high | 2026-06-24 | "协议绑平台"散在 3 处各写一遍：LlmGateway + ModelLabController + ArenaRunWorker 各自按 platformType 建 Claude/OpenAI 客户端，OpenAIImageClient 另有 anthropic 禁 /images 守卫 | 只改网关时 | open | 统一必须一起收口，否则修一漏三；回归测试 `ProtocolBinding_*_AllRouteThroughRegistry` |
| 2026-06-24-startup-legacy-consumer | high | 2026-06-24 | 删 legacy 标记会动到启动期：Program.cs:945 读 IsMain 建 claude 客户端，InfraAgentRuntimeProfileService 读 IsMain 兜底 | 删 IsMain 字段时 | open | 没迁好系统起不来（非功能坏，是 bootstrap 坏）；测试 `Startup_WithoutLegacyFlags_*` |
| 2026-06-24-stats-continuity | medium | 2026-06-24 | appCallerCode 还是计费/统计维度，StatsController 靠 `chat.*` 前缀摘非 chat token；降级若改名/合并会错乱历史分段 | code 降级时 | open | 降级=绑定变可选，绝不改 code 字符串；测试 `Stats_AfterCodeDowngrade_SegmentationUnchanged` |
| 2026-06-24-image-size-cap-orphan | low | 2026-06-24 | image_gen_size_caps 按 modelId/platformId 做键缓存上游允许尺寸；协议/模型身份变更后缓存键孤儿，首发请求重吃 400 再学 | P2 图片并网关迁移时 | open | 迁移期图片短暂报错；测试 `ImageSizeCap_OnUpstream400_RelearnsWithoutUserError` |
| 2026-06-24-exchange-sentinel-dual | low | 2026-06-24 | 池 item 的 PlatformId 有 `__exchange__` 旧 sentinel 与真 exchange id 两种格式，迁移需双格式兼容 | Exchange 路由归一进协议层时 | open | 测试 `Exchange_BothSentinelAndRealId_Resolve` |

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
