# 任务完成交接规则

**强制规则**：当你完成一个开发任务（代码编写 + 编译通过）后，**必须主动**使用 `task-handoff-checklist` 技能生成交接清单，不需要用户要求。

判断标准：
- 涉及 **3 个以上文件变更**，或涉及 **新增/修改 API 端点**，或涉及 **UI 页面变更** → 生成完整交接清单（8 个维度）
- 仅 **1-2 个文件的小修改**（如修个 typo、改个样式） → 不需要生成，直接告知改了什么即可

---

# 项目架构规则

## 应用身份隔离原则

**核心原则**：每个应用必须有独立的 Controller 层，即使底层功能相同，也要在 Controller 层面区分身份。

### 规则说明

1. **Controller 层身份隔离**
   - 每个应用（如文学创作、视觉创作）必须有自己的 Controller
   - Controller 中硬编码该应用的 `appKey`，不由前端传递
   - 即使多个应用调用相同的底层服务，也要通过不同 Controller 入口

2. **appKey 命名规范**
   - 使用 `kebab-case` 格式
   - 命名要清晰表达应用用途

3. **已定义的应用标识**

   | 应用名称 | appKey | 说明 |
   |---------|--------|------|
   | 文学创作 Agent | `literary-agent` | 文章配图、文学创作场景 |
   | 视觉创作 Agent | `visual-agent` | 高级视觉创作工作区 |
   | PRD Agent | `prd-agent` | PRD 智能解读与问答 |
   | 缺陷管理 Agent | `defect-agent` | 缺陷提交与跟踪 |

4. **为什么这样设计**
   - 权限控制：未来可以基于 Controller 做细粒度权限管理
   - 功能隔离：不同应用的特性（如水印配置）互不影响
   - 可维护性：每个应用的入口清晰，便于追踪和调试
   - 扩展性：新增应用只需添加新 Controller，不影响现有逻辑

### 示例

```csharp
// 正确做法：在 Controller 中硬编码 appKey
[ApiController]
[Route("api/visual-agent")]  // 后台管理接口使用 /api/{module} 格式，禁止 /v1/ 版本号
public class VisualAgentController : ControllerBase
{
    private const string AppKey = "visual-agent";

    [HttpPost("image-gen/runs")]
    public async Task<IActionResult> CreateImageGenRun(...)
    {
        // 使用硬编码的 AppKey 调用服务
        await _imageService.GenerateAsync(..., appKey: AppKey, ...);
    }
}
```

```csharp
// 错误做法：由前端传递 appKey
[HttpPost("image-gen/runs")]
public async Task<IActionResult> CreateImageGenRun([FromBody] Request request)
{
    // 不要这样做！
    await _imageService.GenerateAsync(..., appKey: request.AppKey, ...);
}
```

## 水印配置

水印配置基于 `appKey` 绑定，只有绑定了特定 appKey 的应用才会应用对应的水印配置。

---

## LLM Gateway 统一调用规则

**核心原则**：所有大模型调用必须通过 `ILlmGateway` 守门员接口，禁止直接调用底层 LLM 客户端。

### 为什么需要 Gateway

1. **统一模型调度**：根据 AppCallerCode 自动匹配模型池，无需手动解析
2. **统一日志记录**：自动记录期望模型 vs 实际模型、Token 使用量、响应时间
3. **统一健康管理**：自动更新模型健康状态（成功恢复 / 失败降权）
4. **未来可扩展**：Gateway 模块可独立部署，成为模型调度中心

### 使用方式

```csharp
// ✅ 正确做法：通过 Gateway 调用
public class MyService
{
    private readonly ILlmGateway _gateway;

    public async Task<string> ProcessAsync(string prompt, CancellationToken ct)
    {
        var request = new GatewayRequest
        {
            AppCallerCode = "my-app.feature::chat",  // 必填
            ModelType = "chat",                       // 必填
            ExpectedModel = "gpt-4o",                 // 可选，仅作为调度提示
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = prompt }
                }
            }
        };

        // 非流式
        var response = await _gateway.SendAsync(request, ct);
        return response.Content;

        // 流式
        await foreach (var chunk in _gateway.StreamAsync(request, ct))
        {
            yield return chunk.Content;
        }
    }
}
```

```csharp
// ❌ 错误做法：直接调用底层客户端
public class MyService
{
    private readonly OpenAIClient _client;  // 不要这样做！

    public async Task ProcessAsync()
    {
        // 绕过 Gateway = 绕过调度 + 绕过日志 + 绕过健康管理
        await _client.StreamGenerateAsync(...);  // 禁止！
    }
}
```

### Gateway 核心文件

| 文件 | 用途 |
|------|------|
| `ILlmGateway.cs` | 接口定义 |
| `LlmGateway.cs` | 核心实现（调度 + 日志 + 健康管理） |
| `GatewayRequest.cs` | 请求模型 |
| `GatewayResponse.cs` | 响应模型（包含调度信息） |
| `Adapters/*.cs` | 平台适配器（OpenAI、Claude 等） |

### AppCallerCode 命名规范

格式：`{app-key}.{feature}::{model-type}`

| 示例 | 说明 |
|------|------|
| `visual-agent.image.vision::generation` | 视觉代理 - 多图生成 |
| `visual-agent.image.text2img::generation` | 视觉代理 - 文生图 |
| `prd-agent.chat::chat` | PRD 代理 - 对话 |
| `defect-agent.analyze::intent` | 缺陷代理 - 意图识别 |

### 模型调度优先级

1. **专属模型池**：AppCallerCode 绑定的 ModelGroupIds
2. **默认模型池**：ModelType 对应的 IsDefaultForType 池
3. **传统配置**：IsMain / IsIntent / IsVision / IsImageGen 标记

### 日志记录字段

Gateway 自动记录以下信息到 `llmrequestlogs`：

| 字段 | 说明 |
|------|------|
| `RequestPurpose` | AppCallerCode（用于过滤特定应用的日志） |
| `ModelResolutionType` | 调度来源（DedicatedPool / DefaultPool / Legacy） |
| `ModelGroupId` / `ModelGroupName` | 使用的模型池 |
| `Model` | 实际使用的模型名称 |

---

## 前端架构原则

**核心原则**：前端仅作为指令发送者与状态观察者，所有业务逻辑与状态流转必须在后端形成完整闭环，前端不得维护或修改任何中间态。

### 规则说明

1. **单一数据源原则**
   - 所有业务数据的描述信息（如 displayName、中文解释）必须在后端维护
   - 前端禁止维护任何业务数据映射表（如 AppCallerCode → 中文名 的字典）
   - 如果前端需要显示数据描述，必须由后端 API 返回

2. **日志自包含原则**
   - 日志保存的是历史切片，未来可追溯，不依赖当前数据
   - 日志写入时需一次性存储所有解释信息（如 `RequestPurposeDisplayName`）
   - 查询日志时直接展示存储的信息，不做二次解析

3. **前端职责边界**
   - ✅ 发送原子化指令（API 调用）
   - ✅ 展示后端返回的结果
   - ✅ UI 展示逻辑（图标、颜色、布局）
   - ✅ 纯 UI 分组/排序（不涉及业务含义）
   - ❌ 维护业务数据映射
   - ❌ 解析后端数据生成业务描述
   - ❌ 持有任何业务中间状态

### 示例

```typescript
// ✅ 正确做法：直接使用后端返回的 displayName
<div>{item.displayName || item.id}</div>

// 下拉选项使用后端返回的 { value, displayName } 结构
options={metaItems.map(item => ({
  value: item.value,
  label: item.displayName
}))}
```

```typescript
// ❌ 错误做法：前端维护映射表
const appNameMap = {
  'prd-agent-desktop': '桌面端',
  'visual-agent': '视觉创作',
  // ...
};
<div>{appNameMap[item.appCode] || item.appCode}</div>
```

### 关键实现

| 场景 | 后端职责 | 前端职责 |
|------|----------|----------|
| AppCallerCode 显示 | `AppCallerRegistry` 维护 displayName，写入日志/API 返回 | 直接显示 `displayName` 字段 |
| 日志 requestPurpose | 写入时保存 `RequestPurposeDisplayName` | 显示 `requestPurposeDisplayName` |
| 元数据下拉选项 | API 返回 `{ value, displayName }` 数组 | 使用 `value` 作为值，`displayName` 作为标签 |

---

## 服务器权威性设计

**核心原则**：服务器端任务一旦启动，只有显式的用户主动取消请求才能中断，客户端被动断开连接不应取消服务器处理。

### 规则说明

1. **主动取消 vs 被动断开**
   - **主动取消**：用户点击"取消"按钮，触发显式取消 API → 允许取消服务器任务
   - **被动断开**：用户关闭页面、切换路由、网络中断、浏览器刷新 → 不应取消服务器任务

2. **为什么需要这样设计**
   - 服务器端任务（如 LLM 调用、数据持久化）应该完整执行
   - 用户被动断开时，服务器已消耗资源，应该让任务完成并保存结果
   - 用户重新连接时可以查看已完成的结果

3. **实现方式**

   对于 SSE 流式响应场景：
   - 服务器核心处理（LLM 调用、数据库操作）使用 `CancellationToken.None`
   - SSE 写入操作捕获异常但不中断处理
   - 只有收到显式取消 API 时才真正取消任务

### 适用场景

| 场景 | 处理方式 |
|------|----------|
| 文学创作标记生成 | LLM + 数据库用 `CancellationToken.None`，SSE 写入捕获异常 |
| 图片生成任务 | 任务入队后与连接解耦，Worker 独立处理 |
| 对话 Run/Worker | 已通过 Run/Worker 模式实现连接解耦 |

### 示例

```csharp
// ✅ 正确做法：服务器权威性设计
public async Task StreamGenerateAsync(CancellationToken clientCt)
{
    // SSE 响应头
    Response.ContentType = "text/event-stream";

    // LLM 调用不使用客户端 CancellationToken
    await foreach (var chunk in client.StreamGenerateAsync(prompt, messages, false, CancellationToken.None))
    {
        // SSE 写入捕获异常，客户端断开时不中断处理
        try
        {
            await Response.WriteAsync($"data: {chunk}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (OperationCanceledException)
        {
            // 客户端已断开，但继续处理 LLM 响应
        }
        catch (ObjectDisposedException)
        {
            // 连接已关闭，但继续处理
        }
    }

    // 数据库操作不使用客户端 CancellationToken
    await _db.SaveAsync(result, CancellationToken.None);
}
```

```csharp
// ❌ 错误做法：直接传递客户端 CancellationToken
public async Task StreamGenerateAsync(CancellationToken ct)
{
    // 客户端关闭页面会导致整个处理被取消
    await foreach (var chunk in client.StreamGenerateAsync(prompt, messages, false, ct))
    {
        await Response.WriteAsync($"data: {chunk}\n\n", ct);  // 会抛 OperationCanceledException
    }
    await _db.SaveAsync(result, ct);  // 可能不会执行
}
```

---

## Codebase Skill（代码库快照 — 供 AI 增量维护用）

> **最后更新**：2026-02-07 | **总提交数**：329 | **文档版本**：SRS v3.0, PRD v3.0
>
> **用途**：AI 在后续会话中读取此段落即可跳过全盘扫描，仅对增量变更进行定点校验。
> **维护规则**：每次代码结构性变更（新增模块、重命名、废弃功能）后，需同步更新此段落。

### 项目结构

```
prd_agent/
├── prd-api/          # .NET 8 后端 (C# 12)
│   └── src/
│       ├── PrdAgent.Api/             # Controllers + Middleware + Services(Workers)
│       ├── PrdAgent.Core/            # Models + Interfaces + Security
│       └── PrdAgent.Infrastructure/  # LLM clients + DB + Services 实现 + ModelPool/
├── prd-admin/        # React 18 管理后台 (TypeScript, Vite, Zustand, Radix UI)
│   └── src/
│       ├── pages/        # 19 个顶级页面 + 8 个子目录
│       ├── components/   # design/ (GlassCard等), ui/ (Radix)
│       ├── stores/       # authStore, themeStore, chatStore, etc.
│       ├── services/     # API service layer (axios)
│       └── lib/          # themeApplier, themeComputed
├── prd-desktop/      # Tauri 2.0 桌面客户端 (Rust + React)
│   ├── src-tauri/    # Rust: commands/, services/, models/
│   └── src/          # React: components/, stores/, pages/  
├── doc/              # 编号文档 (0-5) + 专题文档 (design.*, agent.*, rule.*) 
└── scripts/          # 构建/部署脚本
```

### 核心架构模式

| 模式 | 说明 |
|------|------|
| **Run/Worker** | 对话创建 Run → Worker 后台执行 → SSE stream (断线 afterSeq 重连) |
| **Platform + Model** | `(platformId, modelId)` 作为业务唯一标识，替代原 Provider 概念 |
| **App Identity** | Controller 硬编码 `appKey`，不由前端传递 |
| **RBAC** | `SystemRole` + `AdminPermissionCatalog` (60+ permissions) + `AdminPermissionMiddleware` |
| **Watermark** | appKey 绑定 + 字体管理 + SixLabors.ImageSharp 渲染 |
| **LLM Gateway** | `ILlmGateway` + `ModelResolver` + 三级调度 + 健康管理 |
| **ModelPool** | 独立策略引擎组件 (`Infrastructure/ModelPool/`)，6 种策略 (FailFast/Race/Sequential/RoundRobin/WeightedRandom/LeastLatency)，`ModelPoolFactory` 桥接 `ModelGroup` + `LLMPlatform` |
| **Marketplace Registry** | `CONFIG_TYPE_REGISTRY` 类型注册 + `IForkable` 白名单复制 |

### 功能注册表

| 功能 | 状态 | 关键文件 |
|------|------|----------|
| 对话 Run/Worker | ✅ DONE | ChatRunsController, ChatRunWorker |
| 提示词阶段 | ✅ DONE | PromptStagesController, PromptStageService |
| 权限矩阵 | ✅ DONE | SystemRolesController, AuthzController, AdminPermissionMiddleware |
| 水印系统 | ✅ DONE | WatermarkController (857行), WatermarkRenderer |
| VisualAgent | ✅ DONE | 4 React pages, ImageGenController, ImageGenRunWorker |
| 文学代理 | ✅ DONE | ArticleIllustrationEditorPage, LiteraryAgentController |
| 速率限制 | ✅ DONE | RedisRateLimitService (Lua 滑动窗口) |
| 液态玻璃主题 | ✅ DONE | themeStore, GlassCard, ThemeSkinEditor |
| Open Platform | ✅ DONE | OpenPlatformChatController, LLMAppCaller |
| 模型组/Gateway | ✅ DONE | ModelGroupsController, LlmGateway, ModelResolver, ModelPoolFactory |
| 模型池策略引擎 | ✅ DONE | `Infrastructure/ModelPool/` (IModelPool, 6 Strategies, PoolHealthTracker, HttpPoolDispatcher) |
| 模型池管理 UI | ✅ DONE | ModelPoolManagePage (策略配置 + 调度预测可视化 + PoolPredictionDialog) |
| 桌面自动更新 | ✅ DONE | tauri.conf.json updater, updater.rs |
| PRD 评论 | ✅ DONE | PrdCommentsController, PrdCommentsPanel |
| 内容缺失检测 | ✅ DONE | GapsController, GapDetectionService |
| 会话归档 | ✅ DONE | SessionsController (archive/unarchive) |
| 数据管理面板 | ✅ DONE | DataManagePage |
| 管理通知 | ✅ DONE | NotificationsController, admin_notifications |
| 缺陷管理 Agent | ✅ DONE | DefectAgentController, DefectAgentTests (25 tests) |
| 配置市场 (海鲜市场) | ✅ DONE | CONFIG_TYPE_REGISTRY, MarketplaceCard, IForkable, ForkService |
| **附件上传** | ✅ DONE | AttachmentsController + Rust upload_attachment + Desktop UI (图片选择/预览/上传) |
| **技能系统** | ✅ DONE | SkillSettings 模型 + SkillsController + Desktop SkillPanel/SkillManagerModal (服务端公共技能 + 客户端本地自定义技能) |
| **知识库** | ⚠️ PARTIAL | KnowledgeBasePage UI 占位，"资料文件"标注开发中 |
| **i18n** | ❌ NOT_IMPL | 无任何 i18n 基础设施，文案硬编码中文 |
| **K8s 部署** | ❌ NOT_IMPL | 仅 docker-compose，无 K8s manifests |
| **告警通知 (邮件/Webhook)** | ❌ NOT_IMPL | 仅 AdminNotification 面板内通知 |

### MongoDB 集合清单 (87 个)

核心业务：`users`, `groups`, `groupmembers`, `documents`, `sessions`, `messages`, `group_message_counters`, `contentgaps`, `attachments`, `prdcomments`, `share_links`

LLM/AI：`llmconfigs`, `llmplatforms`, `llmmodels`, `llmrequestlogs`, `model_groups`, `model_scheduler_config`, `model_test_stubs`, `llm_app_callers`, `model_exchanges`

Model Lab：`model_lab_experiments`, `model_lab_runs`, `model_lab_run_items`, `model_lab_model_sets`, `model_lab_groups`

Arena：`arena_groups`, `arena_slots`, `arena_battles`

VisualAgent (DB 名保留 image_master)：`image_master_workspaces`, `image_assets`, `image_master_sessions`, `image_master_messages`, `image_master_canvases`, `image_gen_size_caps`, `image_gen_runs`, `image_gen_run_items`, `image_gen_run_events`, `upload_artifacts`

水印：`watermark_configs`, `watermark_font_assets`

权限/角色：`system_roles`, `admin_notifications`, `invitecodes`

桌面资产：`desktop_asset_skins`, `desktop_asset_keys`, `desktop_assets`

提示词/技能：`promptstages`, `systemprompts`, `literary_prompts`, `skill_settings`, `skills`, `admin_prompt_overrides`, `literary_agent_configs`, `reference_image_configs`

开放平台：`openplatformapps`, `openplatformrequestlogs`

缺陷管理：`defect_templates`, `defect_reports`, `defect_messages`, `defect_folders`

海鲜市场：`marketplace_fork_logs`

渠道 (Channel)：`channel_whitelist`, `channel_identity_mappings`, `channel_tasks`, `channel_request_logs`, `channel_settings`

工作流：`workflows`, `workflow_executions`, `workflow_schedules`, `workflow_secrets`

工具箱：`toolbox_runs`, `toolbox_items`

邮件：`email_classifications`, `email_workflows`

教程邮件：`tutorial_email_sequences`, `tutorial_email_templates`, `tutorial_email_assets`, `tutorial_email_enrollments`

应用路由：`registered_apps`, `routing_rules`

其他：`apirequestlogs`, `user_preferences`, `appsettings`, `automation_rules`, `admin_idempotency`, `todo_items`, `webhook_delivery_logs`

### 已废弃概念 (勿再引用)

| 废弃概念 | 替代方案 |
|----------|----------|
| Guide 引导讲解模式 | Prompt Stages 提示词阶段 |
| Provider 供应商 | Platform 平台 |
| ImageMaster (代码层) | VisualAgent (DB 集合名保留兼容) |
| 直接 SSE 流 | Run/Worker + afterSeq 重连 |
| GuideController | 已删除 |
| IEEE 830-1998 | ISO/IEC/IEEE 29148:2018 |
| SmartModelScheduler | ILlmGateway + ModelResolver |

### 交叉校验检查点

当更新文档时，务必做以下交叉：

1. **代码→文档**：Controller/Service 存在 → SRS 功能模块有描述
2. **文档→代码**：SRS 描述的功能 → 代码中存在对应实现
3. **Git log→文档**：近期 commit 的功能变更 → 已反映到文档
4. **DB→数据字典**：MongoDbContext 集合 → rule.data-dictionary.md 有记录
5. **目录结构→文档**：实际目录 → SRS 目录结构图一致
6. **未实现标注**：文档中描述但代码不存在的功能 → 必须标注 ⚠️ 状态

---

## 海鲜市场 (Configuration Marketplace) 扩展指南

**触发场景**：当需要将新的配置类型（如画布模板、工作流模板等）发布到海鲜市场时。

### 核心文件

| 文件 | 用途 |
|------|------|
| `prd-admin/src/lib/marketplaceTypes.tsx` | 前端类型注册表 + 预览渲染器 |
| `prd-admin/src/components/marketplace/MarketplaceCard.tsx` | 通用卡片组件 |
| `prd-api/src/PrdAgent.Core/Interfaces/IMarketplaceItem.cs` | `IMarketplaceItem` + `IForkable` 接口 |
| `prd-api/src/PrdAgent.Infrastructure/Services/ForkService.cs` | 通用 Fork 服务 |
| `doc/prd.marketplace.md` | 设计文档 (v3.0) |

### 添加新类型步骤

#### 1. 前端：注册类型定义

```typescript
// prd-admin/src/lib/marketplaceTypes.tsx
export const CONFIG_TYPE_REGISTRY: Record<string, ConfigTypeDefinition<any>> = {
  // 已有类型: prompt, refImage, watermark

  // 新增类型示例
  canvasTemplate: {
    key: 'canvasTemplate',
    label: '画布模板',
    icon: Layout,  // lucide-react 图标
    color: {
      bg: 'rgba(34, 197, 94, 0.12)',
      text: 'rgba(34, 197, 94, 0.95)',
      border: 'rgba(34, 197, 94, 0.25)',
    },
    api: {
      listMarketplace: listCanvasTemplatesMarketplace,
      publish: publishCanvasTemplate,
      unpublish: unpublishCanvasTemplate,
      fork: forkCanvasTemplate,
    },
    getDisplayName: (item) => item.name,
    PreviewRenderer: CanvasTemplatePreview,  // 自定义预览组件
  },
};
```

#### 2. 前端：实现预览渲染器

```typescript
// prd-admin/src/lib/marketplaceTypes.tsx
const CanvasTemplatePreview: React.FC<{ item: CanvasTemplate }> = ({ item }) => (
  <div className="space-y-2">
    <img src={item.thumbnailUrl} className="w-full h-32 object-cover rounded" />
    <div className="text-xs text-muted-foreground">
      {item.width} × {item.height} px
    </div>
  </div>
);
```

#### 3. 后端：实现 IForkable 接口

```csharp
// Model 类实现 IForkable
public class CanvasTemplate : IForkable
{
    // 业务字段
    public string Name { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public List<CanvasObject> Objects { get; set; }

    // IMarketplaceItem 字段 (必须实现)
    public string Id { get; set; }
    public string? OwnerUserId { get; set; }
    public bool IsPublic { get; set; }
    public int ForkCount { get; set; }
    public string? ForkedFromId { get; set; }
    public string? ForkedFromOwnerName { get; set; }
    public string? ForkedFromOwnerAvatar { get; set; }

    // 白名单：Fork 时只复制这些字段
    public string[] GetCopyableFields() => new[]
    {
        "Name", "Width", "Height", "Objects"
    };

    public string GetConfigType() => "canvasTemplate";
    public string GetDisplayName() => Name;
    public string? GetOwnerUserId() => OwnerUserId;
    public void SetOwnerUserId(string userId) => OwnerUserId = userId;

    public void OnForked()
    {
        // Fork 后处理（如重命名）
        Name = $"{Name} (副本)";
    }
}
```

#### 4. 后端：添加 API 端点

```csharp
[HttpGet("marketplace")]
public async Task<IActionResult> ListMarketplace([FromQuery] string? keyword, [FromQuery] string sort = "hot")
{
    var items = await _service.ListPublicAsync(keyword, sort);
    return Ok(ApiResponse.Success(new { items }));
}

[HttpPost("{id}/publish")]
public async Task<IActionResult> Publish(string id)
{
    await _service.PublishAsync(id, CurrentUserId);
    return Ok(ApiResponse.Success());
}

[HttpPost("{id}/fork")]
public async Task<IActionResult> Fork(string id)
{
    var forked = await _forkService.ForkAsync<CanvasTemplate>(id, CurrentUserId);
    return Ok(ApiResponse.Success(forked));
}
```

### 已注册类型

| 类型 Key | 标签 | 数据源集合 |
|----------|------|-----------|
| `prompt` | 提示词 | `literary_prompts` |
| `refImage` | 参考图 | `reference_image_configs` |
| `watermark` | 水印 | `watermark_configs` |

### 设计原则

1. **前端类型注册表**：所有类型在 `CONFIG_TYPE_REGISTRY` 统一注册，卡片渲染自动适配
2. **白名单字段复制**：`GetCopyableFields()` 定义可 Fork 的业务字段，避免复制敏感信息
3. **预览渲染器委托**：每种类型有独立的 `PreviewRenderer`，支持完全不同的展示样式
4. **统一市场字段**：`IMarketplaceItem` 定义公共字段（ForkCount、IsPublic 等）
