# 总裁面板 & 周报 Agent 设计文档

> **版本**：v1.0 | **日期**：2026-02-08 | **状态**：Draft

---

## 一、产品定位

### 两个互补产品

| 产品 | 一句话定位 | 用户 |
|------|-----------|------|
| **总裁面板** | 管理层实时掌握全员 AI 协作状况的一站式驾驶舱 | CEO、CTO、部门负责人 |
| **周报 Agent** | 自动聚合每个人/每个团队一周的 AI 工作轨迹，生成结构化周报 | 全员（自动触发，管理者消费） |

关系：周报 Agent 是总裁面板的"定时快照"——面板看实时，周报看趋势。

---

## 二、我们已经有什么（数据基础盘点）

系统已有的 55 个 MongoDB 集合中，以下直接可用于总裁面板：

| 数据源 | 集合 | 可提取维度 |
|--------|------|-----------|
| **LLM 调用日志** | `llmrequestlogs` | 用户、Agent 类型、模型、Token 消耗、耗时、成功率 |
| **API 请求日志** | `apirequestlogs` | 用户、端点、客户端类型(desktop/web)、状态码、耗时 |
| **开放平台日志** | `openplatformrequestlogs` | AppId、用户、Token、请求路径 |
| **对话数据** | `sessions` + `messages` | 对话数、消息条数、对话时长、角色分布 |
| **缺陷管理** | `defect_reports` + `defect_messages` | 缺陷数、状态流转时间、严重级别分布 |
| **群组活动** | `groups` + `groupmembers` | 团队结构、人员分布、PRD 关联 |
| **用户状态** | `users` | 最后登录、最后活跃时间、角色 |
| **AppCaller 注册表** | `llm_app_callers` | 每个功能点的调用统计（TotalCalls / SuccessCalls / FailedCalls） |
| **渠道日志** | `channel_request_logs` | 邮件等多渠道使用情况 |
| **水印/市场** | `marketplace_fork_logs` | 配置市场活跃度 |

**结论**：数据已经足够丰富，核心缺的是 **聚合层** 和 **展示层**。

---

## 三、总裁面板设计

### 3.1 信息架构（5 个 Tab）

```
总裁面板 (ExecutiveDashboard)
├── 📊 全局概览 (Overview)         — 关键数字一屏看完
├── 👥 团队洞察 (Team Insights)    — 部门/团队/个人下钻
├── 🤖 Agent 使用 (Agent Usage)    — 各 Agent 采纳度与效率
├── 💰 成本中心 (Cost Center)      — Token 消耗 & 预算管理
└── 🔗 外部协作 (Integrations)     — 第三方任务 & OpenClaude
```

### 3.2 Tab 1: 全局概览

**顶部 KPI 卡片行（6 个）**

| 指标 | 数据来源 | 说明 |
|------|----------|------|
| 今日活跃用户 | `users.LastActiveAt` 在今天 | 与昨日对比趋势箭头 |
| 本周对话数 | `sessions` count this week | 与上周对比 |
| 本周 Token 消耗 | `llmrequestlogs` SUM(InputTokens + OutputTokens) | 换算成本 |
| AI 渗透率 | 本周使用AI的用户 / 总活跃用户 | 核心采纳指标 |
| 平均响应时间 | `llmrequestlogs` AVG(DurationMs) | P50/P95 |
| 缺陷处理效率 | `defect_reports` 平均解决时间 | 对比上周 |

**中部区域**

| 区块 | 可视化 | 说明 |
|------|--------|------|
| 使用趋势 | 折线图 (ECharts) | 30 天日活、消息数、Token 消耗三线叠加 |
| Agent 使用分布 | 饼图/环形图 | PRD Agent / Visual Agent / Literary Agent / Defect Agent 占比 |
| 活跃时段热力图 | 热力图 (24h × 7d) | 团队工作节奏可视化 |

**底部区域**

| 区块 | 内容 |
|------|------|
| 最近动态流 | 实时滚动：谁在用什么 Agent 做了什么（脱敏摘要） |
| 系统健康 | 模型池健康状态、API 成功率、异常告警 |

### 3.3 Tab 2: 团队洞察

**核心交互**：组织树 → 团队 → 个人，三级下钻

| 层级 | 展示内容 |
|------|----------|
| **组织维度** | 各部门 AI 使用排名、Token 消耗占比、活跃度对比柱状图 |
| **团队维度** | 团队成员列表 + 每人本周工作摘要（消息数、Agent 使用、处理的 PRD/缺陷数） |
| **个人维度** | 个人 AI 使用画像（详见下方） |

**个人画像卡片**

```
┌──────────────────────────────────────────────────────────┐
│  [头像] 张三 · 产品经理                    活跃度: ████░ │
│                                                          │
│  本周工作摘要                              AI 渗透率 87% │
│  ├─ PRD Agent: 解读了 3 份 PRD，提问 47 次               │
│  ├─ Defect Agent: 提交 12 个缺陷，解决 8 个              │
│  ├─ Visual Agent: 生成 23 张图片                         │
│  └─ 开放平台: 通过 API 调用 156 次                       │
│                                                          │
│  使用时段          Token 消耗趋势         常用功能 Top 5  │
│  [热力图]          [迷你折线图]           [柱状图]        │
│                                                          │
│  外部协作                                                │
│  ├─ Claude Code: 本周 23 个 session, 提交 45 commits     │
│  ├─ Jira: 完成 8 个任务, 进行中 3 个                     │
│  └─ GitLab: 合并 5 个 MR, Review 12 个                   │
└──────────────────────────────────────────────────────────┘
```

### 3.4 Tab 3: Agent 使用分析

每个 Agent 一张分析卡：

| 指标 | 说明 |
|------|------|
| 采纳率 | 使用该 Agent 的用户占比 |
| 使用频率 | 日均调用次数趋势 |
| 使用深度 | 平均对话轮数（浅层 1-3 轮 / 中层 4-10 轮 / 深层 10+ 轮） |
| 功能热度 | 基于 AppCallerCode 的功能点使用排名 |
| 效率提升 | 如 PRD 解读时间 vs 手动、缺陷提交效率等 |

**技能矩阵视图（新增概念）**

```
           PRD解读  需求拆分  缺陷提交  图片生成  代码审查  ...
张三 (PM)    ★★★     ★★☆      ★★★       ★☆☆       -
李四 (DEV)   ★☆☆      -       ★★☆        -        ★★★
王五 (QA)    ★★☆     ★☆☆      ★★★        -        ★☆☆
```

### 3.5 Tab 4: 成本中心

| 模块 | 说明 |
|------|------|
| Token 消耗看板 | 按部门/Agent/模型三维度切分的 Token 消耗 |
| 模型成本明细 | 各模型单价 × 实际 Token，算出真实成本 |
| 预算管理 | 设定月度预算 → 消耗进度条 → 预估月底用量 → 超支预警 |
| 优化建议 | 基于调用模式推荐：如"80% 的简单问答可切换到更便宜的模型" |

### 3.6 Tab 5: 外部协作 (Integrations)

这是总裁面板的差异化核心——**将 AI 系统与日常工作工具打通**。

#### 3.6.1 第三方数据源对接

| 数据源 | 采集方式 | 可获取数据 |
|--------|----------|-----------|
| **Claude Code (OpenClaude)** | Webhook / API 回调 | Session 数、commit 数、代码行数、使用的工具、耗时 |
| **Jira / 禅道** | REST API 轮询 | 任务状态、分配、完成情况、工时记录 |
| **GitLab / GitHub** | Webhook | Commit、MR/PR、Review、CI/CD 状态 |
| **企业微信 / 飞书 / 钉钉** | 开放平台 API | 审批状态、日程、考勤（如允许） |
| **Confluence / 语雀** | REST API | 文档更新、浏览量、协作活动 |

#### 3.6.2 数据模型：外部活动记录

```csharp
/// <summary>
/// 外部协作活动记录 — 统一存储所有第三方数据源的活动
/// </summary>
public class ExternalActivity
{
    public string Id { get; set; }
    public string UserId { get; set; }               // 关联本系统用户
    public string Source { get; set; }                // "claude-code" | "jira" | "gitlab" | "feishu"
    public string ActivityType { get; set; }          // "commit" | "task-complete" | "mr-merged" | "session"
    public string? ExternalId { get; set; }           // 第三方系统的 ID
    public string? ExternalUrl { get; set; }          // 跳转链接
    public string Summary { get; set; }               // 活动摘要
    public Dictionary<string, object>? Metadata { get; set; }  // 扩展字段
    public DateTime OccurredAt { get; set; }          // 发生时间
    public DateTime CreatedAt { get; set; }           // 入库时间
}
```

#### 3.6.3 Claude Code 协作集成（重点）

**采集内容**：

| 维度 | 数据 | 价值 |
|------|------|------|
| Session 活跃度 | 每日 session 数、平均时长 | 衡量 AI 辅助编码的使用频率 |
| 代码产出 | commit 数、代码行数增删 | 量化 AI 辅助的产出效果 |
| 工具使用 | 文件读写、搜索、Bash 执行次数 | 了解使用模式（偏搜索还是偏生成） |
| 项目覆盖 | 涉及的仓库和分支 | 了解 AI 覆盖了哪些项目 |
| 效率指标 | 首次提交到 PR 合并时间 | 对比 AI 辅助 vs 传统开发效率 |

**对接方式**（两种）：

```
方式一：Webhook 回调
Claude Code Session → SessionEnd Hook → POST /api/executive/external-activities
  {
    source: "claude-code",
    activityType: "session-complete",
    metadata: { commits: 3, files_changed: 12, tokens_used: 45000 }
  }

方式二：定时拉取
CronJob → 每小时调用 GitHub API → 过滤 claude/ 分支的活动 → 写入 ExternalActivity
```

---

## 四、周报 Agent 设计

### 4.1 定位

不是一个交互式聊天 Agent，而是一个**定时任务 Agent**：

```
每周日 22:00 自动触发
    → 聚合本周所有用户的活动数据
    → 调用 LLM 生成结构化周报
    → 存入 weekly_reports 集合
    → 推送通知给管理者
    → 总裁面板直接消费
```

### 4.2 架构

```
┌─────────────────────────────────────────────────────┐
│                  WeeklyReportAgent                   │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ Collector │───▶│  Aggregator  │───▶│ Generator │  │
│  │ (数据采集) │    │  (数据聚合)   │    │ (报告生成) │  │
│  └──────────┘    └──────────────┘    └───────────┘  │
│       │                                     │        │
│       ▼                                     ▼        │
│  ┌──────────┐                        ┌───────────┐  │
│  │ MongoDB  │                        │ LLM       │  │
│  │ 各集合    │                        │ Gateway   │  │
│  └──────────┘                        └───────────┘  │
│                                             │        │
│                                             ▼        │
│                                      ┌───────────┐  │
│                                      │  Storage   │  │
│                                      │ + Notify   │  │
│                                      └───────────┘  │
└─────────────────────────────────────────────────────┘
```

### 4.3 数据采集清单

```csharp
public class UserWeeklyActivity
{
    // ── 基本信息 ──
    public string UserId { get; set; }
    public string DisplayName { get; set; }
    public UserRole Role { get; set; }
    public int ActiveDays { get; set; }              // 本周活跃天数

    // ── 对话活动 ──
    public int SessionCount { get; set; }            // 发起的会话数
    public int MessageCount { get; set; }            // 发送的消息数
    public int AvgTurnsPerSession { get; set; }      // 平均对话轮次

    // ── Agent 使用 ──
    public Dictionary<string, AgentUsageStat> AgentUsage { get; set; }
    // key = "prd-agent" | "visual-agent" | "literary-agent" | "defect-agent"
    // value = { Calls, TokensUsed, AvgDurationMs, TopFeatures[] }

    // ── 缺陷管理 ──
    public int DefectsCreated { get; set; }
    public int DefectsResolved { get; set; }
    public int DefectsAssigned { get; set; }

    // ── 图片生成 ──
    public int ImagesGenerated { get; set; }
    public int InpaintingCount { get; set; }
    public int SketchToImageCount { get; set; }

    // ── PRD 活动 ──
    public int PrdsUploaded { get; set; }
    public int PrdQuestionsAsked { get; set; }
    public int PrdCommentsCreated { get; set; }
    public int ContentGapsFound { get; set; }

    // ── 开放平台 ──
    public int OpenPlatformApiCalls { get; set; }

    // ── 外部协作 ──
    public List<ExternalActivitySummary> ExternalActivities { get; set; }
    // Claude Code sessions, Jira tasks, GitLab MRs...

    // ── Token 消耗 ──
    public long TotalInputTokens { get; set; }
    public long TotalOutputTokens { get; set; }
    public decimal EstimatedCostUsd { get; set; }
}
```

### 4.4 LLM 生成周报

Collector 采集原始数据后，交给 LLM 生成可读的叙事性周报：

```
System Prompt:
你是一个企业 AI 协作平台的周报生成器。根据用户本周的活动数据，生成一份简洁的工作周报。

要求：
1. 用第三人称叙述
2. 突出关键产出和效率指标
3. 对比上周数据给出趋势判断
4. 给出下周改进建议
5. 语言简洁，每人不超过 200 字

User Prompt:
以下是 {DisplayName}（{Role}）本周的活动数据：
{JSON of UserWeeklyActivity}

上周数据对比：
{JSON of LastWeekActivity}
```

**输出示例**：

```markdown
### 张三 · 产品经理

**本周产出**：上传 3 份 PRD 文档，通过 PRD Agent 完成解读并提出 47 个深度提问，
发现 12 个内容缺失项。提交 8 个缺陷报告（其中 2 个严重级），全部已分配。

**AI 使用**：活跃 5 天，主要使用 PRD Agent（占 68%）和 Defect Agent（占 25%）。
Token 消耗 12.3 万，较上周增长 15%，属正常使用范围。

**效率亮点**：PRD 解读平均耗时从上周 45 分钟降至 32 分钟（↓29%）。

**外部协作**：通过 Claude Code 完成 3 个 session（涉及前端组件调整），
在 Jira 中关闭 5 个任务。

**建议**：可尝试使用 Visual Agent 为 PRD 生成原型草图，提升沟通效率。
```

### 4.5 存储模型

```csharp
public class WeeklyReport
{
    public string Id { get; set; }
    public int Year { get; set; }                    // 2026
    public int WeekNumber { get; set; }              // W06
    public DateTime WeekStart { get; set; }          // 2026-02-02
    public DateTime WeekEnd { get; set; }            // 2026-02-08
    public DateTime GeneratedAt { get; set; }        // 生成时间

    // ── 全局摘要 ──
    public string ExecutiveSummary { get; set; }     // LLM 生成的全局概述
    public GlobalWeeklyStats Stats { get; set; }     // 全局统计数字

    // ── 个人周报 ──
    public List<UserWeeklyReport> UserReports { get; set; }

    // ── 团队周报 ──
    public List<TeamWeeklyReport> TeamReports { get; set; }

    // ── 原始数据 ──
    public List<UserWeeklyActivity> RawActivities { get; set; }
}

public class UserWeeklyReport
{
    public string UserId { get; set; }
    public string DisplayName { get; set; }
    public UserRole Role { get; set; }
    public string NarrativeSummary { get; set; }     // LLM 生成的叙事周报
    public UserWeeklyActivity Activity { get; set; } // 结构化数据
    public UserWeeklyActivity? LastWeekActivity { get; set; }  // 上周对比
    public List<string> Highlights { get; set; }     // 亮点提炼
    public List<string> Suggestions { get; set; }    // 改进建议
}
```

### 4.6 AppCallerCode

```
executive.weekly-report::chat    — 周报 Agent 调用 LLM 生成报告
```

---

## 五、后端架构

### 5.1 新增文件清单

```
prd-api/src/PrdAgent.Api/
├── Controllers/Api/
│   ├── ExecutiveDashboardController.cs   # 总裁面板 API
│   └── WeeklyReportController.cs         # 周报查询 API
├── Services/Workers/
│   └── WeeklyReportWorker.cs             # 定时任务 Worker

prd-api/src/PrdAgent.Core/
├── Models/
│   ├── ExternalActivity.cs               # 外部协作活动
│   ├── WeeklyReport.cs                   # 周报模型
│   └── ExecutiveStats.cs                 # 仪表盘聚合模型

prd-api/src/PrdAgent.Infrastructure/
├── Services/
│   ├── ExecutiveStatsService.cs          # 聚合查询服务
│   ├── WeeklyReportService.cs            # 周报生成服务
│   └── ExternalActivityService.cs        # 外部活动采集服务
```

### 5.2 新增 MongoDB 集合

| 集合 | 用途 |
|------|------|
| `weekly_reports` | 存储周报（按 year + weekNumber 索引） |
| `external_activities` | 外部协作活动记录（按 userId + occurredAt 索引） |
| `executive_configs` | 总裁面板配置（预算阈值、告警规则等） |

### 5.3 Controller 设计

```csharp
[ApiController]
[Route("api/executive")]
[Authorize]
[AdminController("executive", AdminPermissionCatalog.ExecutiveView)]
public class ExecutiveDashboardController : ControllerBase
{
    // ── 全局概览 ──
    [HttpGet("overview")]
    // 返回: KPI 卡片数据、对比趋势

    [HttpGet("trends")]
    // 返回: 30天日活/消息/Token 趋势

    [HttpGet("heatmap")]
    // 返回: 24h × 7d 活跃时段热力图

    // ── 团队洞察 ──
    [HttpGet("team-ranking")]
    // 返回: 部门/团队使用排名

    [HttpGet("users/{userId}/profile")]
    // 返回: 个人 AI 使用画像

    [HttpGet("users/{userId}/activities")]
    // 返回: 个人活动流（分页）

    // ── Agent 分析 ──
    [HttpGet("agent-adoption")]
    // 返回: 各 Agent 采纳率、使用深度

    [HttpGet("skill-matrix")]
    // 返回: 用户 × Agent 技能矩阵

    // ── 成本中心 ──
    [HttpGet("cost-summary")]
    // 返回: Token 消耗按部门/Agent/模型分组

    [HttpGet("budget-status")]
    // 返回: 预算进度、预估月底消耗

    // ── 外部协作 ──
    [HttpPost("external-activities")]
    // Webhook 入口: 接收第三方活动数据

    [HttpGet("external-activities")]
    // 查询: 按用户/来源/时间范围过滤

    // ── 周报 ──
    [HttpGet("weekly-reports")]
    // 查询周报列表

    [HttpGet("weekly-reports/{year}/{week}")]
    // 查询指定周的周报

    [HttpPost("weekly-reports/generate")]
    // 手动触发生成周报（也支持定时任务自动触发）
}
```

### 5.4 权限设计

新增权限项到 `AdminPermissionCatalog`：

| 权限 Key | 说明 | 建议角色 |
|----------|------|----------|
| `executive.view` | 查看总裁面板 | CEO、CTO、部门负责人 |
| `executive.view-user-detail` | 查看个人详情（含对话内容摘要） | CEO、CTO |
| `executive.manage-budget` | 管理预算配置 | CTO、运维 |
| `executive.generate-report` | 手动触发周报生成 | CEO、CTO |
| `executive.manage-integrations` | 管理第三方集成配置 | CTO、运维 |

---

## 六、前端架构

### 6.1 页面结构

```
prd-admin/src/pages/executive/
├── ExecutiveDashboardPage.tsx      # 入口页 + Tab 路由
├── OverviewTab.tsx                 # 全局概览
├── TeamInsightsTab.tsx             # 团队洞察
├── AgentUsageTab.tsx               # Agent 使用分析
├── CostCenterTab.tsx               # 成本中心
├── IntegrationsTab.tsx             # 外部协作
├── WeeklyReportViewer.tsx          # 周报查看器
├── components/
│   ├── UserProfileCard.tsx         # 个人画像卡片
│   ├── SkillMatrixGrid.tsx         # 技能矩阵网格
│   ├── ActivityTimeline.tsx        # 活动时间线
│   ├── CostBreakdownChart.tsx      # 成本分解图
│   ├── AdoptionFunnel.tsx          # 采纳漏斗
│   └── ExternalActivityFeed.tsx    # 外部协作动态流
```

### 6.2 设计风格

延续现有液态玻璃主题体系：

- 使用 `GlassCard` 作为卡片容器
- 使用 `KpiCard` 展示核心指标
- 使用 `EChart` (echarts-for-react) 渲染所有图表
- 金色渐变 accent 用于"总裁级"视觉区分
- 支持深色/浅色主题

---

## 七、第三方集成协议

### 7.1 通用 Webhook 协议

所有第三方通过统一 Webhook 入口推送活动：

```
POST /api/executive/external-activities
Authorization: Bearer {integration-token}
Content-Type: application/json

{
  "source": "claude-code",
  "userId": "user-mapping-key",      // 通过映射表关联本系统用户
  "activityType": "session-complete",
  "externalId": "session_abc123",
  "externalUrl": "https://claude.ai/code/session_abc123",
  "summary": "完成 PRD Agent 前端重构，提交 3 个 commit",
  "occurredAt": "2026-02-08T15:30:00Z",
  "metadata": {
    "commits": 3,
    "filesChanged": 12,
    "linesAdded": 450,
    "linesDeleted": 120,
    "tokensUsed": 45000,
    "toolsUsed": ["Read", "Edit", "Bash", "Grep"],
    "duration_minutes": 45
  }
}
```

### 7.2 集成配置模型

```csharp
public class IntegrationConfig
{
    public string Id { get; set; }
    public string Source { get; set; }               // "claude-code" | "jira" | "gitlab"
    public string DisplayName { get; set; }          // "Claude Code"
    public bool IsActive { get; set; }
    public string? WebhookSecret { get; set; }       // Webhook 签名验证
    public string? ApiBaseUrl { get; set; }           // 主动拉取的 API 地址
    public string? ApiToken { get; set; }             // API 凭据（加密存储）
    public string? CronExpression { get; set; }       // 定时拉取频率
    public Dictionary<string, string> UserMapping { get; set; }  // 外部ID → 本系统UserId
    public DateTime CreatedAt { get; set; }
    public DateTime? LastSyncAt { get; set; }
}
```

### 7.3 Claude Code 集成详细方案

**方式一：SessionStart/End Hook（推荐）**

在项目的 `.claude/hooks.json` 中配置：

```json
{
  "hooks": {
    "session_end": {
      "command": "curl -s -X POST https://your-prd-agent.com/api/executive/external-activities -H 'Authorization: Bearer $INTEGRATION_TOKEN' -H 'Content-Type: application/json' -d '{\"source\":\"claude-code\",\"activityType\":\"session-complete\",\"metadata\":{}}'"
    }
  }
}
```

**方式二：GitHub Webhook 间接采集**

```
GitHub Webhook (push event)
  → 过滤 branch 是否以 claude/ 开头
  → 是 → 记录为 Claude Code 活动
  → 提取 commit message 中的 session URL
```

### 7.4 Jira 集成

```
定时任务（每小时）
  → GET /rest/api/3/search?jql=updated>=-1h
  → 匹配用户映射表
  → 写入 ExternalActivity {
      source: "jira",
      activityType: "task-updated",
      summary: "[PRD-123] 用户登录功能 → 状态变更为「完成」",
      metadata: { issueKey, status, assignee, storyPoints }
    }
```

---

## 八、实现路径

### Phase 1: 数据聚合层 (1 周)

- [ ] `ExecutiveStatsService` — 基于现有集合的聚合查询
- [ ] `ExecutiveDashboardController` — 概览、趋势、热力图 API
- [ ] 前端 `OverviewTab` — KPI 卡片 + 趋势图 + 热力图

### Phase 2: 团队洞察 (1 周)

- [ ] 用户活动聚合查询（按时间范围）
- [ ] `UserProfileCard` — 个人画像卡片
- [ ] `TeamInsightsTab` — 团队排名 + 个人下钻

### Phase 3: 周报 Agent (1 周)

- [ ] `WeeklyReportService` — 数据采集 + LLM 生成
- [ ] `WeeklyReportWorker` — 定时任务
- [ ] `WeeklyReportViewer` — 前端查看器
- [ ] 通知推送

### Phase 4: 成本中心 (3 天)

- [ ] Token 成本计算（模型单价 × 实际用量）
- [ ] 预算配置 + 预警
- [ ] `CostCenterTab` — 成本分解图 + 预算进度

### Phase 5: 外部协作集成 (1 周)

- [ ] `ExternalActivity` 模型 + Webhook 入口
- [ ] Claude Code Hook 集成
- [ ] Jira/GitLab 轮询适配器
- [ ] `IntegrationsTab` — 配置管理 + 活动流

### Phase 6: Agent 分析 & 技能矩阵 (3 天)

- [ ] 采纳率/使用深度计算
- [ ] `SkillMatrixGrid` — 技能矩阵可视化
- [ ] `AgentUsageTab` — 完整 Agent 分析页

---

## 九、与现有系统的关系

| 现有功能 | 总裁面板如何复用 |
|----------|-----------------|
| `DashboardPage` | 现有仪表盘面向运维，总裁面板面向管理层，指标不同但数据源共享 |
| `LlmLogsPage` | 日志明细页保留，总裁面板只展示聚合指标 |
| `StatsPage` | 可考虑合并进总裁面板的成本中心 Tab |
| `AdminNotification` | 周报生成完成后通过现有通知系统推送 |
| `AppCallerRegistry` | 直接复用 displayName 做 Agent 功能热度展示 |
| `Run/Worker` | 周报生成使用同样的异步 Worker 模式 |
