# Design 文档优化项目进度 · 计划

> **分支**：`claude/simplify-design-doc-cer4E`
> **最后更新**：2026-03-28

## 已确立的原则

1. **故事靠前，设计靠后** — 章节顺序：管理摘要→产品定位→用户场景→核心能力→架构→数据→接口→关联→风险
2. **永远替换，不留历史** — 设计文档不需要版本迭代说明，每次更新直接覆盖，追踪由 changelogs/ 和 Git 承担
3. **按应用归属，不重叠** — 一个应用一个 design 主文档，子功能独立文档从主文档引用
4. **受众分层** — 前四节面向所有人（禁代码），技术章节面向开发者（代码≤30%）
5. **管理摘要必填** — 30 秒让非技术读者看懂方案全貌

以上原则已固化到 `.claude/rules/doc-types.md` 和 `.claude/skills/doc-writer/reference/writing-principles.md`。

## 已完成

### 模板/规则层
- [x] design 模板重构（受众分层+代码纪律）→ `doc-writer` skill + `doc-types` rule + `rule.doc-templates.md`
- [x] 三条新原则（故事靠前/永远替换/按应用归属）写入 `doc-types.md`

### P0 — 37 篇现有文档批量优化
- [x] 30 篇补管理摘要
- [x] 21 篇统一头部格式
- [x] 8 篇修正过时状态
- [x] 6 篇标注废弃概念
- [x] 2 篇子类型标注（ai-report-systems、remotion-gap）
- [x] 删除 design.im-architecture.md（已废弃）
- [x] 合并 design.literary-agent-v2.md → literary-agent.md

### P1 — 核心模块新文档
- [x] `design.system-emergence.md` — 涌现篇（系统灵魂说明书）
- [x] `design.visual-agent.md` — Visual Agent 统一主文档
- [x] `design.report-agent.md` — Report Agent 架构设计
- [x] `design.literary-agent.md` — Literary Agent 重写

### P2 — 基础设施 + 深化
- [x] `design.rbac-permission.md` — 权限系统设计
- [x] `design.llm-gateway.md` — LLM Gateway 架构
- [x] `design.marketplace.md` — 配置市场设计
- [x] `design.workflow-engine.md` — 深化（+管理摘要 +4 场景）
- [x] `design.defect-agent.md` — 深化（+4 涌现场景）

## P3 — 待做

| 优先级 | 任务 | 说明 |
|--------|------|------|
| P3-1 | Video Agent 独立主文档 | 目前只有 scene-codegen 子文档，缺统一架构 |
| P3-2 | 桌面客户端架构文档 | Tauri 2.0 + Rust + React，当前只有部署和网络诊断 |
| P3-3 | 附件/上传系统文档 | 基础模块完全无文档 |
| P3-4 | Open Platform 深化 | 补场景和 OpenAI 兼容协议细节 |
| P3-5 | 代码密度 >30% 的旧文档优化 | 17 篇，后续修改时自然对齐即可 |
| P3-6 | 11 篇子功能文档添加"从主文档引用"标注 | 按去重分析结果 |

## 关键参考文件

| 文件 | 用途 |
|------|------|
| `.claude/rules/doc-types.md` | design.* 的所有规则（模板触发时自动加载） |
| `.claude/skills/doc-writer/reference/templates.md` | 完整模板定义 |
| `.claude/skills/doc-writer/reference/writing-principles.md` | 写作原则 |
| `doc/rule.doc-templates.md` | 文档模板标准（v3.0） |
| `doc/design.system-emergence.md` | 系统全貌（涌现篇） |
| `.claude/rules/codebase-snapshot.md` | 代码库快照（模块清单） |

## 下次继续的方法

1. 切换到分支 `claude/simplify-design-doc-cer4E`
2. 读取本文件了解进度
3. 从 P3 待做列表中按优先级继续
