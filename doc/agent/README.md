# agent/ — 智能体域

各 Agent 的产品规格、技术设计、实施计划，以及 Agent 开发通用规范。

## 按 Agent 分组

### 缺陷管理 Agent (`defect-agent`)
- `design.defect-agent.md` — 功能设计
- `spec.defect-agent.md` — 产品方案
- `design.defect-image-analysis.md` — 缺陷图片分析

### 周报管理 Agent (`report-agent`)
- `spec.report-agent.md` — 产品需求
- `plan.report-agent-impl.md` — 实施计划 (Phase 1-3)

### 文学创作 Agent (`literary-agent`)
- `design.literary-agent.md` — 文章配图功能设计

### 视觉创作 Agent (`visual-agent`)
- `design.multi-image-compose.md` — 多图组合
- `design.multi-image-vision-api.md` — 多图 VLM API
- `design.image-ref-and-persistence.md` — 参考图与消息持久化
- `design.inline-image-chat.md` — 行内图片对话
- `plan.multi-image-ai-interaction.md` — 多图 AI 交互计划
- `plan.merge-image-ref-resolver.md` — 参考图解析合并计划

### AI Arena
- `design.ai-arena.md` — 模型竞技场设计

## 通用
- `rule.agent-development.md` — Agent 开发流程规范
- `design.reusable-patterns.md` — 可复用组件（软删除、回收站等）
