# MAP 平台文档

> 最后更新：{{today}}

## 命名规则（Manus 必读）

本项目所有 `doc/` 下文档**强制使用** `{prefix}.{name}.md` 命名格式，禁止下划线、禁止发明新前缀。

| 前缀 | 对应 | 示例 |
|------|------|------|
| `guide.*` | 操作指南 | `guide.yuque-directory.md` |
| `design.*` | 技术设计 | `design.model-pool.md` |
| `rule.*` | 规范约定 | `rule.doc-naming.md` |
| `spec.*` | 产品规格 | `spec.prd.md` |
| `plan.*` | 实施计划 | `plan.web-hosting.md` |
| `report.*` | 周报 | `report.2026-W10.md` |

- 语雀侧文档标题 = `index.yml` 中的中文标题
- 语雀侧文档唯一标识 = 文件名（不含 `.md`）
- **Manus 不得自行命名文件**，所有文件名由本仓库 AI（Claude/Cursor）生成并写入 `index.yml`

## 变更历史

| 日期 | 操作 | 文件名 | 中文标题 |
| :--- | :--- | :--- | :--- |
| 2026-03-10 | 🟢 新增 | `index.yml` | 文档元数据索引 |
| 2026-03-10 | 🟢 新增 | `guide.yuque-directory.md` | 语雀文档目录页 |

---

## 文档列表

### 一、指南

- [PRD Agent 快速部署指南](guide.quickstart) `guide.quickstart`
  > 从零开始部署 PRD Agent 的完整步骤

- [PRD Agent 开发文档](guide.development-guide) `guide.development-guide`
  > 开发环境搭建、构建命令、调试技巧

- [Claude Code 云开发教程](guide.cloud-dev-tutorial) `guide.cloud-dev-tutorial`
  > 使用 Claude Code 进行云端协作开发的操作指南

- [初始化策略实现总结](guide.init-strategy) `guide.init-strategy`
  > 系统初始化与启动策略的实现说明

- [AI 百宝箱运维指南](guide.ai-toolbox-ops) `guide.ai-toolbox-ops`
  > AI 百宝箱功能的运维操作手册

- [多图组合功能测试备忘录](guide.multi-image-compose-test) `guide.multi-image-compose-test`
  > 多图组合生成功能的测试用例与验证记录

- [语雀文档目录页](guide.yuque-directory) `guide.yuque-directory`
  > 语雀同步的目录页内容，包含变更历史与全量文档列表

### 二、设计文档

- [账户数据共享设计文档](design.account-data-sharing) `design.account-data-sharing`
  > 账户数据跨应用共享的技术方案

- [PRD Admin 设计系统规范](design.admin) `design.admin`
  > 管理后台的设计系统、组件规范与视觉标准

- [Agent Dashboard 设计文档](design.agent-dashboard) `design.agent-dashboard`
  > Agent 运行状态监控面板的设计方案

- [AI 竞技场设计方案](design.ai-arena) `design.ai-arena`
  > 多模型对抗评测的竞技场功能设计

- [AI 百宝箱设计方案](design.ai-toolbox) `design.ai-toolbox`
  > AI 工具集合的整体架构与功能设计

- [Branch Tester (bt) 设计文档](design.cds) `design.cds`
  > 分支测试工具的架构设计

- [多通道适配器设计](design.channel-adapter) `design.channel-adapter`
  > 多消息通道接入的适配器架构设计

- [缺陷管理 Agent 功能设计](design.defect-agent) `design.defect-agent`
  > 缺陷提交、跟踪与升级流程的功能设计

- [缺陷截图 VLM 预解析设计文档](design.defect-image-analysis) `design.defect-image-analysis`
  > 使用视觉语言模型自动解析缺陷截图的设计

- [exec_bt.sh 部署架构与冲突分析](design.exec-bt-deployment) `design.exec-bt-deployment`
  > 部署脚本的架构设计与冲突处理策略

- [总裁面板与周报 Agent 设计文档](design.executive-dashboard) `design.executive-dashboard`
  > 高管视角的数据面板与周报 Agent 的设计

- [PRD Agent IM 架构重设计方案](design.im-architecture) `design.im-architecture`
  > 即时消息架构的重构方案

- [图片引用日志与消息持久化架构设计](design.image-ref-and-persistence) `design.image-ref-and-persistence`
  > 图片引用追踪与消息服务器权威持久化的架构

- [内联图片聊天分析功能改进设计](design.inline-image-chat) `design.inline-image-chat`
  > 聊天中内联图片分析能力的改进方案

- [左右布局重新设计总结](design.left-right-layout) `design.left-right-layout`
  > 页面左右分栏布局的重构总结

- [文学创作 Agent 文章配图功能设计](design.literary-agent) `design.literary-agent`
  > 文学创作场景下文章自动配图的功能设计

- [大模型池设计（三级调度/三级链路）](design.model-pool) `design.model-pool`
  > 模型池策略引擎的三级调度与链路设计

- [多文档上下文与引用系统重设计](design.multi-doc-and-citations) `design.multi-doc-and-citations`
  > 多文档引用与上下文管理的重构方案

- [多文档知识库与文档类型系统设计文档](design.multi-doc-knowledge) `design.multi-doc-knowledge`
  > 知识库多文档管理与文档类型系统的设计

- [多图组合生成设计](design.multi-image-compose) `design.multi-image-compose`
  > 多张图片组合生成的技术方案

- [多图生成设计文档（Vision API 方案）](design.multi-image-vision-api) `design.multi-image-vision-api`
  > 基于 Vision API 的多图生成技术方案

- [网络诊断功能](design.network-diagnostics) `design.network-diagnostics`
  > 客户端网络连通性诊断功能的设计

- [开放平台功能概要](design.open-platform) `design.open-platform`
  > 开放平台 API 接入的整体功能概要

- [桌面端更新与分布式登录/会话审计说明](design.ops-auth) `design.ops-auth`
  > 桌面端自动更新机制与分布式会话管理

- [Remotion 视频质量差距分析报告](design.remotion-gap) `design.remotion-gap`
  > Remotion 视频生成质量问题的分析与改进方案

- [可复用组件产品方案](design.reusable-patterns) `design.reusable-patterns`
  > 跨模块可复用 UI 组件与模式的产品方案

- [服务器权威性设计](design.server-authority) `design.server-authority`
  > 客户端断开不取消服务器任务的架构设计

- [Toast 通知系统实现](design.toast) `design.toast`
  > 全局 Toast 通知组件的实现方案

- [视频场景代码生成架构设计](design.video-scene-codegen) `design.video-scene-codegen`
  > LLM 驱动的 Remotion 视频场景代码生成架构

- [网页托管与分享设计文档](design.web-hosting) `design.web-hosting`
  > COS 静态站点托管与分享链接的设计方案

- [工作流引擎 v2 流程控制舱与 SSE 实时推送设计](design.workflow-control-flow-sse) `design.workflow-control-flow-sse`
  > 工作流引擎 v2 的控制流与 SSE 实时推送

- [工作流引擎设计方案](design.workflow-engine) `design.workflow-engine`
  > 可视化工作流引擎的整体架构设计

### 三、规范与规则

- [Agent 开发交付流程规范](rule.agent-development) `rule.agent-development`
  > Agent 类功能从设计到交付的标准流程

- [Agent 权限分类规则](rule.agent-permissions) `rule.agent-permissions`
  > Agent 权限的分类体系与注册规范

- [应用身份定义规则](rule.app-identity) `rule.app-identity`
  > appKey、Feature、appCallerCode 的命名与使用规范

- [PRD Agent 全面代码审计报告](rule.audit-prd-desktop-codebase) `rule.audit-prd-desktop-codebase`
  > 桌面端代码库的全面审计报告与改进建议

- [数据字典](rule.data-dictionary) `rule.data-dictionary`
  > 数据库集合、缓存 Key 与持久化结构的完整清单

- [默认可编辑原则](rule.default-editable) `rule.default-editable`
  > 表单字段默认可编辑的设计原则与例外条件

- [文档维护说明](rule.doc-maintenance) `rule.doc-maintenance`
  > 文档过时治理与持续维护的操作规范

- [文档命名规则](rule.doc-naming) `rule.doc-naming`
  > doc/ 目录下文档的命名约定

- [文档模板标准](rule.doc-templates) `rule.doc-templates`
  > 六种文档类型的标准模板与写作规范

- [前端组件复用规则](rule.frontend-component-reuse) `rule.frontend-component-reuse`
  > 跨页面共享组件的提取与复用规范

- [技能系统规则与创建指南](rule.skill-system) `rule.skill-system`
  > Claude Code Skill 的创建、注册与管理规范

- [测试组织规范](rule.test-organization) `rule.test-organization`
  > 单元测试与集成测试的组织与命名规范

### 四、产品规格

- [应用注册中心协议规范](spec.app-registry) `spec.app-registry`
  > 应用注册、路由分发的协议规范

- [缺陷管理 Agent 产品方案](spec.defect-agent) `spec.defect-agent`
  > 缺陷管理 Agent 的产品需求与用户故事

- [海鲜市场（Configuration Marketplace）](spec.marketplace) `spec.marketplace`
  > 配置市场的产品规格与 Fork 机制

- [PRD Agent 产品需求文档](spec.prd) `spec.prd`
  > PRD Agent 核心产品的需求文档

- [项目愿景与背景](spec.project-vision) `spec.project-vision`
  > 项目立项的背景分析与愿景目标

- [周报 Agent 产品需求文档](spec.report-agent) `spec.report-agent`
  > 周报 Agent v1.0 的产品需求文档

- [周报 Agent Phase 5 用户故事](spec.report-agent-phase5) `spec.report-agent-phase5`
  > 周报 Agent 第五阶段的用户故事

- [周报 Agent v2.0 产品需求文档](spec.report-agent.v2) `spec.report-agent.v2`
  > 周报 Agent v2.0 的产品需求文档

- [PRD 理解与交互智能体软件需求规格说明书](spec.srs) `spec.srs`
  > 系统软件需求规格说明书（SRS）

### 五、计划与方案

- [AI 文本辅助通用 Domain 设计](plan.ai-text-assist) `plan.ai-text-assist`
  > AI 文本辅助功能的通用领域模型设计

- [AI 百宝箱 MVP 规划](plan.ai-toolbox-mvp) `plan.ai-toolbox-mvp`
  > AI 百宝箱最小可行产品的功能规划

- [AI 百宝箱未完成项与下一步规划](plan.ai-toolbox-next-steps) `plan.ai-toolbox-next-steps`
  > AI 百宝箱后续迭代的待办事项与方向

- [动画优化计划](plan.animation-optimization) `plan.animation-optimization`
  > 基于 ReactBits 组件库的动画优化实施计划

- [Desktop 资产功能方案](plan.desktop-asset-features) `plan.desktop-asset-features`
  > 桌面端资产管理功能的规划方案

- [文档长周期更新计划](plan.doc-update) `plan.doc-update`
  > 文档体系的长期维护与更新计划

- [合并计划书：三入口守门员统一](plan.merge-image-ref-resolver) `plan.merge-image-ref-resolver`
  > 图片引用解析三入口的统一合并方案

- [移动端适配功能规划](plan.mobile-adaptation) `plan.mobile-adaptation`
  > 移动端响应式适配的功能规划

- [移动端布局分析报告](plan.mobile-layout-review) `plan.mobile-layout-review`
  > 移动端布局问题的分析与产品审阅意见

- [PRD Agent 多文档系统设计方案](plan.multi-document) `plan.multi-document`
  > 多文档系统的整体设计与实施方案

- [多图 AI 交互方案](plan.multi-image-ai-interaction) `plan.multi-image-ai-interaction`
  > 多图场景下 AI 交互的实施方案

- [周报 Agent 实施进度追踪](plan.report-agent-impl) `plan.report-agent-impl`
  > 周报 Agent 各阶段的实施进度与状态

- [Claude Code Skill 安装计划](plan.skill-installation) `plan.skill-installation`
  > Claude Code Skill 的安装与配置计划

- [统一缺陷管理平台实施计划](plan.unified-defect-management) `plan.unified-defect-management`
  > 统一缺陷管理平台的分阶段实施计划

- [视频 TTS 语音接入与场景视觉升级实施方案](plan.video-tts-and-scene-upgrade) `plan.video-tts-and-scene-upgrade`
  > 视频生成 TTS 语音与场景视觉效果的升级方案

- [视觉创作视频生成每日限额实施方案](plan.visual-agent-video-gen-daily-limit) `plan.visual-agent-video-gen-daily-limit`
  > 视觉创作视频生成功能的每日限额实施

- [网页托管与分享实现计划](plan.web-hosting) `plan.web-hosting`
  > 网页托管功能的分阶段实现计划

### 六、周报

- [周报 2026-W06 (02-03 ~ 02-08)](report.2026-W06) `report.2026-W06`
  > 2026 年第 6 周工作总结

- [周报 2026-W07 (02-09 ~ 02-15)](report.2026-W07) `report.2026-W07`
  > 2026 年第 7 周工作总结

- [周报 2026-W09 (02-23 ~ 03-01)](report.2026-W09) `report.2026-W09`
  > 2026 年第 9 周工作总结

- [周报 2026-W10 (02-03 ~ 03-08)](report.2026-W10) `report.2026-W10`
  > 2026 年第 10 周工作总结
