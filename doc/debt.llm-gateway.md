# LLM 网关与模型池 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-24 | **状态**：维护中
> **关联设计**：`design.llm-gateway-unification.md`（统一方案）、`design.llm-gateway.md`、`design.model-pool.md`

## 总览

当前 open: 6 / paid: 0 / 总计: 6

本台账记录"LLM 网关与模型池统一"迁移过程中已识别、但尚未在代码中偿还的边界与风险。详细方案见 `design.llm-gateway-unification.md`。

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-06-24-protocol-on-platform | high | 2026-06-24 | 接口模式（adapter/transformer 选择）绑在平台 `PlatformType`，模型无法覆盖；图片另起 5 分支按 apiUrl 猜 | 任何"同平台多协议"或"某模型换格式"需求 | open | 解法=Protocol 下沉到模型，提升 Transformer 为统一协议层（设计 §决策一） |
| 2026-06-24-dead-strategy-engines | medium | 2026-06-24 | 6 个策略引擎 + ModelPoolDispatcher 不在服务链路，唯一调用是管理预览；纯死复杂度 | P0 取证确认库里 StrategyType 全为 FailFast 后 | open | 删前必须跑 `scripts/llm-gateway-phase0-forensics.mongo.js` 第 1 段 |
| 2026-06-24-legacy-flag-tier | medium | 2026-06-24 | 调度第 3 层 legacy 标记（IsMain/IsIntent/IsVision/IsImageGen）与默认池功能重叠 | 迁标记进默认池后 | open | 散落 ~15 文件，删除需全栈审计（enum-ripple-audit） |
| 2026-06-24-appcaller-sync-no-delete | low | 2026-06-24 | AppCallerRegistrySyncService 只增不删，156 条 code 越积越多 | code 降级为标签时 | open | 改对账式 + DeletedAt 软删 + 面板一键清 |
| 2026-06-24-key-descend-rotation | high | 2026-06-24 | Protocol 下沉后更多 ApiKeyEncrypted 落到模型级，密钥轮换需先解密重加密所有字段 | 任何密钥轮换 | open | 受 cross-project-isolation.md 规则 #2 约束，迁移时不放大存量债 |
| 2026-06-24-openrouter-single-point | medium | 2026-06-24 | 默认走 OpenRouter 享受统一，但 OR 故障会全系统瘫 | OR 不可用时 | open | 必须保留一条直连兜底，这是池不能删干净、只能缩短的原因 |

## 已还的债务（归档）

> 修复后从上面表格挪到这里，保留以便复盘

| ID | 修复 PR | 修复日期 | 备注 |
|----|---------|---------|------|
