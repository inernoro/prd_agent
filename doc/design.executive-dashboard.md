# 总裁面板 & 周报 Agent 设计文档

> **版本**：v2.0 | **日期**：2026-02-09 | **状态**：Draft (Data Audit Complete)

---

## 一、产品定位

### 两个互补产品

| 产品 | 一句话定位 | 用户 |
|------|-----------|------|
| **总裁面板** | 管理层实时掌握全员 AI 协作状况的一站式驾驶舱 | CEO、CTO、部门负责人 |
| **周报 Agent** | 自动聚合每个人/每个团队一周的 AI 工作轨迹，生成结构化周报 | 全员（自动触发，管理者消费） |

关系：周报 Agent 是总裁面板的"定时快照"——面板看实时，周报看趋势。

---

## 二、数据审计（字段级盘点）

> 以下基于代码审计结果，逐集合列出可用字段、用户标识覆盖、可提取指标。

### 2.1 用户标识覆盖矩阵

| 集合 | 用户标识字段 | 状态 | 备注 |
|------|-------------|------|------|
| `users` | `UserId`, `LastActiveAt`, `LastLoginAt`, `Role` | **完整** | 有 UserType 区分人/Bot |
| `messages` | `SenderId` | **完整** | User 消息有 SenderId，Assistant 消息也有 |
| `sessions` | `OwnerUserId` | **部分** | 个人会话有，群组会话为 null（通过 GroupId 间接关联） |
| `llm_request_logs` | `UserId` | **完整** | nullable，但绝大多数请求有值 |
| `api_request_logs` | `UserId` | **完整** | 默认值 "anonymous"，需过滤 |
| `defect_reports` | `ReporterId`, `AssigneeId`, `ResolvedById`, `RejectedById` | **完整** | 4 种用户角色均有标识 |
| `defect_messages` | `UserId` | **完整** | user 消息有，assistant 消息为 null |
| `image_gen_runs` | `OwnerAdminId` | **完整** | 字段名是 AdminId 但实际是 UserId |
| `image_master_sessions` | `OwnerUserId` | **完整** | |
| `image_master_messages` | `OwnerUserId` | **完整** | |
| `prd_comments` | `AuthorUserId` | **完整** | |
| `content_gaps` | `AskedByUserId` | **完整** | |
| `open_platform_request_logs` | `UserId` | **完整** | 通过 BoundUserId 关联 |
| `marketplace_fork_logs` | `UserId` | **完整** | 含 SourceOwnerUserId |
| `toolbox_runs` | `UserId` | **完整** | |
| `channel_request_logs` | `MappedUserId` | **部分** | 需通过 ChannelIdentityMapping 映射 |
| `groups` → `group_members` | `UserId` | **完整** | 含 JoinedAt |

**结论：用户标识覆盖率约 95%，无需大规模补数据。**

### 2.2 关键集合字段明细

#### `llm_request_logs` — 最核心的分析数据源

```
字段                          类型        用于
──────────────────────────────────────────────────────────
UserId                        string?     → 按用户聚合
GroupId / SessionId           string?     → 关联对话上下文
RequestPurpose                string?     → AppCallerCode，区分 Agent 和功能点
RequestPurposeDisplayName     string?     → 中文名（自包含，日志写入时已保存）
Provider / Model              string      → 按模型/平台聚合成本
PlatformId / PlatformName     string?     → 平台维度
ModelGroupId / ModelGroupName string?     → 模型池维度
InputTokens / OutputTokens    int?        → Token 消耗（成本计算核心）
CacheReadInputTokens          int?        → 缓存命中率
StartedAt / EndedAt           DateTime    → 耗时分析
FirstByteAt                   DateTime?   → TTFB（首字节延迟）
DurationMs                    long?       → 响应时间
Status                        string      → running/succeeded/failed/cancelled
RequestType                   string?     → chat/intent/vision/generation
ImageSuccessCount             int?        → 生图成功数
IsExchange / ExchangeName     bool/string → Exchange 中继追踪
```

**可提取指标**：
- 每用户 Token 消耗（按天/周/月）
- 每用户 Agent 使用频率（RequestPurpose 前缀 = appKey）
- 模型成本分析（Model × Token × 单价）
- 成功率 / 失败率 / 平均耗时 / TTFB P50/P95
- Agent 采纳度（去重 UserId count by RequestPurpose 前缀）

**TTL 问题**：7 天自动过期 → 历史趋势会丢失（见 2.3）

#### `messages` — 对话活跃度

```
字段                类型          用于
──────────────────────────────────────────────────
SenderId            string?       → 按用户聚合消息数
GroupId             string        → 关联群组/项目
SessionId           string        → 关联会话
Role                MessageRole   → User/Assistant 区分
TokenUsage.Input    int           → 对话级 Token（长期保留，不受 TTL 影响）
TokenUsage.Output   int           → 同上
Timestamp           DateTime      → 活跃时间分析
ViewRole            UserRole?     → PM/DEV/QA 角色视角
LlmRequestId        string?       → 关联 LLM 日志明细
```

**可提取指标**：
- 每用户每天消息数
- 对话轮次（同一 SessionId 的消息数 / 2）
- 使用角色分布（ViewRole）
- 活跃时段热力图（Timestamp 的 hour × weekday）
- **长期 Token 趋势**（TokenUsage 不受 TTL 影响）

#### `defect_reports` — 缺陷管理效率

```
字段                类型        用于
──────────────────────────────────────────────────
ReporterId          string      → 谁提交
AssigneeId          string?     → 谁处理
Severity            string?     → blocker/critical/major/minor/suggestion
Priority            string?     → high/medium/low
Status              string      → 9 种状态
CreatedAt           DateTime    → 提交时间
SubmittedAt         DateTime?   → 正式提交时间
AssignedAt          DateTime?   → 分配时间
ResolvedAt          DateTime?   → 解决时间
ClosedAt            DateTime?   → 关闭时间
```

**可提取指标**：
- 每用户缺陷提交/解决数
- 平均解决时间（ResolvedAt - CreatedAt）
- 按严重级别分布
- 缺陷状态漏斗（draft → submitted → assigned → resolved → closed）

#### `image_gen_runs` — 图片生成

```
字段                类型        用于
──────────────────────────────────────────────────
OwnerAdminId        string      → 谁发起
AppCallerCode       string?     → text2img / img2img / vision / compose
AppKey              string?     → visual-agent / literary-agent
Total / Done / Failed int       → 成功率
CreatedAt / EndedAt DateTime    → 耗时
ModelGroupName      string?     → 使用的模型池
```

**可提取指标**：
- 每用户生图数量
- 按生图类型分布（文生图/图生图/多图合成/局部重绘）
- 生图成功率 & 平均耗时

#### 已有的 StatsController（可直接复用）

```
GET /api/dashboard/stats/overview     → totalUsers, activeUsers, newUsersThisWeek,
                                        totalGroups, totalMessages, todayMessages, usersByRole
GET /api/dashboard/stats/message-trend → 30 天消息趋势（按天）
GET /api/dashboard/stats/token-usage   → Token 用量（chat + 非 chat 合并）
GET /api/dashboard/stats/active-groups → Top N 活跃群组
GET /api/dashboard/stats/gap-stats     → 内容缺失按状态/类型
```

### 2.3 必须先解决的问题：TTL 导致历史数据丢失

**现状**：

| 集合 | TTL | 影响 |
|------|-----|------|
| `llm_request_logs` | **7 天** | 无法做周环比/月趋势；周报 Agent 如果周日跑，只能看到最近 7 天 |
| `api_request_logs` | **7 天** | 同上 |
| `open_platform_request_logs` | **30 天** | 月报还行，季报不行 |
| `channel_request_logs` | **30 天** | 同上 |
| `messages` | **无 TTL** | 长期可用 |
| `defect_reports` | **无 TTL** | 长期可用 |
| `image_gen_runs` | **无 TTL** | 长期可用 |

**解决方案：新增 `daily_stats_snapshots` 集合 — 每日聚合归档**

```csharp
/// <summary>
/// 每日统计快照 — 在 TTL 删除原始日志前，将聚合结果持久化保存。
/// 每天凌晨 1:00 由定时任务生成前一天的快照。
/// </summary>
public class DailyStatsSnapshot
{
    public string Id { get; set; }
    public DateTime Date { get; set; }               // 哪一天（UTC Date）

    // ── 全局指标 ──
    public int ActiveUserCount { get; set; }          // 当天活跃用户数
    public int NewUserCount { get; set; }             // 当天新注册
    public int TotalMessageCount { get; set; }        // 当天总消息数
    public int TotalSessionCount { get; set; }        // 当天活跃会话数
    public long TotalInputTokens { get; set; }        // 当天总输入 Token
    public long TotalOutputTokens { get; set; }       // 当天总输出 Token
    public int TotalLlmCalls { get; set; }            // 当天 LLM 调用次数
    public int FailedLlmCalls { get; set; }           // 失败次数
    public double AvgDurationMs { get; set; }         // 平均响应时间
    public double P95DurationMs { get; set; }         // P95 响应时间
    public int ImageGenCount { get; set; }            // 当天生图数量
    public int DefectsCreated { get; set; }           // 当天新缺陷
    public int DefectsResolved { get; set; }          // 当天解决缺陷

    // ── 按用户明细 ──
    public List<UserDailyStat> UserStats { get; set; } = new();

    // ── 按 Agent 明细 ──
    public List<AgentDailyStat> AgentStats { get; set; } = new();

    // ── 按模型明细 ──
    public List<ModelDailyStat> ModelStats { get; set; } = new();

    // ── 活跃时段 ──
    public int[] HourlyActiveUsers { get; set; } = new int[24];  // 每小时活跃用户数
}

public class UserDailyStat
{
    public string UserId { get; set; }
    public int MessageCount { get; set; }
    public int LlmCallCount { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public int ImageGenCount { get; set; }
    public int DefectsCreated { get; set; }
    public int DefectsResolved { get; set; }
    public List<string> AgentsUsed { get; set; } = new();      // 当天用过哪些 Agent
    public List<int> ActiveHours { get; set; } = new();        // 活跃在哪些小时
}

public class AgentDailyStat
{
    public string AppKey { get; set; }                // "prd-agent" | "visual-agent" | ...
    public int CallCount { get; set; }
    public int UniqueUsers { get; set; }
    public long TotalTokens { get; set; }
    public double AvgDurationMs { get; set; }
    public Dictionary<string, int> FeatureBreakdown { get; set; } = new();
    // key = AppCallerCode 的 feature 部分, value = 调用次数
}

public class ModelDailyStat
{
    public string Model { get; set; }
    public string? PlatformName { get; set; }
    public int CallCount { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public double AvgDurationMs { get; set; }
    public int FailedCount { get; set; }
}
```

**执行策略**：
```
每日 01:00 UTC 定时任务:
  1. 查询昨天的 llm_request_logs（在 TTL 删除前）
  2. 查询昨天的 api_request_logs
  3. 查询昨天的 messages、defect_reports、image_gen_runs
  4. 聚合为 DailyStatsSnapshot
  5. 写入 daily_stats_snapshots（无 TTL，永久保留）

总裁面板查询策略:
  - 最近 7 天：直接查原始集合（实时精确）
  - 7 天以前：查 daily_stats_snapshots（聚合近似）
```

### 2.4 需要修复的数据问题

| 问题 | 集合 | 现状 | 修复方案 |
|------|------|------|----------|
| **api_request_logs UserId = "anonymous"** | `api_request_logs` | 未登录或中间件未注入时为 "anonymous" | 查询时过滤 `!= "anonymous"` 即可，不需要改代码 |
| **sessions.OwnerUserId 群组会话为 null** | `sessions` | 群组会话不记录创建人 | 通过 `messages.SenderId` WHERE `SessionId = x` GROUP BY SenderId 间接得到参与者 |
| **messages.SenderId Assistant 消息** | `messages` | Assistant 消息的 SenderId 可能是 bot userId | 通过 `users.UserType == Human` 过滤 |
| **image_gen_runs 字段名不一致** | `image_gen_runs` | 用 `OwnerAdminId` 而非 `UserId` | 查询时用 OwnerAdminId 做 JOIN 即可，不需要改字段名 |

**结论：无需做数据迁移，只需在查询层做适配。**

---

## 三、你会看到什么（数据 → 展示映射）

> 这一节回答核心问题：**根据已有数据，每个面板到底能展示什么**。

### 3.0 数据 → 面板指标映射总表

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           数据源 → 展示指标 映射                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  users (永久)                                                                        │
│  ├─ LastActiveAt          → 今日/本周 DAU                                            │
│  ├─ LastLoginAt           → 最后登录时间（个人画像）                                    │
│  ├─ Role (PM/DEV/QA)     → 角色分布饼图                                              │
│  └─ CreatedAt             → 新用户增长趋势                                            │
│                                                                                      │
│  messages (永久)                                                                     │
│  ├─ SenderId + Timestamp  → 每用户每天消息数、活跃时段热力图                             │
│  ├─ TokenUsage            → Token 消耗长期趋势（不受 7 天 TTL 限制）                    │
│  ├─ SessionId             → 对话轮次深度（消息数 / 2）                                  │
│  ├─ GroupId               → 最活跃群组排名                                             │
│  └─ ViewRole              → 角色使用偏好（PM 视角占比 vs DEV 视角占比）                  │
│                                                                                      │
│  llm_request_logs (7天TTL → 需 daily_stats_snapshots 归档)                            │
│  ├─ UserId + RequestPurpose  → 每用户 Agent 使用频率、功能热度 Top N                    │
│  ├─ InputTokens/OutputTokens → 实时 Token 消耗（按用户/模型/Agent 三维度）              │
│  ├─ Model + DurationMs       → 模型性能对比（平均耗时、TTFB P50/P95）                   │
│  ├─ Status                   → 成功率/失败率                                           │
│  └─ RequestPurpose 前缀      → Agent 采纳率（prd-agent.* / visual-agent.* / ...）       │
│                                                                                      │
│  defect_reports (永久)                                                               │
│  ├─ ReporterId/AssigneeId    → 每人缺陷提交/处理数                                     │
│  ├─ Severity/Priority        → 缺陷严重级别分布                                        │
│  ├─ CreatedAt → ResolvedAt   → 平均解决时间                                            │
│  └─ Status 流转              → 缺陷生命周期漏斗                                        │
│                                                                                      │
│  image_gen_runs (永久)                                                               │
│  ├─ OwnerAdminId             → 每人生图数量                                            │
│  ├─ AppCallerCode            → 文生图/图生图/多图/局部重绘 分类统计                      │
│  ├─ Total/Done/Failed        → 生图成功率                                              │
│  └─ CreatedAt/EndedAt        → 生图耗时趋势                                            │
│                                                                                      │
│  prd_comments (永久)                                                                 │
│  └─ AuthorUserId + CreatedAt → 每人 PRD 评论数                                         │
│                                                                                      │
│  content_gaps (永久)                                                                 │
│  └─ AskedByUserId + Status   → 每人发现的内容缺失数 + 解决率                            │
│                                                                                      │
│  marketplace_fork_logs (永久)                                                        │
│  └─ UserId + ConfigType      → 市场活跃度（Fork 次数、热门配置）                         │
│                                                                                      │
│  daily_stats_snapshots (新增，永久保留)                                                │
│  └─ 以上所有维度的每日聚合    → 30天/90天/1年 长期趋势图                                 │
│                                                                                      │
│  external_activities (新增，永久保留)                                                  │
│  └─ Claude Code / Jira / GitLab → 第三方协作数据                                       │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.0.1 具体展示效果预览

**全局概览 — 6 个 KPI 卡片**

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  今日活跃用户  │  │  本周对话数   │  │ 本周Token消耗 │  │  AI 渗透率    │  │  平均响应时间  │  │  缺陷解决率   │
│     12       │  │    347       │  │   283 万     │  │    87%       │  │   1.2s       │  │    76%       │
│   ↑ 20%     │  │   ↑ 15%     │  │   ↓ 8%      │  │   ↑ 5%      │  │   ↓ 18%     │  │   ↑ 12%     │
│  vs 昨日     │  │  vs 上周     │  │  vs 上周     │  │  vs 上周     │  │  vs 上周     │  │  vs 上周     │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘

数据来源:
  活跃用户  ← users WHERE LastActiveAt >= today
  对话数    ← sessions WHERE CreatedAt in this week
  Token    ← messages.TokenUsage (实时) + daily_stats_snapshots (历史)
  渗透率   ← (本周发过消息的去重 SenderId) / (本周 LastActiveAt 的用户)
  响应时间  ← llm_request_logs AVG(DurationMs) WHERE Status=succeeded
  缺陷解决率 ← defect_reports WHERE ResolvedAt in this week / CreatedAt in this week
```

**个人画像 — 点击用户下钻看到**

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  [头像] 张三 · PM                                   本周活跃 5/7 天   渗透率 92% │
│                                                                                  │
│  Agent 使用                                          Token 消耗趋势              │
│  ┌─────────────────────────────────┐                 ┌────────────────────┐      │
│  │ PRD Agent     ██████████ 68%   │ ← messages WHERE │    ╱\  /\         │      │
│  │ Defect Agent  █████     25%   │   SenderId=张三   │  ╱  \/  \  /\    │      │
│  │ Visual Agent  ██        7%    │   GROUP BY        │ ╱        \/  \   │      │
│  └─────────────────────────────────┘   RequestPurpose │╱             \   │      │
│                                        前缀           └────────────────────┘      │
│  本周产出统计                                          ← messages.TokenUsage     │
│  ├─ 发送 127 条消息（↑32% vs 上周）  ← messages COUNT WHERE SenderId=张三         │
│  ├─ PRD 评论 23 条                   ← prd_comments WHERE AuthorUserId=张三       │
│  ├─ 发现内容缺失 12 个               ← content_gaps WHERE AskedByUserId=张三       │
│  ├─ 提交缺陷 8 个，解决 5 个         ← defect_reports WHERE ReporterId/ResolvedById │
│  ├─ 生成图片 15 张                   ← image_gen_runs WHERE OwnerAdminId=张三       │
│  └─ Token 消耗 12.3 万              ← messages.TokenUsage SUM                      │
│                                                                                  │
│  活跃时段                             常用功能 Top 5                              │
│  ┌─ 24h × 7d 热力图 ──────────┐     ┌──────────────────────────────┐              │
│  │     M  T  W  T  F  S  S   │     │ 1. PRD 解读问答     89 次   │              │
│  │ 09  ■  ■  ■  ■  ■  ·  ·   │     │ 2. 缺陷 AI 润色    34 次   │              │
│  │ 10  ■  ■  ■  ■  ■  ·  ·   │     │ 3. 内容缺失检测     12 次   │              │
│  │ 14  ■  ■  ·  ■  ■  ·  ·   │     │ 4. 文生图           8 次   │              │
│  │ 15  ■  ·  ■  ■  ·  ·  ·   │     │ 5. PRD 评论         6 次   │              │
│  └─────────────────────────────┘     └──────────────────────────────┘              │
│  ← messages.Timestamp               ← llm_request_logs.RequestPurpose             │
│    HOUR(ts) × DAYOFWEEK(ts)           GROUP BY feature, COUNT(*)                  │
│                                                                                  │
│  外部协作（需新增 external_activities 集合）                                        │
│  ├─ Claude Code: 本周 5 个 session, 提交 12 commits   ← external_activities       │
│  ├─ Jira: 完成 8 个任务, 进行中 3 个                  ← external_activities       │
│  └─ GitLab: 合并 2 个 MR                             ← external_activities       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Agent 采纳度 — 从 llm_request_logs.RequestPurpose 提取**

```
RequestPurpose (AppCallerCode) 解析规则:
  "prd-agent.chat::chat"                    → appKey = prd-agent,    feature = chat
  "visual-agent.image.text2img::generation" → appKey = visual-agent, feature = text2img
  "defect-agent.analyze::intent"            → appKey = defect-agent, feature = analyze
  "literary-agent.illustration::generation" → appKey = literary-agent, feature = illustration

聚合 SQL (伪代码):
  SELECT
    SPLIT(RequestPurpose, '.')[0] AS appKey,
    COUNT(DISTINCT UserId) AS uniqueUsers,
    COUNT(*) AS totalCalls,
    SUM(InputTokens + OutputTokens) AS totalTokens
  FROM llm_request_logs
  WHERE StartedAt >= @weekStart
  GROUP BY appKey

展示:
  ┌──────────────────────────────────────────────────────────────┐
  │  Agent 名称       采纳率    调用次数   Token消耗    使用深度    │
  │  PRD Agent         87%     1,234     180万       ████████░  │
  │  Defect Agent      65%       456      52万       █████░░░░  │
  │  Visual Agent      43%       289     320万       ██████░░░  │
  │  Literary Agent    21%        78      45万       ███░░░░░░  │
  └──────────────────────────────────────────────────────────────┘
  采纳率 = 本周使用该Agent的用户数 / 本周总活跃用户数
  使用深度 = 平均对话轮次 (1-3轮=浅 / 4-10轮=中 / 10+轮=深)
```

**成本中心 — 从 llm_request_logs 计算**

```
成本计算公式:
  cost = (InputTokens × inputPricePerMillion / 1_000_000)
       + (OutputTokens × outputPricePerMillion / 1_000_000)

需要新增: model_pricing 配置（可存在 llm_models 集合中）

展示:
  按模型维度:
  ┌───────────────────────────────────────────────────┐
  │  模型           调用次数   Token消耗   预估成本($)  │
  │  gpt-4o          523     380万      $11.40      │
  │  claude-sonnet   312     220万       $6.60      │
  │  deepseek-v3     198      95万       $0.47      │
  │  dall-e-3         89       -        $8.90      │
  └───────────────────────────────────────────────────┘

  按用户维度:
  ┌───────────────────────────────────────────────────┐
  │  用户     消息数   Token消耗  预估成本   主用Agent   │
  │  张三      127    12.3万    $0.37    PRD Agent  │
  │  李四       89     8.7万    $0.26    Visual     │
  │  王五       56     4.2万    $0.13    Defect     │
  └───────────────────────────────────────────────────┘
```

### 3.1 信息架构（5 个 Tab）

```
总裁面板 (ExecutiveDashboard)
├── 全局概览 (Overview)         — 关键数字一屏看完
├── 团队洞察 (Team Insights)    — 部门/团队/个人下钻
├── Agent 使用 (Agent Usage)    — 各 Agent 采纳度与效率
├── 成本中心 (Cost Center)      — Token 消耗 & 预算管理
└── 外部协作 (Integrations)     — 第三方任务 & OpenClaude
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

### Phase 0: 数据基础设施（必须先做）

> 没有这一步，后面所有面板只能看 7 天数据，30 天趋势图会是空的。

- [ ] 新增 `DailyStatsSnapshot` 模型 + `daily_stats_snapshots` 集合
- [ ] 实现 `DailyStatsAggregationWorker` 定时任务（每日 01:00 UTC）
- [ ] 回填历史数据：基于 messages（永久保留）重建过去 N 天的快照
- [ ] 在 `LlmModel` 上新增 `InputPricePerMillion` / `OutputPricePerMillion` 字段（成本计算用）

### Phase 1: 全局概览 Tab

- [ ] `ExecutiveStatsService` — 聚合查询（实时 + 快照双源）
- [ ] `ExecutiveDashboardController` — 6 个 KPI + 趋势 + 热力图 API
- [ ] 前端 `OverviewTab` — KPI 卡片 + 30 天趋势 ECharts + 热力图

### Phase 2: 团队洞察 Tab

- [ ] 用户活动聚合查询（跨 messages / defect_reports / image_gen_runs / prd_comments / content_gaps）
- [ ] `UserProfileCard` — 个人画像卡片
- [ ] `TeamInsightsTab` — 团队排名 + 个人下钻

### Phase 3: 周报 Agent

- [ ] `WeeklyReportService` — 从 daily_stats_snapshots 汇总 + LLM 生成叙述
- [ ] `WeeklyReportWorker` — 每周日 22:00 定时任务
- [ ] `WeeklyReportViewer` — 前端查看器
- [ ] 通知推送（复用 AdminNotification）

### Phase 4: 成本中心 Tab

- [ ] Token 成本计算（llm_request_logs × model 单价）
- [ ] 预算配置 + 预警（executive_configs）
- [ ] `CostCenterTab` — 成本分解图 + 预算进度

### Phase 5: 外部协作 Tab

- [ ] `ExternalActivity` 模型 + Webhook 入口
- [ ] Claude Code Hook 集成
- [ ] Jira/GitLab 轮询适配器
- [ ] `IntegrationsTab` — 配置管理 + 活动流

### Phase 6: Agent 分析 Tab

- [ ] 采纳率/使用深度计算（基于 RequestPurpose 前缀聚合）
- [ ] `SkillMatrixGrid` — 用户 × Agent 技能矩阵
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
