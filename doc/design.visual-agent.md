# Visual Agent (视觉创作) · 设计

> **版本**：v1.0 | **日期**：2026-07-17 | **状态**：已落地

> **appKey**：`visual-agent`

**一句话**：AI 驱动的一站式视觉创作工作台——从灵感到成品，全流程 AI 协同。
**谁该读**：视觉创作的产品与工程师。
**读完能做什么**：说清工作空间、画布、资产三者的关系。

## 一、管理摘要

- **解决什么问题**：创意工作者需要 AI 辅助生成和编辑图片，但生图能力分散在多个工具中，缺乏统一的工作空间和资产管理
- **方案概述**：提供工作空间 → 会话 → 画布 → 生图的全链路视觉创作平台，支持文生图、图生图、多图组合、Vision 分析、水印叠加等完整图片创作流水线
- **业务价值**：一站式视觉创作工作台，用户无需切换多个工具，所有创作过程和资产统一管理、可追溯、可复用
- **影响范围**：prd-api（ImageMasterController + ImageGenController + WatermarkController）、prd-admin（7+ 前端页面）、LLM Gateway（Vision/Generation 模型调用）、桌面客户端
- **当前状态**：核心功能已实现，持续迭代中

## 二、产品定位

**目标用户**：

| 角色 | 核心需求 | 使用频率 |
|------|----------|----------|
| 设计师/插画师 | AI 辅助生图、风格迁移、参考图组合 | 每天 |
| 内容创作者 | 文章配图、社交媒体图片批量生成 | 每周 |
| 产品经理 | 快速原型图、概念图生成 | 按需 |

**设计理念**：工作空间承载创作过程，画布承载视觉编排，Run/Worker 驱动异步生图，所有资产可追溯可复用。

## 三、用户场景与协同涌现

### 场景 1：设计师日常创作

> 设计师小王需要为一篇推广文章制作 5 张配图，风格需要统一。

1. 小王创建工作空间，命名"春季推广配图"
2. 上传品牌参考图到工作空间资产
3. 对话描述需求："参考这张图的风格，帮我生成春天主题的推广图"
4. 系统调用 Vision 分析参考图风格 → Plan API 优化 prompt → 批量生图（5 张变体）
5. 小王在画布中编排 5 张图的布局，微调选中 3 张
6. 系统自动叠加品牌水印 → 导出成品

**单 Agent 价值**：从"打开 3 个工具分别生图、下载、加水印、排版"变成"一个工作空间全搞定"。

### 场景 2：文章自动配图（与 Literary Agent 协同）

> 作者写了一篇 3000 字的散文，需要在合适的位置插入配图。

1. Literary Agent 分析文章，自动在 5 个段落标注 `[插图]: 描述`
2. 触发工作流 → 工作流逐条调用 Visual Agent 的 Generate API
3. 每张配图生成后，SSE 实时推送进度（"正在生成第 3/5 张…"）
4. 全部完成 → 文章 + 配图打包导出

**协同涌现**：Literary Agent 负责"在哪配图、配什么图"，Visual Agent 负责"生成图片"。两个 Agent 各做自己擅长的事，工作流把它们串起来。

### 场景 3：抖音封面批量生成（与工作流 + Channel Adapter 协同）

> 运营团队每天需要为 20 条抖音视频生成封面图。

1. 运营通过苹果快捷指令批量分享 20 个抖音链接
2. Channel Adapter 接收 → 触发工作流
3. 工作流：抖音解析舱提取视频标题 → LLM 分析器生成封面描述 → Visual Agent Generate API 生成封面
4. 20 张封面自动生成 → 邮件发送舱推送给运营

**协同涌现**：手机分享 → 自动解析 → AI 描述 → AI 生图 → 邮件送达。运营只做了"分享链接"，系统产出了"20 张品牌封面"。

### 场景 4：缺陷截图增强（与 Defect Agent 协同）

> 测试员提交了一个 UI 缺陷，附了截图但描述模糊。

1. Defect Agent 发布事件 `defect-agent.report.created`
2. AutomationHub 匹配规则 → 触发工作流
3. 工作流调用 Visual Agent 的 Vision 能力分析截图
4. 识别出截图中的 UI 元素异常（如"按钮文字溢出"、"图标缺失"）
5. 自动补充缺陷描述 → 回写到 Defect Agent

**协同涌现**：Vision 能力本来是给设计师用的，但通过事件驱动自动服务了测试流程。

## 四、核心能力矩阵

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
| **分层 PSD 导出** | 生成图片按语义拆成多个图层（如主体/背景/文字），导出为可在设计软件里逐层编辑的 PSD；分层结果持久化到画布 Frame，支持单层重新编辑与免重算复用；默认展示 AI 分层合成结果，原图降级为隐藏参考层 | LLM Gateway `image-layering` 公开能力 |

## 五、整体架构

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

## 六、核心流程

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

## 七、数据设计

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

## 八、接口设计

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

## 九、关联设计文档

| 文档 | 聚焦领域 | 关系 |
|------|----------|------|
| [design.platform.image-ref-and-persistence.md](./design.platform.image-ref-and-persistence.md) | 图片引用日志 + 消息持久化 | 解决 LLM 请求中参考图 base64 截断和消息丢失问题 |
| [design.visual-agent.inline-image-chat.md](./design.visual-agent.inline-image-chat.md) | 内联图片聊天分析 | RichComposer 中图片引用的统一处理方案 |
| [design.visual-agent.multi-image-compose.md](./design.visual-agent.multi-image-compose.md) | 多图组合生成 | 两阶段架构：预提取描述 + 实时组合 |
| [design.visual-agent.multi-image-vision-api.md](./design.visual-agent.multi-image-vision-api.md) | Vision API 多图支持 | 解决 img2img 端点只支持单张参考图的限制 |
| [design.video-agent.remotion-gap.md](./design.video-agent.remotion-gap.md) | Remotion 质量分析 | 视频场景生成中的视觉质量差距分析（与 VideoAgent 交叉） |
| [changelogs/2026-08-11_上游生图尺寸能力.md](../changelogs/2026-08-11_上游生图尺寸能力.md) | 上游生图尺寸能力 | 高级配置声明尺寸字段与提示词传输能力，统一请求阶段尺寸能力并按上游元数据自适应分辨率档位 |

## 十、影响范围与风险

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
| LLM Gateway 分层能力 | MAP 单向依赖网关暴露的 `image-layering` 公开能力，不感知具体上游平台和模型 | 网关团队 |

### 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 生图模型服务不稳定 | 中 | 高 | 模型池故障转移（[design.platform.model-pool.md](./design.platform.model-pool.md)） |
| 大量并发生图消耗 API 额度 | 中 | 中 | Run 队列 + 速率限制 |
| COS 存储成本随资产增长 | 低 | 中 | 定期清理孤立资产 + 用户配额 |
| 多图组合语义理解偏差 | 中 | 低 | Clarify API 反问澄清 + Plan API 优化 prompt |

## 视觉分镜台（Storyboard，2026-06-14）

将文章/想法拆解为电影风格分镜，每镜生成关键帧 image prompt + 运动 prompt，复用现有生图引擎实时生长并支持逐镜精修。后端新增 `storyboard-script` 接口（`visual-agent.storyboard.script::chat`），预留 image-to-video 扩展点。同步修复 OpenAIImageClient 对 OpenRouter 图片生成协议的支持（`/chat/completions + modalities:[image,text]`）。

## AI 分层（Image Layering，2026-08-12）

### 为什么走异步任务

分层是把一张图拆成多个语义图层（如主体/背景/文字）的生图请求，模型侧耗时明显长于普通生成，早期走同步端点时会撞上边缘网关的 30 秒超时——用户点击后请求直接失败，但模型可能仍在生成。分层改造为与视觉创作既有生图任务共用的 Run/Worker 机制：提交立即返回任务号，前端订阅并展示实时进度（「已生成 N/M 个图层」），产物由 Worker 逐层落库、逐层推事件，浏览器刷新或断线不影响任务在服务端继续跑完。

### 组装台：实时合成预览

图层面板（内部称「组装台」）不是一次性导出结果的展示区，而是一个可交互的合成工作台：显隐、不透明度、叠放次序的任何一次调整，合成预览立刻重算。PSD 与合成 PNG 这两种「所见即所得」的合成导出内容与预览严格一致（ZIP 打包与单层下载走的是原始素材，不受面板状态影响，见下「导出出口」）。这个设计目的是让用户在导出 PSD 之前就能确认最终效果，而不是导出后才在设计软件里发现次序不对。

分层结果落到画布上表现为一个「Frame」（编组）：原图保持原位不动，编组作为一份独立副本摆到旁边空地上（自动找一块不与既有元素重叠的位置），组内各图层按原图的相对位置叠放、观感与原图一致，每个部件仍可单独选中、拖动；平铺展开成为一种可选视图而非默认强制布局。这样设计是为了让「同一张图重新拆一次」不会覆盖上一次的结果——两次产物并排摆放，用户可以直接比较着挑。图层归属（分组、序号、显隐、不透明度、次序）持久化到画布数据里，刷新页面或重新打开不会丢失已调整好的状态。

### 拆法输入与层数

用户既可以用自然语言描述拆分方式（例如「把人物和风景分开」），也可以直接调整期望层数（2-8 层，记住上次偏好）。上游返回的实际层数不保证等于期望值，界面用「期望拆 N 层」而非「最多拆 N 层」这类无法保证兑现的措辞。模型为凑够层数产出的纯色实色层、整幅低透明度的雾状层等低价值图层，会被识别为空层并默认隐藏，不占用户注意力，但不会被删除——用户仍可手动找回。

### 导出出口

分层结果支持四种下载出口：分层 PSD（每层只写「有内容的最小矩形」而非铺满整张画布）、合成 PNG、全部图层打包 ZIP、单层透明 PNG。其中只有 PSD 与合成 PNG 会应用面板当前的显隐/不透明度状态——这两种是「所见即所得」的合成结果；ZIP 打包与单层下载给的是每个图层的原始图像，不受面板临时调整影响，方便用户拿到未经处理的素材原图。

### 与网关的边界

MAP 只单向依赖 LLM Gateway 对外暴露的 `image-layering` 公开能力标识，不感知具体使用了哪个上游平台和模型；这个能力标识不会出现在视觉创作的常规「选择模型」列表里，因为它只能被分层这个专用动作调用，不是用户可自由选择的普通生成模型（这类仅供特定动作调用的操作性能力，在网关对外的模型目录出口统一被过滤掉，详见 [design.platform.llm-gateway.md](./design.platform.llm-gateway.md)）。

分层这条链路上仍缺机械判据验证的部分（如「自然语言拆法是否真的影响拆分结果」「多上游兼容性」），见 [debt.visual-agent.layering.md](./debt.visual-agent.layering.md)。

## 模型池可见性与故障恢复（视觉创作，2026-08-12）

视觉创作的模型选择器按业务模型池展示身份，而不是展示具体的上游 Provider 或 Offering 名称——用户选择的是一个业务含义稳定的池，池内部由 LLM Gateway 按健康状况调度具体成员，调度细节和故障隔离规则见 [design.platform.llm-gateway.md](./design.platform.llm-gateway.md) 六、七两节。

选择器同时展示该池近期（最近若干次真实请求）的成功率与平均耗时，让用户在选择前就能看到这个池当前跑得顺不顺，而不是提交后才发现频繁失败。某个池被判定不健康时，界面会提示但不强行阻止选择——用户可以坚持使用，系统尊重这个选择而不是替用户做决定。模型目录加载失败时保留已有的目录数据并提供手动重载入口，不会因为一次网络抖动就让整个模型列表塌成空白。

网关侧的上游故障与恢复会产生站内信通知，按租户、平台、模型与请求类型的组合去重（同一个故障不会被同一类请求反复刷屏，但不同请求类型各自独立提醒一次），并带日志深链方便定位。站内信列表按管理员权限过滤，非管理员在通知中心看不到这类通知；但外部推送订阅（把站内信转发到 Bark / Webhook 等外部渠道）目前没有复用同一道权限校验——具备普通看板权限的非管理员账号仍可以订阅这类主题并把内容转发到自己配置的外部地址，属已知的权限口径不一致，见 [debt.prd-agent.md](./debt.prd-agent.md) 已知边界。
