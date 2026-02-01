# PRD Agent 项目全景指南

> **版本**: v1.0
> **生成日期**: 2026-02-01
> **适用对象**: 新成员入门、技术评审、架构决策参考
> **文档性质**: AI 自动生成，综合产品方案、架构设计、开发文档

---

## 目录

1. [项目概览](#一项目概览)
2. [核心设计思想](#二核心设计思想)
3. [系统架构](#三系统架构)
4. [功能模块清单](#四功能模块清单)
5. [Agent 能力矩阵](#五agent-能力矩阵)
6. [技术栈全景](#六技术栈全景)
7. [核心架构原则](#七核心架构原则)
8. [数据模型概览](#八数据模型概览)
9. [开发规范速查](#九开发规范速查)
10. [本周进展 (2026-01-20 ~ 2026-02-01)](#十本周进展)
11. [已知技术债务](#十一已知技术债务)
12. [快速上手指南](#十二快速上手指南)

---

## 一、项目概览

### 1.1 项目定位

**PRD Agent** 是一款**专精于 PRD 理解**的智能 Agent 平台，用 AI 作为产品经理的"嘴替"，让"讲解"从依赖个人精力转变为**可扩展、可复用、可追溯**的系统能力。

### 1.2 核心愿景

> **"文档即共识"** —— 任何角色在首次阅读时即可完整理解方案背景、核心流程与边界条件，无需依赖额外的口头讲解。

### 1.3 要解决的问题

| 问题层级 | 问题描述 | 表现 |
|---------|---------|------|
| **文档层面** | 文档膨胀 | 越写越长、越写越散 |
| **沟通层面** | 理解偏差 | "看不懂"、"抓不住主流程" |
| **协作层面** | 信息衰减 | 关键决策仅存于口头沟通 |
| **系统层面** | 恶性循环 | 文档不可执行 → 反复沟通 → 信息丢失 → 文档膨胀 |

### 1.4 核心洞察

人类对"口语化表达"具有更高的注意力黏性与理解容忍度，对"可反复追问、即时澄清"的沟通方式有天然偏好。文档的信息完整，但人类的"吸收路径"并非为纯文本而优化。

---

## 二、核心设计思想

### 2.1 四味药策略

PRD Agent 针对早期"米多智库"项目的四个致命问题，制定了四个核心对策：

| 策略 | 以前的问题 | 现在的策略 | 效果 |
|------|----------|----------|------|
| **策略一：面向资料** | 知识库回答"所有问题" | 只针对 PRD 内容 | 知识域收窄，置信度提升 |
| **策略二：面向群体** | 面向全员开放 | 只面向产研团队（PM/DEV/QA） | 用户问题专业，回答专业 |
| **策略三：面向问题** | 开放性问题满天飞 | 只针对具象问题 | 期望对齐，满意度提升 |
| **策略四：面向技术** | RAG 切分拉垮 | Cache 替代 RAG，全量加载 | 不切就不会切错 |

### 2.2 底层逻辑

**做减法** —— 不是"我要做一个什么都懂的全能先生"，而是"我只做一个专科老师"，只教这一门课，只带这几个学生，但教得明白、带得扎实。

### 2.3 工程原则：服务器优先闭环

从用户发出指令的那一刻开始，闭环在服务器内完成。客户端只负责发送指令与观察结果。

```
用户指令 → 创建 Run（返回 runId）→ Worker 后台执行 → SSE 推送结果
           └─────────────────────────────────────────────────────┘
                            服务器闭环（断线不影响）
```

---

## 三、系统架构

### 3.1 整体架构拓扑

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRD Agent 系统架构                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                 │
│   │ prd-desktop  │    │  prd-admin   │    │ Open Platform│                 │
│   │  (Tauri 2.0) │    │  (React 18)  │    │   Clients    │                 │
│   │  桌面客户端   │    │  管理后台     │    │  第三方接入   │                 │
│   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                 │
│          │                   │                   │                          │
│          └───────────────────┼───────────────────┘                          │
│                              ▼                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                     prd-api (.NET 8 C# 12)                          │  │
│   │  ┌────────────────────────────────────────────────────────────────┐ │  │
│   │  │                    Controllers (63个)                          │ │  │
│   │  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐│ │  │
│   │  │  │ PRD Agent   │ │Visual Agent │ │Literary Agent│ │Defect Agent││ │  │
│   │  │  │ prd-agent   │ │visual-agent │ │literary-agent│ │defect-agent││ │  │
│   │  │  └─────────────┘ └─────────────┘ └─────────────┘ └───────────┘│ │  │
│   │  └────────────────────────────────────────────────────────────────┘ │  │
│   │                              │                                       │  │
│   │  ┌───────────────────────────┴─────────────────────────────────┐    │  │
│   │  │                   ILlmGateway (统一守门员)                    │    │  │
│   │  │  ┌────────────┐  ┌─────────────┐  ┌─────────────┐           │    │  │
│   │  │  │ModelResolver│  │HealthManager│  │  LogWriter  │           │    │  │
│   │  │  │  三级调度   │  │  自动降权   │  │  统一日志   │           │    │  │
│   │  │  └────────────┘  └─────────────┘  └─────────────┘           │    │  │
│   │  └─────────────────────────────────────────────────────────────┘    │  │
│   │                              │                                       │  │
│   │  ┌───────────────────────────┴─────────────────────────────────┐    │  │
│   │  │                 Workers (Run/Worker 模式)                    │    │  │
│   │  │  ┌──────────────┐              ┌─────────────────┐          │    │  │
│   │  │  │ChatRunWorker │              │ImageGenRunWorker│          │    │  │
│   │  │  │  SSE 流式    │              │   图片生成队列   │          │    │  │
│   │  │  │ afterSeq 重连│              │    异步处理     │          │    │  │
│   │  │  └──────────────┘              └─────────────────┘          │    │  │
│   │  └─────────────────────────────────────────────────────────────┘    │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                              │                                              │
│   ┌──────────────────────────┴──────────────────────────────────────────┐  │
│   │                           数据层                                     │  │
│   │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │  │
│   │  │  MongoDB    │    │    Redis    │    │ Tencent COS │              │  │
│   │  │   55 集合   │    │   速率限制   │    │  对象存储   │              │  │
│   │  │   业务数据   │    │  滑动窗口   │    │  图片/字体  │              │  │
│   │  └─────────────┘    └─────────────┘    └─────────────┘              │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                      LLM 平台适配层                                  │  │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │  │
│   │  │  OpenAI  │ │  Claude  │ │Volcengine│ │ DeepSeek │ │  其他... │  │  │
│   │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 分层架构

| 层级 | 职责 | 关键组件 |
|------|------|---------|
| **API Layer** | HTTP 请求处理、参数验证、认证授权 | Controllers、Middleware |
| **Core Layer** | 业务逻辑、领域模型、服务接口 | Services、Models、Interfaces |
| **Infrastructure** | 外部服务集成、数据持久化 | LLM Clients、MongoDB、Redis |

**依赖方向**：单向 API → Core → Infrastructure

### 3.3 LLM Gateway 三级调度

```
请求到达（AppCallerCode）
    │
    ▼
┌─────────────────────────────────────┐
│ 1. 专属模型池 (DedicatedPool)        │
│    AppCallerCode → ModelGroupIds    │
└─────────────────┬───────────────────┘
                  │ 未命中
                  ▼
┌─────────────────────────────────────┐
│ 2. 默认模型池 (DefaultPool)          │
│    ModelType → IsDefaultForType     │
└─────────────────┬───────────────────┘
                  │ 未命中
                  ▼
┌─────────────────────────────────────┐
│ 3. 传统配置 (Legacy)                 │
│    IsMain / IsVision / IsImageGen   │
└─────────────────────────────────────┘
```

### 3.4 Run/Worker 模式时序

```
客户端                    API                     Worker                  LLM
   │                       │                        │                      │
   │──── POST /runs ──────▶│                        │                      │
   │                       │──── 创建 Run ─────────▶│                      │
   │◀──── 202 + runId ─────│                        │                      │
   │                       │                        │                      │
   │──── GET /stream ─────────────────────────────────▶                    │
   │                       │                        │──── LLM 调用 ────────▶│
   │◀──── SSE event ────────────────────────────────│◀──── 流式响应 ────────│
   │◀──── SSE event ────────────────────────────────│                      │
   │                       │                        │                      │
   │  (断线重连 afterSeq=N) │                        │                      │
   │──── GET /stream?afterSeq=N ───────────────────▶│                      │
   │◀──── 续传剩余事件 ─────────────────────────────│                      │
```

---

## 四、功能模块清单

### 4.1 核心功能状态

| 功能模块 | 状态 | 关键文件 |
|---------|:----:|---------|
| PRD 智能问答 | ✅ | ChatRunsController, ChatRunWorker |
| 角色适配（PM/DEV/QA） | ✅ | SessionService, PromptStageService |
| 群组协作 | ✅ | GroupsController, GroupService |
| 内容缺失检测 | ✅ | GapsController, GapDetectionService |
| 提示词阶段管理 | ✅ | PromptStagesController |
| 权限矩阵 RBAC | ✅ | SystemRolesController, AdminPermissionMiddleware |
| LLM Gateway 调度 | ✅ | LlmGateway, ModelResolver |
| 水印系统 | ✅ | WatermarkController, WatermarkRenderer |
| 速率限制 | ✅ | RedisRateLimitService (Lua 滑动窗口) |
| 会话归档 | ✅ | SessionsController (archive/unarchive) |
| 数据管理面板 | ✅ | DataManagePage |
| 管理通知 | ✅ | NotificationsController |
| 开放平台 API | ✅ | OpenPlatformChatController |

### 4.2 Agent 功能状态

| Agent | appKey | 状态 | 说明 |
|-------|--------|:----:|------|
| PRD Agent | `prd-agent` | ✅ | PRD 智能解读与问答 |
| 视觉创作 Agent | `visual-agent` | ✅ | 高级视觉创作工作区、多图生成 |
| 文学创作 Agent | `literary-agent` | ✅ | 文章配图（标记生成 + 批量生图 + 导出） |
| 缺陷管理 Agent | `defect-agent` | ✅ | 极简缺陷提交、AI 审核、工单流转 |

### 4.3 待实现/部分实现功能

| 功能 | 状态 | 说明 |
|------|:----:|------|
| 附件上传 | ⚠️ | Model 定义完成，无通用上传 Controller |
| 知识库 | ⚠️ | UI 占位，"资料文件"开发中 |
| 多图 Vision API | ⚠️ | 核心逻辑完成，缺集成测试 |
| 多图组合生成 | ⚠️ | 接口定义完成，Service 待实现 |
| i18n 国际化 | ❌ | 无基础设施，文案硬编码中文 |
| K8s 部署 | ❌ | 仅 docker-compose |
| 告警通知 | ❌ | 仅面板内通知，无邮件/Webhook |

---

## 五、Agent 能力矩阵

### 5.1 PRD Agent

**核心价值**: 让 AI 作为产品经理的"嘴替"，代替人工讲解 PRD

| 能力 | 说明 |
|------|------|
| 文档解析 | 支持 Markdown，提取 H1-H6 结构、表格、列表 |
| 角色适配 | PM/DEV/QA 三种视角，差异化回答 |
| 智能问答 | 自然语言提问，流式输出 |
| 边界识别 | 识别无关问题，友好拒答 |
| 缺失检测 | 识别 PRD 未覆盖的问题，提醒 PM |

### 5.2 视觉创作 Agent

**核心价值**: 高级图像生成工作区，支持多图参考、画布编辑

| 能力 | 说明 |
|------|------|
| 工作区管理 | 创建/切换/删除工作区 |
| 图像生成 | 文生图、图生图、多图组合 |
| 资产管理 | 图片上传、裁剪、删除 |
| 画布编辑 | 拖拽、缩放、图层管理 |
| 多图 Vision | 2+ 张图片参考生成 |

### 5.3 文学创作 Agent

**核心价值**: 自动为文章生成配图提示词标记，批量生成配图，导出完整文章

| 阶段 | 说明 |
|------|------|
| **上传** | 上传 .md/.txt 文章 |
| **预览** | 预览内容，选择提示词模板 |
| **配图标记** | AI 生成 `[插图]: 描述` 标记 |
| **生图** | 逐条解析标记，调用生图模型 |
| **导出** | 下载带图片的 Markdown |

**状态机规则**:
- 提交型修改清空后续阶段（version++）
- 禁止跳转到未生成过的阶段
- 单项可随时查看已生成的任意阶段

### 5.4 缺陷管理 Agent

**核心价值**: 极简提交（自然语言 + 附件），AI 辅助审核，自动提取结构化数据

| 能力 | 说明 |
|------|------|
| 极简提交 | 自然语言描述 + 粘贴/拖拽附件 |
| AI 审核 | 自动检查是否符合模板要求 |
| 字段提取 | AI 自动提取标题、步骤、严重程度等 |
| 工单流转 | draft → reviewing → submitted → assigned → processing → resolved/closed |
| 模板管理 | Admin 可配置必填字段和 AI 提示词 |

---

## 六、技术栈全景

### 6.1 后端

| 层面 | 技术 | 版本 |
|------|------|------|
| 运行时 | .NET | 8.0 |
| 语言 | C# | 12 |
| 数据库 | MongoDB | 8.0+ |
| 缓存 | Redis | 7+ |
| 日志 | Serilog | - |
| 认证 | JWT | - |
| API 通信 | REST + SSE | - |

### 6.2 桌面客户端

| 层面 | 技术 | 版本 |
|------|------|------|
| 框架 | Tauri | 2.0 |
| 后端 | Rust | 1.70+ |
| 前端 | React + TypeScript | 18 / 5 |
| 样式 | Tailwind CSS + Radix UI | - |
| 状态 | Zustand | - |

### 6.3 Web 管理后台

| 层面 | 技术 | 版本 |
|------|------|------|
| 框架 | React + TypeScript | 18 / 5 |
| 构建 | Vite | - |
| UI | Radix UI | - |
| 样式 | Tailwind CSS | - |
| 状态 | Zustand | - |

### 6.4 外部服务

| 服务 | 用途 |
|------|------|
| Claude API / OpenAI API | 大模型调用 |
| 腾讯云 COS | 文件存储 |
| GitHub Releases | 桌面端自动更新 |

---

## 七、核心架构原则

### 7.1 应用身份隔离原则

```csharp
// ✅ 正确做法：Controller 硬编码 appKey
[ApiController]
[Route("api/visual-agent")]
public class VisualAgentController : ControllerBase
{
    private const string AppKey = "visual-agent"; // 硬编码

    [HttpPost("image-gen/runs")]
    public async Task<IActionResult> Create(...)
    {
        await _service.GenerateAsync(..., appKey: AppKey, ...);
    }
}

// ❌ 错误做法：从请求读取 appKey
await _service.GenerateAsync(..., appKey: request.AppKey, ...);
```

**优势**：权限控制、功能隔离、可维护性、扩展性

### 7.2 LLM Gateway 统一调用

```csharp
// ✅ 正确做法：通过 Gateway 调用
var request = new GatewayRequest
{
    AppCallerCode = "literary-agent.content::chat",
    ModelType = "chat",
    RequestBody = new JsonObject { ["messages"] = messages }
};
var response = await _gateway.SendAsync(request, ct);

// ❌ 错误做法：直接调用底层客户端
await _openAiClient.StreamGenerateAsync(...); // 禁止！
```

**优势**：统一调度、统一日志、统一健康管理

### 7.3 服务器权威性设计

```csharp
// ✅ 核心处理使用 CancellationToken.None
await foreach (var chunk in client.StreamGenerateAsync(
    prompt, messages, false, CancellationToken.None))  // 不受客户端断开影响
{
    try {
        await Response.WriteAsync($"data: {chunk}\n\n");
    }
    catch (OperationCanceledException) {
        // 客户端断开，但继续处理
    }
}
await _db.SaveAsync(result, CancellationToken.None);  // 确保保存
```

### 7.4 前端单一数据源原则

```typescript
// ✅ 正确做法：使用后端返回的 displayName
<div>{item.displayName || item.id}</div>

// ❌ 错误做法：前端维护映射表
const nameMap = { 'prd-agent': 'PRD 代理' };
<div>{nameMap[item.code]}</div>
```

---

## 八、数据模型概览

### 8.1 MongoDB 集合分类 (55 个)

| 分类 | 集合 | 数量 |
|------|------|:----:|
| 核心业务 | users, groups, sessions, messages, parsed_prds, attachments, contentgaps, prdcomments | 9 |
| LLM/AI | llm_platforms, llm_models, llm_request_logs, model_groups, llm_app_callers | 7 |
| VisualAgent | image_master_workspaces, image_master_sessions, image_master_messages, image_master_canvas_objects | 5 |
| 水印 | watermark_configs, watermark_font_assets | 2 |
| 权限 | system_roles, admin_notifications | 2 |
| 提示词 | prompt_stages, literary_prompts | 2 |
| 开放平台 | openplatformapps, openplatformrequestlogs | 2 |
| 缺陷管理 | defect_templates, defect_reports, defect_messages | 3 |

### 8.2 关键数据模型

**Session（会话）**:
```javascript
{
  _id, userId, groupId, documentId,
  currentRole: "PM" | "DEV" | "QA",
  mode: "chat",
  createdAt, updatedAt
}
```

**Message（消息）**:
```javascript
{
  _id, sessionId, seq, role: "user" | "assistant",
  content, tokenUsage: { prompt, completion },
  runId, createdAt
}
```

**DefectReport（缺陷报告）**:
```javascript
{
  _id, defectNo: "DEF-2025-0001",
  templateId, rawContent,
  structuredData: { title, description, steps, severity },
  status: "draft" | "reviewing" | "submitted" | "assigned" | ...,
  reporterId, assigneeId,
  createdAt, updatedAt
}
```

---

## 九、开发规范速查

### 9.1 AppCallerCode 命名

**格式**: `{app-key}.{feature}[.{subfeature}...]::modelType`

| 示例 | 说明 |
|------|------|
| `prd-agent.chat::chat` | PRD 对话 |
| `visual-agent.image.vision::generation` | 视觉创作多图生成 |
| `literary-agent.illustration.text2img::generation` | 文学创作文生图 |
| `defect-agent.review::chat` | 缺陷 AI 审核 |

### 9.2 API 路由规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 管理后台 | `/api/{module}` | `/api/users`, `/api/models` |
| 客户端 | `/api/v1/{module}` | `/api/v1/sessions` |
| Agent | `/api/{agent-key}` | `/api/defect-agent` |

### 9.3 权限点命名

| 格式 | 示例 |
|------|------|
| `{module}.read` | `users.read`, `groups.read` |
| `{module}.write` | `users.write`, `models.write` |
| `{agent-key}.use` | `visual-agent.use`, `defect-agent.use` |
| `{agent-key}.manage` | `defect-agent.manage` |

### 9.4 新 Agent 开发清单

```
Phase 1: 规划设计
  □ 产品方案文档
  □ appKey 注册（rule.app-key-definition.md）
  □ 状态机设计
  □ 数据模型设计
  □ 界面原型

Phase 2: 后端实现
  □ Models 定义
  □ 权限点注册（AdminPermissionCatalog）
  □ 菜单注册（AdminMenuCatalog）
  □ Controller（硬编码 appKey）
  □ Service / Worker
  □ AppCallerCode 注册
  □ MongoDB 集合

Phase 3: 前端实现
  □ API 路由（services/api.ts）
  □ Contract 类型
  □ Service 实现
  □ Store
  □ Page 组件
  □ 路由注册
  □ 权限守卫

Phase 4: 测试 & 文档
  □ 后端单元测试
  □ 前端组件测试
  □ E2E 流程测试
  □ 更新 CLAUDE.md
  □ 更新 SRS/数据字典
```

---

## 十、本周进展

### 2026-01-20 ~ 2026-02-01 主要提交

| 日期 | 类型 | 内容 |
|------|------|------|
| 01-31 | docs | 代码审计报告 (audit.code-review-2026-02.md) |
| 01-30 | fix | navOrderStore 用户偏好处理优化 |
| 01-29 | refactor | PanelCard 组件抽离优化 |
| 01-28 | fix | ArticleIllustrationEditorPage 图片处理和下载功能 |
| 01-27 | feat | 文学创作 Agent 图片生成功能增强 |
| 01-26 | feat | LLM Gateway 架构和多图 Vision API 支持 (#53) |
| 01-25 | feat | 参考图配置管理、水印设置增强 |
| 01-24 | feat | 用户头像和缺陷管理功能增强 |
| 01-23 | feat | 水印测试功能和 UI 改进 |
| 01-22 | feat | 缺陷管理 Agent 完整实现 (#50) |
| 01-21 | docs | MDC 规则同步和过时内容修复 (#49) |
| 01-20 | feat | LLM 调度和日志需求实现 |

### 本周重点功能

1. **LLM Gateway 架构落地** - 三级调度、健康管理、统一日志
2. **缺陷管理 Agent 完整交付** - AI 审核、状态机、前后端完整实现
3. **文学创作 Agent 增强** - 图片生成、下载功能优化
4. **多图 Vision API 支持** - 2+ 张图片参考生成
5. **代码审计报告** - 识别 25 个问题，制定修复计划

---

## 十一、已知技术债务

### 11.1 严重问题 (P0)

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 1 | ImageGenController appKey 未硬编码 | `Controllers/Api/ImageGenController.cs:1027-1033` | 应用身份隔离漏洞 |
| 2 | 前端业务映射表硬编码 | `lib/appCallerUtils.ts:199-246` | 违反单一数据源 |
| 3 | 前端菜单定义硬编码 | `lib/authzMenuMapping.ts:16-100` | 违反单一数据源 |
| 4 | GuideOutlineItem 未清理 | `Core/Models/GuideOutlineItem.cs` | 废弃代码残留 |
| 5 | Mutex unwrap 可能 panic | `prd-desktop/commands/session.rs:22-51` | 生产稳定性风险 |

### 11.2 中等问题 (P1)

| # | 问题 | 文件 |
|---|------|------|
| 6 | SSE 直接 fetch 调用 | `AiChatPage.tsx:818-820` |
| 7 | SSE 直接 fetch 调用 | `PromptStagesPage.tsx:575-576` |
| 8 | guide_step 字段未删 | `prd-desktop/models/mod.rs:62` |
| 9 | 角色中文映射硬编码 | `MessageList.tsx:42-78` |
| 10 | localStorage 登出不清理 | `prd-desktop/authStore.ts:40-46` |
| 11 | MessageList 1477 行过大 | `Chat/MessageList.tsx` |

### 11.3 修复优先级

1. **第一阶段 (1-2 周)**: P0 问题 - 安全与合规
2. **第二阶段 (2-3 周)**: P1 问题 - 架构一致性
3. **第三阶段 (持续)**: 代码质量优化

---

## 十二、快速上手指南

### 12.1 环境准备

```bash
# 后端
cd prd-api
dotnet restore
dotnet run --project src/PrdAgent.Api

# 管理后台
cd prd-admin
pnpm install
pnpm dev

# 桌面客户端
cd prd-desktop
pnpm install
pnpm tauri dev
```

### 12.2 必读文档

| 优先级 | 文档 | 说明 |
|:------:|------|------|
| 1 | `CLAUDE.md` | 项目架构规则（必读） |
| 2 | `doc/1.why.md` | 项目背景和设计思想 |
| 3 | `doc/4.dev.md` | 开发指南 |
| 4 | `doc/rule.data-dictionary.md` | 数据字典 |
| 5 | `doc/rule.app-key-definition.md` | appKey 规范 |

### 12.3 常用命令

```bash
# 运行测试
cd prd-api && dotnet test

# 构建桌面端
cd prd-desktop && pnpm tauri build

# 查看 API 日志
cd prd-api && tail -f logs/prdagent-*.log

# 数据库连接
mongosh mongodb://localhost:27017/prdagent
```

### 12.4 调试技巧

1. **LLM 调用追踪**: 查看 `llm_request_logs` 集合，按 `RequestPurpose` 过滤
2. **SSE 调试**: 使用 `curl -N` 或浏览器 EventSource
3. **权限问题**: 检查 `system_roles` 和 `AdminPermissionMiddleware` 日志
4. **前端状态**: 使用 Redux DevTools 查看 Zustand store

---

## 附录

### A. 文档索引

| 编号 | 文件 | 内容 |
|------|------|------|
| 0 | doc-maintenance.md | 文档维护指南 |
| 1 | why.md | 项目背景 |
| 2 | srs.md | 软件需求规格 |
| 3 | prd.md | 产品需求文档 |
| 4 | dev.md | 开发文档 |
| 5 | step.md | 开发进度 |
| rule.* | - | 规则文档 (6 个) |
| design.* | - | 设计文档 (10 个) |
| agent.* | - | Agent 文档 |
| audit.* | - | 审计报告 |

### B. 联系方式

- **GitHub**: https://github.com/inernoro/prd_agent
- **问题反馈**: GitHub Issues

---

*本文档由 Claude Opus 4.5 自动生成，基于项目文档和代码扫描综合分析*
