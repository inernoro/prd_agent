# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Build & Development Commands

### Backend (prd-api/) — .NET 8, C# 12

```bash
cd prd-api
dotnet restore
dotnet build                             # Build all projects
dotnet watch run --project src/PrdAgent.Api  # Dev server (port 5000)
dotnet test PrdAgent.sln                 # Run all tests (xunit)
dotnet test PrdAgent.sln --filter "Category!=Integration"  # Unit tests only
dotnet test --filter "FullyQualifiedName~ClassName.MethodName"  # Single test
```

Docker build (no .NET SDK required): `./scripts/build-server-docker.sh`

### Admin Web (prd-admin/) — React 18, Vite, TypeScript, Zustand, Radix UI

```bash
cd prd-admin
pnpm install
pnpm dev          # Dev server (port 8000, proxies /api → localhost:5000)
pnpm build        # tsc && vite build → dist/
pnpm lint         # ESLint
pnpm tsc          # Type check only
pnpm test         # vitest
```

### Desktop (prd-desktop/) — Tauri 2.0 (Rust + React)

```bash
cd prd-desktop
pnpm install
pnpm tauri:dev    # Dev with hot reload (port 1420)
pnpm tauri:build  # Production bundle
pnpm lint         # ESLint
pnpm theme:scan   # Theme consistency check
```

Version must stay in sync across: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. Use `./quick.sh version vX.Y.Z` to sync.

### Video (prd-video/) — Remotion 4.0

```bash
cd prd-video
npm install
npm start         # Remotion Studio
npm run build     # Render to out/tutorial.mp4
```

### Docker Compose

```bash
docker compose -f docker-compose.dev.yml up -d --build  # Dev stack (all services)
# Web: localhost:5500, API: localhost:5000, Mongo: localhost:18081, Redis: localhost:18082
```

### Quick Start (Windows)

```powershell
.\quick.ps1           # Backend only
.\quick.ps1 all       # Server + desktop + admin
.\quick.ps1 ci        # Full CI checks
```

# 前端包管理器规则

**强制规则**：本项目所有 Node.js / 前端项目（`prd-admin`、`prd-desktop`、`prd-video` 等）统一使用 **pnpm**，禁止使用 npm 或 yarn。

- 安装依赖：`pnpm install`
- 添加依赖：`pnpm add <package>`
- 运行脚本：`pnpm run <script>` 或 `pnpm <script>`
- Lockfile：仅保留 `pnpm-lock.yaml`，禁止提交 `package-lock.json` 或 `yarn.lock`

---

# C# 代码静态分析规则

**强制规则**：任何涉及 C#（`.cs` 文件）的改动，完成后**必须**使用 Roslyn 进行代码静态分析，确认零错误后才算完成。

### 执行方式

```bash
# 在 prd-api 目录下执行
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

### 判定标准

- **error CS\*\***：必须修复，不允许提交
- **warning CS\*\***：评估是否为本次改动引入，如是则修复

---

# 任务完成交接规则

**强制规则**：当你完成一个开发任务（代码编写 + 编译通过）后，**必须主动**使用 `task-handoff-checklist` 技能生成交接清单，不需要用户要求。

判断标准：
- 涉及 **3 个以上文件变更**，或涉及 **新增/修改 API 端点**，或涉及 **UI 页面变更** → 生成完整交接清单（8 个维度）
- 仅 **1-2 个文件的小修改**（如修个 typo、改个样式） → 不需要生成，直接告知改了什么即可

---

# 质量保障技能链

> AI 辅助开发的完整质量保障流程，6 个技能覆盖从设计到上线的全生命周期。

### 全景链路

```
设计阶段              实现阶段              验收阶段              上线阶段
    │                    │                    │                    │
 /risk                /trace               /verify              /handoff
 风险矩阵              路径追踪              交叉验证              交接清单
 "有什么风险"          "怎么跑的"            "做对了吗"            "能上线吗"
    │                    │                    │                    │
    └──────── /smoke-test（冒烟测试，贯穿各阶段）─────────┘          │
                                                              /weekly
                                                              周报总结
                                                             "做了什么"
```

### 技能速查表

| 技能 | 触发词 | 用途 | 适合谁 |
|------|--------|------|--------|
| **risk-matrix** | "风险评估"、"/risk" | MECE 六维度风险评估（正确性/兼容性/性能/安全/运维/体验） | 技术负责人、架构师 |
| **flow-trace** | "追踪"、"/trace" | 全链路数据流+控制流追踪，大白话输出路径图 | 产品、开发、新人 |
| **human-verify** | "验证一下"、"/verify" | 多角度模拟验证（逆向验证/边界测试/数据流追踪） | 开发者 |
| **smoke-test** | "冒烟测试"、"/smoke" | 自动生成链式 curl 命令端到端测试 | 开发者、QA |
| **task-handoff-checklist** | "交接"、"/handoff" | 8 维度交接清单（导航/文档/规则/流程/测试/风险/质量/后续） | 所有人 |
| **conflict-resolution** | "合并主分支"、"/resolve" | PR 前预合并 main 到特性分支（三级冲突分类、禁止丢弃代码、高风险交人类） | 开发者 |
| **weekly-update-summary** | "生成周报"、"/weekly" | 从 git 历史自动生成结构化周报 | 项目负责人 |
| **doc-writer** | "写文档"、"/doc"、自动触发 | doc/ 下文档类型守护（6 种类型模板 + 格式校验） | 所有人 |

### 使用指引

1. **方案评审时** → 先 `/risk` 评估风险，再 `/trace` 追踪关键链路
2. **开发完成后** → 先 `/verify` 交叉验证，再 `/smoke-test` 跑端到端
3. **提 PR 前** → `/resolve` 预合并主分支，AI 代替人类解决冲突
4. **准备上线时** → `/handoff` 生成交接清单（涉及 3+ 文件时自动触发）
5. **周五收尾时** → `/weekly` 生成本周总结
6. **写文档时** → `/doc` 查看类型速查，或直接创建文档时自动套用模板

---

## doc/ 文档类型规则

**强制规则**：`doc/` 下所有 `.md` 文件必须属于以下 6 种类型之一，禁止发明新前缀。每种类型回答一个不可替代的问题（4W1H + 回顾）。

| 前缀 | 对应 | 核心问题 | 子类型 |
|------|------|---------|--------|
| `spec.*` | **What** | 做什么 | 产品规格、Agent 文档、用户故事 |
| `design.*` | **How** | 怎么做 | 技术设计、技术分析 |
| `plan.*` | **When** | 什么时候做 | 实施计划 |
| `rule.*` | **Why not** | 为什么不能那样做 | 规范约定、审计报告 |
| `guide.*` | **How-to** | 怎么操作 | 操作指南、备忘录 |
| `report.*` | **What happened** | 做了什么 | 周报 |

详细模板和写作规范见 `doc-writer` 技能（`/doc`）和 `doc/rule.doc-templates.md`。

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
   | 视频 Agent | `video-agent` | 文章转视频教程生成 |
   | 周报管理 Agent | `report-agent` | 周报创建、提交、审阅管理 |

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

## 数据关系审计原则

**核心原则**：当实体 A 新增了对实体 B 的引用关系（如 `Session.DocumentIds` 引用 `Document`），必须审计所有访问实体 B 的端点，确保权限校验覆盖新关系。

> **根因案例**：多文档功能上线后，补充文档无法预览（"该文档未绑定到当前群组"）。原因是 `Session.DocumentIds` 存储了补充文档引用，但 `DocumentsController`、`PrdCommentsController`、`Api/DocumentsController` 三个端点的绑定校验仍只查 `Group.PrdDocumentId`。写入路径做了，读取路径漏了。

### 审计清单

当新增数据关系时（Model 类新增 `List<string> xxxIds` 字段、新增外键引用、新增"A 拥有 B"的业务逻辑）：

- [ ] **Grep 实体 B 的所有消费端点**：搜索 `documentId`、`DocumentId`、`GetByIdAsync` 等关键词
- [ ] **逐个检查权限校验**：是否覆盖了新的访问路径（不只是旧的唯一入口）
- [ ] **逐个检查硬编码假设**：是否有 `group.PrdDocumentId == id` 这类只认单一来源的写法
- [ ] **检查反向路径**：删除实体 A 时，实体 B 的引用是否需要清理

### 典型触发场景

| 变更类型 | 审计动作 |
|----------|----------|
| Model 新增 `List<string> XxxIds` | Grep 被引用实体的所有 Controller，检查访问校验 |
| 新增"A 包含 B"关系 | 检查 B 的 CRUD 端点是否识别新的所属关系 |
| 将单引用改为多引用 | 所有 `== id` 比较改为 `Contains(id)` |

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

## 默认可编辑原则

**核心原则**：系统开发初期，减少约束。除非业务明确禁止或具有破坏性，所有表单字段默认可编辑，不主动加 `disabled` / `readOnly` 限制。

- 仅在**业务明确禁止**（如已发布合同编号）、**破坏性较重**（修改导致大量数据不一致且无法自动修复）、**安全要求**（审计日志不可篡改）时才禁用
- "编辑时可能不太合适"、"一般不会改"、"改了需要同步" → 均不构成禁用理由

> 详细规则见 `doc/rule.default-editable.md`

---

## 前端组件复用原则

**核心原则**：全局同属性元素，能复用则复用。多个页面需要相同语义的 UI 元素时，必须抽取为 `src/components/` 下的共享组件，禁止在各页面硬编码重复的选项列表或选择器。

### 规则说明

1. **两个以上页面**出现同一业务概念的选择/展示 → 必须提取共享组件
2. 数据源（枚举定义、常量列表）统一维护在 `src/lib/` 下的单一文件
3. 新增/修改页面时，先搜索现有共享组件，已有则直接使用

### 已注册共享组件

| 组件 | 路径 | 数据源 |
|------|------|--------|
| `ModelTypePicker` | `components/model/ModelTypePicker.tsx` | `lib/appCallerUtils.ts → MODEL_TYPE_DEFINITIONS` |
| `ModelTypeFilterBar` | `components/model/ModelTypePicker.tsx` | 同上 |

> 详细规则见 `doc/rule.frontend-component-reuse.md`

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

## 单一数据源渲染原则 (Single Source of Truth for Rendering)

**核心原则**：同一个组件、同一处 UI、同一个业务功能的渲染，禁止从两个数据源获取数据。

> 业界参考：Redux SSOT (Single Source of Truth)、TanStack Query 的 queryKey 唯一缓存、React 单向数据流。

### 规则说明

1. **一个列表 = 一个数据源**
   - 一个 UI 列表只能由一个 Store 字段（或一个 query cache entry）驱动
   - 禁止：组件 A 通过接口 X 填充列表，组件 B 通过接口 Y 填充同一列表
   - 正确：列表数据统一存储在一个 Store 字段，所有写入路径最终都更新同一个字段

2. **mutation 后刷新**
   - 修改操作（增/删/改）完成后，必须更新同一个 Store 字段
   - 禁止在 mutation 回调中绕过 Store 直接操作 UI 状态

3. **rehydrate 兼容**
   - 当 Store 新增字段时，必须在 `onRehydrateStorage` 中处理旧数据兼容
   - 确保旧 localStorage 缺失新字段时，能从已有字段派生出正确初始值

### 示例

```typescript
// ✅ 正确做法：统一数据源
// sessionStore 中只有 documents[] 一个字段
// openGroupSession → setDocuments(allDocs)
// addDocument → setDocuments(updatedDocs)
// removeDocument → setDocuments(updatedDocs)
// KnowledgeBasePage 读取 → sessionStore.documents
// Sidebar 读取 → sessionStore.documents

// ❌ 错误做法：两个数据源
// openGroupSession → 填充 sessionStore.document (单数)
// addDocument → 直接 fetch 并维护 KnowledgeBasePage 本地 state
// 结果：切换页面/刷新后数据不一致
```

### 检查清单

当新增/修改 Store 字段时：
- [ ] 确认该字段是否为某个 UI 列表的唯一数据源
- [ ] 确认所有写入路径（初始化、mutation、rehydrate）都更新同一个字段
- [ ] 确认 `onRehydrateStorage` 能兼容旧数据
- [ ] 确认没有组件通过本地 state 维护该字段的"影子副本"

---

## 服务器权威性设计

> 详细设计文档：`doc/design.server-authority.md`

**核心原则**：客户端被动断开（关页面、切路由、网络中断）不得取消服务器任务。只有用户主动调用取消 API 才允许中断。

### 强制规则

1. **LLM 调用、数据库写操作**必须使用 `CancellationToken.None`，禁止传递 `HttpContext.RequestAborted`
2. **SSE 写入**必须捕获 `OperationCanceledException` + `ObjectDisposedException`，断开后跳过写入但继续处理
3. **长任务**（图片生成、视频渲染、工作流）必须通过 **Run/Worker 模式**与 HTTP 连接解耦
4. **SSE 流**必须每 10 秒发送 keepalive 心跳，必须支持 `afterSeq` 断线续传
5. **Worker 关闭时**必须将未完成的 run 标记为失败（`CancellationToken.None`）

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
├── prd-video/        # Remotion 视频合成项目 (React + TypeScript)
│   ├── src/          # components/, scenes/, utils/, Root.tsx, TutorialVideo.tsx
│   └── scripts/      # generate_srt.py, render.sh
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
| **VideoGen Service** | `IVideoGenService` 领域服务封装视频生成 CRUD + 状态流转，供 Controller + 工作流胶囊复用 |

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
| 缺陷管理 Agent | ✅ DONE | DefectAgentController, DefectEscalationWorker, DefectWebhookService, DefectAgentTests (25 tests)。含项目维度、待验收流程、超时催办、统计看板、Webhook 通知 |
| 视频 Agent | ✅ DONE | VideoAgentController, VideoGenRunWorker, IVideoGenService (领域服务), prd-video/ (Remotion: TransitionSeries 转场、ParticleField 粒子、AnimatedText 动画文字、PathDraw SVG 描边、@remotion/transitions+paths+noise) |
| 视觉创作视频生成 | ✅ DONE | VisualAgentVideoController (appKey=visual-agent, 每日限额1次), 共享 IVideoGenService + VideoGenRunWorker |
| 视频生成工作流胶囊 | ✅ DONE | CapsuleTypes.VideoGeneration ("video-generation"), CapsuleExecutor.ExecuteVideoGenerationAsync, 支持从工作流中创建视频任务并等待完成 |
| 配置市场 (海鲜市场) | ✅ DONE | CONFIG_TYPE_REGISTRY, MarketplaceCard, IForkable, ForkService |
| 周报管理 Agent | ✅ Phase 1-4 DONE | ReportAgentController, ReportAgentPage (7 tabs)，详见 `doc/plan.report-agent-impl.md` |
| **附件上传** | ✅ DONE | AttachmentsController + Rust upload_attachment + Desktop UI (图片选择/预览/上传) |
| **技能系统** | ✅ DONE | SkillSettings 模型 + SkillsController + Desktop SkillPanel/SkillManagerModal (服务端公共技能 + 客户端本地自定义技能) |
| **网页托管** | ✅ DONE | WebPagesController + IHostedSiteService + HostedSiteService, WebPagesPage + ShareViewPage, COS 站点托管 + 分享链接，详见 `doc/design.web-hosting.md` |
| **知识库** | ⚠️ PARTIAL | KnowledgeBasePage UI 占位，"资料文件"标注开发中 |
| **i18n** | ❌ NOT_IMPL | 无任何 i18n 基础设施，文案硬编码中文 |
| **K8s 部署** | ❌ NOT_IMPL | 仅 docker-compose，无 K8s manifests |
| **告警通知 (邮件/Webhook)** | ❌ NOT_IMPL | 仅 AdminNotification 面板内通知 |

### MongoDB 集合清单 (98 个)

核心业务：`users`, `groups`, `groupmembers`, `documents`, `sessions`, `messages`, `group_message_counters`, `contentgaps`, `attachments`, `prdcomments`, `share_links`

网页托管：`hosted_sites`, `web_page_share_links`

LLM/AI：`llmconfigs`, `llmplatforms`, `llmmodels`, `llmrequestlogs`, `model_groups`, `model_scheduler_config`, `model_test_stubs`, `llm_app_callers`, `model_exchanges`

Model Lab：`model_lab_experiments`, `model_lab_runs`, `model_lab_run_items`, `model_lab_model_sets`, `model_lab_groups`

Arena：`arena_groups`, `arena_slots`, `arena_battles`

VisualAgent (DB 名保留 image_master)：`image_master_workspaces`, `image_assets`, `image_master_sessions`, `image_master_messages`, `image_master_canvases`, `image_gen_size_caps`, `image_gen_runs`, `image_gen_run_items`, `image_gen_run_events`, `upload_artifacts`

水印：`watermark_configs`, `watermark_font_assets`

权限/角色：`system_roles`, `admin_notifications`, `invitecodes`

桌面资产：`desktop_asset_skins`, `desktop_asset_keys`, `desktop_assets`

提示词/技能：`promptstages`, `systemprompts`, `literary_prompts`, `skill_settings`, `skills`, `admin_prompt_overrides`, `literary_agent_configs`, `reference_image_configs`

开放平台：`openplatformapps`, `openplatformrequestlogs`

缺陷管理：`defect_templates`, `defect_reports`, `defect_messages`, `defect_folders`, `defect_projects`, `defect_webhook_configs`

视频 Agent：`video_gen_runs`

周报管理：`report_teams`, `report_team_members`, `report_templates`, `report_weekly_reports`, `report_daily_logs`, `report_data_sources`, `report_commits`, `report_comments`, `report_team_summaries`

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

**存在性校验（有没有）**：

1. **代码→文档**：Controller/Service 存在 → SRS 功能模块有描述
2. **文档→代码**：SRS 描述的功能 → 代码中存在对应实现
3. **Git log→文档**：近期 commit 的功能变更 → 已反映到文档
4. **DB→数据字典**：MongoDbContext 集合 → rule.data-dictionary.md 有记录
5. **目录结构→文档**：实际目录 → SRS 目录结构图一致
6. **未实现标注**：文档中描述但代码不存在的功能 → 必须标注 ⚠️ 状态

**完整性校验（全不全）**：

7. **关系→访问路径**：Model 新增引用字段 → 所有消费该实体的端点已更新权限校验（参见「数据关系审计原则」）
8. **写入→读取对称**：能写入的数据 → 必须有对应的读取/展示路径，不允许"断头功能"（能存不能看）
9. **UI→API 闭环**：前端有入口的功能 → 对应 API 端点完整可用（增删改查全链路通）

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
| `doc/spec.marketplace.md` | 设计文档 (v3.0) |

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

---

