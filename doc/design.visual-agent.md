# Visual Agent (视觉创作) 架构设计

> **版本**：v1.0 | **日期**：2026-03-28 | **状态**：已实现
>
> **appKey**：`visual-agent`

## 一、管理摘要

- **解决什么问题**：创意工作者需要 AI 辅助生成和编辑图片，但生图能力分散在多个工具中，缺乏统一的工作空间和资产管理
- **方案概述**：提供工作空间 → 会话 → 画布 → 生图的全链路视觉创作平台，支持文生图、图生图、多图组合、Vision 分析、水印叠加等完整图片创作流水线
- **业务价值**：一站式视觉创作工作台，用户无需切换多个工具，所有创作过程和资产统一管理、可追溯、可复用
- **影响范围**：prd-api（ImageMasterController 3020 行 + ImageGenController 2050 行 + WatermarkController 1246 行）、prd-admin（7+ 前端页面）、LLM Gateway（Vision/Generation 模型调用）、桌面客户端
- **当前状态**：核心功能已实现，持续迭代中。是系统中代码量最大（46K 行）、变更最频繁（37 次/月）的模块

## 二、产品定位

**一句话**：AI 驱动的一站式视觉创作工作台——从灵感到成品，全流程 AI 协同。

**目标用户**：

| 角色 | 核心需求 | 使用频率 |
|------|----------|----------|
| 设计师/插画师 | AI 辅助生图、风格迁移、参考图组合 | 每天 |
| 内容创作者 | 文章配图、社交媒体图片批量生成 | 每周 |
| 产品经理 | 快速原型图、概念图生成 | 按需 |

**设计理念**：工作空间承载创作过程，画布承载视觉编排，Run/Worker 驱动异步生图，所有资产可追溯可复用。

## 三、核心能力矩阵

| 能力 | 说明 | 关键技术 |
|------|------|----------|
| **工作空间管理** | 创建/编辑/删除工作空间，承载完整创作项目 | ImageMasterController |
| **会话对话** | 在工作空间内与 AI 对话，描述创作意图 | Run/Worker + SSE |
| **文生图 (Text2Img)** | 文字描述 → AI 生成图片 | ILlmGateway → Generation 模型 |
| **图生图 (Img2Img)** | 参考图 + 描述 → 风格迁移/编辑 | Vision API + Generation |
| **多图组合 (Compose)** | 多张参考图 + 自然语言 → 组合生成 | VLM 预提取描述 + 实时组合 |
| **Vision 分析** | AI 分析图片内容并给出描述 | Vision 模型 |
| **画布 (Canvas)** | 可视化画布编排图片布局和关系 | 前端 Canvas 组件 |
| **批量生图 (Batch)** | 同一 prompt 批量生成多张变体 | SSE 流式推送进度 |
| **Run 生图** | 工作空间内触发的异步生图任务 | ImageGenRun/RunItem/RunEvent |
| **水印系统** | 按应用绑定水印配置，生图后自动叠加 | WatermarkController |
| **Prompt 规划** | AI 优化/扩展用户的简短描述为完整 prompt | Plan API |
| **Prompt 澄清** | 意图模糊时 AI 反问澄清 | Clarify API |
| **尺寸限制** | 不同模型支持不同尺寸，动态配置 | ImageGenSizeCaps |
| **资产管理** | 上传/删除工作空间资产，COS 存储 | UploadArtifacts |
| **投稿系统** | 优秀作品投稿展示，含生成快照 | SubmissionsController |

## 四、整体架构

```
┌──────────────────────────────────────────────────────┐
│                    prd-admin (前端)                    │
│  WorkspaceList → WorkspaceEditor → Canvas → Preview  │
│  AdvancedVisualAgentTab    ImageGenPanel   Fullscreen │
└──────────────────┬───────────────────────────────────┘
                   │ HTTP API / SSE
┌──────────────────▼───────────────────────────────────┐
│              Controller 层 (appKey=visual-agent)      │
├──────────────────┬────────────────┬──────────────────┤
│ ImageMaster      │ ImageGen       │ Watermark        │
│ Controller       │ Controller     │ Controller       │
│ (3020 行)        │ (2050 行)       │ (1246 行)        │
│ 工作空间/会话/    │ 文生图/图生图/  │ 水印配置/绑定/   │
│ 画布/资产/消息    │ 组合/批量/Run   │ 预览/叠加        │
└───────┬──────────┴───────┬────────┴──────┬───────────┘
        │                  │               │
   ┌────▼─────┐     ┌─────▼──────┐  ┌─────▼──────┐
   │ MongoDB  │     │ ILlmGateway│  │ COS 存储   │
   │ 10 集合   │     │ Generation │  │ 图片/水印   │
   │          │     │ Vision     │  │ 字体资产    │
   └──────────┘     └────────────┘  └────────────┘
```

### 核心流程

**文生图流程**：
1. 用户在工作空间中输入描述文字
2. 系统调用 Plan API 优化 prompt（可选）
3. 用户确认 prompt + 选择模型和尺寸
4. 前端调用 Generate API → 创建 ImageGenRun
5. Worker 异步执行：调用 ILlmGateway → Generation 模型
6. 生成结果写入 ImageGenRunItem，SSE 推送进度
7. 生成的图片上传 COS，URL 写回资产列表
8. 如有水印配置，自动叠加水印

**多图组合流程**：
1. 用户选择多张参考图，用自然语言描述组合意图（如"把 @大象 放进 @房间"）
2. 系统调用 Vision 模型预提取每张参考图的描述
3. 将描述 + 用户意图拼装为组合 prompt
4. 调用 Compose API → Generation 模型生成组合图
5. 结果返回前端画布

**工作空间管理流程**：
1. 用户创建工作空间 → 系统分配独立的会话和画布
2. 用户在工作空间内对话/生图/编辑画布
3. 所有资产（生成图、上传图）归属工作空间
4. 支持 AI 自动生成工作空间标题

## 五、数据设计

| 集合 | 用途 | 关键字段 |
|------|------|----------|
| `image_master_workspaces` | 工作空间 | UserId, Title, ModelId, ViewportState |
| `image_master_sessions` | 会话 | WorkspaceId, UserId, ModelType |
| `image_master_messages` | 对话消息 | SessionId, Role, Content, ImageRefs |
| `image_master_canvases` | 画布 | SessionId/WorkspaceId, Items(图片布局数据) |
| `image_assets` | 图片资产 | WorkspaceId, UserId, Url, ThumbnailUrl, Source |
| `image_gen_runs` | 生图任务 | WorkspaceId, Status, Prompt, ModelId |
| `image_gen_run_items` | 生图结果 | RunId, ImageUrl, Status, Error |
| `image_gen_run_events` | 生图事件 | RunId, EventType, Seq（SSE afterSeq 重连） |
| `image_gen_size_caps` | 尺寸限制 | ModelPattern, Sizes, MaxPixels |
| `upload_artifacts` | 上传产物 | UserId, Url, ContentType, FileSize |

水印相关集合：

| 集合 | 用途 | 关键字段 |
|------|------|----------|
| `watermark_configs` | 水印配置 | AppKey, Text, FontFamily, Position, Opacity |
| `watermark_font_assets` | 水印字体 | FontFamily, FileUrl |

## 六、接口设计

### ImageMasterController — 工作空间 & 会话

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/visual/workspaces` | 工作空间列表 |
| POST | `/api/visual/workspaces` | 创建工作空间 |
| PUT | `/api/visual/workspaces/{id}` | 更新工作空间 |
| DELETE | `/api/visual/workspaces/{id}` | 删除工作空间 |
| GET | `/api/visual/workspaces/{id}/detail` | 工作空间详情（含消息和资产） |
| POST | `/api/visual/workspaces/{id}/generate-title` | AI 生成标题 |
| POST | `/api/visual/workspaces/{id}/messages` | 发送消息 |
| GET | `/api/visual/workspaces/{id}/messages` | 消息列表 |
| GET | `/api/visual/workspaces/{id}/canvas` | 获取画布 |
| PUT | `/api/visual/workspaces/{id}/canvas` | 保存画布 |
| PUT | `/api/visual/workspaces/{id}/viewport` | 保存视口状态 |
| POST | `/api/visual/workspaces/{id}/assets` | 上传资产 |
| DELETE | `/api/visual/workspaces/{id}/assets/{assetId}` | 删除资产 |
| POST | `/api/visual/workspaces/{id}/image-gen/runs` | 创建工作空间生图任务 |
| POST | `/api/visual/sessions` | 创建独立会话 |
| GET | `/api/visual/sessions` | 会话列表 |
| GET | `/api/visual/sessions/{id}` | 会话详情 |

### ImageGenController — 生图引擎

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/image-gen/models` | 可用生图模型列表 |
| GET | `/api/image-gen/models/text2img` | 文生图模型 |
| GET | `/api/image-gen/models/img2img` | 图生图模型 |
| GET | `/api/image-gen/models/vision` | Vision 模型 |
| POST | `/api/image-gen/plan` | Prompt 优化规划 |
| POST | `/api/image-gen/clarify` | 意图澄清 |
| POST | `/api/image-gen/generate` | 单张生图 |
| POST | `/api/image-gen/compose` | 多图组合 |
| POST | `/api/image-gen/batch/stream` | 批量生图（SSE 流） |
| POST | `/api/image-gen/runs` | 创建 Run 生图任务 |
| GET | `/api/image-gen/runs/{runId}` | 查询 Run 状态 |
| GET | `/api/image-gen/size-caps` | 尺寸限制配置 |
| GET | `/api/image-gen/logs` | 生图日志 |
| GET | `/api/image-gen/logs/{id}` | 日志详情 |

### WatermarkController — 水印

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/watermarks` | 水印配置列表 |
| GET | `/api/watermarks/app/{appKey}` | 指定应用的水印 |
| POST | `/api/watermarks` | 创建水印配置 |
| PUT | `/api/watermarks/{id}` | 更新水印 |
| DELETE | `/api/watermarks/{id}` | 删除水印 |
| POST | `/api/watermarks/{id}/bind/{appKey}` | 绑定到应用 |
| DELETE | `/api/watermarks/{id}/unbind/{appKey}` | 解绑 |
| GET | `/api/watermark/preview/{id}.png` | 水印预览图 |

## 七、关联设计文档

| 文档 | 聚焦领域 | 关系 |
|------|----------|------|
| `design.image-ref-and-persistence.md` | 图片引用日志 + 消息持久化 | 解决 LLM 请求中参考图 base64 截断和消息丢失问题 |
| `design.inline-image-chat.md` | 内联图片聊天分析 | RichComposer 中图片引用的统一处理方案 |
| `design.multi-image-compose.md` | 多图组合生成 | 两阶段架构：预提取描述 + 实时组合 |
| `design.multi-image-vision-api.md` | Vision API 多图支持 | 解决 img2img 端点只支持单张参考图的限制 |
| `design.remotion-gap.md` | Remotion 质量分析 | 视频场景生成中的视觉质量差距分析（与 VideoAgent 交叉） |

> 注：代码层 `ImageMaster` 已更名为 `VisualAgent`，数据库集合名保留兼容（`image_master_*`）。

## 八、影响范围与风险

### 影响范围

| 影响模块 | 变更内容 | 需要配合的团队 |
|----------|----------|---------------|
| LLM Gateway | Generation + Vision 模型调用，appCallerCode = `visual-agent.*::generation/vision` | 模型运维 |
| COS 存储 | 图片资产上传/删除 | 基础设施 |
| 投稿系统 | SubmissionsController 消费 VisualAgent 生成的作品 | 社区运营 |
| Literary Agent | 文章配图功能复用 ImageGen 引擎 | 文学创作团队 |
| Video Agent | 视频封面/素材复用 VisualAgent 资产 | 视频团队 |
| 水印系统 | 按 appKey 绑定，生图后自动叠加 | 全局 |
| 桌面客户端 | 桌面端有独立的 VisualAgent 入口 | 桌面团队 |

### 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 生图模型服务不稳定 | 中 | 高 | 模型池故障转移（design.model-pool-failover.md） |
| 大量并发生图消耗 API 额度 | 中 | 中 | Run 队列 + 速率限制 |
| COS 存储成本随资产增长 | 低 | 中 | 定期清理孤立资产 + 用户配额 |
| 多图组合语义理解偏差 | 中 | 低 | Clarify API 反问澄清 + Plan API 优化 prompt |
