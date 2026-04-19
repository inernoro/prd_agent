# MAP 平台文档索引 · 指南

> 最后更新：2026-03-31
>
> 本文件是 `doc/` 目录的结构化索引，供外部同步工具（语雀、Confluence 等）消费。
> 元数据定义见 `doc/index.yml`，命名规范见 `doc/rule.doc-naming.md`。
>
> **排序原则**：先理解产品 → 再了解架构 → 然后动手操作 → 参考规范 → 未来计划 → 历史记录

## 使用方式

| 角色 | 怎么用 |
|------|--------|
| AI（Claude/Cursor） | PR 前运行 `doc-sync` 技能，自动对齐 `index.yml` 和本文件 |
| 外部同步工具 | `git pull` → 读取 `index.yml`（文件名↔标题映射）+ 本文件（目录结构）→ 调用目标平台 API |
| 开发者 | 直接浏览本文件了解 doc/ 全貌 |

---

## 文档列表

### 一、产品规格

- [项目愿景与背景](spec.project-vision) `spec.project-vision`
  > 项目立项的背景分析与愿景目标

- [PRD Agent 产品需求文档](spec.prd) `spec.prd`
  > PRD Agent 核心产品的需求文档

- [PRD 理解与交互智能体软件需求规格说明书](spec.srs) `spec.srs`
  > 系统软件需求规格说明书（SRS）

- [应用注册中心协议规范](spec.app-registry) `spec.app-registry`
  > 应用注册、路由分发的协议规范

- [海鲜市场（Configuration Marketplace）](spec.marketplace) `spec.marketplace`
  > 配置市场的产品规格与 Fork 机制

- [缺陷管理 Agent 产品方案](spec.defect-agent) `spec.defect-agent`
  > 缺陷管理 Agent 的产品需求与用户故事

- [周报 Agent 产品需求文档](spec.report-agent) `spec.report-agent`
  > 周报 Agent v1.0 的产品需求文档

- [周报 Agent v2.0 产品需求文档](spec.report-agent.v2) `spec.report-agent.v2`
  > 周报 Agent v2.0 的产品需求文档

- [周报 Agent Phase 5 用户故事](spec.report-agent-phase5) `spec.report-agent-phase5`
  > 周报 Agent 第五阶段的用户故事

- [CDS (Cloud Development Suite) 功能需求说明书](spec.cds) `spec.cds`
  > CDS 云开发套件的功能需求与用户故事

- [作品投稿与画廊展示规格](spec.submission-gallery) `spec.submission-gallery`
  > 作品投稿、画廊瀑布流展示与社交互动的产品规格

### 二、设计文档

- [服务器权威性设计](design.server-authority) `design.server-authority`
  > 客户端断开不取消服务器任务的架构设计

- [LLM Gateway 统一调用架构设计](design.llm-gateway) `design.llm-gateway`
  > 所有 LLM 调用通过统一网关，三级调度 + 健康管理

- [大模型池设计（三级调度/三级链路）](design.model-pool) `design.model-pool`
  > 模型池策略引擎的三级调度与链路设计

- [开放平台功能概要](design.open-platform) `design.open-platform`
  > 开放平台 API 接入的整体功能概要

- [工作流引擎设计方案](design.workflow-engine) `design.workflow-engine`
  > 可视化工作流引擎的整体架构设计

- [工作流引擎 v2 流程控制舱与 SSE 实时推送设计](design.workflow-control-flow-sse) `design.workflow-control-flow-sse`
  > 工作流引擎 v2 的控制流与 SSE 实时推送

- [PRD Admin 设计系统规范](design.admin) `design.admin`
  > 管理后台的设计系统、组件规范与视觉标准

- [账户数据共享设计文档](design.account-data-sharing) `design.account-data-sharing`
  > 账户数据跨应用共享的技术方案

- [桌面端更新与分布式登录/会话审计说明](design.ops-auth) `design.ops-auth`
  > 桌面端自动更新机制与分布式会话管理

- [多通道适配器设计](design.channel-adapter) `design.channel-adapter`
  > 多消息通道接入的适配器架构设计

- [苹果快捷指令集成设计方案](design.apple-shortcuts) `design.apple-shortcuts`
  > Apple Shortcuts 与 MAP 系统集成的架构设计

- [总裁面板与周报 Agent 设计文档](design.executive-dashboard) `design.executive-dashboard`
  > 高管视角的数据面板与周报 Agent 的设计

- [缺陷管理 Agent 功能设计](design.defect-agent) `design.defect-agent`
  > 缺陷提交、跟踪与升级流程的功能设计

- [缺陷截图 VLM 预解析设计文档](design.defect-image-analysis) `design.defect-image-analysis`
  > 使用视觉语言模型自动解析缺陷截图的设计

- [文学创作 Agent 文章配图功能设计](design.literary-agent) `design.literary-agent`
  > 文学创作场景下文章自动配图的功能设计

- [产品评审员技术设计文档](design.review-agent) `design.review-agent`
  > ReviewAgent 的完整技术设计：状态机、LLM 集成、SSE 协议、权限模型、解析策略

- [多文档知识库与文档类型系统设计文档](design.multi-doc-knowledge) `design.multi-doc-knowledge`
  > 知识库多文档管理与文档类型系统的设计

- [多文档上下文与引用系统重设计](design.multi-doc-and-citations) `design.multi-doc-and-citations`
  > 多文档引用与上下文管理的重构方案

- [多图组合生成设计](design.multi-image-compose) `design.multi-image-compose`
  > 多张图片组合生成的技术方案

- [多图生成设计文档（Vision API 方案）](design.multi-image-vision-api) `design.multi-image-vision-api`
  > 基于 Vision API 的多图生成技术方案

- [内联图片聊天分析功能改进设计](design.inline-image-chat) `design.inline-image-chat`
  > 聊天中内联图片分析能力的改进方案

- [图片引用日志与消息持久化架构设计](design.image-ref-and-persistence) `design.image-ref-and-persistence`
  > 图片引用追踪与消息服务器权威持久化的架构

- [视频场景代码生成架构设计](design.video-scene-codegen) `design.video-scene-codegen`
  > LLM 驱动的 Remotion 视频场景代码生成架构

- [Remotion 视频质量差距分析报告](design.remotion-gap) `design.remotion-gap`
  > Remotion 视频生成质量问题的分析与改进方案

- [网页托管与分享设计文档](design.web-hosting) `design.web-hosting`
  > COS 静态站点托管与分享链接的设计方案

- [AI 竞技场设计方案](design.ai-arena) `design.ai-arena`
  > 多模型对抗评测的竞技场功能设计

- [AI 百宝箱设计方案](design.ai-toolbox) `design.ai-toolbox`
  > AI 工具集合的整体架构与功能设计

- [可复用组件产品方案](design.reusable-patterns) `design.reusable-patterns`
  > 跨模块可复用 UI 组件与模式的产品方案

- [左右布局重新设计总结](design.left-right-layout) `design.left-right-layout`
  > 页面左右分栏布局的重构总结

- [Toast 通知系统实现](design.toast) `design.toast`
  > 全局 Toast 通知组件的实现方案

- [网络诊断功能](design.network-diagnostics) `design.network-diagnostics`
  > 客户端网络连通性诊断功能的设计

- [CDS (Cloud Development Suite) 设计文档](design.cds) `design.cds`
  > 云开发套件的架构设计

- [CDS 极简上手设计](design.cds-onboarding) `design.cds-onboarding`
  > CDS 一键配置与项目扫描技能的上手设计

- [AI 周报系统市场调研报告](design.ai-report-systems) `design.ai-report-systems`
  > AI 周报领域 20+ 竞品分析与战略方向研究

- [CDS 部署架构与冲突分析](design.exec-bt-deployment) `design.exec-bt-deployment`
  > 部署脚本的架构设计与冲突处理策略

- [模型池故障转移与自动探活设计](design.model-pool-failover) `design.model-pool-failover`
  > 模型池健康检查与故障自动恢复的设计方案

- [生成快照设计](design.generation-snapshot) `design.generation-snapshot`
  > 投稿 GenerationSnapshot 完整输入配方的持久化设计

- [配置市场（海鲜市场）技术设计](design.marketplace) `design.marketplace`
  > CONFIG_TYPE_REGISTRY + IForkable 白名单复制的市场架构

- [RBAC 权限系统设计](design.rbac-permission) `design.rbac-permission`
  > SystemRole + AdminPermissionCatalog 60+ 权限的 RBAC 体系

- [周报管理 Agent 架构设计](design.report-agent) `design.report-agent`
  > 周报 Agent 的完整架构：团队管理、AI 生成、数据源采集

- [产品评审员技术设计文档](design.review-agent) `design.review-agent`
  > ReviewAgent 的完整技术设计：状态机、LLM 集成、SSE 协议

- [系统涌现：从基础组件到协同智能](design.system-emergence) `design.system-emergence`
  > MAP 平台从基础能力到协同智能的涌现机制说明

- [Visual Agent (视觉创作) 架构设计](design.visual-agent) `design.visual-agent`
  > 视觉创作 Agent 的三栏工作区架构与生图流水线设计

### 三、指南

- [文档索引目录页](guide.list.directory) `guide.list.directory`
  > doc/ 目录的结构化索引，供外部同步工具消费

- [PRD Agent 快速部署指南](guide.quickstart) `guide.quickstart`
  > 从零开始部署 PRD Agent 的完整步骤

- [PRD Agent 开发文档](guide.development-guide) `guide.development-guide`
  > 开发环境搭建、构建命令、调试技巧

- [Claude Code 云开发教程](guide.cloud-dev-tutorial) `guide.cloud-dev-tutorial`
  > 使用 Claude Code 进行云端协作开发的操作指南

- [初始化策略实现总结](guide.init-strategy) `guide.init-strategy`
  > 系统初始化与启动策略的实现说明

- [PRD Agent 使用教程](guide.prd-agent) `guide.prd-agent`
  > PRD 对话与群组管理的完整操作流程

- [PRD Agent 全平台操作手册](guide.prd-agent-operations) `guide.prd-agent-operations`
  > PRD Agent 全平台（Web + Desktop）操作手册

- [视觉创作 Agent 使用教程](guide.visual-agent) `guide.visual-agent`
  > 三栏式工作区的图像生成与编辑教程

- [文学创作 Agent 使用教程](guide.literary-agent) `guide.literary-agent`
  > 文章配图、风格选择与批量生成的操作指南

- [缺陷管理 Agent 使用教程](guide.defect-agent) `guide.defect-agent`
  > 缺陷提交、四种视图、AI 分析与分享协作

- [产品评审员使用手册](guide.review-agent) `guide.review-agent`
  > 方案上传、7 维度评分解读、维度自定义与权限说明

- [视频创作 Agent 使用教程](guide.video-agent) `guide.video-agent`
  > 文章转视频的分镜生成与导出全流程

- [周报管理 Agent 使用教程](guide.report-agent) `guide.report-agent`
  > 日志记录、Git 集成、AI 周报生成与团队汇总

- [AI 竞技场使用教程](guide.arena) `guide.arena`
  > 多模型盲测对比、评判揭晓与对战历史

- [工作流引擎使用教程](guide.workflow-agent) `guide.workflow-agent`
  > 画布编辑器、5 种胶囊节点与执行日志

- [快捷指令使用教程](guide.shortcuts-agent) `guide.shortcuts-agent`
  > iOS 快捷指令创建、扫码安装与 Siri 触发

- [海鲜市场（配置市场）使用教程](guide.marketplace) `guide.marketplace`
  > 配置浏览、筛选、Fork 与发布的完整流程

- [工作流画布操作手册](guide.workflow-canvas) `guide.workflow-canvas`
  > 工作流画布的详细操作参考

- [周报功能完整操作指南](guide.weekly-report) `guide.weekly-report`
  > 周报功能端到端操作指南

- [CDS 环境变量配置指南](guide.cds-env) `guide.cds-env`
  > CDS 环境变量的配置与使用说明

- [CDS + 后端 API 双层认证诊断指南](guide.cds-ai-auth) `guide.cds-ai-auth`
  > CDS 与后端 API 双层认证的诊断与排查指南

- [CDS GitHub Webhook 订阅配置指南](guide.cds-github-webhook-events) `guide.cds-github-webhook-events`
  > 说明 CDS 消费哪些 GitHub webhook 事件、哪些被静默过滤,以及如何在 GitHub App 后台配置订阅

- [AI 技能工作流指南](guide.skill-workflow) `guide.skill-workflow`
  > 从需求到上线的完整技能链工作流指南

- [疑难杂症排查手册](guide.troubleshooting) `guide.troubleshooting`
  > 常见问题的诊断与解决方案（ReactFlow 路由冲突等）

- [AI 百宝箱运维指南](guide.ai-toolbox-ops) `guide.ai-toolbox-ops`
  > AI 百宝箱功能的运维操作手册

- [MongoDB 索引手册](guide.mongodb-indexes) `guide.mongodb-indexes`
  > MongoDB 索引的创建规范与手动维护操作指南

- [多图组合功能测试备忘录](guide.multi-image-compose-test) `guide.multi-image-compose-test`
  > 多图组合生成功能的测试用例与验证记录

- [豆包 ASR 模型中继接入指南](guide.doubao-asr-relay) `guide.doubao-asr-relay`
  > 豆包流式 ASR WebSocket 中继的接入与配置指南

### 四、规范与规则

- [文档命名规则](rule.doc-naming) `rule.doc-naming`
  > doc/ 目录下文档的命名约定

- [文档模板标准](rule.doc-templates) `rule.doc-templates`
  > 六种文档类型的标准模板与写作规范

- [文档维护说明](rule.doc-maintenance) `rule.doc-maintenance`
  > 文档过时治理与持续维护的操作规范

- [应用身份定义规则](rule.app-identity) `rule.app-identity`
  > appKey、Feature、appCallerCode 的命名与使用规范

- [Agent 权限分类规则](rule.agent-permissions) `rule.agent-permissions`
  > Agent 权限的分类体系与注册规范

- [Agent 开发交付流程规范](rule.agent-development) `rule.agent-development`
  > Agent 类功能从设计到交付的标准流程

- [数据字典](rule.data-dictionary) `rule.data-dictionary`
  > 数据库集合、缓存 Key 与持久化结构的完整清单

- [默认可编辑原则](rule.default-editable) `rule.default-editable`
  > 表单字段默认可编辑的设计原则与例外条件

- [前端组件复用规则](rule.frontend-component-reuse) `rule.frontend-component-reuse`
  > 跨页面共享组件的提取与复用规范

- [测试组织规范](rule.test-organization) `rule.test-organization`
  > 单元测试与集成测试的组织与命名规范

- [技能系统规则与创建指南](rule.skill-system) `rule.skill-system`
  > Claude Code Skill 的创建、注册与管理规范

- [PRD Agent 全面代码审计报告](rule.audit-prd-desktop-codebase) `rule.audit-prd-desktop-codebase`
  > 桌面端代码库的全面审计报告与改进建议

### 五、计划与方案

- [周报 Agent 实施进度追踪](plan.report-agent-impl) `plan.report-agent-impl`
  > 周报 Agent 各阶段的实施进度与状态

- [统一缺陷管理平台实施计划](plan.unified-defect-management) `plan.unified-defect-management`
  > 统一缺陷管理平台的分阶段实施计划

- [PRD Agent 多文档系统设计方案](plan.multi-document) `plan.multi-document`
  > 多文档系统的整体设计与实施方案

- [多图 AI 交互方案](plan.multi-image-ai-interaction) `plan.multi-image-ai-interaction`
  > 多图场景下 AI 交互的实施方案

- [视频 TTS 语音接入与场景视觉升级实施方案](plan.video-tts-and-scene-upgrade) `plan.video-tts-and-scene-upgrade`
  > 视频生成 TTS 语音与场景视觉效果的升级方案

- [网页托管与分享实现计划](plan.web-hosting) `plan.web-hosting`
  > 网页托管功能的分阶段实现计划

- [移动端适配功能规划](plan.mobile-adaptation) `plan.mobile-adaptation`
  > 移动端响应式适配的功能规划

- [移动端布局分析报告](plan.mobile-layout-review) `plan.mobile-layout-review`
  > 移动端布局问题的分析与产品审阅意见

- [AI 百宝箱 MVP 规划](plan.ai-toolbox-mvp) `plan.ai-toolbox-mvp`
  > AI 百宝箱最小可行产品的功能规划

- [AI 百宝箱未完成项与下一步规划](plan.ai-toolbox-next-steps) `plan.ai-toolbox-next-steps`
  > AI 百宝箱后续迭代的待办事项与方向

- [AI 文本辅助通用 Domain 设计](plan.ai-text-assist) `plan.ai-text-assist`
  > AI 文本辅助功能的通用领域模型设计

- [动画优化计划](plan.animation-optimization) `plan.animation-optimization`
  > 基于 ReactBits 组件库的动画优化实施计划

- [Desktop 资产功能方案](plan.desktop-asset-features) `plan.desktop-asset-features`
  > 桌面端资产管理功能的规划方案

- [文档长周期更新计划](plan.doc-update) `plan.doc-update`
  > 文档体系的长期维护与更新计划

- [合并计划书：三入口守门员统一](plan.merge-image-ref-resolver) `plan.merge-image-ref-resolver`
  > 图片引用解析三入口的统一合并方案

- [Claude Code Skill 安装计划](plan.skill-installation) `plan.skill-installation`
  > Claude Code Skill 的安装与配置计划

- [CDS 部署规划](plan.cds-deployment) `plan.cds-deployment`
  > CDS 云开发套件的部署规划

- [CDS 产品路线图](plan.cds-roadmap) `plan.cds-roadmap`
  > CDS 产品迭代路线图

- [Report Agent v3.0 升级方案](plan.report-agent-v3) `plan.report-agent-v3`
  > 周报 Agent v3.0 采集优先架构升级方案

- [视觉创作视频生成每日限额实施方案](plan.visual-agent-video-gen-daily-limit) `plan.visual-agent-video-gen-daily-limit`
  > 视觉创作视频生成功能的每日限额实施

- [Design 文档优化项目进度](plan.design-doc-optimization) `plan.design-doc-optimization`
  > 37 篇设计文档补全管理摘要的实施进度追踪

### 六、周报

- [周报 2026-W13 (03-23 ~ 03-29)](report.2026-W13) `report.2026-W13`
  > 2026 年第 13 周工作总结（312 commits / 44 PRs，两个新 Agent 上线）

- [周报 2026-W12 (03-16 ~ 03-22)](report.2026-W12) `report.2026-W12`
  > 2026 年第 12 周工作总结（503 commits / 68 PRs，项目历史峰值）

- [周报 2026-W11 (03-09 ~ 03-15)](report.2026-W11) `report.2026-W11`
  > 2026 年第 11 周工作总结

- [周报 2026-W10 (03-02 ~ 03-08)](report.2026-W10) `report.2026-W10`
  > 2026 年第 10 周工作总结

- [周报 2026-W09 (02-23 ~ 03-01)](report.2026-W09) `report.2026-W09`
  > 2026 年第 9 周工作总结

- [周报 2026-W07 (02-09 ~ 02-15)](report.2026-W07) `report.2026-W07`
  > 2026 年第 7 周工作总结

- [周报 2026-W06 (02-03 ~ 02-08)](report.2026-W06) `report.2026-W06`
  > 2026 年第 6 周工作总结

- [PRD Agent Web 端同步开发报告](report.prd-agent-web-sync) `report.prd-agent-web-sync`
  > PRD Agent Web 端与桌面端同步开发的完整报告

- [CDS API 全功能测试报告](report.cds-api-full-test-2026-03-28) `report.cds-api-full-test-2026-03-28`
  > CDS API 全功能端到端测试报告

- [文档技能评测报告](report.skill-doc-evaluation) `report.skill-doc-evaluation`
  > 三种文档技能 vs 已有文档的评测对比报告

- [文档技能评测·user-guide-writing 样本输出](report.skill-eval-sample-user-guide) `report.skill-eval-sample-user-guide`
  > 评测报告引用的 skill 原始输出样本（用户操作指南类）

- [文档技能评测·technical-writing 样本输出](report.skill-eval-sample-technical) `report.skill-eval-sample-technical`
  > 评测报告引用的 skill 原始输出样本（技术规格类）

- [文档技能评测·documentation-writer 样本输出](report.skill-eval-sample-diataxis) `report.skill-eval-sample-diataxis`
  > 评测报告引用的 skill 原始输出样本（Diátaxis 四象限类）

---

## 变更历史

| 日期 | 操作 | 文件名 | 中文标题 |
| :--- | :--- | :--- | :--- |
| 2026-04-19 | 🔄 重命名 | `output-user-guide-writing` → `report.skill-eval-sample-user-guide` | 文档技能评测·user-guide-writing 样本输出 |
| 2026-04-19 | 🔄 重命名 | `output-technical-writing` → `report.skill-eval-sample-technical` | 文档技能评测·technical-writing 样本输出 |
| 2026-04-19 | 🔄 重命名 | `output-documentation-writer` → `report.skill-eval-sample-diataxis` | 文档技能评测·documentation-writer 样本输出 |
| 2026-03-31 | 🟢 新增 | `report.2026-W13` | 周报 2026-W13 (03-23 ~ 03-29) |
| 2026-03-31 | 🟢 新增 | `design.llm-gateway` | LLM Gateway 统一调用架构设计 |
| 2026-03-31 | 🟢 新增 | `design.marketplace` | 配置市场（海鲜市场）技术设计 |
| 2026-03-31 | 🟢 新增 | `design.rbac-permission` | RBAC 权限系统设计 |
| 2026-03-31 | 🟢 新增 | `design.report-agent` | 周报管理 Agent 架构设计 |
| 2026-03-31 | 🟢 新增 | `design.review-agent` | 产品评审员技术设计文档 |
| 2026-03-31 | 🟢 新增 | `design.system-emergence` | 系统涌现：从基础组件到协同智能 |
| 2026-03-31 | 🟢 新增 | `design.visual-agent` | Visual Agent 架构设计 |
| 2026-03-31 | 🟢 新增 | `guide.mongodb-indexes` | MongoDB 索引手册 |
| 2026-03-31 | 🟢 新增 | `guide.doubao-asr-relay` | 豆包 ASR 模型中继接入指南 |
| 2026-03-31 | 🟢 新增 | `spec.submission-gallery` | 作品投稿与画廊展示规格 |
| 2026-03-31 | 🟢 新增 | `plan.design-doc-optimization` | Design 文档优化项目进度 |
| 2026-03-31 | 🟢 新增 | `report.cds-api-full-test-2026-03-28` | CDS API 全功能测试报告 |
| 2026-03-31 | 🔄 替换 | `design.im-architecture` → `design.llm-gateway` | IM 架构文档替换为 LLM Gateway |
| 2026-03-31 | 🔄 批量更新 | 37 篇 `design.*` | 补全管理摘要、头部信息与废弃标注 |
| 2026-03-28 | 🟢 新增 | `guide.review-agent` | 产品评审员使用手册 |
| 2026-03-23 | 🟢 新增 | `design.generation-snapshot` | 生成快照设计 |
| 2026-03-23 | 🟢 新增 | `guide.cds-ai-auth` | CDS + 后端 API 双层认证诊断指南 |
| 2026-03-23 | 🟢 新增 | `guide.prd-agent-operations` | PRD Agent 全平台操作手册 |
| 2026-03-23 | 🟢 新增 | `guide.skill-workflow` | AI 技能工作流指南 |
| 2026-03-23 | 🟢 新增 | `report.prd-agent-web-sync` | PRD Agent Web 端同步开发报告 |
| 2026-03-23 | 🔄 更新 | `report.2026-W12` | 周报 2026-W12 (全量重写) |
| 2026-03-20 | 🟢 新增 | `report.2026-W12` | 周报 2026-W12 (03-16 ~ 03-22) |
| 2026-03-20 | 🟢 新增 | `guide.prd-agent` | PRD Agent 使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.visual-agent` | 视觉创作 Agent 使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.literary-agent` | 文学创作 Agent 使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.defect-agent` | 缺陷管理 Agent 使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.video-agent` | 视频创作 Agent 使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.report-agent` | 周报管理 Agent 使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.arena` | AI 竞技场使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.workflow-agent` | 工作流引擎使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.shortcuts-agent` | 快捷指令使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.marketplace` | 海鲜市场（配置市场）使用教程 |
| 2026-03-20 | 🟢 新增 | `guide.workflow-canvas` | 工作流画布操作手册 |
| 2026-03-20 | 🟢 新增 | `guide.weekly-report` | 周报功能完整操作指南 |
| 2026-03-20 | 🟢 新增 | `design.model-pool-failover` | 模型池故障转移与自动探活设计 |
| 2026-03-20 | 🟢 新增 | `report.skill-doc-evaluation` | 文档技能评测报告 |
| 2026-03-15 | 🟢 新增 | `report.2026-W11` | 周报 2026-W11 (03-09 ~ 03-15) |
| 2026-03-15 | 🟢 新增 | `spec.cds` | CDS 功能需求说明书 |
| 2026-03-15 | 🟢 新增 | `design.apple-shortcuts` | 苹果快捷指令集成设计方案 |
| 2026-03-15 | 🟢 新增 | `design.cds-onboarding` | CDS 极简上手设计 |
| 2026-03-15 | 🟢 新增 | `guide.cds-env` | CDS 环境变量配置指南 |
| 2026-03-15 | 🟢 新增 | `guide.troubleshooting` | 疑难杂症排查手册 |
| 2026-03-15 | 🟢 新增 | `plan.cds-deployment` | CDS 部署规划 |
| 2026-03-15 | 🟢 新增 | `plan.cds-roadmap` | CDS 产品路线图 |
| 2026-03-15 | 🟢 新增 | `plan.report-agent-v3` | Report Agent v3.0 升级方案 |
| 2026-03-15 | 🔴 移除 | `design.agent-dashboard` | Agent Dashboard 设计文档（文件已删除） |
| 2026-03-11 | 🔄 重排 | `index.yml` + `guide.list.directory.md` | 按阅读优先级重新排序文档索引 |
| 2026-03-10 | 🟢 新增 | `index.yml` | 文档元数据索引 |
| 2026-03-10 | 🟢 新增 | `guide.list.directory.md` | 文档索引目录页 |
