# MAP 平台文档索引 · 指南

> 最后更新：2026-05-22
>
> 本文件是 `doc/` 目录的结构化索引，供外部同步工具（语雀、Confluence 等）消费。
> 元数据定义见 `doc/index.yml`，命名规范见 `doc/rule.doc-naming.md`。
>
> **排序原则**：先理解产品 → 再了解架构 → 然后动手操作 → 参考规范 → 未来计划 → 当前债务 → 历史记录

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

- [缺陷自动化协议](spec.defect-agent-automation-protocol) `spec.defect-agent-automation-protocol`
  > domain + K、工作流端点、commit 回写、更新中心关联和发布后验收通知的稳定协议

- [私人执行助理（PA Agent）产品方案](spec.pa-agent) `spec.pa-agent`
  > PA Agent 产品定位、Phase 1 能力与路线图，可独立下载评审

- [毒舌秘书：PA Agent 最小可行升级方案](spec.pa-agent-savage-upgrade) `spec.pa-agent-savage-upgrade`
  > PA Agent 升级为毒舌秘书的最小可行方案，1-2 天内可上线，保留架构只改产品灵魂

- [毒舌秘书 v2 迭代升级方案](spec.pa-agent-savage-iter-v2) `spec.pa-agent-savage-iter-v2`
  > 毒舌秘书 PA Agent v2 阶段迭代升级方案

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

- [CDS Compose 契约（SSOT）](spec.cds-compose-contract) `spec.cds-compose-contract`
  > CDS docker-compose 契约的唯一来源规格

- [CDS 服务生命周期与缓存范围规格](spec.cds-lifecycle) `spec.cds-lifecycle`
  > CDS 服务生命周期管理与缓存隔离范围的规格说明

- [CDS MAP 配对协议规格](spec.cds-map-pairing-protocol) `spec.cds-map-pairing-protocol`
  > CDS 与 MAP 平台之间的配对协议规格

- [MAP 知识库传输协议（MAP-KBTP v1）规格](spec.map-kb-transfer-protocol) `spec.map-kb-transfer-protocol`
  > MAP 平台知识库双向同步的底层传输协议规格（PeerSync + DocumentStoreSyncResource，v1.1 已落地）

- [CDS 多项目数据字典](spec.cds-project-model) `spec.cds-project-model`
  > CDS 多项目数据模型的字段定义与约束

- [统一短链系统规格](spec.short-links) `spec.short-links`
  > 统一短链系统产品规格，已落地（PR #613）

- [演讲智能体产品规格](spec.speech-agent) `spec.speech-agent`
  > 长文本/文档转思维导图风格的可演讲材料，首期 mindmap 模式（MVP 已落地）

- [前端搭档智能体产品规格](spec.front-end-agent) `spec.front-end-agent`
  > 面向后端同事的前端交付助手：接 API、写组件、修报错、看截图现象

### 二、设计文档

- [手机端整体重构调研](design.mobile-refactor) `design.mobile-refactor`
  > 真机视口取证 16 页 + 行为聚合使用强度 + 三波改造优先级（排除视觉创作）
- [每日小贴士 / 路径式教程系统设计](design.daily-tips) `design.daily-tips`
  > 右下角悬浮教程书 + SpotlightOverlay 多步 Tour + 推送/批量/dismiss 闭环

- [功能验收体系设计](design.acceptance-system) `design.acceptance-system`
- [验收报告知识库设计](design.acceptance-kb) `design.acceptance-kb`
  > 业界对标(IEEE 829 / ISO·IEC·IEEE 29119-3 / 29148 / ISTQB / BDD)的标准化验收：为何而写、踩过的坑、v2 落地与 v3 演进、涌现与未来

- [智能体宇宙设计](design.agent-universe) `design.agent-universe`
  > 能力契约 SSOT + 统一调用信封；选了不自动发、视觉创作真出图、漫威宇宙式互通
- [知识库智能体架构设计](design.knowledge-agent-architecture) `design.knowledge-agent-architecture`
  > 三层模型(脑/技能/沙箱) + map-agent·cds-agent 命名 + 借运行时不重建 + 唯一接缝(KB 当工作目录进、改动经 diff 闸出)；md→ppt 避坑
- [MAP MCP 连接器设计](design.map-mcp-connector) `design.map-mcp-connector`
  > 把 AgentOpenEndpoint 登记表翻译成 MCP 工具，远程 /mcp 端点（Streamable HTTP）复用 sk-ak + scope，可被 Claude/Codex 当连接器接入
- [服务器权威性设计](design.server-authority) `design.server-authority`
  > 客户端断开不取消服务器任务的架构设计
- [团队动态设计](design.team-activity) `design.team-activity`
  > 全局白名单审计 Filter 自动留痕 + TargetTitle 标题快照（删除前预读）+ 管理员时间线页（/team-activity）

- [LLM Gateway 统一调用架构设计](design.llm-gateway) `design.llm-gateway`
  > 所有 LLM 调用通过统一网关，三级调度 + 健康管理

- [大模型池设计（三级调度/三级链路）](design.model-pool) `design.model-pool`
  > 模型池策略引擎的三级调度与链路设计

- [开放平台功能概要](design.open-platform) `design.open-platform`
  > 开放平台 API 接入的整体功能概要

- [工作流引擎设计方案](design.workflow-engine) `design.workflow-engine`
  > 可视化工作流引擎的整体架构设计

- [工作流自动配置设计](design.workflow-auto-config) `design.workflow-auto-config`
  > AI 生成校验自愈闭环 + 降低工作流配置门槛（让用户只描述、自动配）

- [赋码采集关联智能体（CCAS）设计](design.ccas-agent) `design.ccas-agent`
  > 产线赋码业务三件套：PRD 文档生成 + 设备素材库 + 流程示意图（appKey: ccas-agent）

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

- [产品管理 Agent 设计](design.product-agent) `design.product-agent`
  > 产品-版本-需求-功能-缺陷-客户全链路串联、版本化管理、分级追溯与知识图谱（参考 TAPD / RTM）
- [产品管理 Agent 债务台账](debt.product-agent) `debt.product-agent`
  > 产品管理智能体已知边界与后续波次债务
- [缺陷管理 Agent 功能设计](design.defect-agent) `design.defect-agent`
  > 缺陷提交、跟踪与升级流程的功能设计

- [缺陷管理标签体系设计](design.defect-labels) `design.defect-labels`
  > 缺陷协作标签的枚举、权限、展示和桌面端同步设计

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

- [CDS 构建耗时与发布版/热加载机制设计](design.cds-build-time) `design.cds-build-time`
  > 构建流水线时间去向、>10 分钟根因（Java 重复下载依赖 / buildTimeout 上限 / 自动发布双构建）、发布版 vs 热加载对照与自动发布介入时机

- [CDS Agent API 契约设计](design.cds-agent-api) `design.cds-agent-api`
  > MAP/CDS 会话、事件、工具审批、Hook、runtime profile 与工作流调用的 API 契约

- [CDS Agent 运行时架构设计](design.cds-agent-runtime-architecture) `design.cds-agent-runtime-architecture`
  > MAP 会话、CDS shared-service、sidecar pool、会话级 worker 与业务分支容器的边界图

- [CDS Agent 官方 SDK Adapter 设计](design.cds-agent-official-sdk-adapter) `design.cds-agent-official-sdk-adapter`
  > 保留 MAP/CDS 控制面，把自研 agent loop 压缩为官方 SDK adapter 的边界设计

- [CDS Agent 商业级架构与路线图](design.cds-agent-commercial-architecture-and-roadmap) `design.cds-agent-commercial-architecture-and-roadmap`
  > CDS Agent 商业级可用的整体架构方案与路线图规划

- [CDS Agent R0 · CDS-managed runtime fact source 设计](design.cds-agent-managed-runtime-fact-source) `design.cds-agent-managed-runtime-fact-source`
  > CDS-managed runtime 事实来源的设计文档

- [CDS Agent 工作区基础设施模型](design.knowledge-agent-architecture) `design.knowledge-agent-architecture`
  > 工作区来源从 GitHub 仓库迁移到文件夹/知识库（document_stores），GitHub 降级为可选钩子；含官方/自建边界表、数据模型、文件注入受阻说明

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

- [海鲜市场技能开放接口](design.skill-marketplace-open-api) `design.skill-marketplace-open-api`
- [开放接口（OpenAI 兼容对外网关）技术设计](design.open-api) `design.open-api`
  > AgentApiKey 长效 M2M 鉴权 + scope 白名单 + findmapskills 官方技能同步到海鲜市场 + P3 Agent 开放接口铺路

- [RBAC 权限系统设计](design.rbac-permission) `design.rbac-permission`
  > SystemRole + AdminPermissionCatalog 60+ 权限的 RBAC 体系

- [周报管理 Agent 架构设计](design.report-agent) `design.report-agent`
  > 周报 Agent 的完整架构：团队管理、AI 生成、数据源采集

- [系统涌现：从基础组件到协同智能](design.system-emergence) `design.system-emergence`
  > MAP 平台从基础能力到协同智能的涌现机制说明

- [Visual Agent (视觉创作) 架构设计](design.visual-agent) `design.visual-agent`
  > 视觉创作 Agent 的三栏工作区架构与生图流水线设计

- [技能系统统一设计](design.unified-skill-system) `design.unified-skill-system`
  > Claude Code Skill 的统一管理架构与注册机制设计

- [文档空间设计](design.document-store) `design.document-store`
  > 文档空间多文档上传、内容预览与订阅源定期同步设计

- [知识库跨环境同步设计](design.document-store-sync) `design.document-store-sync`
  > 任一知识库与另一处库（跨环境/本环境两库）永久令牌配对、单/双向手动同步、血缘 ID 幂等 upsert、签名快照改动检测；含组件架构/数据流/双向决策架构图

- [知识库引用网络设计](design.knowledge-base-mention-network) `design.knowledge-base-mention-network`
  > mentions 通用 @ 账本 + WikiLinkParser 双链解析 + 反向链接面板 + WikilinkHoverCard + 宇宙图 Graph View 架构设计；MVP 仅 document→document，v2 候选跨实体/AI 补链

- [涌现探索器设计](design.emergence-explorer) `design.emergence-explorer`
  > 种子→探索→涌现三维度 + SSE 流式 + ReactFlow 画布的架构设计

- [LLM Gateway 图片生成重构设计](design.llm-gateway-refactor) `design.llm-gateway-refactor`
  > compute-then-send 重构方案，消除二次 Resolve 的根因
- [LLM 网关与模型池统一设计](design.llm-gateway-unification) `design.llm-gateway-unification`
  > 协议下沉到模型 + 池减负 + 图片并网关 + code 降级为标签（草案，分 6 相位）

- [PR Review V2 设计](design.pr-review-v2) `design.pr-review-v2`
  > OAuth Device Flow 每用户独立 + PR 快照 + 笔记的最小可审查工作台

- [外部授权中心设计](design.external-authorization) `design.external-authorization`
  > TAPD / 语雀 / GitHub 凭证统一管理的授权中心设计

- [Page Agent Bridge 设计](design.page-agent-bridge) `design.page-agent-bridge`
  > 编码 Agent 通过 CDS Bridge 操作预览页面的架构设计

- [GitHub 基础设施层设计](design.github-infrastructure) `design.github-infrastructure`
  > Infrastructure.GitHub 层的架构与 webhook 集成设计

- [模型中继虚拟平台设计](design.exchange-virtual-platform) `design.exchange-virtual-platform`
  > Exchange as Virtual Platform 的模型中继与虚拟平台设计

- [Claude SDK 执行器设计](design.claude-sdk-executor) `design.claude-sdk-executor`
  > CLI Agent 执行器 claude-sdk 类型的架构与 Python sidecar 设计

- [CLI Agent 工作空间设计](design.workspace) `design.workspace`
  > CLI Agent 工作空间上下文共享与隔离架构设计

- [跨存储迁移与资源分离设计](design.storage-migration) `design.storage-migration`
  > COS / S3 跨存储迁移与资源分离的技术方案

- [CDS 多项目设计](design.cds-multi-project) `design.cds-multi-project`
  > CDS 多项目隔离架构：Project model + dockerNetwork + 权限边界

- [CDS 数据迁移设计](design.cds-data-migration) `design.cds-data-migration`
  > CDS state.json → MongoDB 的数据迁移技术方案

- [CDS FU-02 MapAuthStore（Mongo 后端）设计](design.cds-fu-02-auth-store-mongo) `design.cds-fu-02-auth-store-mongo`
  > CDS 认证存储从文件迁移到 MongoDB 后端的设计

- [CDS 控制面/数据面分离设计](design.cds-control-data-split) `design.cds-control-data-split`
  > CDS 控制面与数据面分离的架构设计（蓝绿部分已废弃）

- [CDS 集群引导协议设计](design.cds-cluster-bootstrap) `design.cds-cluster-bootstrap`
  > CDS Connect / Disconnect / Capacity Auto-Expand 集群引导协议

- [CDS 容量预算与故障隔离设计](design.cds-resilience) `design.cds-resilience`
  > 小服务器负载均衡到分布式集群的容量预算与故障隔离设计

- [CDS Railway 式部署向导设计](design.cds-railway-onboarding-flow) `design.cds-railway-onboarding-flow`
- [CDS 绝对可视化一键部署设计（含架构图）](design.cds-visual-deploy) `design.cds-visual-deploy`
- [演讲智能体技术设计](design.speech-agent) `design.speech-agent`
  > 数据模型 / Controller / SpeechAgentService 流式拆大纲 / SSE 协议 / compute-then-send 落地
- [CDS AI 生成 compose 草稿设计](design.cds-ai-compose) `design.cds-ai-compose`
  > 从 Railway 首次部署路径抽象 CDS 一键部署、运行环境选择、基础设施创建和可观察性闭环

- [缺陷分享与 Agent 技能修复架构](design.defect-agent-share-skill-architecture) `design.defect-agent-share-skill-architecture`
  > 缺陷分享中心、外部 Agent 技能接入与修复报告闭环的架构设计

- [系统级跨节点互传（Peer Sync）设计](design.peer-sync) `design.peer-sync`
  > 多节点间消息互传的协议设计、数据模型与同步机制

- [文档再加工 · 智能体调用路由设计](design.reprocess-chat-routing) `design.reprocess-chat-routing`
  > 文档再加工功能中不同智能体（视觉/文学）的调用路由与分发设计

### 三、指南

- [Agent 开发入门指南（新手必读）](guide.agent-onboarding) `guide.agent-onboarding`
  > 新手 Agent 开发入门：阶段式陪伴、AGENT_WORKSPACE 进度文件、验收标准

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
- [MAP MCP 连接器接入指南](guide.mcp-connector) `guide.mcp-connector`
  > 把 MAP 当 MCP 连接器接入 Claude/Codex：/api/mcp 端点 + sk-ak + 5 内置工具 + 共享其他 Agent + AI 自助签发自测

- [视觉验收技能跨仓库使用教程](guide.visual-acceptance-skill) `guide.visual-acceptance-skill`
  > 用个人 AgentApiKey + 海鲜市场安装、更新 `create-visual-test-to-kb`，避免借用个人 accesskey

- [工作流画布操作手册](guide.workflow-canvas) `guide.workflow-canvas`
  > 工作流画布的详细操作参考

- [周报功能完整操作指南](guide.weekly-report) `guide.weekly-report`
  > 周报功能端到端操作指南

- [多平台博主订阅 → 首页海报弹窗](guide.poster-feed-card) `guide.poster-feed-card`
  > 涌现 1 系列：TikTok / 抖音 / B 站 / 小红书 / YouTube 任一博主作品自动拉到首页海报弹窗。含 4 种版式（feed-card / ad-4-3 / ad-rich-text / static）+ media-rehost 防盗链 + ASR 字幕浮层

- [CDS Agent 工作台用户指南](guide.cds-agent-workbench) `guide.cds-agent-workbench`
  > 普通用户从 CDS Agent 页面创建远程会话、发送任务、审批工具、查看事件和日志的操作指南

- [CDS Agent 工作台复现操作指南](guide.cds-agent-workbench-reproduce) `guide.cds-agent-workbench-reproduce`
  > 从真实入口复现 CDS Agent 创建会话、审批工具、查看产物、远程浏览器和 PR 闭环的操作教程

- [CDS Agent 下一代测试与涌现建议](guide.cds-agent-next-agent-testing) `guide.cds-agent-next-agent-testing`
  > 给下一个智能体的分层测试矩阵、视觉验收标准、涌现分析和下一代路线建议

- [CDS Agent 管理员指南](guide.cds-agent-admin) `guide.cds-agent-admin`
  > 管理员配置系统级 CDS 长期授权、模型运行配置、Hook profile 和安全边界的操作指南

- [CDS Agent 运行手册](guide.cds-agent-runbook) `guide.cds-agent-runbook`
  > CDS Agent 部署检查、401、撤销、runtime、事件恢复、PR 验收失败的排障手册

- [CDS Agent 代码审查上手指南](guide.cds-agent-code-review-quickstart) `guide.cds-agent-code-review-quickstart`
  > CDS Agent 代码审查功能快速上手指南

- [CDS Agent Runtime Pool 恢复指南](guide.cds-agent-runtime-pool-recovery) `guide.cds-agent-runtime-pool-recovery`
  > CDS Agent Runtime Pool 恢复与官方 SDK Smoke 测试操作指南

- [CDS 环境变量配置指南](guide.cds-env) `guide.cds-env`
  > CDS 环境变量的配置与使用说明

- [CDS + 后端 API 双层认证诊断指南](guide.cds-ai-auth) `guide.cds-ai-auth`
  > CDS 与后端 API 双层认证的诊断与排查指南

- [CDS GitHub Webhook 订阅配置指南](guide.cds-github-webhook-events) `guide.cds-github-webhook-events`
  > 说明 CDS 消费哪些 GitHub webhook 事件、哪些被静默过滤,以及如何在 GitHub App 后台配置订阅

- [CDS CLI 蜂群优化操作手册](guide.cds-cli-swarm) `guide.cds-cli-swarm`
  > 多 agent 并行反馈+修复+复测：3 个反馈方 + 1 个修复方 + 1 个协调方，含 5 段可直接复制的 prompt

- [CDS 三种部署方式指南](guide.cds-deploy-three-paths) `guide.cds-deploy-three-paths`
  > 从 cds-compose.yml、CDS 技能扫描、从 0 创建三条路径完成部署的步骤和验收标准

- [从零开始的 CDS 教程 · 指南](guide.cds-tutorial) `guide.cds-tutorial`
- [CDS 可视化部署与验收指南](guide.cds-deploy-acceptance) `guide.cds-deploy-acceptance`
- [CDS 一键可视化部署使用教程](guide.cds-one-click-deploy) `guide.cds-one-click-deploy`
  > 4 个横向场景（静态/网页+后台/+MongoDB/+redis+mysql+rabbitmq）× 2 条纵向路径（直配/compose 导入）+ compose 评分/自愈 + 每场景独立知识库

- [CDS 全栈基础设施冒烟样例指南](guide.cds-fullstack-infra-smoke) `guide.cds-fullstack-infra-smoke`
  > 使用前端、后端、MySQL、Redis、RabbitMQ 极简样例验证 CDS 一键部署和沙盒导入适配度

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
- [开放接口（OpenAI 兼容对外网关）接入指南](guide.open-api) `guide.open-api`
  > 豆包流式 ASR WebSocket 中继的接入与配置指南

- [CDS 集群扩容指南](guide.cds-cluster-setup) `guide.cds-cluster-setup`
  > CDS 从单节点扩展到多节点集群的操作指南

- [CDS Forwarder 部署 / 迁移 / 卸载 Runbook](guide.cds-forwarder-deploy) `guide.cds-forwarder-deploy`
  > CDS Forwarder 进程的完整部署、迁移与卸载操作手册

- [CDS state.json → MongoDB 迁移指南](guide.cds-mongo-migration) `guide.cds-mongo-migration`
  > CDS 状态存储从 state.json 迁移到 MongoDB 的操作指南

- [CDS 多分支数据库隔离指南（Phase 5）](guide.cds-multi-branch-db) `guide.cds-multi-branch-db`
  > CDS 多分支数据库隔离的配置与操作指南

- [CDS 多项目升级迁移指南](guide.cds-multi-project-upgrade) `guide.cds-multi-project-upgrade`
  > 从单项目 CDS 升级到多项目架构的迁移操作指南

- [CDS MySQL 接入实战 Runbook（Phase 6）](guide.cds-mysql-validation-runbook) `guide.cds-mysql-validation-runbook`
  > CDS MySQL 数据库接入的实战验证操作手册

- [CDS ORM 支持指南（Phase 4 起）](guide.cds-orm-support) `guide.cds-orm-support`
  > CDS ORM 层的接入与配置使用指南

- [CDS 列表视图与拓扑视图功能对齐指南](guide.cds-view-parity) `guide.cds-view-parity`
  > CDS Dashboard 列表视图与拓扑视图的功能对等说明

- [CDS Web 迁移运行手册](guide.cds-web-migration-runbook) `guide.cds-web-migration-runbook`
  > CDS 前端从原生 HTML/JS 迁移到 React/Vite 的操作运行手册

- [CDS 蓝绿改造交接（已废弃，留档备查）](guide.cds-blue-green-handoff) `guide.cds-blue-green-handoff`
  > 蓝绿部署方案的设计与踩坑记录，已被 Forwarder 方案取代

- [Claude SDK 三步接入指南](guide.claude-sdk-quickstart) `guide.claude-sdk-quickstart`
  > 三步把 Claude Agent SDK 接进本系统，零代码改动、零专业知识

- [Claude SDK + CDS MAP 配对 MVP 指南](guide.claude-sdk-cds-map-mvp) `guide.claude-sdk-cds-map-mvp`
  > CDS 调度外部 Anthropic Agent SDK sidecar，MAP 通过 CDS-MAP 配对发现并路由到该 sidecar

- [Playwright E2E 测试指南](guide.e2e-tests) `guide.e2e-tests`
  > 端到端测试的编写、运行与调试操作指南

- [基础设施沙箱 Agent 完整手册](guide.infra-sandbox-agent) `guide.infra-sandbox-agent`
  > 基础设施建设沙箱 Agent 的设计思路、操作步骤与已知边界

- [技能百科全书指南](guide.skill-catalog) `guide.skill-catalog`
  > 所有已注册技能的完整目录与使用说明

- [删技能前置检查清单 · 指南](guide.skill-removal-checklist) `guide.skill-removal-checklist`
  > 删除/合并技能前必跑的引用面检查清单（PR #690 教训固化）

- [冒烟测试指南](guide.smoke-tests) `guide.smoke-tests`
  > 核心业务流程冒烟测试的操作说明与 curl 命令集

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

- [同族技能触发词去重规则](rule.skill-trigger-disambiguation) `rule.skill-trigger-disambiguation`
  > 多个技能围绕同一中心系统拆分时的 description / slash / 触发词去重硬规则

- [PRD Agent 全面代码审计报告](rule.audit-prd-desktop-codebase) `rule.audit-prd-desktop-codebase`
  > 桌面端代码库的全面审计报告与改进建议

- [AI 模型可见性原则](rule.ai-model-visibility) `rule.ai-model-visibility`
  > 大模型调用功能必须向用户展示当前模型名称的强制规则

- [Issues 体系协议规则](rule.issues-system) `rule.issues-system`
  > 三技能协同（autofix/visual-create/visual-run）+ label 全局体系 + #605 模板演化机制

- [流式文本动效统一规范](rule.streaming-text) `rule.streaming-text`
  > prd-admin 所有 LLM 流式输出统一通过 StreamingText 组件，默认 Blur focus 动效

- [CDS state.json → MongoDB 迁移与回滚规则](rule.cds-mongo-migration) `rule.cds-mongo-migration`
  > CDS 状态存储迁移过程中的操作规范与回滚规则

- [CDS 多项目隔离审计规则](rule.cds-project-isolation-audit) `rule.cds-project-isolation-audit`
  > CDS 多项目环境下的权限隔离审计检查规则

- [前端模态框布局硬约束规则](rule.frontend-modal) `rule.frontend-modal`
  > 模态框必须满足 createPortal + inline style 高度 + min-h-0 三条物理约束

- [首页 / 登录页视觉语言规则](rule.landing-visual-style) `rule.landing-visual-style`
  > 首页与登录页的视觉风格、动效与色彩规范

- [LLM Gateway 流式调用与 Reasoning 规则](rule.llm-gateway) `rule.llm-gateway`
  > LLM Gateway 流式场景的关键陷阱与 Reasoning 推理内容处理规则

### 五、计划与方案

- [PA Agent 竞品调研与改进方案](plan.pa-agent-competitive-improvements) `plan.pa-agent-competitive-improvements`
  > 四类竞品谱系、与 Phase 1 差距对照、P2～P4 分期改进包

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

- [海报工坊设计器重构交接](plan.weekly-poster-designer-handoff) `plan.weekly-poster-designer-handoff`
  > 海报工坊从「向导一键生成」升级为「Canva 式设计器」(左列表+中页面tabs+右图文编辑)交接文档

- [CDS 前端迁移计划与交接](plan.cds-web-migration) `plan.cds-web-migration`
  > CDS 从原生 HTML/JS/CSS 渐进迁移到 React + Vite + Tailwind + shadcn/ui，逐页接管 + 老页面共存于 cds/web-legacy/，URL 永远干净（无 /v2 前缀）
- [CDS legacy 特色功能迁移合并计划](plan.cds-legacy-feature-rollup) `plan.cds-legacy-feature-rollup`
  > 页面级路由迁完后,补 12k 行 app.js 里 13 项特色功能模块的功能级迁移(Activity Monitor / 集群管理 / 容量超限选择 / 拓扑 DAG / AI 占用 feed 等),分 3 wave,带状态/效果/测试/工作量字段

- [移动端适配功能规划](plan.mobile-adaptation) `plan.mobile-adaptation`
  > 移动端响应式适配的功能规划

- [移动端布局分析报告](plan.mobile-layout-review) `plan.mobile-layout-review`
  > 移动端布局问题的分析与产品审阅意见

- [AI 百宝箱 MVP 规划](plan.ai-toolbox-mvp) `plan.ai-toolbox-mvp`
  > AI 百宝箱最小可行产品的功能规划

- [AI 百宝箱未完成项与下一步规划](plan.ai-toolbox-next-steps) `plan.ai-toolbox-next-steps`
  > AI 百宝箱后续迭代的待办事项与方向

- [AI 文本辅助通用 Domain 设计](plan.ai-text-assist) `plan.ai-text-assist`
- [MD转PPT 对话式 artifact 工作台改造计划](plan.md-to-ppt-chat-redesign) `plan.md-to-ppt-chat-redesign`
  > MD 转 PPT 对话式工作台改造的实施计划

- [MD 转 PPT 下一波执行计划](plan.md-to-ppt-next-wave) `plan.md-to-ppt-next-wave`
  > MD 转 PPT 下一波：大纲右侧编辑器 / 状态机 / 澄清问卷 / 编辑深修

- [配图标记手动干预](plan.manual-image-marking-control) `plan.manual-image-marking-control`
  > 配图标记从"自动黑盒"升级为"提示词+位置策略+段落级操作"的分阶段计划（Phase 1/2/3）

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

- [海鲜市场技能开放接口 — 下一程交接](plan.skill-marketplace-open-api-next) `plan.skill-marketplace-open-api-next`
  > P2/P3/P4 待办清单 + UAT 10 条 + 环境准备 + 代码约定，接力 Agent 一份就懂

- [CDS 当前状态看板](plan.cds-status) `plan.cds-status`
  > CDS 唯一"我在哪"入口（每次 handoff 必更新）— 大期完成度 + F1-F18 状态 + 子文档分层链接

- [CDS Agent 工作台完全可用路线](plan.cds-agent-workbench) `plan.cds-agent-workbench`
  > MAP 通过 CDS 操作 Claude SDK / Codex 类 Agent 干活的完全可用路线，覆盖对话页、工作流、智能体、远程浏览器、可观测性和逐项验收

- [CDS Agent 官方 SDK Adapter 迁移计划](plan.cds-agent-official-sdk-migration) `plan.cds-agent-official-sdk-migration`
  > 一个周期内把 CDS Agent runtime 收缩到官方 SDK adapter 的最小开发计划、调试顺序和验收门槛

- [CDS Agent Runtime 架构纠偏 · 有限计划](plan.cds-agent-runtime-correction-limited) `plan.cds-agent-runtime-correction-limited`
  > CDS Agent Runtime 架构纠偏的有限范围实施计划

- [CDS 产品路线图](plan.cds-roadmap) `plan.cds-roadmap`
- [CDS 绝对可视化部署计划](plan.cds-visual-deploy) `plan.cds-visual-deploy`
  > Phase 0-3 长期路线图

- [CDS 部署规划](plan.cds-deployment) `plan.cds-deployment`
  > CDS 云开发套件的部署规划

- [CDS Railway 式体验补齐计划](plan.cds-railway-ux-followup) `plan.cds-railway-ux-followup`
  > 已完成项、未完成项和三种部署路径自测范围

- [Report Agent v3.0 升级方案](plan.report-agent-v3) `plan.report-agent-v3`
  > 周报 Agent v3.0 采集优先架构升级方案

- [视觉创作视频生成每日限额实施方案](plan.visual-agent-video-gen-daily-limit) `plan.visual-agent-video-gen-daily-limit`
  > 视觉创作视频生成功能的每日限额实施

- [Design 文档优化项目进度](plan.design-doc-optimization) `plan.design-doc-optimization`
  > 37 篇设计文档补全管理摘要的实施进度追踪

- [每日小贴士功能 — 剩余工作交接文档](plan.daily-tips-remaining-work) `plan.daily-tips-remaining-work`
  > Issue 1/2/3 现状 + 方案选项 + 新 Agent 接手 checklist

- [教程小书三场景统一 + 过时检测自动化](plan.daily-tips-scenarios-and-staleness) `plan.daily-tips-scenarios-and-staleness`
  > 三场景统一设计与过时检测自动化方案（交接给后续 Agent）

- [CDS 横向事项 Backlog 矩阵](plan.cds-backlog-matrix) `plan.cds-backlog-matrix`
  > CDS 跨期横向事项的优先级矩阵与进度追踪

- [CDS 多项目改造 7 期交付计划](plan.cds-multi-project-phases) `plan.cds-multi-project-phases`
  > CDS 多项目改造各期交付物与验收标准

- [CDS 高可用改造落地进度](plan.cds-resilience-rollout) `plan.cds-resilience-rollout`
  > CDS 高可用改造的分阶段落地进度追踪（可续传）

- [prd-admin 样式统一迁移看板](plan.prd-admin-surface-style-migration) `plan.prd-admin-surface-style-migration`
  > prd-admin Surface System 样式统一迁移的进度看板

- [视频创作 Agent 列表/详情页全面重做交接](plan.video-agent-list-detail-rebuild) `plan.video-agent-list-detail-rebuild`
  > 视频创作 Agent 列表与详情页全面重做的交接文档

- [CDS PR #684 审查修复计划](plan.cds-pr684-review-remediation) `plan.cds-pr684-review-remediation`
  > CDS PR #684 代码审查发现问题的分阶段修复计划与进度追踪

- [MD 转 PPT 下一波（大纲右侧编辑器 + 状态机 + 澄清问卷）](plan.md-to-ppt-next-wave) `plan.md-to-ppt-next-wave`
  > MD 转 PPT 下一波迭代：大纲右侧编辑器、状态机重构、澄清问卷，源自用户 2026-06-10 11 条反馈

### 六、技术债务台账

> 模块级未还工程债（已知边界 / 后续可补 / 留尾风险）。命名规范见 `rule.doc-naming.md` 「debt.* 专项约定」。

- [项目迁移(CDS 项目移植) · 债务台账](debt.cds-project-migration) `debt.cds-project-migration`
  > 配置复刻已落地(dry-run/merge/replace-all 到远端 CDS)；数据全量落库走手动备份/恢复桥接(只读扫描)、accessKey 明文存 state、仅 MongoDB 扫描
- [CDS 过期分支预览页(合并/放弃分流) · 债务台账](debt.cds-removed-branch-pages) `debt.cds-removed-branch-pages`
  > 分支墓碑区分合并/放弃；后续可补 commit 直链、放弃页推荐可用分支、git push --delete 也写墓碑
- [智能体宇宙 · 债务台账](debt.agent-universe) `debt.agent-universe`
  > MVP 边界：仅视觉创作走真实生图、文学图文一体待补、信封仅再加工接入、img2img 占位
- [CDS 极速版（CI 预构建）· 已知边界与遗留事项](debt.cds-ci-prebuilt) `debt.cds-ci-prebuilt`
  > 7 条 open：ghcr 包需手动设 public / 工作流名硬编码 / 每 push 双镜像 / 仍 git pull worktree / 构建时延 / 切回源码非一键 / ClaudeSdk 回调端口
- [知识库版本控制/图片插入/大小统计 · 已知边界](debt.knowledge-base-versioning) `debt.knowledge-base-versioning`
  > 图片插入不刷新已修；版本控制独立集合 + 恢复只写文本不删资产；遗留：github 日同步覆盖手动编辑、大小不含外链图片字节、版本留存上限100
- [LLM 网关协议保真（函数调用穿协议 + 能力软门）· 已知边界](debt.llm-gateway-protocol-fidelity) `debt.llm-gateway-protocol-fidelity`
  > G1-G5 已落地；3 条 open：Claude 流式 tool_use 增量未映射 / 能力软门池路径为 null（best-effort 放行）/ Extensions 容器已建未消费
- [更新中心（终身存储 + SSE 推送）债务台账](debt.changelog-center) `debt.changelog-center`
  > 3 条 open：推送中枢进程内单例（多实例需 Redis/change stream）/ 刷新周期不分视图冷热 / GitHub 日志前端 35s 轮询与 SSE 并存
- [项目管理智能体 · 债务台账](debt.pm-agent) `debt.pm-agent`
  > Phase 1 MVP 仅交付执行层；治理层（干系人/NPSS/奖金/盘点）待 Phase 2-3；Leader 职级强校验待 User 加字段
- [快捷指令 Agent · 债务台账](debt.shortcuts-agent) `debt.shortcuts-agent`
  > 3 条 open：一键安装依赖管理员配 iCloud 模板/macOS 签名（前端无法替代）、Agent 绑定仍是 Phase2 占位、签名直出 409 会露原始 JSON
- [视频生成 Agent · 债务台账](debt.video-agent) `debt.video-agent`
  > 4 条 open：OpenRouter CDN 7 天过期、混合渲染 ffmpeg normalize、直出心跳文案分级、成本预估 tooltip
- [知识库划词评论（批注栏/内联 + 就地输入 + 回读闭环）· 债务台账](debt.kb-inline-comment) `debt.kb-inline-comment`
  > 6 条边界：图片批注未做、inline 卡片定位 MVP、批注栏按时间非锚点排序、批注栏/TOC 互斥、回读为轮询、偏好走 localStorage
- [知识库划词 AI 局部编辑（AI 改写 + 选区配图）· 债务台账](debt.kb-selection-ai) `debt.kb-selection-ai`
  > 8 条边界：歧义选区禁替换、无撤销、无乐观锁、配图定位失败落文末、动作集首批 5 个、仅文本类条目、编辑态无入口、后端编译依赖 CDS

- [工作流 Agent · 债务台账](debt.workflow-agent) `debt.workflow-agent`
  > 7 条 open：video-to-text asr 模式 ASR 池绑定 / maxItems 硬编码 / LlmRequestContext / 转写失败兜底 / ffmpeg 检测 / Play 后无返回 / count 与 maxItems 联动

- [资源存储（IAssetStorage 实现）债务台账](debt.asset-storage) `debt.asset-storage`
  > IAssetStorage 实现层的已知边界与后续优化债务

- [Claude SDK 执行器 / Python sidecar 债务台账](debt.claude-sdk-executor) `debt.claude-sdk-executor`
  > claude-sdk 执行器与 Python sidecar 的已知债务与边界约束

- [CDS Agent 工作台 · 债务台账](debt.cds-agent) `debt.cds-agent`
  > 4 条 open：R1 商业级 provider 闭环 / Lite 只读模式能力边界 / CDS Agent 文档群熵减 / 无 profile 时 Lite 直跑
- [CDS 多分支跨分支隔离 · 债务台账](debt.cds-branch-isolation) `debt.cds-branch-isolation`
  > 2 条 open：同项目多分支共享一张网 + 裸服务别名 → DNS round-robin 串台（worker 调 ai 间歇命中旧分支 404）/ 共享 Redis + BullMQ 无分支前缀 → 别分支旧 worker 抢 job；触发=多服务+多分支并存+代码不一致
- [CDS 后端部署冻结 · 分支 api 跑旧代码](debt.cds-backend-deploy-freeze) `debt.cds-backend-deploy-freeze`
  > open（阻塞）：构建成功≠运行新代码，后端 .cs 改动进不到运行进程；图生视频下载鲁棒修复 + 额度用尽主动提醒已就绪待部署修好后复验
- [视觉分镜台 · 债务台账](debt.visual-storyboard) `debt.visual-storyboard`
  > open：OpenRouter 出图画幅(size/image_config)+modalities 需按模型能力派生 / 拆镜改 SSE 流式逐镜吐出 / 关键帧 ImageGenRun 离场取消（SSE 无同步 runId）

- [MD 转网页 PPT · 债务台账](debt.md-to-ppt) `debt.md-to-ppt`
  > 2 条 open：预览 iframe same-origin 安全债（重构时从隔离源渲染）/ 知识库注入 CDS Agent 会话未实现（UI 已禁用占位）

- [CDS state.json 影子存储 · 债务台账](debt.cds-state-json) `debt.cds-state-json`
  > 4 条 open：webhook deliveries 全量刷盘 / StateService 内存全量加载 / mongo-split 模式 state.json 同步写 / 无独立清理策略

- [CDS compose 模板 TODO secrets · 债务台账](debt.cds-compose-secrets) `debt.cds-compose-secrets`
  > 2 条 open：x-cds-env TODO secrets 致全量 import 必被拒 / admin static 每次冷 vite build 就绪窗口紧绷

- [CDS 教程（示例工程 + 隔离知识库 + 评分/自愈）· 债务台账](debt.cds-tutorial) `debt.cds-tutorial`
- [CDS 绝对可视化一键部署 · 债务台账](debt.cds-visual-deploy) `debt.cds-visual-deploy`
  > 5 条 open：--write 重序列化丢注释 / 自愈覆盖面有限 / 占位值需人工 / 真机冒烟依赖 CDS / 发布脚本需真实 owner

- [演讲智能体 · 债务台账](debt.speech-agent) `debt.speech-agent`

- [团队动态（团队脉搏）· 债务台账](debt.team-activity) `debt.team-activity`
  > 6 条边界：排行按原始计数可刷量 / 直方图近 5000 条采样 / 整小时时区近似 / 环比同长上一窗 / TargetUrl 深链未通 / 鉴权态验收依赖人工
  > 11 条 open：输入仅支持粘贴 / 视图非画布 / 无 Run-Worker / 无配图 / 无备注 / 无播放态 / 无发布 / 白天主题待适配 / 无节点增删 / 无 chunk / CDS 自测待补

- [LLM 网关与模型池统一迁移债务台账](debt.llm-gateway) `debt.llm-gateway`
  > 19 条 open：接口绑平台(3处漂移) / 死策略引擎 / legacy承重(60%) / 3个死池被legacy静默兜住 / 45%静默fallback无告警 / 生图默认走stub / 池泛滥孤儿 / 平台化(退役老sk网关/配额stub/模型名公开契约) / 等
- [知识库（AI Toolbox attachment + 文档空间）债务台账](debt.knowledge-base) `debt.knowledge-base`
  > 8 条 open：两套并存模型 / RAG embedding 未做 / wip 标签 CI 守卫 / 上传 API 不互通 / 等

- [知识库引用网络 · 债务台账](debt.knowledge-base-mention-network) `debt.knowledge-base-mention-network`
  > 双链/反向链接/宇宙图 MVP 后续债务：跨实体引用、AI 自动补链、时间轴回放等候选项

- [网页托管 · 债务台账](debt.web-hosting) `debt.web-hosting`
  > 3 条 open：reveal 纵向子页 remap / 合成事件 isTrusted=false 长尾 / 未覆盖工作流生成内容

- [功能验收体系 · 债务台账](debt.acceptance-system) `debt.acceptance-system`
  > 标准创建/执行/结果三方经知识库打通的未来架构：分阶段还债（先 schema 化+版本绑定，后拆 Agent），含触发条件与 YAGNI 边界

- [知识库跨环境同步 · 债务台账](debt.document-store-sync) `debt.document-store-sync`
  > 库↔库/跨环境同步首版已知边界：不传播删除、只搬文本、双向冲突本地优先、库级变更检测、令牌永久、需网络互通

- [分享链接安全债务台账](debt.share-link-security) `debt.share-link-security`
  > 分享链接系统的已知安全边界与待补项

- [网页托管真实客户端 IP 债务台账](debt.web-hosting-client-ip) `debt.web-hosting-client-ip`
  > XFF 解析的私网链伪造边界与彻底方案（需部署侧可信代理配置）

- [团队（网页托管 + 知识库）债务台账](debt.team-feature) `debt.team-feature`
  > 团队 wave 1 已知边界：回收站未做 / KB 次要端点仍 owner-only / 公共团队仅留字段 / 邀请链接路由 / 旧条目头像兜底
- [验收技能（create-visual-test-to-kb）债务台账](debt.visual-acceptance-skill) `debt.visual-acceptance-skill`
  > 验收技能 wave 1 已落地强制必给地址 + ZZ 照做风 + 画框序号；待补自动 diff 画框 / 流程缩略图 / AI 文案 / AI 视觉判定；明确不做录屏 + 自动镜头
- [小技巧与首页提醒过时机制债务台账](debt.daily-tips) `debt.daily-tips`
  > 小技巧/缺陷提醒 1 周过时机制的已知边界（历史数据不回填、存量环境需 seed 一次）
- [殿堂阅读器（克莱风暖色）保留未融合 DocBrowser 的债务台账](debt.library-doc-reader) `debt.library-doc-reader`
  > LibraryDocReader 720 行刻意做了米黄+圆体字+暖色调差异化品牌，融合需先做 DocBrowser 皮肤系统；记录重启评估的 4 个触发条件，避免下次重复调研
- [周报详情页（异构数据）保留独立实现的债务台账](debt.report-detail) `debt.report-detail`
  > ReportDetailPage 900 行业务实体（成员×周次矩阵 + 多 tabs + 计划对比 + 右栏面板），不是文档库语义；融合需先给 DocBrowser 加 leftSidebar/rightPanel/entryBadges 三 slot 系统
- [开放接口对外网关债务台账](debt.open-api) `debt.open-api`
  > Phase 1 落地网关 + 按 Key 绑定 + 默认回落 + 导航修复；伞形 appCallerCode 静态注册不变量（守卫测试）；限流按 Key 桶 / 降级预警 / 配额 / embeddings 分到 Phase 2

- [日报技能债务台账](debt.daily-report) `debt.daily-report`
  > daily-report-summary 技能与 reference/publish.py 的已知边界与待补项

- [系统级跨节点互传（Peer Sync）债务台账](debt.peer-sync) `debt.peer-sync`
  > prd-api PeerSync + prd-admin 系统互联的已知边界与 Phase 2 待补功能

- [个人任务树 Agent · 债务台账](debt.task-tree) `debt.task-tree`
  > TaskTreeController + prd-admin pages/task-tree 的已知边界与后续可补项

- [网页托管评论 · 债务台账](debt.web-hosting-comments) `debt.web-hosting-comments`
  > 网页托管评论功能的已知边界与待补实现

- [MAP MCP 连接器 · 债务台账](debt.map-mcp-connector) `debt.map-mcp-connector`
  > MAP MCP 连接器核心链路已上线，债务台账记录 PR #836 后显式延后的硬化项（共 4 条，open 3）

- [行为洞察 / VOC 体验之声 工程债务台账](debt.voc) `debt.voc`
  > 行为洞察页面已知边界、待建造项（顶部 ribbon 流式动画、VOC 信息流等）与跨 session 债务

- [移动端控制条过载治理台账](debt.mobile-control-bar-overload) `debt.mobile-control-bar-overload`
  > 移动端控制条过载问题（知识库/缺陷/周报/海鲜市场等页面，进内容前控制条 >1 条），治理机制与进度

### 七、周报

- [智能体宇宙 · 完备度看板](report.agent-universe-completeness) `report.agent-universe-completeness`
  > 各智能体完备度看板：终极目标、当前进度、TodoList、目前情况、风险点（当前加权进度约 55%）

- [CDS 绝对可视化一键部署 · 完整报告](report.cds-visual-deploy) `report.cds-visual-deploy`
- [CDS Agent 商业级可用闭环目标审计报告](report.cds-agent-goal-completion-audit-2026-05-19) `report.cds-agent-goal-completion-audit-2026-05-19`
  > CDS Agent 商业级可用闭环目标的完成度审计报告（2026-05-19）
- [CDS Agent 体验修复验收报告](report.cds-agent-ux-acceptance-2026-06-06) `report.cds-agent-ux-acceptance-2026-06-06`
  > 用户 9 问逐条验收：发送卡死/不流式/噪声/展开空已修并取证；工具循环/线程不停在借来的 runtime（缓解）；工作区文件注入是需新建的接缝（gates md→ppt 案例）

- [CDS Agent P4-1 远端发布前验收与试用入口报告](report.cds-agent-p4-1-remote-preflight-2026-05-19) `report.cds-agent-p4-1-remote-preflight-2026-05-19`
  > CDS Agent P4-1 远端发布前验收与试用入口的验收报告

- [CDS Agent P4-2 远端 Provider 闭环验收报告](report.cds-agent-p4-2-provider-closure-2026-05-19) `report.cds-agent-p4-2-provider-closure-2026-05-19`
  > CDS Agent P4-2 远端 Provider 闭环验收报告

- [CDS Agent P4-3 远端试用入口与发布验收包](report.cds-agent-p4-3-remote-trial-acceptance-2026-05-19) `report.cds-agent-p4-3-remote-trial-acceptance-2026-05-19`
  > CDS Agent P4-3 远端试用入口与发布验收包

- [CDS Agent P4-4 发布/合并策略评估报告](report.cds-agent-p4-4-release-merge-strategy-2026-05-19) `report.cds-agent-p4-4-release-merge-strategy-2026-05-19`
  > CDS Agent P4-4 发布与合并策略的评估报告

- [CDS Agent P4-5 writable/PR/KB apply 试用计划](report.cds-agent-p4-5-writable-trial-plan-2026-05-19) `report.cds-agent-p4-5-writable-trial-plan-2026-05-19`
  > CDS Agent P4-5 writable / PR / KB apply 试用计划

- [CDS Agent Phase 1 验收报告](report.cds-agent-phase1-acceptance-2026-05-19) `report.cds-agent-phase1-acceptance-2026-05-19`
  > CDS Agent Phase 1 阶段验收报告（2026-05-19）

- [CDS Agent Phase 2 验收报告](report.cds-agent-phase2-acceptance-2026-05-19) `report.cds-agent-phase2-acceptance-2026-05-19`
  > CDS Agent Phase 2 阶段验收报告（2026-05-19）

- [CDS Agent Phase 3 验收报告](report.cds-agent-phase3-acceptance-2026-05-19) `report.cds-agent-phase3-acceptance-2026-05-19`
  > CDS Agent Phase 3 阶段验收报告（2026-05-19）

- [CDS Agent 执行过程账本](report.cds-agent-execution-ledger-2026-05-18) `report.cds-agent-execution-ledger-2026-05-18`
  > CDS Agent 开发执行过程的完整账本记录（2026-05-18）

- [CDS Agent SDK Runtime 再次侵入 MAP 主系统 · 调查报告](report.cds-agent-runtime-pool-contamination-2026-05-18) `report.cds-agent-runtime-pool-contamination-2026-05-18`
  > CDS Agent SDK Runtime 再次侵入 MAP 主系统的调查与根因分析报告（2026-05-18）

- [CDS Agent sidecar 侵入 MAP 分支服务 · 调查报告](report.cds-agent-sidecar-contamination-2026-05-18) `report.cds-agent-sidecar-contamination-2026-05-18`
  > CDS Agent sidecar 侵入 MAP 分支服务的调查报告（2026-05-18）

- [Claude Agent SDK 容器侵入 MAP 主系统 · 根因报告](report.claude-agent-sdk-map-intrusion-root-cause-2026-05-18) `report.claude-agent-sdk-map-intrusion-root-cause-2026-05-18`
  > Claude Agent SDK 容器侵入 MAP 主系统的根因分析报告（2026-05-18）

- [CDS Agent 当前进度面板](report.cds-agent-current-progress) `report.cds-agent-current-progress`
  > CDS Agent 当前开发进度与状态面板（已合并到权威入口）

- [CDS Agent 工作台完成复盘（2026-05-15）](report.cds-agent-workbench-2026-05-15) `report.cds-agent-workbench-2026-05-15`
  > CDS Agent 工作台从连接探活到远程 sandbox 自巡检 PR 闭环的功能清单、坑位、未完成债务和交接提示词

- [周报 2026-W25 (06-15 ~ 06-21)](report.2026-W25) `report.2026-W25`
  > 2026 年第 25 周工作总结（288 commits / 27 PRs，W24 峰值后的归途收口周：缺陷自动化闭环正式合龙 defect-agent v3+控制台 UI+精确领取+证据链+授权窄 scope、CDS 灰度预览体感升级 构建 ETA+本地账号登录+验收报告项目级鉴权+mongo-split 写入合并+持久化投影剥离 runtime 派生、视觉创作首页重新设计+上传压缩保留透明通道+视频本地超时取消后端 run、知识库图片插入/版本恢复/大库分页三老 Bug 收口、网页托管 PDF 改 PDF.js 治微信打开空白、产品蓝图 Wave1+Wave2+PRD 多轮改稿+设备素材本地上传、教程飞回入口 pill 弹簧接住光效、新增 expectation-management/content-fills-canvas 两条系统规则；fix 占比 50% 名副其实归途周）

- [周报 2026-W24 (06-08 ~ 06-14)](report.2026-W24) `report.2026-W24`
  > 2026 年第 24 周工作总结（566 commits / 56 PRs，6 周以来最忙的一周：PM Agent Phase 2 全屏改版+AI 工作台+跨项目报表+P3 里程碑详情+AI 项目简报、Product Agent 立项 v1+TAPD 数字编号统一、MD 转 PPT 锚定 deck 模式+流式逐页大纲+模型池直选、知识库双链 v2+反向链接+Obsidian 风宇宙图+划词 AI 局部编辑、CDS 资源工作台协议+数据库工作台闭环+SSH 发布作战台+Agent 请求观测台、跨项目密钥隔离穿透事故复盘+平台密钥自检自愈、三个新智能体上线 TAPD 缺陷提报/商品溯源/识途、团队动态+行为洞察、网页托管团队空间 P0~P2、教程系统 v3 我已学会退出口+飞回动画半速+轻微提醒更新子类）

- [周报 2026-W23 (06-01 ~ 06-07)](report.2026-W23) `report.2026-W23`
  > 2026 年第 23 周工作总结（215 commits / 18 PRs，PM Agent Phase 1 完整体系、智能体宇宙能力契约 + 统一调用信封、多页面教程系统从悬浮图标迁移到页头常驻 pill、CDS 基础设施单一 SSOT + 一键部署闭环、知识库列表两次反复改造、网页托管 5 个边界 bug 收口）

- [周报 2026-W22 (05-25 ~ 05-31)](report.2026-W22) `report.2026-W22`
  > 2026 年第 22 周工作总结（250 commits / 24 PRs，智能体爆发周：CCAS + Project Route + PM + 个人任务树一周新增 4 个 Agent；验收技能 create-visual-test-to-kb 标准化；CDS 自更新链路重构 + 教程体系 + compose 评分自愈；网页托管角色细分 + 分享面板 + 站点评论；CDS Agent Lite 降级）

- [周报 2026-W21 (05-18 ~ 05-24)](report.2026-W21) `report.2026-W21`
  > 2026 年第 21 周工作总结（160 commits / 20 PRs，分享链接安全加固 /s/{token} 统一、周报编辑器 Notion 式大改造 + 时间树视图、CDS Agent 官方 SDK 边界合入、CDS 容器可观测性收口、预览 URL SSOT 化）

- [周报 2026-W20 (05-11 ~ 05-17)](report.2026-W20) `report.2026-W20`
  > 2026 年第 20 周工作总结（702 commits / 28 PRs，知识库文档浏览器、作品广场动态列数 + 头像筛选、多类型资源预览、统一短链基础设施、CDS Agent runtime SDK 探索与熔断教训、老王智能体 + issues 三技能）

- [周报 2026-W19 (05-04 ~ 05-10)](report.2026-W19) `report.2026-W19`
  > 2026 年第 19 周工作总结（310 commits / 15 PRs，CDS 蓝绿/Forwarder 架构落地、自更新十八轮收尾、五平台博主订阅 → 首页海报 Phase 2+3、Claude SDK 执行器 + CDS-MAP 配对协议 v1）

- [周报 2026-W18 (04-27 ~ 05-03)](report.2026-W18) `report.2026-W18`
  > 2026 年第 18 周工作总结（222 commits / 23 PRs，CDS 控制台 React 化大重命名、Week 4.6 视觉重构九刀、MySQL 接入 9 Phase + 15 轮 Bugbot、多项目隔离、env 边界根治、浅色 P0+P1+P2 像素级精修）

- [周报 2026-W17 (04-20 ~ 04-26)](report.2026-W17) `report.2026-W17`
  > 2026 年第 17 周工作总结（363 commits / 43 PRs，开闸+多线并行周：LLM Gateway compute-then-send 重构、周报浅色三波、海鲜市场 sk-ak 长效凭据、Daily Tips 全栈、CDS 多项目隔离 + 主题一劳永逸、移动端 Apple Today、用户自定义导航）

- [周报 2026-W16 (04-13 ~ 04-19)](report.2026-W16) `report.2026-W16`
  > 2026 年第 16 周工作总结（329 commits / 38 PRs，CDS 多项目化收官与 GitHub 自动部署闭环）

- [周报 2026-W15 (04-06 ~ 04-12)](report.2026-W15) `report.2026-W15`
  > 2026 年第 15 周工作总结（301 commits / 39 PRs，CDS 平台化升级与首页重写）

- [周报 2026-W14 (03-30 ~ 04-05)](report.2026-W14) `report.2026-W14`
  > 2026 年第 14 周工作总结（95 commits / 12 PRs，文档空间起步与 Page Agent Bridge 开工）

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

- [CDS Self-Update 耗时观察记录（2026-05-13）](report.cds-self-update-timing-observation-2026-05-13) `report.cds-self-update-timing-observation-2026-05-13`
  > CDS 自更新流程各阶段耗时的实测观察与数据记录（2026-05-13）

- [CDS 项目卡片基础设施误读审计报告（2026-05-12）](report.cds-project-card-infra-audit-2026-05-12) `report.cds-project-card-infra-audit-2026-05-12`
  > CDS 项目卡片基础设施节点误读问题的审计与修复报告

- [CDS GitHub 自动部署验收报告（2026-05-11）](report.cds-github-auto-deploy-acceptance-2026-05-11) `report.cds-github-auto-deploy-acceptance-2026-05-11`
  > CDS GitHub 自动部署 webhook 链路验收测试报告

- [CDS Forwarder 替代蓝绿部署收尾报告](report.cds-forwarder-success) `report.cds-forwarder-success`
  > Forwarder 独立进程方案成功取代蓝绿部署的验收报告

- [CDS Self-Update 时间体系审视报告](report.cds-self-update-timing-audit) `report.cds-self-update-timing-audit`
  > CDS 自更新流程中时间戳体系的问题分析与修复报告

- [prd-admin 样式统一统计报表](report.prd-admin-surface-style-migration) `report.prd-admin-surface-style-migration`
  > prd-admin Surface System 迁移完成度的统计数据报表

- [周报 MAP 平台工作记录准确性修复](report.weekly-map-data-accuracy-fix-2026-04-10) `report.weekly-map-data-accuracy-fix-2026-04-10`
  > MAP 平台工作记录数据准确性问题的修复过程报告

- [PRD Agent Web 端同步开发报告](report.prd-agent-web-sync) `report.prd-agent-web-sync`
  > PRD Agent Web 端与桌面端同步开发的完整报告

- [CDS Onboarding UAT 终结报告](report.cds-onboarding-uat) `report.cds-onboarding-uat`
  > 18 friction 全清单 + 4 audit 子结果(隔离/SSE/UI/mysql)+ 41 契约对照 + 真人 UAT 剩余清单（合并自原 5 个子文件）

- [文档技能评测报告](report.skill-doc-evaluation) `report.skill-doc-evaluation`
  > 三种文档技能 vs 已有文档的评测对比报告

- [文档技能评测·user-guide-writing 样本输出](report.skill-eval-sample-user-guide) `report.skill-eval-sample-user-guide`
  > 评测报告引用的 skill 原始输出样本（用户操作指南类）

- [文档技能评测·technical-writing 样本输出](report.skill-eval-sample-technical) `report.skill-eval-sample-technical`
  > 评测报告引用的 skill 原始输出样本（技术规格类）

- [文档技能评测·documentation-writer 样本输出](report.skill-eval-sample-diataxis) `report.skill-eval-sample-diataxis`
  > 评测报告引用的 skill 原始输出样本（Diátaxis 四象限类）

- [CDS Mongo 日志拆分事故复盘（2026-05-23）](report.cds-mongo-log-split-incident-2026-05-23) `report.cds-mongo-log-split-incident-2026-05-23`
  > CDS 控制面 cds-master 崩溃导致 502 的事故根因分析与复盘

---

## 变更历史

| 日期 | 操作 | 文件名 | 中文标题 |
| :--- | :--- | :--- | :--- |
| 2026-06-21 | 新增 | `report.2026-W25` | 2026-W25 周报（06-15 ~ 06-21）：W24 峰值后归途收口周，缺陷自动化闭环合龙 + CDS 灰度预览体感升级 + 视觉/知识库收口 + 两条新系统规则 |
| 2026-06-21 | 新增 | `.claude/rules/expectation-management.md` | 预期管理总纲：让用户任何时刻知道在做什么/还要多久/接下来怎样/刚才变了什么/我该做什么 |
| 2026-06-21 | 新增 | `.claude/rules/content-fills-canvas.md` | 内容填满画布：主产物必须 flex-1 占主导，禁内容小盒子 + 大留白 |
| 2026-06-21 | 新增 | `doc/debt.cds-branch-isolation.md` | CDS 多分支跨分支隔离债务台账 |
| 2026-06-21 | 新增 | `doc/spec.defect-agent-automation-protocol.md` | 缺陷自动化协议契约 SSOT |
| 2026-06-19 | 新增 | `debt.visual-storyboard` | 视觉分镜台债务台账：OpenRouter 出图画幅/modalities 按能力派生 + 拆镜 SSE 流式 + 关键帧 ImageGenRun 离场取消 |
| 2026-06-19 | 新增 | `debt.cds-backend-deploy-freeze` | CDS 后端部署冻结台账：分支 api 跑旧代码（构建成功≠运行新代码）+ 图生视频下载修复/额度提醒待部署复验 |
| 2026-06-04 | 新增 | `report.tutorial-coverage` `debt.onboarding-tips` | 页面教程系统统一升级:全量路由覆盖审计 + 债务台账(video-agent/薄教程加厚/编辑器/跨页待补) |
| 2026-06-02 | 新增 | `design.agent-universe` `debt.agent-universe` | 智能体宇宙设计（能力契约 + 调用信封）与债务台账 |
| 2026-06-02 | 新增 | `design.cds-visual-deploy` `guide.cds-one-click-deploy` `report.cds-visual-deploy` `debt.cds-visual-deploy` | CDS 绝对可视化一键部署收尾:设计(含架构图)+使用教程+完整报告+债务台账;`plan.cds-visual-deploy` 状态更新为核心收尾 |
| 2026-06-01 | 新增 | `design.cds-ai-compose` `plan.cds-visual-deploy` `guide.cds-deploy-acceptance` | CDS AI 生成 compose 草稿设计、绝对可视化部署计划看板、可视化部署与验收指南（已发布到 KB） |
| 2026-05-30 | 新增 | `debt.cds-agent` | CDS Agent 工作台债务台账（R1 商业级 / Lite 只读边界 / 文档熵减 / 无 profile 直跑） |
| 2026-05-22 | 新增 | `design.defect-agent-share-skill-architecture` `debt.share-link-security` `report.cds-mongo-log-split-incident-2026-05-23` | 缺陷分享架构设计、分享链接安全债务台账、CDS Mongo 事故复盘 |
| 2026-05-15 | 新增 | `design.cds-agent-runtime-architecture` | CDS Agent 运行时架构设计 |
| 2026-05-15 | 新增 | `report.cds-agent-workbench-2026-05-15` `guide.cds-agent-workbench-reproduce` `guide.cds-agent-next-agent-testing` | CDS Agent A10 完成复盘、复现教程、下一代测试与涌现建议 |
| 2026-05-14 | 新增 | `guide.cds-agent-workbench` `guide.cds-agent-admin` `design.cds-agent-api` `guide.cds-agent-runbook` | CDS Agent 完全可用文档闭环 |
| 2026-05-11 | 补齐 | 批量 | 补齐 57 个长期未登记文档（spec×4 / design×17 / guide×16 / rule×6 / plan×6 / debt×2 / report×5 + 文件重命名 2 个 + index.yml 同步 53 条） |
| 2026-05-07 | 新增 | `guide.poster-feed-card` | 多平台博主订阅 → 首页海报弹窗（涌现 1 Phase 3 用户教程：5 平台 + 4 版式 + ASR 字幕） |
| 2026-05-07 | 调整 | `plan.emergence-1-tiktok-douyin-poster` | Phase 3 已交付，新增 §3 多平台 / media-rehost / feed-card / ASR 字幕 + §3.7 关键文件 + §3.8 已知边界 |
| 2026-05-07 | 调整 | `debt.workflow-agent` | v2.0：Phase 2 留尾 7 项全部 paid，新增 5 项 open（CDS dev 模式 hot-reload / B站 YouTube 无 mp4 / 小红书图集 / avatar 防盗链 / cues 仅 ASR 模式） |
| 2026-06-14 | 新增 | `report.2026-W24` | 周报 2026-W24 (06-08 ~ 06-14) |
| 2026-06-07 | 新增 | `report.2026-W23` | 周报 2026-W23 (06-01 ~ 06-07) |
| 2026-06-07 | 新增 | `report.2026-W22` | 周报 2026-W22 (05-25 ~ 05-31) |
| 2026-05-24 | 新增 | `report.2026-W21` | 周报 2026-W21 (05-18 ~ 05-24) |
| 2026-05-24 | 新增 | `report.2026-W20` | 周报 2026-W20 (05-11 ~ 05-17) |
| 2026-05-09 | 新增 | `report.2026-W19` | 周报 2026-W19 (05-04 ~ 05-10) |
| 2026-05-09 | 新增 | `report.2026-W18` | 周报 2026-W18 (04-27 ~ 05-03) |
| 2026-05-09 | 新增 | `report.2026-W17` | 周报 2026-W17 (04-20 ~ 04-26) |
| 2026-05-06 | 新增 | `debt.workflow-agent` | 工作流 Agent · 债务台账（涌现 1 Phase 2 任务 A/B/C 留尾 7 项） |
| 2026-05-06 | 调整 | `plan.emergence-1-tiktok-douyin-poster` | Phase 2 任务 A/B/C 已交付，新增 §2 完整交付总览 + §2.6 已知边界 |
| 2026-04-26 | 新增 | `debt.video-agent` | 视频生成 Agent · 债务台账（首个 debt.* 文件，落地方案 A） |
| 2026-04-26 | 调整 | `rule.doc-naming` | 文档命名规则 v3.1：新增 `debt.*` 类型前缀 + 专项约定 |
| 2026-04-21 | 新增 | `plan.daily-tips-remaining-work` | 每日小贴士功能 — 剩余工作交接文档 |
| 2026-04-20 | 新增 | `report.2026-W16` | 周报 2026-W16 (04-13 ~ 04-19) |
| 2026-04-20 | 新增 | `report.2026-W15` | 周报 2026-W15 (04-06 ~ 04-12) |
| 2026-04-20 | 新增 | `report.2026-W14` | 周报 2026-W14 (03-30 ~ 04-05) |
| 2026-04-19 | 重命名 | `output-user-guide-writing` → `report.skill-eval-sample-user-guide` | 文档技能评测·user-guide-writing 样本输出 |
| 2026-04-19 | 重命名 | `output-technical-writing` → `report.skill-eval-sample-technical` | 文档技能评测·technical-writing 样本输出 |
| 2026-04-19 | 重命名 | `output-documentation-writer` → `report.skill-eval-sample-diataxis` | 文档技能评测·documentation-writer 样本输出 |
| 2026-03-31 | 新增 | `report.2026-W13` | 周报 2026-W13 (03-23 ~ 03-29) |
| 2026-03-31 | 新增 | `design.llm-gateway` | LLM Gateway 统一调用架构设计 |
| 2026-03-31 | 新增 | `design.marketplace` | 配置市场（海鲜市场）技术设计 |
| 2026-03-31 | 新增 | `design.rbac-permission` | RBAC 权限系统设计 |
| 2026-03-31 | 新增 | `design.report-agent` | 周报管理 Agent 架构设计 |
| 2026-03-31 | 新增 | `design.review-agent` | 产品评审员技术设计文档 |
| 2026-03-31 | 新增 | `design.system-emergence` | 系统涌现：从基础组件到协同智能 |
| 2026-03-31 | 新增 | `design.visual-agent` | Visual Agent 架构设计 |
| 2026-03-31 | 新增 | `guide.mongodb-indexes` | MongoDB 索引手册 |
| 2026-03-31 | 新增 | `guide.doubao-asr-relay` | 豆包 ASR 模型中继接入指南 |
| 2026-03-31 | 新增 | `spec.submission-gallery` | 作品投稿与画廊展示规格 |
| 2026-03-31 | 新增 | `plan.design-doc-optimization` | Design 文档优化项目进度 |
| 2026-05-03 | 新增 | `plan.cds-status` | CDS 当前状态看板（唯一"我在哪"入口） |
| 2026-05-03 | 新增 | `report.cds-onboarding-uat` | CDS Onboarding UAT 终结报告（合并自 5 个子文件） |
| 2026-05-03 | 删除 | `report.cds-handoff-2026-04-16` `report.cds-phase-b-e-handoff-2026-04-14` `guide.cds-handoff-2026-05-01` `guide.cds-web-migration-handoff` `report.cds-api-full-test-2026-03-28` `report.cds-railway-alignment` `plan.cds-mysql-readiness` `plan.cds-onboarding-uat-completion` `plan.cds-github-integration-followups` `report.cds-onboarding-uat-completion` `report.cds-onboarding-uat-ui-walkthrough` `report.cds-isolation-audit` `report.cds-server-authority-audit` | CDS 文档整合归档 13 个过期 / 已合并文件，进度统一改读 `plan.cds-status.md` |
| 2026-03-31 | 替换 | `design.im-architecture` → `design.llm-gateway` | IM 架构文档替换为 LLM Gateway |
| 2026-03-31 | 批量更新 | 37 篇 `design.*` | 补全管理摘要、头部信息与废弃标注 |
| 2026-03-28 | 新增 | `guide.review-agent` | 产品评审员使用手册 |
| 2026-03-23 | 新增 | `design.generation-snapshot` | 生成快照设计 |
| 2026-03-23 | 新增 | `guide.cds-ai-auth` | CDS + 后端 API 双层认证诊断指南 |
| 2026-03-23 | 新增 | `guide.prd-agent-operations` | PRD Agent 全平台操作手册 |
| 2026-03-23 | 新增 | `guide.skill-workflow` | AI 技能工作流指南 |
| 2026-03-23 | 新增 | `report.prd-agent-web-sync` | PRD Agent Web 端同步开发报告 |
| 2026-03-23 | 更新 | `report.2026-W12` | 周报 2026-W12 (全量重写) |
| 2026-03-20 | 新增 | `report.2026-W12` | 周报 2026-W12 (03-16 ~ 03-22) |
| 2026-03-20 | 新增 | `guide.prd-agent` | PRD Agent 使用教程 |
| 2026-03-20 | 新增 | `guide.visual-agent` | 视觉创作 Agent 使用教程 |
| 2026-03-20 | 新增 | `guide.literary-agent` | 文学创作 Agent 使用教程 |
| 2026-03-20 | 新增 | `guide.defect-agent` | 缺陷管理 Agent 使用教程 |
| 2026-03-20 | 新增 | `guide.video-agent` | 视频创作 Agent 使用教程 |
| 2026-03-20 | 新增 | `guide.report-agent` | 周报管理 Agent 使用教程 |
| 2026-03-20 | 新增 | `guide.arena` | AI 竞技场使用教程 |
| 2026-03-20 | 新增 | `guide.workflow-agent` | 工作流引擎使用教程 |
| 2026-03-20 | 新增 | `guide.shortcuts-agent` | 快捷指令使用教程 |
| 2026-03-20 | 新增 | `guide.marketplace` | 海鲜市场（配置市场）使用教程 |
| 2026-03-20 | 新增 | `guide.workflow-canvas` | 工作流画布操作手册 |
| 2026-03-20 | 新增 | `guide.weekly-report` | 周报功能完整操作指南 |
| 2026-03-20 | 新增 | `design.model-pool-failover` | 模型池故障转移与自动探活设计 |
| 2026-03-20 | 新增 | `report.skill-doc-evaluation` | 文档技能评测报告 |
| 2026-03-15 | 新增 | `report.2026-W11` | 周报 2026-W11 (03-09 ~ 03-15) |
| 2026-03-15 | 新增 | `spec.cds` | CDS 功能需求说明书 |
| 2026-03-15 | 新增 | `design.apple-shortcuts` | 苹果快捷指令集成设计方案 |
| 2026-03-15 | 新增 | `design.cds-onboarding` | CDS 极简上手设计 |
| 2026-03-15 | 新增 | `guide.cds-env` | CDS 环境变量配置指南 |
| 2026-03-15 | 新增 | `guide.troubleshooting` | 疑难杂症排查手册 |
| 2026-03-15 | 新增 | `plan.cds-deployment` | CDS 部署规划 |
| 2026-03-15 | 新增 | `plan.cds-roadmap` | CDS 产品路线图 |
| 2026-03-15 | 新增 | `plan.report-agent-v3` | Report Agent v3.0 升级方案 |
| 2026-03-15 | 移除 | `design.agent-dashboard` | Agent Dashboard 设计文档（文件已删除） |
| 2026-03-11 | 重排 | `index.yml` + `guide.list.directory.md` | 按阅读优先级重新排序文档索引 |
| 2026-03-10 | 新增 | `index.yml` | 文档元数据索引 |
| 2026-03-10 | 新增 | `guide.list.directory.md` | 文档索引目录页 |
| 2026-06-10 | 新增 | `debt.cds-nginx-loading-pages` | CDS loading pages 债务台账 |
| 2026-06-10 | 新增 | `design.cds-skill-version-update` | CDS 技能版本与更新架构 |
| 2026-06-10 | 新增 | `plan.product-agent-version-workflow` | 产品管理智能体版本流程整改计划 |
| 2026-06-20 | 新增 | `design.team-activity-voc` | 团队动态·用户体验之声(VOC) 设计（treemap + 痛点指数 + 闭环 + 设计思想） |
| 2026-06-11 | 新增 | `report.version-20260610-1-summary` | version-20260610-1 分支改动说明 |
| 2026-06-21 | 新增 | `debt.cds-performance` | CDS 性能债务台账（Docker 垃圾堆积致构建越来越慢 + mongo 索引非主因结论 + 逐步解决路线） |
| 2026-06-22 | 新增 | `debt.mobile-control-bar-overload` | 移动端控制条过载治理台账（知识库/缺陷/周报等页面，进内容前控制条 >1 条，治理机制与进度） |
