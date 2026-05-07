| fix | cds | routes/cds-system-connections.ts accept 端字段映射 bug：MAP 端发 mapId/mapName/mapBaseUrl，但 routes 之前读 partnerXxx，导致配对永远失败报 partner_info_missing。修后兼容两种命名（mapXxx 优先），13 个 pairing 单测继续全绿
| docs | doc | 新增 doc/guide.infra-sandbox-agent.md 主篇（基础设施建设 - 沙箱 Agent SSOT），含设计思路 / 历程决策表 / 架构图 / 组件位置 / 操作步骤 / 预计结果 / 测试方法 / 链路追踪 / 已知问题 / 后续路线 / 关联文档 / 历史背景
| docs | doc | 删除已被主篇消化的 3 个冗余文档：plan.cds-shared-service-extension.md（决策已并入主篇 §1.3+§2）/ plan.sidecar-server-management.md（备用方案历史已并入 §2）/ report.cds-shared-service-mvp-runthrough.md（沙箱实测已并入 §7.2）
