# 文学创作 Agent (Literary Agent) · 设计

> **版本**：v1.0 | **日期**：2026-03-28 | **状态**：已实现
>
> **appKey**：`literary-agent`

## 一、管理摘要

- **解决什么问题**：内容创作者写完文章后，配图环节繁琐——需要手动寻找合适的图片位置、编写生图 prompt、逐张生成、下载、插入文章，整个过程耗时且割裂
- **方案概述**：提供文学创作工作空间，支持文章上传 → AI 自动标注配图位置 → 批量生图 → 带图导出的全流程自动化，同时复用 VisualAgent 的生图引擎
- **业务价值**：将"写完文章到拿到带图成品"的时间从 2 小时缩短到 5 分钟；提示词和参考图可发布到市场供他人复用，形成创作资产沉淀
- **影响范围**：prd-api（4 个 Controller 共 2300+ 行）、prd-admin（5+ 前端页面）、VisualAgent（复用生图引擎）、市场系统
- **当前状态**：已实现，持续迭代。与 VisualAgent 共享底层生图能力，独立维护创作流程和提示词体系

## 二、产品定位

**一句话**：AI 驱动的文学创作助手——写作配图一条龙，创作资产可沉淀。

**目标用户**：

| 角色 | 核心需求 | 使用频率 |
|------|----------|----------|
| 内容创作者 | 写文章 → 自动配图 → 导出成品 | 每天 |
| 提示词工程师 | 精调提示词模板 → 发布到市场供他人使用 | 每周 |
| 团队管理员 | 管理参考图库、提示词库，统一团队创作风格 | 按需 |

**设计理念**：

- **阶段式工作流**：上传 → 预览编辑 → AI 标注配图位置 → 批量生图 → 导出。每个阶段可回退，提交型修改自动清空后续阶段
- **服务器权威**：工作流状态（`ArticleIllustrationWorkflow`）由服务端管理，浏览器刷新后恢复到正确阶段
- **创作资产化**：提示词和参考图不只是"用完即弃"的参数，而是可发布、可复用、可 fork 的创作资产

## 三、用户场景与协同涌现

### 场景 1：小说作者的一天

> 网文作者小周每天更新 3000 字章节，需要 3 张配图。

1. 小周写好章节 → 上传到 Literary Agent 工作空间
2. 选择"玄幻风格"提示词模板 + 激活"水墨参考图"
3. 点击"生成配图标记" → AI 在 3 个场景描写段落标注 `[插图]: 描述`
4. 小周微调描述（如"把'一片森林'改成'黑暗森林中透出微光'"）
5. 点击"开始生图" → SSE 实时推送"正在生成第 2/3 张…"
6. 3 张配图完成 → 导出带图文章 → 发布

**以前**：去 Midjourney 生图 → 下载 → 用 PS 调整 → 手动插入文章 → 约 40 分钟。
**现在**：上传 → 标注 → 生图 → 导出 → 约 5 分钟。

### 场景 2：提示词资产沉淀与复用

> 团队有 10 个创作者，每人调出了自己擅长的风格提示词。

1. 资深创作者将"水彩插画风"提示词发布到市场（`/publish`）
2. 新人在市场浏览 → Fork 到自己的提示词库
3. 新人基于 Fork 的提示词微调，形成自己的变体
4. 市场记录 ForkCount → 最受欢迎的提示词浮到顶部

**创作资产化**：提示词不再是"用完就忘的一句话"，而是可积累、可传播、可追溯的团队知识资产。

### 场景 3：内容创作流水线（与 VisualAgent + Video Agent 协同）

> 运营需要一篇文章 → 配图 → 短视频 → 展示网页的全套内容。

1. Literary Agent：接收主题 → LLM 生成文章 → AI 标注配图位置
2. 工作流触发 → VisualAgent 批量生成配图
3. 配图完成 → 工作流触发 → Video Agent 将文章 + 配图转为短视频分镜
4. 视频生成完成 → 网页生成舱 → 生成展示页面 → 站点发布

**协同涌现**：运营说了一个主题，系统产出了文章 + 配图 + 视频 + 网页。Literary Agent 负责文字和标注，VisualAgent 负责图片，Video Agent 负责视频，工作流负责编排。

### 场景 4：风格统一的批量创作（与工作流协同）

> 电商团队需要 50 篇产品描述文章，每篇 3 张统一风格配图。

1. 管理员配置工作流：数据源（产品列表 CSV）→ LLM 分析舱（生成文章）→ Literary Agent 配图
2. 激活统一的参考图 + 提示词模板 → 确保 50 篇文章配图风格一致
3. 定时触发或手动批量执行
4. 150 张配图 + 50 篇文章 → 自动导出

**协同涌现**：Literary Agent 单次只处理一篇文章，但通过工作流循环编排，变成了"批量内容工厂"。

## 四、核心能力矩阵

| 能力 | 说明 | 关键组件 |
|------|------|----------|
| **工作空间管理** | 创建/管理文学创作工作空间，承载文章和配图 | LiteraryAgentWorkspaceController |
| **文章配图工作流** | 5 阶段状态机：上传 → 预览 → 标记生成 → 生图中 → 导出 | ArticleIllustrationWorkflow |
| **AI 配图标注** | LLM 分析文章内容，自动在合适位置插入 `[插图]: 描述` 标记 | ILlmGateway |
| **批量生图** | 逐条解析标记 → 调用 ImageGen → SSE 实时推送进度 | LiteraryAgentImageGenController |
| **提示词管理** | 创建/编辑/分类提示词模板，支持 AI 优化 | LiteraryPromptsController |
| **提示词市场** | 发布/下架/fork 提示词到配置市场 | IForkable + Marketplace |
| **参考图管理** | 上传/激活/停用参考图配置（用于图生图风格迁移） | LiteraryAgentConfigController |
| **参考图市场** | 发布/下架/fork 参考图配置到配置市场 | IForkable + Marketplace |
| **应用级配置** | 底图 SHA256、参考图 URL 等全局配置 | LiteraryAgentConfig |
| **资产上传** | 工作空间内上传文章文件（.md/.txt） | WorkspaceController |

## 五、整体架构

```
┌──────────────────────────────────────────────────────────┐
│                     prd-admin (前端)                       │
│  WorkspaceList → Editor → ArticleIllustration → Export   │
│  PromptLibrary    RefImageManager    Marketplace          │
└──────────────────────┬────────────────────────────────────┘
                       │ HTTP API / SSE
┌──────────────────────▼────────────────────────────────────┐
│            Controller 层 (appKey=literary-agent)           │
├──────────┬──────────────┬───────────────┬─────────────────┤
│Workspace │ ImageGen     │ Config        │ Prompts         │
│Controller│ Controller   │ Controller    │ Controller      │
│工作空间   │ 批量生图/    │ 参考图/模型/  │ 提示词 CRUD/    │
│CRUD/资产 │ Run/Stream   │ 市场发布      │ 优化/市场       │
└────┬─────┴──────┬───────┴───────┬───────┴────────┬────────┘
     │            │               │                │
┌────▼────┐ ┌────▼──────┐ ┌─────▼──────┐  ┌──────▼──────┐
│MongoDB  │ │ ImageGen  │ │ Marketplace│  │ ILlmGateway │
│         │ │ Engine    │ │ (Fork)     │  │ chat/vision │
│         │ │(VisualAgt)│ │            │  │             │
└─────────┘ └───────────┘ └────────────┘  └─────────────┘
```

### 文章配图工作流——5 阶段状态机

```
Upload(0) → Editing(1) → MarkersGenerated(2) → ImagesGenerating(3) → ImagesGenerated(4)
   ↑            │                 │                      │
   └────────────┴─── 提交型修改 ──┘                      │
                     (回退并清空后续)                     ↓
                                                      导出
```

| 阶段 | 阶段标识 | 说明 | 可跳转条件 |
|------|----------|------|-----------|
| 上传 | `Upload(0)` | 上传文章文件（.md/.txt） | 总是可跳转 |
| 预览 | `Editing(1)` | 预览文章内容，选择提示词模板 | 已上传文章 |
| 配图标记 | `MarkersGenerated(2)` | AI 生成带 `[插图]: 描述` 标记的文章 | 已生成标记 |
| 生图中 | `ImagesGenerating(3)` | 逐条解析标记并调用生图模型 | 已生成标记（自动进入） |
| 导出 | `ImagesGenerated(4)` | 所有配图生成完成，可导出 | 所有配图已完成 |

**核心规则**：
- 提交型修改（重新上传/重新标注）会清空后续阶段 + Version +1
- 浏览器刷新以服务端 `workflow.Phase` 为准恢复阶段
- 生图进度通过 `ExpectedImageCount` / `DoneImageCount` 实时追踪

## 六、数据设计

| 集合 | 用途 | 关键字段 |
|------|------|----------|
| `literary_agent_configs` | 应用级配置 | Id(=appKey), ReferenceImageSha256, ReferenceImageUrl |
| `literary_prompts` | 提示词库 | Title, Content, ScenarioType, IsPublic, ForkCount |
| `reference_image_configs` | 参考图配置 | Name, ImageUrl, IsActive, IsPublic, ForkCount |
| `image_master_workspaces` | 工作空间（复用 VisualAgent 集合） | ArticleIllustrationWorkflow 嵌入文档扩展配图工作流状态 |
| `image_assets` | 生成图片资产（复用 VisualAgent 集合） | 配图生成结果存储 |

## 七、接口设计

### 工作空间（LiteraryAgentWorkspaceController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/literary/workspaces` | 工作空间列表 |
| POST | `/api/literary/workspaces` | 创建工作空间 |
| PUT | `/api/literary/workspaces/{id}` | 更新工作空间 |
| DELETE | `/api/literary/workspaces/{id}` | 删除工作空间 |
| GET | `/api/literary/workspaces/{id}/detail` | 工作空间详情（含文章和配图） |
| POST | `/api/literary/workspaces/{id}/assets` | 上传文章文件 |

### 配图生图（LiteraryAgentImageGenController）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/literary/image-gen/runs` | 创建配图生图任务（批量） |
| GET | `/api/literary/image-gen/runs/{runId}` | 查询生图任务状态 |
| GET | `/api/literary/image-gen/runs/{runId}/stream` | SSE 流式获取生图进度 |
| POST | `/api/literary/image-gen/runs/{runId}/cancel` | 取消生图任务 |

### 参考图与配置（LiteraryAgentConfigController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/literary/config/reference-images` | 参考图列表 |
| POST | `/api/literary/config/reference-images` | 创建参考图配置 |
| PUT | `/api/literary/config/reference-images/{id}` | 更新参考图 |
| PUT | `/api/literary/config/reference-images/{id}/image` | 更换参考图图片 |
| DELETE | `/api/literary/config/reference-images/{id}` | 删除参考图 |
| POST | `/api/literary/config/reference-images/{id}/activate` | 激活参考图 |
| POST | `/api/literary/config/reference-images/{id}/deactivate` | 停用参考图 |
| GET | `/api/literary/config/reference-images/active` | 获取当前激活的参考图 |
| GET | `/api/literary/config/reference-images/marketplace` | 市场中的参考图 |
| POST | `/api/literary/config/reference-images/{id}/publish` | 发布到市场 |
| POST | `/api/literary/config/reference-images/{id}/unpublish` | 从市场下架 |
| POST | `/api/literary/config/reference-images/{id}/fork` | Fork 市场参考图 |
| GET | `/api/literary/config` | 获取应用配置 |
| POST | `/api/literary/config/reference-image` | 设置全局参考图 |
| DELETE | `/api/literary/config/reference-image` | 清除全局参考图 |
| GET | `/api/literary/config/models/*` | 获取可用生图模型（text2img/img2img/all/main） |

### 提示词（LiteraryPromptsController）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/literary/prompts` | 提示词列表 |
| POST | `/api/literary/prompts` | 创建提示词 |
| PUT | `/api/literary/prompts/{id}` | 更新提示词 |
| DELETE | `/api/literary/prompts/{id}` | 删除提示词 |
| GET | `/api/literary/prompts/marketplace` | 市场中的提示词 |
| POST | `/api/literary/prompts/{id}/publish` | 发布到市场 |
| POST | `/api/literary/prompts/{id}/unpublish` | 从市场下架 |
| POST | `/api/literary/prompts/{id}/fork` | Fork 市场提示词 |
| POST | `/api/literary/prompts/optimize` | AI 优化提示词 |

## 八、关联设计文档

| 文档 | 关系 |
|------|------|
| `design.visual-agent.md` | 共享底层生图引擎（ImageGen），Literary Agent 复用 VisualAgent 的工作空间和资产集合 |
| `design.system-emergence.md` | 涌现篇中"内容创作流水线"场景的详细来源 |
| `design.unified-skill-system.md` | 提示词与技能系统统一设计 |

## 九、影响范围与风险

### 影响范围

| 影响模块 | 变更内容 | 需要配合的团队 |
|----------|----------|---------------|
| VisualAgent | 共享 ImageGen 引擎和工作空间集合 | 视觉创作团队 |
| LLM Gateway | 文章分析 + 配图标注调用，appCallerCode = `literary-agent.*::chat` | 模型运维 |
| Marketplace | 提示词和参考图的发布/fork | 市场运营 |
| COS 存储 | 参考图和生成图片存储 | 基础设施 |

### 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| AI 标注位置不准确 | 中 | 低 | 用户可手动调整标记位置和描述 |
| 批量生图耗时长 | 中 | 中 | SSE 实时进度 + 支持取消 |
| 提交型修改误清后续阶段 | 低 | 中 | Version 机制 + 前端二次确认 |
| 市场 fork 的提示词质量不可控 | 低 | 低 | ForkCount 排序 + 管理员审核 |
