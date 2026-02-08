# PRD Agent 系统优化计划书

> **编写日期**：2026-02-08
> **分析范围**：后端 (prd-api)、前端 (prd-admin)、桌面端 (prd-desktop)、基础设施 (CI/CD/Docker)
> **代码规模**：后端 404 C# 文件 / 前端 101,468 行 / 桌面 Rust 2,181 行

---

## 一、总体评价

系统在架构设计上有明确的分层（Api / Core / Infrastructure）、良好的 Gateway 抽象、成熟的 Run/Worker 模式和完善的 RBAC 权限体系。API 服务层契约化设计优秀，Zustand 状态管理克制得当。但随着功能持续迭代，积累了若干结构性技术债，主要集中在**巨型文件膨胀**、**关注点未分离**、**前端性能基础设施缺失**和**安全加固不足**四个方面。

---

## 二、优化领域总览

| # | 领域 | 严重度 | 预估影响 |
|---|------|--------|----------|
| 1 | 安全加固 | 🔴 P0 | 防止凭据泄露、XSS 攻击 |
| 2 | 后端巨型文件拆分 | 🔴 P0 | 可维护性、可测试性 |
| 3 | 前端性能基础设施 | 🔴 P0 | 首屏加载、用户体验 |
| 4 | 前端巨型组件治理 | 🟡 P1 | 可维护性、可复用性 |
| 5 | 数据库访问层优化 | 🟡 P1 | 查询性能、代码复用 |
| 6 | 可观测性建设 | 🟡 P1 | 生产运维能力 |
| 7 | 启动配置工程化 | 🟡 P1 | 配置安全、可维护性 |
| 8 | 前端架构规范治理 | 🟢 P2 | 代码质量一致性 |
| 9 | 测试覆盖补全 | 🟢 P2 | 回归防护 |
| 10 | 文档与代码同步 | 🟢 P2 | 知识传承 |

---

## 三、详细优化方案

### 1. 安全加固 🔴 P0

#### 1.1 桌面端 CSP 策略为空

**现状**：`prd-desktop/src-tauri/tauri.conf.json` 中 `"csp": null`，完全禁用内容安全策略。

**风险**：任何注入脚本可无限制执行，即使 Tauri 有沙箱保护，也不应关闭 CSP。

**方案**：
```json
"csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:"
```

#### 1.2 邮件渠道密码明文存储

**现状**：`ChannelAdminController.cs` 中 IMAP/SMTP 密码以明文写入 MongoDB，代码中有 `// TODO: 加密存储` 注释。

**方案**：复用项目已有的 `ApiKeyCrypto` 模式，对 `ImapPassword` / `SmtpPassword` 做 AES 加密后存储，读取时解密。

#### 1.3 异常信息泄露

**现状**：`ExceptionMiddleware.cs` 对部分异常类型返回 `exception.Message`，可能暴露实现细节。

**方案**：生产环境统一返回通用错误消息，`exception.Message` 仅写入日志。

---

### 2. 后端巨型文件拆分 🔴 P0

以下文件已严重超过单一职责边界，维护风险高：

| 文件 | 行数 | 核心问题 |
|------|------|---------|
| `ImageMasterController.cs` | 2,649 | 28 个 Action，混合 Workspace/Asset/Canvas/Session |
| `DefectAgentController.cs` | 1,837 | Agent 全功能混在一个 Controller |
| `ImageGenController.cs` | 1,672 | 生图逻辑嵌入 Controller |
| `RequestResponseLoggingMiddleware.cs` | 1,062 | 5+ 个关注点混合 |
| `LlmGateway.cs` | 1,128 | 发送/流式/日志/校验混合 |
| `ModelResolver.cs` | 864 | 解析/健康/调度混合 |
| `Program.cs` | 951 | 所有 DI 注册集中一处 |

#### 2.1 Controller 拆分方案

**ImageMasterController → 3 个 Controller**：
- `ImageMasterWorkspaceController` — Workspace CRUD
- `ImageMasterAssetController` — Asset 管理
- `ImageMasterCanvasController` — Canvas 操作 + Session

**DefectAgentController → 2 个 Controller + Service 提取**：
- `DefectAgentController` — 缺陷管理核心 API
- `DefectTemplateController` — 模板管理
- 业务逻辑下沉到 `DefectAgentService`

#### 2.2 中间件拆分方案

**RequestResponseLoggingMiddleware → 5 个单元**：
- `RequestBodyCaptureService` — 请求体捕获
- `ApiResponseSummarizer` — 响应摘要
- `DesktopPresenceTracker` — 桌面端心跳
- `ApiRequestLogPersister` — 日志持久化
- `RequestLoggingMiddleware` — 瘦中间件，编排上述服务

#### 2.3 LLM Gateway 拆分方案

**LlmGateway.cs → 3 个类**：
- `LlmGatewayRequester` — Send + Stream 核心逻辑
- `LlmGatewayLogger` — 请求日志记录
- `LlmGatewayValidator` — 请求校验

**ModelResolver.cs → 3 个类**：
- `ModelResolutionService` — 模型解析
- `ModelHealthManager` — 健康追踪
- `ModelSchedulingEngine` — 三级调度

#### 2.4 Program.cs 模块化

拆分为扩展方法：
```csharp
builder.Services.AddAuthenticationServices(builder.Configuration);
builder.Services.AddLlmServices(builder.Configuration);
builder.Services.AddMongoServices(builder.Configuration);
builder.Services.AddCacheServices(builder.Configuration);
builder.Services.AddWorkerServices();
```

---

### 3. 前端性能基础设施 🔴 P0

#### 3.1 路由级代码分割（当前完全缺失）

**现状**：`App.tsx` 中 20+ 页面全部静态 import，首屏加载所有页面代码。

**方案**：
```tsx
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const UsersPage = lazy(() => import('@/pages/UsersPage'));
// ... 所有页面

<Suspense fallback={<PageSkeleton />}>
  <Routes>
    <Route path="/dashboard" element={<DashboardPage />} />
  </Routes>
</Suspense>
```

**预估收益**：首屏 bundle 减少 20-30%。

#### 3.2 React Error Boundary（当前完全缺失）

**现状**：整个前端无 Error Boundary，任何 JS 运行时错误导致白屏。

**方案**：
- 全局 `AppErrorBoundary` 捕获顶层异常
- 页面级 `PageErrorBoundary` 隔离页面崩溃
- 可选：接入 Sentry 上报

#### 3.3 重型依赖动态加载

Three.js (`AttentionLandscape.tsx`) 等重型库应 dynamic import，避免污染主 bundle。

---

### 4. 前端巨型组件治理 🟡 P1

| 组件 | 行数 | 拆分建议 |
|------|------|---------|
| `AdvancedVisualAgentTab.tsx` | 8,686 | 拆为 Canvas/Toolbar/Sidebar/Dialog 4+ 子组件 |
| `LlmLabTab.tsx` | 4,720 | 拆为 Config/Results/History 子组件 |
| `ArticleIllustrationEditorPage.tsx` | 3,629 | 拆为 Editor/Preview/Settings 子组件 |
| `UsersPage.tsx` | 2,290 | 30+ useState → 提取 useUserManagement Hook |
| `WatermarkSettingsPanel.tsx` | 2,487 | 拆为 FontConfig/LayoutConfig/Preview 子组件 |
| `LlmLogsPage.tsx` | 2,517 | 拆为 Filter/Table/Detail 子组件 |

#### 4.1 通用工具函数外提

以下函数在组件中内联定义，应提取到 `/lib/`：
- `computeObjectFitContainRect()` → `lib/canvasUtils.ts`
- `formatRelativeTime()` (在 2 个文件中重复) → `lib/dateUtils.ts`
- `safeJsonParse()` → `lib/jsonUtils.ts`
- Canvas 几何计算函数 → `lib/geometryUtils.ts`

#### 4.2 消除 CLAUDE.md 违规的前端硬编码映射

以下文件违反了"前端禁止维护业务数据映射表"原则：

- `UserProfilePopover.tsx`: `agentLabels` / `agentIcons` 映射表
- `WatermarkSettingsPanel.tsx`: `appKeyLabelMap` 映射表
- 至少 5+ 处其他 appKey → 中文名映射

**方案**：后端 API 返回 `{ value, displayName, iconKey }` 结构，前端仅做渲染。

#### 4.3 TypeScript `any` 类型清理

当前 179 处 `any` 使用，重点清理：
- `appCallerUtils.ts` — 10+ 处
- `marketplaceTypes.tsx` — 5+ 处
- `AttentionLandscape.tsx` — 8+ 处

---

### 5. 数据库访问层优化 🟡 P1

#### 5.1 泛型 Repository 基类

**现状**：7 个 Repository 中大量重复 CRUD 模式。

**方案**：
```csharp
public abstract class MongoRepository<T> where T : class, IEntity
{
    protected IMongoCollection<T> Collection { get; }

    public virtual Task<T?> FindByIdAsync(string id, CancellationToken ct = default);
    public virtual Task<List<T>> FindAsync(FilterDefinition<T> filter, CancellationToken ct = default);
    public virtual Task InsertAsync(T entity, CancellationToken ct = default);
    public virtual Task ReplaceAsync(T entity, CancellationToken ct = default);
    public virtual Task DeleteAsync(string id, CancellationToken ct = default);
}
```

#### 5.2 查询投影优化

**现状**：多数查询 `Find().FirstOrDefaultAsync()` 返回完整文档，无投影。

**方案**：对列表查询添加 `.Project()` 只取需要的字段，减少 BSON 反序列化开销。

#### 5.3 CancellationToken 一致性

部分 Repository 方法未接受 `CancellationToken` 参数，应统一补全。

---

### 6. 可观测性建设 🟡 P1

#### 6.1 健康检查增强

**现状**：`/health` 仅返回 `{ status: "healthy" }`，不检测任何依赖。

**方案**：
```csharp
builder.Services.AddHealthChecks()
    .AddMongoDb(connectionString, name: "mongodb")
    .AddRedis(redisConnectionString, name: "redis")
    .AddCheck<LlmGatewayHealthCheck>("llm-gateway");
```

#### 6.2 分布式追踪

**现状**：无 OpenTelemetry 集成，生产环境排查问题困难。

**方案**：引入 OpenTelemetry SDK，trace HTTP 请求 → LLM Gateway → MongoDB 的完整链路。

#### 6.3 日志改进

**现状**：`RequestResponseLoggingMiddleware` 中多处 `catch { /* ignore */ }` 吞掉异常。

**方案**：所有 catch 块至少记录 `_logger.LogWarning(ex, "...")`.

---

### 7. 启动配置工程化 🟡 P1

#### 7.1 类型化配置选项

**现状**：`Program.cs` 中大量魔法字符串 `"MongoDB:ConnectionString"`, `"Redis:ConnectionString"` 等。

**方案**：
```csharp
public class MongoDbOptions
{
    public const string Section = "MongoDB";
    public string ConnectionString { get; set; } = "";
    public string DatabaseName { get; set; } = "";
}

// 注册
builder.Services.Configure<MongoDbOptions>(
    builder.Configuration.GetSection(MongoDbOptions.Section));
```

为 MongoDB / Redis / JWT / TencentCOS / LLM 各建一个 Options 类。

#### 7.2 环境变量命名统一

**现状**：混合使用 `Jwt__Secret`（.NET 风格）和 `ASSETS_PROVIDER`（Unix 风格）。

**方案**：统一使用 .NET 的双下划线映射风格，在文档中列明所有环境变量。

---

### 8. 前端架构规范治理 🟢 P2

#### 8.1 表单管理库引入

**现状**：所有表单手动管理 state，`UsersPage.tsx` 中 30+ useState 管理多个表单。

**方案**：引入 `react-hook-form` + `zod`，统一表单校验和状态管理。

#### 8.2 公共工具方法去重

| 方法 | 重复位置 | 目标 |
|------|---------|------|
| `GetUserId()` | 12 个 Controller | 提取到 `ControllerBase` 扩展方法 |
| `IsRoot()` | 2 个 Middleware | 提取到 `ClaimsPrincipalExtensions` |
| `formatRelativeTime()` | 2 个前端文件 | 提取到 `lib/dateUtils.ts` |

#### 8.3 前端 Console 日志清理

**现状**：63 处 `console.log/error/warn`。

**方案**：引入 `eslint-plugin-no-console` 或 Vite 插件在生产构建时自动 strip。

---

### 9. 测试覆盖补全 🟢 P2

#### 9.1 后端测试缺口

| 缺失区域 | 建议 |
|---------|------|
| AdminPermissionMiddleware | 单元测试 — 验证权限矩阵 |
| RequestResponseLoggingMiddleware | 集成测试 — 验证日志落库 |
| Authentication Handlers | 单元测试 — JWT/ApiKey/AiAccessKey |
| RateLimitMiddleware | 集成测试 — 滑动窗口行为 |

#### 9.2 前端测试缺口

- 当前仅 4 个测试文件（themeSystem / canvasLayerUtils / sizeAdaptation / canvasPersist）
- 19 个页面级组件无任何测试
- 建议优先为核心页面添加 Vitest + React Testing Library 测试

#### 9.3 桌面端测试

- Rust 命令层无可见测试
- 建议为 `api_client.rs` / `session.rs` 核心模块添加单元测试

---

### 10. 文档与代码同步 🟢 P2

#### 10.1 自动化校验

**现状**：文档团队已在 `0.doc-maintenance.md` 中承认文档漂移问题。

**方案**：
- CI 中添加 Swagger 提取 → 与文档对比
- Controller 上添加 `[SrsRef("2.5.3")]` 属性，可追溯对应文档章节

#### 10.2 API 版本化

**现状**：路由使用 `/api/v1/` 但无版本化框架，无法优雅弃用旧接口。

**方案**：引入 `Asp.Versioning.Mvc`，Controller 上标注 `[ApiVersion("1.0")]`。

---

## 四、实施路线图

```
Phase 0 — 安全修复（立即）
├── 启用桌面端 CSP
├── 加密邮件渠道密码
└── 修复异常信息泄露

Phase 1 — 性能与结构（2-3 周）
├── 前端路由级代码分割 + Error Boundary
├── ImageMasterController 拆分为 3 个 Controller
├── RequestResponseLoggingMiddleware 拆分
├── Program.cs 模块化
└── 健康检查增强

Phase 2 — 代码质量（2-3 周）
├── LlmGateway / ModelResolver 拆分
├── 泛型 MongoRepository<T> 基类
├── 前端巨型组件拆分（AdvancedVisualAgentTab 优先）
├── GetUserId / IsRoot 去重
├── 类型化配置 Options
└── 消除前端硬编码映射表

Phase 3 — 长期投入（持续）
├── OpenTelemetry 分布式追踪
├── 表单管理库迁入
├── TypeScript any 类型清理
├── 测试覆盖补全
├── API 版本化框架
└── 文档自动化校验
```

---

## 五、关键度量指标

| 指标 | 当前值 | 目标值 |
|------|--------|--------|
| 最大单文件行数 (后端) | 2,649 行 | < 500 行 |
| 最大单组件行数 (前端) | 8,686 行 | < 800 行 |
| TypeScript `any` 数量 | 179 处 | < 20 处 |
| 前端 Error Boundary | 0 个 | 全局 + 页面级 |
| 路由懒加载覆盖率 | 0% | 100% |
| 健康检查依赖覆盖 | 0 个 | MongoDB + Redis + LLM |
| 后端重复工具方法 | 12+ 处 | 0（提取到共享基类） |
| `catch { /* ignore */ }` | 4+ 处 | 0 |
| 明文存储密码 | 2 处 | 0 |

---

## 六、风险与注意事项

1. **Controller 拆分**需同步更新前端 API 路由，建议旧路由保持兼容一个版本周期
2. **RequestResponseLoggingMiddleware 拆分**涉及请求生命周期管理，需充分测试
3. **前端代码分割**后需验证 SSE 流场景的 chunk 加载不阻塞消息接收
4. **MongoRepository 基类**不应强制所有集合使用，仅适用于标准 CRUD 场景
5. **泛型 Repository 的 CancellationToken** 需遵循项目"服务器权威性"原则——核心写入操作使用 `CancellationToken.None`
