# Agent 开发交付流程规范

> **版本**：v1.0 | **创建日期**：2025-01-23 | **适用范围**：所有新增 Agent 应用

## 概述

本文档定义了在 PRD Agent 系统中创建新 Agent 应用的标准化交付流程。遵循此流程可确保架构一致性、权限安全性和可维护性。

---

## 一、交付流程总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agent 开发交付流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Phase 1: 规划设计                                               │
│  ├─ 1.1 需求分析与产品方案                                        │
│  ├─ 1.2 appKey 注册与命名                                        │
│  ├─ 1.3 状态机 / 工作流设计                                       │
│  ├─ 1.4 数据模型设计                                             │
│  └─ 1.5 界面元素选定 (字符画/线框)                                 │
│                                                                 │
│  Phase 2: 后端实现                                               │
│  ├─ 2.1 Model 层 (PrdAgent.Core)                                │
│  ├─ 2.2 权限注册 (AdminPermissionCatalog)                        │
│  ├─ 2.3 菜单注册 (AdminMenuCatalog)                              │
│  ├─ 2.4 Controller 层 (硬编码 appKey)                            │
│  ├─ 2.5 Service 层 (业务逻辑)                                    │
│  ├─ 2.6 Worker 层 (异步任务)                                     │
│  ├─ 2.7 AppCaller 注册 (LLM 调用标识)                            │
│  └─ 2.8 MongoDB 集合配置                                         │
│                                                                 │
│  Phase 3: 前端实现                                               │
│  ├─ 3.1 API 路由定义 (services/api.ts)                           │
│  ├─ 3.2 Contract 类型定义                                        │
│  ├─ 3.3 Service 实现层                                           │
│  ├─ 3.4 Store 状态管理 (Zustand)                                 │
│  ├─ 3.5 Page 组件开发                                            │
│  ├─ 3.6 路由注册 (App.tsx)                                       │
│  └─ 3.7 权限守卫 (RequirePermission)                             │
│                                                                 │
│  Phase 4: 集成测试                                               │
│  ├─ 4.1 后端单元测试 / 集成测试                                    │
│  ├─ 4.2 前端组件测试                                             │
│  ├─ 4.3 E2E 流程验证                                            │
│  └─ 4.4 权限矩阵验证                                             │
│                                                                 │
│  Phase 5: 文档同步                                               │
│  ├─ 5.1 更新 CLAUDE.md (Codebase Skill)                         │
│  ├─ 5.2 更新 SRS (2.srs.md)                                     │
│  ├─ 5.3 更新数据字典 (rule.data-dictionary.md)                   │
│  ├─ 5.4 更新命名规范 (rule.app-feature-definition.md)            │
│  └─ 5.5 创建功能设计文档 (doc/N.xxx.md)                          │
│                                                                 │
│  Phase 6: Debugger Skill                                        │
│  ├─ 6.1 日志埋点规范                                             │
│  ├─ 6.2 错误追踪路径                                             │
│  └─ 6.3 调试检查清单                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、Phase 1: 规划设计

### 1.1 需求分析与产品方案

**交付物**：功能设计文档 (`doc/N.{agent-name}.md`)

需包含：
- 核心用例描述
- 用户角色定义
- 工作流程图 (ASCII/Mermaid)
- 关键交互场景
- 非功能性需求（性能、安全、并发）

### 1.2 appKey 注册与命名

**规范**：
- 格式：`kebab-case`
- 模式：`{功能描述}-agent`（Agent 类应用）
- 唯一性：在 `AdminMenuCatalog.All` 中检查无冲突

**注册位置**：
```
CLAUDE.md → 已定义的应用标识表
AdminPermissionCatalog.cs → 权限常量
AdminMenuCatalog.cs → 菜单定义
AppCallerRegistry.cs → LLM 调用标识
```

### 1.3 状态机 / 工作流设计

参照 Literary Agent 的阶段模式设计状态流转：

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│  Phase A  │───▶│  Phase B  │───▶│  Phase C  │
│ (初始态)   │    │ (处理态)   │    │ (完成态)   │
└──────────┘    └──────────┘    └──────────┘
       │                │                │
       ▼                ▼                ▼
   验证规则A         验证规则B         验证规则C
```

**设计要求**：
- 每个阶段有明确的准入/退出条件
- 不可跳跃到未达成前置条件的阶段
- 状态变更触发版本递增（如适用）
- 考虑异常/回退路径

### 1.4 数据模型设计

**Model 层规范**：
- 位于 `PrdAgent.Core/Models/`
- 使用 BSON 属性注解
- 包含 `CreatedAt` / `UpdatedAt` 时间戳
- 主键使用 `string Id`（MongoDB ObjectId）

### 1.5 界面元素选定

**设计系统参考**：
- 使用 GlassCard 容器组件（液态玻璃主题）
- Lucide 图标集
- Radix UI 基础组件
- 响应式布局（AppShell 内 or 全屏独立）

**界面规划产出**：
```
┌────────────────────────────────────────────────┐
│ [Agent Name]                          [Actions]│
├──────────┬─────────────────────────────────────┤
│          │                                     │
│  列表/    │        主内容区                      │
│  导航     │        (编辑器/详情/对话)             │
│          │                                     │
│          │                                     │
└──────────┴─────────────────────────────────────┘
```

---

## 三、Phase 2: 后端实现

### 2.1 Model 层

**文件位置**：`prd-api/src/PrdAgent.Core/Models/`

```csharp
// 命名：{AgentName}{Entity}.cs
// 示例：DefectReport.cs
public class DefectReport
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    public string OwnerUserId { get; set; } = null!;
    public string Title { get; set; } = null!;
    // ... 业务字段

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
```

### 2.2 权限注册

**文件**：`PrdAgent.Core/Security/AdminPermissionCatalog.cs`

```csharp
/// <summary>
/// {Agent 名称} 权限：{描述}
/// </summary>
public const string YourAgentUse = "your-agent.use";

// 在 All 列表中注册
new(YourAgentUse, "{Agent 中文名}", "{功能描述}"),
```

### 2.3 菜单注册

**文件**：`PrdAgent.Core/Security/AdminMenuCatalog.cs`

```csharp
// Agent 菜单排序在 60-89 区间
new("your-agent", "/your-agent", "{Agent 中文名}", "{描述}", "{LucideIcon}", {SortOrder}),
```

### 2.4 Controller 层

**文件位置**：`prd-api/src/PrdAgent.Api/Controllers/Api/`

**强制规则**：
- ✅ 硬编码 `AppKey` 常量
- ✅ 使用 `[AdminController]` 属性
- ✅ Route 前缀为 `api/{agent-key}/`
- ❌ 不从前端接收 appKey

```csharp
[ApiController]
[Route("api/your-agent")]
[Authorize]
[AdminController("your-agent", AdminPermissionCatalog.YourAgentUse)]
public class YourAgentController : ControllerBase
{
    private const string AppKey = "your-agent";

    // 注入服务...
}
```

### 2.5 Service 层

**文件位置**：
- 接口：`PrdAgent.Core/Interfaces/I{AgentName}Service.cs`
- 实现：`PrdAgent.Infrastructure/Services/{AgentName}Service.cs`

### 2.6 Worker 层（如需异步处理）

**文件位置**：`PrdAgent.Api/Services/{AgentName}Worker.cs`

遵循 Run/Worker 模式：
1. Controller 创建 Run → 入队
2. Worker 出队 → 处理 → 存储事件
3. 客户端 SSE 订阅 → afterSeq 断线重连

### 2.7 AppCaller 注册

**文件**：`PrdAgent.Core/Models/AppCallerRegistry.cs`

```csharp
public static class YourAgent
{
    public const string AppName = "Your Agent";

    public static class Feature
    {
        [AppCallerMetadata("功能名", "描述", ModelTypes = new[] { ModelTypes.Chat })]
        public const string Operation = "your-agent.feature::chat";
    }
}
```

### 2.8 MongoDB 集合配置

**文件**：`PrdAgent.Infrastructure/Data/MongoDbContext.cs`

```csharp
public IMongoCollection<YourModel> YourAgentCollection =>
    _database.GetCollection<YourModel>("your_agent_items");
```

---

## 四、Phase 3: 前端实现

### 3.1 API 路由定义

**文件**：`prd-admin/src/services/api.ts`

```typescript
yourAgent: {
  items: {
    list: () => '/api/your-agent/items',
    byId: (id: string) => `/api/your-agent/items/${id}`,
    create: () => '/api/your-agent/items',
  },
  runs: {
    create: () => '/api/your-agent/runs',
    stream: (runId: string) => `/api/your-agent/runs/${runId}/stream`,
  },
},
```

### 3.2 Contract 类型定义

**文件**：`prd-admin/src/services/contracts/yourAgent.ts`

### 3.3 Service 实现层

**文件**：`prd-admin/src/services/real/yourAgent.ts`

### 3.4 Store 状态管理

**文件**：`prd-admin/src/stores/yourAgentStore.ts`（Zustand）

### 3.5 Page 组件开发

**目录**：`prd-admin/src/pages/your-agent/`

```
your-agent/
├── index.ts
├── YourAgentListPage.tsx       # 列表页
├── YourAgentDetailPage.tsx     # 详情页
└── components/                 # 页面内组件
    ├── YourAgentForm.tsx
    └── YourAgentCard.tsx
```

### 3.6 路由注册

**文件**：`prd-admin/src/app/App.tsx`

```tsx
<Route path="your-agent" element={
  <RequirePermission perm="your-agent.use">
    <YourAgentListPage />
  </RequirePermission>
} />
```

### 3.7 权限守卫

使用 `<RequirePermission>` 组件包裹，对应 `AdminPermissionCatalog` 中定义的权限点。

---

## 五、Phase 4: 集成测试

### 4.1 后端测试

```
Tests/
├── YourAgent.Controller.Tests.cs   # API 端点测试
├── YourAgent.Service.Tests.cs      # 业务逻辑测试
└── YourAgent.Worker.Tests.cs       # 异步任务测试
```

**测试覆盖要求**：
- Controller：路由映射、权限验证、输入校验
- Service：核心业务逻辑、边界条件
- Worker：队列处理、错误恢复、SSE 事件序列

### 4.2 前端测试

```
__tests__/
├── YourAgentListPage.test.tsx     # 页面渲染测试
├── yourAgentStore.test.ts         # Store 状态测试
└── yourAgentService.test.ts       # API 调用 Mock 测试
```

### 4.3 E2E 验证

- 完整工作流走通
- SSE 断线重连
- 权限拒绝场景
- 并发场景

### 4.5 UI 自动化与视觉回归（Playwright）

**目标**：减少人工回归，支持一次性自动跑通关键流程，并做视觉回归对比。

**基线位置**：
- 测试目录：`prd-admin/e2e/`
- 视觉基线：`prd-admin/e2e/**/-snapshots/`（由 Playwright 自动生成）

**运行命令**：
```
pnpm -C prd-admin e2e
pnpm -C prd-admin e2e:ui
pnpm -C prd-admin e2e:headed
```

**必需环境变量（仅本地注入，禁止写入仓库）**：
```
PRD_ADMIN_BASE_URL=http://localhost:8000
E2E_ADMIN_USER=your-admin-user
E2E_ADMIN_PASS=your-admin-pass
```

**推荐用例**：
- 缺陷管理流程：登录 → 进入缺陷列表 → 新建缺陷 → 提交审核 → 详情页截图对比
- 周报流程：登录 → 初始化模板（如有权限） → 新建计划 → 提交 → 列表与团队页截图对比

**稳定性建议**：
- 测试中禁用动画/过渡，降低截图抖动
- 视觉阈值使用轻度容差（`maxDiffPixelRatio` 约 0.1%）

### 4.4 权限矩阵验证

| 角色 | 访问菜单 | 创建 | 编辑 | 删除 | 管理 |
|------|---------|------|------|------|------|
| Admin | ✅ | ✅ | ✅ | ✅ | ✅ |
| User | ✅ | ✅ | 自己的 | 自己的 | ❌ |
| Guest | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 六、Phase 5: 文档同步

### 更新清单

| 文档 | 更新内容 |
|------|----------|
| `CLAUDE.md` | Codebase Skill 段落：应用标识表、功能注册表、MongoDB 集合 |
| `doc/2.srs.md` | 功能模块描述 |
| `doc/rule.data-dictionary.md` | 新增集合定义 |
| `doc/rule.app-feature-definition.md` | 新增应用清单 |
| `doc/N.{agent}.md` | 新建功能设计文档 |

---

## 七、Phase 6: Debugger Skill

### 6.1 日志埋点

```csharp
// Controller 入口
_logger.LogInformation("[{AppKey}] {Action} by {UserId}", AppKey, action, userId);

// Worker 关键节点
_logger.LogInformation("[{AppKey}:Worker] Run {RunId} started", AppKey, runId);
_logger.LogWarning("[{AppKey}:Worker] Run {RunId} retrying: {Error}", AppKey, runId, error);
_logger.LogError(ex, "[{AppKey}:Worker] Run {RunId} failed", AppKey, runId);
```

### 6.2 错误追踪路径

```
用户操作 → Controller 日志 → Service 日志 → Worker 日志 → LLM 请求日志
                                                              ↓
                                                     llm_request_logs 集合
```

### 6.3 调试检查清单

- [ ] 权限被拒绝时日志有记录
- [ ] Worker 异常不会导致队列阻塞
- [ ] SSE 中断后 afterSeq 可正确恢复
- [ ] LLM 调用超时有合理回退
- [ ] MongoDB 查询有适当索引

---

## 八、接入方式对照表

| 接入方式 | 适用场景 | 示例 |
|----------|---------|------|
| AppShell 内页面 | 标准管理页面 | PRD Agent, Literary Agent |
| 全屏独立页面 | 需要沉浸式体验 | Visual Agent |
| Open Platform API | 外部系统调用 | CI/CD 集成 |
| Desktop 客户端 | 桌面端功能 | 桌面对话 |

---

## 九、检查清单 (Gate Review)

### 开发前准入 (Phase 1 完成)
- [ ] appKey 已确定且无冲突
- [ ] 状态机设计已评审
- [ ] 数据模型已确认
- [ ] 界面线框已确认

### 开发中检查 (Phase 2-3 进行中)
- [ ] Controller 硬编码 AppKey
- [ ] 权限点已注册
- [ ] 菜单定义已添加
- [ ] AppCaller 标识已注册
- [ ] 前端路由已配置
- [ ] 权限守卫已添加

### 交付前验收 (Phase 4-6 完成)
- [ ] 核心流程测试通过
- [ ] 权限矩阵验证通过
- [ ] 文档已同步更新
- [ ] Debugger Skill 检查通过
- [ ] CLAUDE.md Codebase Skill 已更新
