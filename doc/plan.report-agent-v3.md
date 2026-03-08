# Report Agent v3.0 升级方案 — 采集优先架构

> **编写日期**：2026-03-08
> **基于**：`doc/research.ai-report-systems.md` 市场调研 + 现有 v2.0 架构分析 + 业界最佳实践
> **核心理念**：**用户打开周报的那一刻，应该已经是满的。** 不是给空模板让人填，而是自动采集 → AI 填充 → 人只需审阅微调。

---

## 零、设计哲学

### 业界最佳实践对比

| 产品 | 模式 | 用户看到的第一眼 | 用户需要做什么 |
|------|------|------------------|---------------|
| **Status Hero** | 预填充 + 补充 | 昨天的 Jira/GitHub 活动已在列表中 | 勾选相关的 + 加 2 句话 |
| **Reclaim.ai** | 纯自动 | 本周时间分配图表已生成 | 什么都不用做 |
| **Gitmore** | Git → AI 叙述 | AI 写好的周报已在邮箱/Slack | 扫一眼确认 |
| **Range.co** | 多源聚合 + 策展 | 各工具的近期活动预拉取 | 选择 + 标注 |
| **LinearB/Waydev** | 纯度量 | DORA 指标仪表盘已刷新 | 什么都不用做 |
| **我们 v2.0** | AI 生成草稿 | ⚠️ 依赖工作流配置和个人源绑定，无配置时看到大量空白 | 配置工作流 + 绑定源 + 填每日打点 |

### v3.0 目标体验

```
周五 16:00，成员打开"我的周报"：

┌─────────────────────────────────────────────────────────┐
│  📊 本周工作概览                          W10 · 2026    │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ 代码提交  │ │ 需求完成  │ │ 缺陷处理  │ │ 文档协作  │  │
│  │   23 次   │ │   4 个    │ │   6 个    │ │   3 篇    │  │
│  │  ↑15%    │ │  ↓1      │ │  ↑2      │ │  →0      │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                         │
│  ✅ 完成事项 (AI 已从 Git/TAPD 自动整理，可编辑)        │
│  · 完成用户中心页面重构 (12 commits, PR #234)           │
│  · 修复登录超时问题 (#BUG-567) → 已验证               │
│  · 协助前端组 Code Review (3 个 PR)                    │
│                                                         │
│  📋 每日打点回顾                                        │
│  · 周一: 产品需求评审会 (2h), 开始用户中心开发          │
│  · 周三: 联调接口 + 修复超时 bug                        │
│  · ...                                                  │
│                                                         │
│  📝 下周计划 (请补充)                                    │
│  · _______________                                      │
│                                                         │
│  💬 备注 (可选)                                          │
│  · _______________                                      │
│                                                         │
│  [提交]                                                  │
└─────────────────────────────────────────────────────────┘

需要用户填写的：只有"下周计划"和"备注"两个框
其余全部自动采集 + AI 整理
```

### 采集优先三原则

1. **零配置有数据**：即使用户没绑定任何外部源，系统内部活动（PRD 会话、缺陷、文档编辑、AI 调用）也能撑起一份有内容的周报
2. **渐进增强**：绑定 GitHub → 多了代码数据；绑定 TAPD → 多了需求数据；每一步都是"锦上添花"而非"从无到有"
3. **AI 兜底**：即使数据稀疏，AI 也要基于仅有的数据写出像样的摘要，而不是输出"本周无数据"

---

## 一、现状诊断

### 系统内已有但未使用的数据源

**MapActivityCollector 当前只采集 6 个数据流**，但系统内还有大量未开发的数据金矿：

| 数据源 | MongoDB 集合 | 当前状态 | 可采集内容 | 采集难度 |
|--------|-------------|----------|-----------|---------|
| PRD 会话数 | `sessions` | ✅ 已用 | 对话次数 | — |
| 缺陷提交数 | `defect_reports` | ✅ 已用（仅计数） | **可扩展**：解决时间、严重度分布、重开率 | 低 |
| 视觉创作数 | `image_master_sessions` | ✅ 已用（仅计数） | 计数 | — |
| LLM 调用数 | `llm_request_logs` | ✅ 已用 | 调用次数 | — |
| Git 提交 | `report_commits` | ✅ 已用 | 提交详情 | — |
| 每日打点 | `report_daily_logs` | ✅ 已用 | 用户手动日志 | — |
| **PRD 消息量** | `messages` | ❌ 未用 | 消息数、对话深度、协作模式 | **低** |
| **图片生成完成数** | `image_gen_runs` | ❌ 未用 | 完成的图片生成任务数 | **低** |
| **视频生成完成数** | `video_gen_runs` | ❌ 未用 | 完成的视频任务数 | **低** |
| **文档编辑活动** | `documents` | ❌ 未用 | 文档修改次数、协作文档数 | **中** |
| **工作流执行数** | `workflow_executions` | ❌ 未用 | 自动化工作流完成数 | **低** |
| **工具箱使用** | `toolbox_runs` | ❌ 未用 | AI 工具调用次数 | **低** |
| **网页发布** | `hosted_sites` | ❌ 未用 | 站点发布/更新次数 | **低** |
| **附件上传** | `attachments` | ❌ 未用 | 共享资料数 | **低** |

**结论**：仅靠内部数据就能做到"打开就有内容"，不依赖任何外部配置。

### 关键差距（对标市场领先者）

| 差距 | 根因 | 对标产品 | 影响 |
|------|------|----------|------|
| **冷启动空白** | 只有配了工作流/个人源才有数据 | Status Hero（工具活动预填充） | 用户第一次打开看到空白，立刻流失 |
| 管理者汇总太粗糙 | 汇总 = 内容拼接，无洞察 | 飞书 AI 智能汇报 | 管理者仍需逐份阅读 |
| 无主动推送 | 必须打开页面 | DailyBot、Geekbot | 用户忘记周报 |
| 无自然语言查询 | — | Geekbot MCP | 无法回答"上月张三做了什么" |
| 无风险/阻塞检测 | — | Stepsize AI | 问题暴露靠人不靠 AI |
| AI 生成质量无反馈闭环 | — | Lattice | 生成质量无法自我改进 |

---

## 二、升级路线图

### Phase 0：数据采集增强 — 消灭空白（1.5 周）

> **参考**：Status Hero（预填充模型）+ Reclaim.ai（零配置即有数据）
> **价值**：解决最核心的问题 — 用户打开不再看到空白
> **原则**：先把系统内已有的数据全部用起来，零成本、零配置

#### 0.1 扩展 MapActivityCollector — 8 个新数据流

**现状**：`MapActivityCollector.cs` 当前查询 6 个集合，实际系统有 14+ 个可用集合。

**改动**：在 `MapActivityCollector` 中新增以下查询：

```csharp
// 新增数据流
public class CollectedActivity
{
    // 已有
    public int PrdSessionCount { get; set; }
    public int DefectReportCount { get; set; }
    public int VisualSessionCount { get; set; }
    public int LlmCallCount { get; set; }
    public int GitCommitCount { get; set; }
    public List<DailyLogItem> DailyLogs { get; set; }

    // 新增 ↓
    public int PrdMessageCount { get; set; }          // messages 集合
    public int ImageGenCompletedCount { get; set; }   // image_gen_runs (Status=Completed)
    public int VideoGenCompletedCount { get; set; }   // video_gen_runs (Status=Completed)
    public int DocumentEditCount { get; set; }        // documents (UpdatedAt in range)
    public int WorkflowExecutionCount { get; set; }   // workflow_executions (Status=Completed)
    public int ToolboxRunCount { get; set; }           // toolbox_runs
    public int WebPagePublishCount { get; set; }       // hosted_sites (UpdatedAt in range)
    public int AttachmentUploadCount { get; set; }     // attachments (CreatedAt in range)

    // 新增：缺陷详情（不只是计数）
    public DefectStats DefectDetails { get; set; }
}

public class DefectStats
{
    public int Submitted { get; set; }
    public int Resolved { get; set; }
    public int Reopened { get; set; }
    public double AvgResolutionHours { get; set; }
}
```

**实现要点**：
- 每个查询都是简单的 `CountDocumentsAsync` + 时间过滤，性能可控
- 缺陷详情需要聚合管道（group by status + avg resolution time）
- 所有查询并行执行（`Task.WhenAll`）

**效果**：即使用户零配置，周报草稿也会包含：
> "本周你进行了 12 次 PRD 对话（共 47 条消息），处理了 3 个缺陷（平均 4.2 小时解决），
>  完成了 2 次图片生成，编辑了 4 篇文档，执行了 1 个自动化工作流。"

#### 0.2 智能统计卡片面板

**设计参考**：Reclaim.ai 的时间分配仪表盘 + Waydev 的工程效能看板

在"我的周报"顶部渲染统计概览卡片组（不可编辑，纯展示）：

```
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ 代码     │ │ 需求     │ │ 缺陷     │ │ 协作     │ │ AI 工具  │
│ 23 commits│ │ 4 完成   │ │ 6 处理   │ │ 47 消息  │ │ 15 调用  │
│ ↑15%     │ │ ↓1      │ │ ↑2      │ │ →       │ │ ↑50%    │
│ +312/-89 │ │ 2 进行中 │ │ 4.2h 平均│ │ 4 文档   │ │ 3 工具箱 │
└─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

**卡片分组逻辑**：

| 卡片 | 数据来源 | 显示条件 |
|------|----------|----------|
| 代码 | `report_commits` | 有 Git 数据源时显示 |
| 需求 | 工作流 Artifacts (TAPD) | 有工作流时显示 |
| 缺陷 | `defect_reports` 聚合 | 有缺陷数据时显示 |
| 协作 | `messages` + `documents` | **始终显示**（系统内数据） |
| AI 工具 | `llm_request_logs` + `toolbox_runs` | **始终显示** |
| 视觉创作 | `image_gen_runs` + `video_gen_runs` | 有数据时显示 |

**关键**：至少 2 个卡片"始终显示"（协作 + AI 工具），确保任何用户打开都不是空白。

**后端改动**：

| 文件 | 改动 |
|------|------|
| `MapActivityCollector.cs` | 新增 8 个数据流查询 |
| 新增 `ActivityStatsDto.cs` | 统计概览 DTO（含 week-over-week delta） |
| `ReportAgentController.cs` | 修改 `GET /activity` 返回增强后的统计数据 |
| `ReportGenerationService.cs` | 将新数据流注入 AI Prompt 上下文 |

**前端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `StatsCardPanel.tsx` | 统计卡片组组件（响应式网格） |
| `WeeklyReportEditor.tsx` | 顶部嵌入 StatsCardPanel |

#### 0.3 AI Prompt 增强 — 数据稀疏兜底

**现状问题**：当数据较少时，AI 生成的内容很空洞或直接说"无数据"。

**改进策略**：

```
Prompt 中新增指令：
"你的任务是基于已收集到的数据，写出有价值的周报内容。
 规则：
 1. 永远不要说"本周无数据"或"暂无记录"
 2. 如果某个维度数据量少（<3 条），将其合并到"其他工作"段落
 3. 如果只有系统活动数据（对话、AI 调用），从使用模式中提炼工作重心
 4. 使用具体数字而非模糊描述（"进行了 12 次 PRD 对话"而非"频繁使用 PRD 系统"）
 5. 对比上周数据时，用趋势箭头标注变化方向"
```

**效果示例**（仅有系统内数据时）：

```
本周工作总结：

本周主要工作集中在产品设计与缺陷处理方面：
· 进行了 12 次 PRD 对话讨论（共 47 条消息），较上周增加 15%，
  主要围绕用户权限模块的需求澄清
· 提交并处理了 6 个缺陷报告，其中 4 个已修复验证，
  平均处理时间 4.2 小时，效率较上周提升
· 编辑了 4 篇 PRD 文档，发布了 1 个项目站点
· 完成了 2 次 AI 图片生成任务
```

→ 即使零外部配置，这也是一份"有内容"的周报，而非空白。

#### 0.4 渐进增强引导

**设计参考**：Range.co 的集成引导流

当统计卡片仅显示系统内数据时，在卡片下方显示渐进式引导：

```
💡 想让周报更丰富？
   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │ 🔗 绑定 GitHub    │  │ 📋 接入 TAPD     │  │ 📝 开启每日打点   │
   │ 自动统计代码提交  │  │ 自动追踪需求进度  │  │ 2 分钟记录每天    │
   │ [一键绑定]        │  │ [配置工作流]      │  │ [去设置]          │
   └──────────────────┘  └──────────────────┘  └──────────────────┘
```

**规则**：
- 已绑定的源不再显示对应引导卡片
- 全部绑定后，引导区域消失
- 引导卡片按数据价值排序（Git > TAPD > 每日打点）

---

### Phase 1：管理者 AI 增强（2-3 周）

> **参考**：飞书 AI 智能汇报 + Stepsize AI + LinearB 工程指标
> **价值**：解决管理者"读 20 份周报"的核心痛点
> **前提**：Phase 0 的增强采集已就位，管理者能看到的数据更丰富

#### 1.1 智能团队汇总 Pro

**现状**：`TeamSummaryService` 已有基础汇总（5 个 section），但输出是扁平文本，缺乏洞察。

**升级目标**：

```
当前：汇总 = 各人内容的简单拼接摘要
目标：汇总 = 结构化洞察报告 + 风险预警 + 贡献度分析 + 行动建议
```

**新增输出结构**：

```json
{
  "executive_summary": "一句话概括本周团队状态",
  "health_score": 78,
  "health_trend": "declining",
  "highlights": [
    { "content": "...", "contributor": "张三", "impact": "high" }
  ],
  "risks": [
    {
      "description": "前端重构进度落后计划 2 天",
      "severity": "medium",
      "affected_members": ["李四"],
      "suggested_action": "考虑分配额外人力或调整里程碑"
    }
  ],
  "blockers": [
    { "description": "...", "reported_by": "王五", "duration_weeks": 2 }
  ],
  "contribution_map": {
    "张三": { "commits": 45, "tasks_completed": 8, "highlight_count": 3 },
    "李四": { "commits": 12, "tasks_completed": 3, "highlight_count": 0 }
  },
  "week_over_week_delta": {
    "commits": "+15%",
    "completion_rate": "-5%",
    "new_risks": 2
  },
  "action_items": [
    { "content": "跟进前端重构延期原因", "assignee": "李四", "priority": "high" }
  ],
  "next_week_outlook": "..."
}
```

**后端改动**：

| 文件 | 改动 |
|------|------|
| `TeamSummary.cs` | 新增 `HealthScore`, `HealthTrend`, `Risks[]`, `Blockers[]`, `ContributionMap`, `WeekOverWeekDelta`, `ActionItems[]` |
| `TeamSummaryService.cs` | 重写 Prompt（提供上周汇总作为对比上下文）；解析新 JSON 结构；输入包含 Phase 0 增强后的统计数据 |
| `ReportAgentController.cs` | 新增 `GET /teams/{id}/summary/insights` 返回结构化洞察 |

**前端改动**：

| 文件 | 改动 |
|------|------|
| `TeamDashboard.tsx` | 新增「团队健康度」仪表盘（分数环形图 + 趋势箭头 + 颜色编码）；风险列表（severity 颜色标签）；贡献度热力图；周环比对比条 |

#### 1.2 AI 速读（单份周报）

**参考**：飞书"AI 速读"功能

每份提交的周报旁边显示 AI 生成的 1-2 句话摘要，管理者扫一眼即可判断是否需要详读。

| 层 | 改动 |
|----|------|
| Model | `WeeklyReport` 新增 `AiDigest: string`（1-2 句话摘要） |
| Service | 在 `Submit` 时异步调用 LLM 生成 digest（`report-agent.digest::chat`） |
| API | `GET /reports` 列表返回包含 `aiDigest` 字段 |
| 前端 | `TeamDashboard` 成员卡片下方显示 digest，灰色小字 |

#### 1.3 风险与阻塞自动检测

**参考**：Stepsize AI 风险预警 + DailyBot 阻塞检测

**触发时机**：
- 每次有成员提交周报时自动扫描
- 团队汇总生成时综合扫描

**检测维度**（规则引擎 + AI 混合）：

| 维度 | 信号 | 实现方式 | 严重度 |
|------|------|---------|--------|
| **进度延期** | 上周 plan 中的任务本周未出现在完成列表 | AI 语义匹配 | Medium |
| **提交量异常** | 本周 commit 量 < 上周 50% 且无请假 | 规则引擎 | Low |
| **重复阻塞** | 同一阻塞项连续出现 ≥2 周 | AI 语义匹配 | High |
| **静默成员** | 连续 2 周未提交周报且未标记休假 | 规则引擎 | High |
| **过度加班信号** | 提交时间 >22:00 或周末提交 > 总量 30% | 规则引擎 | Medium |
| **单点风险** | 某模块 >80% commit 来自同一人 | 规则引擎 | Low |

**后端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `RiskDetectionService.cs` | 规则引擎（6 条规则）+ AI 辅助（语义匹配）→ 生成 `ReportRisk[]` |
| 新增 `ReportRisk.cs` | `{ dimension, severity, description, affectedMembers[], detectedAt, weekYear, weekNumber, source(rule/ai) }` |
| `TeamSummaryService.cs` | 汇总时合并 AI 生成的风险 + 规则检测的风险 |
| `ReportAgentController.cs` | 新增 `GET /teams/{id}/risks?weekYear=&weekNumber=` |

**前端改动**：

| 文件 | 改动 |
|------|------|
| `TeamDashboard.tsx` | 新增"风险预警"区块，红/黄/蓝 severity 颜色编码，可展开详情 + 建议行动 |

---

### Phase 2：智能推送 — 让周报找人（2 周）

> **参考**：DailyBot + Geekbot + Gitmore（Slack/Email 推送）
> **价值**：周报不再只在 Web 端，主动送到用户手边

#### 2.1 Webhook 推送通道

**设计**：复用现有 `defect_webhook_configs` 模式。

```
事件类型：
- report.generated     — 周报已自动生成（提醒成员编辑）
- report.submitted     — 成员已提交（通知 Leader）
- report.all_submitted — 全员已提交（通知 Leader 可汇总）
- report.summary_ready — 团队汇总已生成（含健康度评分）
- report.risk_detected — 检测到高严重度风险
- report.overdue       — 逾期未提交
```

**Webhook Payload 示例**（summary_ready 事件，参考 Gitmore 的 Slack 消息格式）：

```json
{
  "event": "report.summary_ready",
  "team": { "id": "...", "name": "前端组" },
  "week": { "year": 2026, "number": 10 },
  "summary": {
    "health_score": 78,
    "health_trend": "declining",
    "executive_summary": "本周完成 3 个需求，前端重构落后 2 天需关注",
    "submitted_count": 8,
    "total_count": 10,
    "risk_count": 2,
    "top_risk": "前端重构进度延期"
  },
  "url": "https://app.example.com/report-agent?tab=dashboard&week=2026-W10"
}
```

**后端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `ReportWebhookConfig.cs` | teamId, webhookUrl, events[], secret, enabled |
| 新增 `ReportWebhookService.cs` | HMAC 签名 + 指数退避重试（3 次） |
| `ReportNotificationService.cs` | 每个通知事件同时触发 Webhook |
| `ReportAgentController.cs` | 新增 Webhook CRUD 端点（4 个） |

#### 2.2 推送内容模板

不同事件推送不同格式，参考 Gitmore 和 DailyBot 的 IM 消息设计：

| 事件 | 推送内容 |
|------|---------|
| `report.generated` | "📝 你的 W10 周报草稿已生成，已自动填充 23 条代码提交 + 6 个缺陷记录。[查看并编辑]" |
| `report.summary_ready` | "📊 前端组 W10 周报汇总\n健康度: 78/100 (↓)\n亮点: 用户中心重构完成\n风险: 前端进度延期 2 天\n[查看详情]" |
| `report.risk_detected` | "⚠️ 风险预警: 李四连续 2 周提到「设计稿阻塞」未解决 [查看]" |

---

### Phase 3：自然语言查询（2-3 周）

> **参考**：Geekbot MCP + Gitmore Gitmind + LinearB AI
> **价值**：将周报从"写完就存档"变为"可持续查询的团队知识库"

#### 3.1 周报问答 Agent

```
用户："上个月张三的代码提交情况怎么样？"
AI："张三在 2026 年 2 月共提交 127 次 commit，平均每周 31.75 次。
     主要涉及前端重构（占 60%）和 Bug 修复（占 25%）。
     相比 1 月（98 次），提交量增长 29.6%。
     高亮：W6 完成了用户中心模块重构（32 commits）。"
```

**实现策略**（参考 Geekbot MCP 的结构化查询模式，不需要 RAG）：

```
用户问题
    ↓
Step 1: 意图识别 (report-agent.query.intent::intent)
    → { queryType: "member_contribution", userId: "...", dateRange: "2026-02", metrics: ["commits"] }
    ↓
Step 2: MongoDB 结构化查询
    → 聚合管道: report_commits + report_weekly_reports
    ↓
Step 3: 回答生成 (report-agent.query.answer::chat)
    → 自然语言回答 + 数据表格
```

**查询能力矩阵**：

| 查询类型 | 数据源 | 示例 |
|----------|--------|------|
| 个人贡献 | `report_commits` + `report_weekly_reports` | "张三上月做了什么" |
| 阻塞追踪 | `report_weekly_reports.sections` | "那个设计稿阻塞解决了吗" |
| 团队对比 | `report_team_summaries` + 聚合 | "前端组 vs 后端组本月效率" |
| 趋势分析 | `report_commits` 聚合 | "最近 3 个月提交量趋势" |
| 风险回顾 | `report_risks` | "上个季度有哪些高风险项" |

**后端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `ReportQueryService.cs` | 意图解析 → MongoDB 查询 → LLM 回答生成 |
| `ReportAgentController.cs` | 新增 `POST /query` 端点 |

**前端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `ReportQueryPanel.tsx` | 对话式 UI + 预设问题快捷卡片 |

#### 3.2 预设问题快捷卡片

参考 LinearB 的 Insight Cards，在团队面板上方显示：

```
[ 🔴 本周谁还没提交？ ] [ ⚠️ 有哪些风险项？ ] [ 📈 提交量 Top 5 ] [ 🔄 上周遗留问题 ]
```

点击直接触发查询，无需打字。

---

### Phase 4：AI 生成质量闭环（1 周）

> **参考**：Lattice AI 偏见检测 + 用户反馈闭环
> **价值**：让 AI 生成的内容越来越好

#### 4.1 隐式反馈采集

**不加 👍/👎 按钮**（增加用户负担），而是通过编辑行为自动推断：

| 信号 | 含义 | 采集方式 |
|------|------|---------|
| 用户直接提交未修改 | AI 生成质量好 | 对比 AI 原始 vs 提交内容 |
| 用户大幅编辑（编辑距离 >50%） | AI 生成质量差 | Levenshtein ratio |
| 用户删除整段 | 该段无价值 | 段落级 diff |
| 用户补充新段落 | AI 遗漏了重要内容 | 新增内容检测 |

**后端改动**：

| 文件 | 改动 |
|------|------|
| `WeeklyReportSection` | 新增 `AiOriginalContent: string`（生成时快照）, `EditDistance: double`（提交时计算） |
| `ReportGenerationService.cs` | 生成时保存原始内容快照 |
| 新增 `ReportQualityAnalyzer.cs` | 定期聚合编辑距离 → 识别低质量 section type → 生成 Prompt 调优建议 |

#### 4.2 Prompt 模板可配置

| 改动 | 说明 |
|------|------|
| `ReportGenerationService.cs` | Prompt 从硬编码改为 `report_prompt_templates` 集合加载 |
| 新增 `report_prompt_templates` 集合 | `{ key, version, systemPrompt, userPromptTemplate, isActive }` |

---

## 三、优先级与实施计划

### ROI 分析

| Phase | 功能 | 开发量 | 解决的核心问题 | 建议 |
|-------|------|--------|---------------|------|
| **P0** | 数据采集增强 + 统计卡片 | 1.5 周 | **冷启动空白** — 最高优先 | **🔴 第一个做** |
| **P1** | 智能汇总 Pro + AI 速读 + 风险检测 | 2.5 周 | 管理者效率 + 风险可见性 | **🔴 紧跟** |
| **P2** | Webhook 推送 | 1.5 周 | 被动等人 → 主动触达 | **🟡 第二波** |
| **P3** | 自然语言查询 | 2.5 周 | 周报变知识库 | **🟡 第二波** |
| **P4** | AI 质量闭环 | 1 周 | AI 持续改进 | **🟢 第三波** |

### 实施顺序

```
第 1 波（4 周）: P0 采集增强 → P1 管理者增强
                 消灭空白 + 让管理者爱用

第 2 波（4 周）: P2 Webhook 推送 + P3 自然语言查询
                 打通 IM + 变为知识库

第 3 波（1 周）: P4 AI 质量闭环
                 持续优化
```

---

## 四、技术架构影响

### 新增 MongoDB 集合

| 集合 | 用途 |
|------|------|
| `report_risks` | AI + 规则引擎检测的风险项 |
| `report_webhook_configs` | Webhook 推送配置 |
| `report_query_logs` | 自然语言查询日志 |
| `report_prompt_templates` | AI Prompt 版本管理 |

### 新增 AppCallerCode

| Code | 用途 |
|------|------|
| `report-agent.digest::chat` | 单份周报 AI 速读 |
| `report-agent.risk-detect::chat` | AI 辅助风险检测（语义匹配） |
| `report-agent.query.intent::intent` | 查询意图识别 |
| `report-agent.query.answer::chat` | 查询结果生成回答 |
| `report-agent.summary-pro::chat` | 增强版团队汇总 |

### 新增权限

| 权限 | 说明 |
|------|------|
| `report-agent.query.access` | 使用自然语言查询 |
| `report-agent.webhook.manage` | 管理 Webhook 配置 |
| `report-agent.risk.view` | 查看风险预警 |
| `report-agent.prompt.manage` | 管理 AI Prompt 模板（超管） |

### 核心改动文件清单

| 文件 | Phase | 改动类型 |
|------|-------|---------|
| `MapActivityCollector.cs` | P0 | **大改** — 新增 8 个数据流 |
| `CollectedActivity.cs` (DTO) | P0 | **大改** — 新增字段 |
| `ReportGenerationService.cs` | P0 | **中改** — Prompt 增强 + 新数据流注入 |
| `ReportAgentController.cs` | P0-P3 | **持续改** — 新增端点 |
| `TeamSummary.cs` | P1 | **中改** — 新增结构化洞察字段 |
| `TeamSummaryService.cs` | P1 | **大改** — 重写 Prompt + 解析逻辑 |
| `WeeklyReport.cs` | P1 | **小改** — 新增 AiDigest |
| 新增 `RiskDetectionService.cs` | P1 | **新建** |
| 新增 `ReportWebhookService.cs` | P2 | **新建** |
| 新增 `ReportQueryService.cs` | P3 | **新建** |
| 新增 `StatsCardPanel.tsx` | P0 | **新建** |
| `TeamDashboard.tsx` | P1 | **大改** — 健康度 + 风险 + 贡献度 |
| 新增 `ReportQueryPanel.tsx` | P3 | **新建** |

---

## 五、对标定位

升级完成后：

| 能力维度 | v2.0 | v3.0 | 对标谁 | 核心差异 |
|----------|------|------|--------|---------|
| **冷启动体验** | ⭐ 空白 | ⭐⭐⭐⭐⭐ 满的 | Status Hero | 我们有系统内数据，冷启动更好 |
| 数据采集广度 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Waydev | 内部活动 + 外部源 + 工作流 |
| AI 生成质量 | ⭐⭐ | ⭐⭐⭐⭐ | Gitmore | 多源融合 + 稀疏兜底 |
| 管理者体验 | ⭐⭐ | ⭐⭐⭐⭐⭐ | 飞书 + Stepsize | 健康度 + 风险 + 速读 |
| 智能推送 | ⭐ | ⭐⭐⭐⭐ | DailyBot | Webhook + 富内容 |
| 知识查询 | ⭐ | ⭐⭐⭐⭐ | Geekbot MCP | 结构化查询 + 预设问题 |
| 风险预测 | ⭐ | ⭐⭐⭐⭐ | Stepsize | 规则 + AI 混合 |

**核心定位**：

> **采集优先的团队效能平台** — 系统自动采集一切可采集的数据，AI 负责整理成人话，人只需审阅和补充"机器看不到的东西"（计划、感受、判断）。
