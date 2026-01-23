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
   | 缺陷管理 Agent | `defect-agent` | AI 驱动的缺陷检测与自动修复 |

4. **为什么这样设计**
   - 权限控制：未来可以基于 Controller 做细粒度权限管理
   - 功能隔离：不同应用的特性（如水印配置）互不影响
   - 可维护性：每个应用的入口清晰，便于追踪和调试
   - 扩展性：新增应用只需添加新 Controller，不影响现有逻辑

### 示例

```csharp
// 正确做法：在 Controller 中硬编码 appKey
[ApiController]
[Route("api/v1/admin/visual-agent")]
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

## Codebase Skill（代码库快照 — 供 AI 增量维护用）

> **最后更新**：2026-01-23 | **总提交数**：110 | **文档版本**：SRS v3.0, PRD v2.0
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
│       └── PrdAgent.Infrastructure/  # LLM clients + DB + Services 实现
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
├── doc/              # 编号文档 (0-20) + 维护计划
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
| **Smart Scheduler** | `ModelGroup` + `SmartModelScheduler` + 健康评分 + 降级 |

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
| 模型组/调度器 | ✅ DONE | ModelGroupsController, SmartModelScheduler |
| 桌面自动更新 | ✅ DONE | tauri.conf.json updater, updater.rs |
| PRD 评论 | ✅ DONE | PrdCommentsController, PrdCommentsPanel |
| 内容缺失检测 | ✅ DONE | GapsController, GapDetectionService |
| 会话归档 | ✅ DONE | SessionsController (archive/unarchive) |
| 数据管理面板 | ✅ DONE | DataManagePage |
| 管理通知 | ✅ DONE | NotificationsController, admin_notifications |
| **缺陷管理 Agent** | 📋 PLANNED | DefectAgentController, DefectReviewWorker, DefectFixWorker (设计文档: doc/20) |
| **附件上传** | ⚠️ PARTIAL | Model 定义 + Message.AttachmentIds 关联，无通用上传 Controller |
| **知识库 (多文档)** | ✅ DONE | KnowledgeBasePage, kbStore, kb.rs, KnowledgeBaseController |
| **i18n** | ❌ NOT_IMPL | 无任何 i18n 基础设施，文案硬编码中文 |
| **K8s 部署** | ❌ NOT_IMPL | 仅 docker-compose，无 K8s manifests |
| **告警通知 (邮件/Webhook)** | ❌ NOT_IMPL | 仅 AdminNotification 面板内通知 |

### MongoDB 集合清单 (52 个 + 6 PLANNED)

核心业务：`users`, `groups`, `group_members`, `sessions`, `messages`, `parsed_prds`, `attachments`, `contentgaps`, `prdcomments`

LLM/AI：`llm_platforms`, `llm_models`, `llm_request_logs`, `model_groups`, `model_scheduler_config`, `model_test_stubs`, `llm_app_callers`

VisualAgent (DB 名保留 image_master)：`image_master_workspaces`, `image_master_workspace_assets`, `image_master_sessions`, `image_master_messages`, `image_master_canvas_objects`

水印：`watermark_configs`, `watermark_font_assets`

权限/角色：`system_roles`, `admin_notifications`

桌面资产：`desktop_asset_skins`, `desktop_asset_keys`, `desktop_assets`

提示词：`prompt_stages`, `literary_prompts`

开放平台：`openplatformapps`, `openplatformrequestlogs`

缺陷管理 (PLANNED)：`defect_reports`, `defect_reviews`, `defect_fixes`, `defect_repo_configs`, `defect_github_tokens`, `defect_products`

其他：`api_request_logs`, `user_preferences`

### 已废弃概念 (勿再引用)

| 废弃概念 | 替代方案 |
|----------|----------|
| Guide 引导讲解模式 | Prompt Stages 提示词阶段 |
| Provider 供应商 | Platform 平台 |
| ImageMaster (代码层) | VisualAgent (DB 集合名保留兼容) |
| 直接 SSE 流 | Run/Worker + afterSeq 重连 |
| GuideController | 已删除 |
| IEEE 830-1998 | ISO/IEC/IEEE 29148:2018 |
| DocumentUpload (单文档上传建群) | KnowledgeBasePage (多文档管理) |
| bind_group_prd (群绑定单PRD) | 知识库多文档 (list/upload/replace/delete) |
| commands/document.rs | commands/kb.rs |

### Agent 开发流程

新增 Agent 应用必须遵循 `doc/19.agent-development-workflow.md` 定义的标准化交付流程（6 个 Phase）。
关键检查点：appKey 注册 → 权限定义 → Controller 硬编码 → 菜单注册 → AppCaller 注册 → 前端路由 → 文档同步。

### 交叉校验检查点

当更新文档时，务必做以下交叉：

1. **代码→文档**：Controller/Service 存在 → SRS 功能模块有描述
2. **文档→代码**：SRS 描述的功能 → 代码中存在对应实现
3. **Git log→文档**：近期 commit 的功能变更 → 已反映到文档
4. **DB→数据字典**：MongoDbContext 集合 → 7.data-dictionary.md 有记录
5. **目录结构→文档**：实际目录 → SRS 目录结构图一致
6. **未实现标注**：文档中描述但代码不存在的功能 → 必须标注 ⚠️ 状态
