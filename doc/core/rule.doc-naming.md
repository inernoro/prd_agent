# 文档命名规则（doc/）

## 目录结构（DDD 限界上下文）

```
doc/
├── core/     # 核心平台 — SRS、PRD、LLM Gateway、模型池、通用规则
├── agent/    # 智能体 — 各 Agent 的 spec/design/plan + agent 开发规范
├── engine/   # 引擎层 — 工作流、百宝箱、市场、通道、开放平台、技能
├── client/   # 客户端 — 管理后台 UI、桌面端、移动端、部署
└── ops/      # 运维归档 — 周报、审计、备忘
```

## 文件命名格式

```
{context}/{type}.{topic}.md
```

### 类型前缀

| 前缀 | 含义 | 示例 |
|------|------|------|
| `spec.` | 产品规格（PRD、SRS、Agent 需求） | `core/spec.srs.md` |
| `design.` | 技术设计（架构、方案） | `core/design.server-authority.md` |
| `plan.` | 实施计划（开发计划、迁移计划） | `agent/plan.report-agent-impl.md` |
| `rule.` | 规范约定（命名、测试、开发流程） | `core/rule.app-identity.md` |
| `ref.` | 参考资料（指南、教程、快速开始） | `core/ref.quickstart.md` |

### ops/ 特殊前缀

| 前缀 | 含义 | 示例 |
|------|------|------|
| `report.` | 周报 | `ops/report.2026-W09.md` |
| `audit.` | 审计报告 | `ops/audit.prd-desktop-codebase.md` |
| `memo.` | 备忘录 | `ops/memo.multi-image-compose-test.md` |

## 规则

1. **topic 使用 `kebab-case`**
2. **一个文件只归属一个上下文**，按主要领域归类
3. **新增 Agent** 至少需要 `agent/spec.{name}.md`（需求）+ `agent/design.{name}.md`（设计）
4. **禁止在 doc/ 根目录放文件**，必须放入对应上下文文件夹
