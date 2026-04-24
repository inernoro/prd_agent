# 统一缺陷管理平台 · 计划

> 版本 1.0 | 2026-03-05
>
> 目标：将缺陷管理从「个人工具」升级为「跨团队跨项目的统一平台」

---

## 一、改造总览

### 核心改动

| # | 改动项 | 优先级 | 后端文件 | 前端文件 | 预估改动量 |
|---|--------|--------|----------|----------|-----------|
| 1 | 项目维度 + 团队归属 | P0 | Model + Controller + DbContext | contracts + store + list + page | 中 |
| 2 | 新增「待验收」状态 | P0 | Model + Controller | contracts + detail + list | 小 |
| 3 | 超时催办 Worker | P1 | 新增 Worker | 无 | 中 |
| 4 | 统计看板 API | P1 | Controller 新增端点 | 新增 StatsPage | 大 |
| 5 | Webhook 外部通知 | P2 | 新增 Service + Model | 通知配置页 | 中 |
| 6 | 精简废弃状态 | P2 | Model 清理 | 无影响 | 小 |

### 不改动（保留优势）

- AI 内容润色 / 截图 VLM 分析
- 模板系统
- 版本审计
- SEQ 消息会话 + afterSeq 断线续传
- 桌面端 Tauri 集成
- API 日志自动采集

---

## 二、Phase 1：项目维度 + 团队归属（P0）

### 2.1 新增 Model：DefectProject

```csharp
// 新文件：PrdAgent.Core/Models/DefectProject.cs
namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷项目（跨团队可见）
/// </summary>
public class DefectProject
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>项目名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>项目标识（如 prd-agent, visual-agent）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>项目描述</summary>
    public string? Description { get; set; }

    /// <summary>项目负责人 UserId</summary>
    public string? OwnerUserId { get; set; }

    /// <summary>项目负责人名称</summary>
    public string? OwnerName { get; set; }

    /// <summary>关联的默认模板 ID</summary>
    public string? DefaultTemplateId { get; set; }

    /// <summary>是否归档</summary>
    public bool IsArchived { get; set; } = false;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
```

### 2.2 DefectReport 新增字段

```csharp
// 在 DefectReport.cs 中追加：

/// <summary>所属项目 ID</summary>
public string? ProjectId { get; set; }

/// <summary>所属项目名称（冗余，便于展示和搜索）</summary>
public string? ProjectName { get; set; }

/// <summary>所属团队 ID（复用 report_teams）</summary>
public string? TeamId { get; set; }

/// <summary>所属团队名称（冗余）</summary>
public string? TeamName { get; set; }
```

### 2.3 MongoDB 变更

```
新增集合：defect_projects
  索引：key (unique), ownerUserId

defect_reports 新增索引：
  idx_defect_reports_project: { projectId: 1, status: 1, createdAt: -1 }
  idx_defect_reports_team:    { teamId: 1, status: 1, createdAt: -1 }
```

### 2.4 Controller 改动

**DefectAgentController.cs** 变更：

| 端点 | 改动 |
|------|------|
| `GET /defects` | 新增 `projectId`、`teamId` 查询参数 |
| `POST /defects` | 新增 `projectId`、`teamId` 可选字段 |
| `PUT /defects/{id}` | 允许修改 `projectId`、`teamId` |
| `GET /projects` | **新增**：列出项目（支持 keyword 搜索） |
| `POST /projects` | **新增**：创建项目 |
| `PUT /projects/{id}` | **新增**：更新项目 |
| `DELETE /projects/{id}` | **新增**：归档项目 |
| `GET /teams` | **新增**：列出团队（复用 report_teams 集合） |
| `GET /stats` | 扩展支持 `projectId`、`teamId` 过滤 |

### 2.5 前端改动

**contracts/defectAgent.ts**：
- `DefectReport` 接口新增 `projectId`、`projectName`、`teamId`、`teamName`
- 新增 `DefectProject` 接口
- `ListDefectsContract` 新增 `projectId`、`teamId` 参数

**stores/defectStore.ts**：
- 新增 `projects: DefectProject[]`、`teams: Team[]`
- 新增 `projectFilter`、`teamFilter` 状态
- 新增 `loadProjects()`、`loadTeams()` 方法

**DefectAgentPage.tsx**：
- Tab 栏右侧新增项目和团队下拉筛选器
- 切换筛选器时重新加载列表

**DefectSubmitPanel.tsx**：
- 新增项目选择下拉框（提交缺陷时可选项目）

**DefectList.tsx**：
- 卡片/列表行中显示项目名称标签

---

## 三、Phase 2：新增「待验收」状态 + 精简状态机（P0）

### 3.1 目标状态机

```
draft (草稿)
  ↓ [submit]
submitted (待处理)
  ↓ [assign]
assigned (已指派)
  ↓ [process]
processing (处理中)
  ├─ [resolve] → verifying (待验收) ← 新增
  └─ [reject]  → rejected (已驳回)

verifying (待验收) ← 新增
  ├─ [verify-pass]  → closed (已关闭)
  └─ [verify-fail]  → processing (重新处理)

rejected (已驳回)
  ├─ [reopen] → submitted (重新提交)
  └─ [close]  → closed (已关闭)

closed (已关闭)
  └─ [reopen] → submitted (重新打开)
```

### 3.2 后端改动

**DefectReport.cs**：
```csharp
// DefectStatus 新增：
public const string Verifying = "verifying";

// 废弃（保留常量但不再使用，Controller 不再路由到这些状态）：
// Reviewing — 从未使用
// Awaiting — 从未使用
```

**DefectAgentController.cs 新增端点**：
```csharp
/// <summary>提交修复，进入待验收</summary>
[HttpPost("{id}/resolve")]
// 现有 resolve 端点改为：状态从 processing → verifying（而非直接 resolved）

/// <summary>验收通过，关闭缺陷</summary>
[HttpPost("{id}/verify-pass")]
// 仅 reporter 可操作，verifying → closed

/// <summary>验收不通过，打回处理中</summary>
[HttpPost("{id}/verify-fail")]
// 仅 reporter 可操作，verifying → processing
```

**关键改动**：
- `resolve` 端点的目标状态从 `resolved` 改为 `verifying`
- 新增 `verify-pass` 和 `verify-fail` 端点
- `resolved` 状态保留用于兼容旧数据，但新流程不再直接进入

### 3.3 DefectReport 新增字段

```csharp
/// <summary>验收人 UserId（通常是 reporter）</summary>
public string? VerifiedById { get; set; }

/// <summary>验收人名称</summary>
public string? VerifiedByName { get; set; }

/// <summary>验收时间</summary>
public DateTime? VerifiedAt { get; set; }

/// <summary>验收不通过原因</summary>
public string? VerifyFailReason { get; set; }
```

### 3.4 前端改动

**contracts/defectAgent.ts**：
- `DefectStatus` 新增 `Verifying: 'verifying'`
- 新增 `verifyPass(id)`、`verifyFail(id, reason)` API

**DefectDetailPanel.tsx**：
- `statusLabels` 新增 `'verifying': '待验收'`
- `statusColors` 新增对应颜色
- 操作按钮逻辑：
  - 当 status=verifying 且 currentUser=reporter → 显示「验收通过」「验收不通过」按钮

**DefectList.tsx**：
- `activeDefects` 过滤条件加入 `verifying`

---

## 四、Phase 3：超时催办 Worker（P1）

### 4.1 新增 DefectEscalationWorker

```csharp
// 新文件：PrdAgent.Api/Services/DefectAgent/DefectEscalationWorker.cs
public class DefectEscalationWorker : BackgroundService
{
    // 每 5 分钟扫描一次
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await CheckEscalationsAsync();
            await Task.Delay(Interval, stoppingToken);
        }
    }
}
```

### 4.2 超时规则

| 严重等级 | 超时阈值（从 submittedAt 计算） | 催办对象 |
|---------|-------------------------------|---------|
| blocker | 2 小时 | assignee + 团队 leader |
| critical | 4 小时 | assignee |
| major | 24 小时 | assignee |
| minor/suggestion | 72 小时 | assignee |

### 4.3 DefectReport 新增字段

```csharp
/// <summary>最后催办时间（防止重复催办）</summary>
public DateTime? LastEscalatedAt { get; set; }

/// <summary>催办次数</summary>
public int EscalationCount { get; set; } = 0;
```

### 4.4 催办逻辑

1. 查询状态为 `submitted`/`assigned`/`processing` 且超时的缺陷
2. 检查 `LastEscalatedAt` 避免短时间内重复催办（最小间隔 = 超时阈值）
3. 创建 `AdminNotification`（Level = warning/error）
4. 更新 `LastEscalatedAt` 和 `EscalationCount`
5. 未来：触发 Webhook 通知（Phase 5）

### 4.5 DI 注册

```csharp
// Program.cs
builder.Services.AddHostedService<DefectEscalationWorker>();
```

---

## 五、Phase 4：统计看板（P1）

### 5.1 新增 API 端点

```csharp
// DefectAgentController.cs 新增：

/// <summary>统计概览（支持按团队/项目/时间段过滤）</summary>
[HttpGet("stats/overview")]
// 返回：总数、各状态数、各严重度数、平均处理时长

/// <summary>按人统计</summary>
[HttpGet("stats/by-user")]
// 返回：每人的提交数、被指派数、已解决数、平均解决时长

/// <summary>趋势统计</summary>
[HttpGet("stats/trend")]
// 返回：按天/周/月的新增数、关闭数

/// <summary>排行榜</summary>
[HttpGet("stats/leaderboard")]
// 返回：解决最多 TOP 10、积压最多 TOP 10、最快响应 TOP 10
```

### 5.2 通用查询参数

所有统计端点都支持：
- `projectId` — 按项目过滤
- `teamId` — 按团队过滤
- `from` / `to` — 时间范围
- `period` — 聚合粒度（day/week/month）

### 5.3 前端新增页面

**新文件：`pages/defect-agent/DefectStatsPage.tsx`**

布局：
```
┌─────────────────────────────────────────────┐
│ [项目筛选] [团队筛选] [时间范围]              │
├──────────┬──────────┬──────────┬────────────┤
│ 总缺陷数  │ 未解决数  │ 平均时长  │ 本周新增   │
├──────────┴──────────┴──────────┴────────────┤
│ 趋势图（新增 vs 关闭折线图）                   │
├─────────────────────┬───────────────────────┤
│ 按严重度分布（饼图）  │ 按状态分布（饼图）      │
├─────────────────────┴───────────────────────┤
│ 按人排行榜（表格：姓名、提交数、解决数、时长）   │
└─────────────────────────────────────────────┘
```

**路由**：在 DefectAgentPage 中新增 Tab「统计看板」

---

## 六、Phase 5：Webhook 外部通知（P2）

### 6.1 新增 Model

```csharp
// 新文件：PrdAgent.Core/Models/DefectWebhookConfig.cs
public class DefectWebhookConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID（null = 全局）</summary>
    public string? TeamId { get; set; }

    /// <summary>所属项目 ID（null = 全局）</summary>
    public string? ProjectId { get; set; }

    /// <summary>渠道：wecom / dingtalk / feishu / custom</summary>
    public string Channel { get; set; } = "wecom";

    /// <summary>Webhook URL</summary>
    public string WebhookUrl { get; set; } = string.Empty;

    /// <summary>触发事件：submitted, assigned, escalated, resolved, closed</summary>
    public List<string> TriggerEvents { get; set; } = new();

    /// <summary>是否启用</summary>
    public bool IsEnabled { get; set; } = true;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
```

### 6.2 新增 Service

```csharp
// 新文件：PrdAgent.Infrastructure/Services/DefectWebhookService.cs
public class DefectWebhookService
{
    /// <summary>发送缺陷事件通知到配置的 Webhook</summary>
    public async Task NotifyAsync(DefectReport defect, string eventType, CancellationToken ct)
    {
        // 1. 查找匹配的 webhook 配置（team + project + event）
        // 2. 按 channel 格式化消息（企业微信 markdown / 钉钉 actionCard）
        // 3. HTTP POST 发送
        // 4. 记录发送结果到 webhook_delivery_logs
    }
}
```

### 6.3 集成点

在 DefectAgentController 的以下端点中注入 `DefectWebhookService.NotifyAsync()`：
- `submit` → event: "submitted"
- `assign` → event: "assigned"
- `resolve` → event: "resolved"
- `close` → event: "closed"
- `DefectEscalationWorker` → event: "escalated"

---

## 七、实施顺序与依赖关系

```
Phase 1: 项目+团队  ──→  Phase 3: 超时催办 Worker
     │                        │
     ↓                        ↓
Phase 2: 待验收状态  ──→  Phase 4: 统计看板（依赖 Phase 1 的维度）
                              │
                              ↓
                        Phase 5: Webhook 通知（依赖 Phase 3 的催办事件）
```

**建议执行顺序**：Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

Phase 1 和 Phase 2 可以并行开发（无依赖），但建议先做 Phase 1（改动范围更大，是后续的基础）。

---

## 八、文件变更清单

### 后端（新增）

| 文件 | 用途 |
|------|------|
| `PrdAgent.Core/Models/DefectProject.cs` | 项目模型 |
| `PrdAgent.Core/Models/DefectWebhookConfig.cs` | Webhook 配置模型 |
| `PrdAgent.Api/Services/DefectAgent/DefectEscalationWorker.cs` | 超时催办 Worker |
| `PrdAgent.Infrastructure/Services/DefectWebhookService.cs` | Webhook 推送服务 |

### 后端（修改）

| 文件 | 改动 |
|------|------|
| `PrdAgent.Core/Models/DefectReport.cs` | 新增 ProjectId/TeamId/Verifying 等字段 |
| `PrdAgent.Api/Controllers/Api/DefectAgentController.cs` | 新增端点 + 查询参数 + 状态转换 |
| `PrdAgent.Infrastructure/Database/MongoDbContext.cs` | 新增集合 + 索引 |
| `PrdAgent.Core/Security/AdminPermissionCatalog.cs` | 新增统计/项目管理权限 |
| `Program.cs` | 注册 Worker + Service |

### 前端（新增）

| 文件 | 用途 |
|------|------|
| `pages/defect-agent/DefectStatsPage.tsx` | 统计看板页 |
| `pages/defect-agent/components/ProjectSelector.tsx` | 项目选择器组件 |

### 前端（修改）

| 文件 | 改动 |
|------|------|
| `services/contracts/defectAgent.ts` | 新增类型定义 + API 契约 |
| `services/real/defectAgent.ts` | 新增 API 方法 + 查询参数 |
| `stores/defectStore.ts` | 新增 project/team 状态 + 加载方法 |
| `pages/defect-agent/DefectAgentPage.tsx` | 新增筛选器 + 统计 Tab |
| `pages/defect-agent/components/DefectList.tsx` | 显示项目标签 + 新状态 |
| `pages/defect-agent/components/DefectDetailPanel.tsx` | 验收按钮 + 新状态颜色 |
| `pages/defect-agent/components/DefectSubmitPanel.tsx` | 项目选择 |

---

## 九、数据迁移

### 旧数据兼容

- `projectId = null` → 显示为「未分类项目」
- `teamId = null` → 显示为「个人缺陷」
- `status = "resolved"` → 等价于新流程的 `verifying`（跳过验收直接关闭），或保留原样作为历史状态
- `status = "reviewing" / "awaiting"` → 如果存在旧数据，迁移为 `submitted`

### 迁移脚本

```javascript
// MongoDB Shell
// 清理从未使用的状态
db.defect_reports.updateMany(
  { status: { $in: ["reviewing", "awaiting"] } },
  { $set: { status: "submitted" } }
);
```

---

## 十、风险与注意事项

| 风险 | 缓解措施 |
|------|---------|
| 团队基础设施依赖周报模块的 report_teams | 直接复用，查询时做只读引用，不跨模块写入 |
| 旧数据无 projectId/teamId | 允许 null，前端显示「未分类」 |
| 桌面端需要同步更新 | Phase 1-2 先做 Web 端，桌面端后续跟进 |
| 超时催办可能产生通知轰炸 | 设置最小催办间隔 + 每日最大催办次数 |
| Webhook 发送失败 | 异步重试 3 次 + 记录到 delivery_logs |
