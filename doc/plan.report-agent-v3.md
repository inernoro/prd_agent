# Report Agent v3.0 升级方案

> **编写日期**：2026-03-08
> **基于**：`doc/research.ai-report-systems.md` 市场调研 + 现有 v2.0 架构分析
> **目标**：将周报系统从"能用"提升到"好用、智能、有竞争力"

---

## 一、现状诊断

### 已有能力（v2.0）

| 能力 | 状态 | 对标产品 |
|------|------|----------|
| Git/SVN 数据采集 | ✅ 完整 | Gitmore |
| 个人数据源（GitHub/GitLab/语雀） | ✅ 完整 | — |
| 工作流驱动数据采集（TAPD 等） | ✅ 完整 | — |
| AI 自动生成周报 | ✅ 基础 | ClickUp Brain（基础级） |
| 团队 AI 汇总 | ✅ 基础 | 飞书 AI 智能汇报（基础级） |
| 每日打点 | ✅ 完整 | — |
| 模板系统 | ✅ 完整 | — |
| 评论/反馈 | ✅ 完整 | — |
| 趋势统计 | ✅ 完整 | Reclaim.ai（基础级） |
| 周五自动触发 | ✅ 完整 | Notion Agents（基础级） |
| Markdown 导出 | ✅ 完整 | — |

### 关键差距（对标市场领先者）

| 差距 | 对标产品 | 影响 |
|------|----------|------|
| 管理者汇总太粗糙 | 飞书 AI 智能汇报 | 管理者仍需逐份阅读 |
| 无主动推送 | DailyBot、Geekbot | 用户必须打开页面才能看 |
| 无自然语言查询 | Geekbot MCP、Lattice AI Agent | 无法回答"上月张三做了什么" |
| 无风险/阻塞检测 | Stepsize AI | 问题暴露靠人，不靠 AI |
| 无情感/士气分析 | Geekbot、Standup Alice | 管理者无法感知团队状态 |
| 周报消费形态单一 | Linear Pulse | 只能在 Web 端看，无音频/邮件/IM |
| AI 生成质量无反馈闭环 | Lattice | 不知道生成的好不好，无法自我改进 |

---

## 二、升级路线图

### Phase 1：管理者 AI 增强（2-3 周）

> **参考**：飞书 AI 智能汇报 + Stepsize AI
> **价值**：解决管理者"读 20 份周报"的核心痛点

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
| `TeamSummaryService.cs` | 重写 Prompt（提供上周汇总作为对比上下文）；解析新 JSON 结构 |
| `ReportAgentController.cs` | 新增 `GET /teams/{id}/summary/insights` 返回结构化洞察 |

**前端改动**：

| 文件 | 改动 |
|------|------|
| `TeamDashboard.tsx` | 新增「团队健康度」卡片（分数 + 趋势箭头 + 颜色）；风险列表（severity 颜色编码）；贡献度热力图 |

#### 1.2 AI 速读（单份周报）

**参考**：飞书"AI 速读"功能

每份提交的周报旁边显示 AI 生成的 1-2 句话摘要，管理者扫一眼即可判断是否需要详读。

**改动**：

| 层 | 改动 |
|----|------|
| Model | `WeeklyReport` 新增 `AiDigest: string`（1-2 句话摘要） |
| Service | 在 `Submit` 时异步调用 LLM 生成 digest（`report-agent.digest::chat`） |
| API | `GET /reports` 列表返回包含 `aiDigest` 字段 |
| 前端 | `TeamDashboard` 成员卡片下方显示 digest，灰色小字 |

---

### Phase 2：智能推送与提醒（2 周）

> **参考**：DailyBot + Geekbot + 飞书定时推送
> **价值**：周报不再只在 Web 端，送到用户手边

#### 2.1 Webhook 推送通道

**设计**：复用现有 `defect_webhook_configs` 模式，新增周报 Webhook。

```
事件类型：
- report.generated     — 周报已自动生成（提醒成员编辑）
- report.submitted     — 成员已提交（通知 Leader）
- report.all_submitted — 全员已提交（通知 Leader 可汇总）
- report.summary_ready — 团队汇总已生成
- report.overdue       — 逾期未提交
```

**后端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `ReportWebhookConfig.cs` | teamId, webhookUrl, events[], secret, enabled |
| 新增 `ReportWebhookService.cs` | 发送 Webhook（HMAC 签名 + 重试 3 次） |
| `ReportNotificationService.cs` | 在每个通知事件中同时触发 Webhook |
| `ReportAgentController.cs` | 新增 Webhook CRUD 端点（4 个） |

**Webhook Payload 示例**：

```json
{
  "event": "report.summary_ready",
  "team": { "id": "...", "name": "前端组" },
  "week": { "year": 2026, "number": 10 },
  "summary": {
    "health_score": 78,
    "executive_summary": "本周完成 3 个需求，1 个风险待跟进",
    "submitted_count": 8,
    "total_count": 10
  },
  "url": "https://app.example.com/report-agent?tab=dashboard&week=2026-W10"
}
```

**适用场景**：
- 接入飞书/钉钉/企微机器人（Webhook URL 配置为机器人地址）
- 接入 Slack Incoming Webhook
- 接入自定义邮件网关

#### 2.2 邮件摘要推送

**设计**：每周一早上自动发送上周团队汇总邮件给 Leader。

| 文件 | 改动 |
|------|------|
| `ReportAutoGenerateWorker.cs` | 新增周一 9:00 触发：查询已生成的 TeamSummary → 渲染 HTML 邮件 → 发送 |
| 新增 `ReportEmailRenderer.cs` | 将 TeamSummary 渲染为 HTML 邮件模板 |
| `ReportTeam.cs` | 新增 `NotificationConfig: { emailEnabled, webhookEnabled, reminderTimes[] }` |

---

### Phase 3：自然语言查询（2-3 周）

> **参考**：Geekbot 对话式分析 + Lattice AI Agent
> **价值**：将静态周报变为可查询的知识库

#### 3.1 周报问答 Agent

**设计**：在周报页面新增"问答"入口，用户可以用自然语言查询历史周报数据。

```
用户："上个月张三的代码提交情况怎么样？"
AI："张三在 2026 年 2 月共提交 127 次 commit，平均每周 31.75 次。
     主要涉及前端重构（占 60%）和 Bug 修复（占 25%）。
     相比 1 月（98 次），提交量增长 29.6%。
     高亮：W6 完成了用户中心模块重构（32 commits）。"

用户："哪些人上周有阻塞项？"
AI："以下 3 人在 W10 周报中提到了阻塞：
     1. 李四：等待设计稿确认（已持续 2 周）
     2. 王五：测试环境不稳定
     3. 赵六：第三方 API 文档缺失"
```

**后端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `ReportQueryService.cs` | 接收自然语言 → 构建 MongoDB 查询 → 拼装上下文 → 调用 LLM → 返回结构化回答 |
| `ReportAgentController.cs` | 新增 `POST /query` 端点（接收 `{ question, teamId?, dateRange? }`） |

**查询能力矩阵**：

| 查询类型 | 数据源 | 示例 |
|----------|--------|------|
| 个人贡献查询 | `report_commits` + `report_weekly_reports` | "张三上月做了什么" |
| 阻塞/风险查询 | `report_weekly_reports.sections` | "谁提到了阻塞" |
| 趋势对比 | `report_commits` + 聚合 | "前端组提交量趋势" |
| 团队状态 | `report_team_summaries` | "上周各组健康度" |
| 跨周追踪 | `report_weekly_reports` 多周 | "那个性能问题解决了吗" |

**实现策略**：
- **不用 RAG/向量库**（数据量可控，结构化查询足够）
- Step 1：LLM 解析用户意图 → 生成查询参数（`report-agent.query.intent::intent`）
- Step 2：执行 MongoDB 查询，取回相关数据
- Step 3：LLM 基于数据生成回答（`report-agent.query.answer::chat`）

**前端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `ReportQueryPanel.tsx` | 对话式 UI（输入框 + 消息列表），可固定常用问题 |
| `ReportAgentPage.tsx` | 新增第 8 个 Tab "智能问答" 或作为全局浮窗 |

#### 3.2 预设问题快捷卡片

在团队面板上方显示 3-4 个常用问题卡片，点击直接查询：

```
[ 本周谁还没提交？ ] [ 有哪些风险项？ ] [ 提交量 Top 5 ] [ 上周遗留问题 ]
```

---

### Phase 4：风险与阻塞智能检测（1-2 周）

> **参考**：Stepsize AI 风险预警 + DailyBot 阻塞检测
> **价值**：从"等人报告问题"变为"AI 主动发现问题"

#### 4.1 自动风险扫描

**触发时机**：每次有成员提交周报时，自动扫描。

**检测维度**：

| 维度 | 信号 | 严重度 |
|------|------|--------|
| **进度延期** | 上周 plan 中的任务本周未出现在完成列表 | Medium |
| **提交量异常** | 本周 commit 量 < 上周 50% 且无请假 | Low |
| **重复阻塞** | 同一阻塞项连续出现 ≥2 周 | High |
| **静默成员** | 连续 2 周未提交周报且未标记休假 | High |
| **过度加班信号** | 提交时间 >22:00 或周末提交 > 总量 30% | Medium |
| **单点风险** | 某模块 >80% commit 来自同一人 | Low |

**后端改动**：

| 文件 | 改动 |
|------|------|
| 新增 `RiskDetectionService.cs` | 多维度扫描 → 生成 `ReportRisk[]` |
| 新增 `ReportRisk.cs` | `{ dimension, severity, description, affectedMembers[], detectedAt, weekYear, weekNumber }` |
| `TeamSummaryService.cs` | 汇总时合并 AI 生成的风险 + 规则检测的风险 |
| `ReportAgentController.cs` | 新增 `GET /teams/{id}/risks` |

**前端改动**：

| 文件 | 改动 |
|------|------|
| `TeamDashboard.tsx` | 新增"风险预警"区块，红/黄/蓝 severity 颜色，可展开详情 |

---

### Phase 5：AI 生成质量提升（1-2 周）

> **参考**：Lattice 偏见检测 + 用户反馈闭环
> **价值**：让 AI 生成的内容越来越好

#### 5.1 用户反馈机制

每个 AI 生成的 section 旁边显示 👍/👎 按钮。

| 层 | 改动 |
|----|------|
| Model | `WeeklyReportSection` 新增 `AiFeedback: { rating, editDistance, editedAt }` |
| Service | 提交时自动计算 AI 原始内容与最终提交内容的编辑距离（Levenshtein ratio） |
| 分析 | 定期聚合：哪些 section type 的 AI 被大幅修改 → 调整 Prompt |

#### 5.2 Prompt 模板化 + A/B 测试

| 改动 | 说明 |
|------|------|
| `ReportGenerationService.cs` | Prompt 从硬编码改为从 `report_prompt_templates` 集合加载 |
| 新增 `report_prompt_templates` 集合 | `{ key, version, systemPrompt, userPromptTemplate, isActive }` |
| 管理后台 | 模板管理中增加 "AI Prompt 管理" 子页（仅超管可见） |

---

### Phase 6：消费形态多样化（2 周）

> **参考**：Linear Pulse 音频 + 邮件摘要
> **价值**：让周报不只是"看"的

#### 6.1 团队汇总音频摘要

**设计**：将团队汇总转为 TTS 音频，管理者可在移动端/通勤时收听。

| 层 | 改动 |
|----|------|
| 新增 `ReportAudioService.cs` | 调用 TTS API（复用 LLM Gateway 扩展）将汇总文本转音频 |
| API | `GET /teams/{id}/summary/audio?weekYear=&weekNumber=` 返回音频 URL |
| 前端 | 汇总页面新增"播放"按钮 + 简易音频播放器 |

#### 6.2 周报卡片分享

**设计**：生成精美的周报卡片图片，可分享到 IM。

| 层 | 改动 |
|----|------|
| 新增 `ReportCardRenderer.cs` | 使用 SixLabors.ImageSharp（复用水印渲染基础设施）生成卡片 |
| API | `GET /reports/{id}/card` 返回 PNG |
| 前端 | 周报详情页新增"生成卡片"按钮 |

---

## 三、优先级排序与 ROI 分析

| Phase | 功能 | 开发量 | 用户价值 | 差异化 | 建议优先级 |
|-------|------|--------|----------|--------|------------|
| **P1** | 智能团队汇总 Pro | 中 | ⭐⭐⭐⭐⭐ | 高 | **🔴 立刻做** |
| **P1** | AI 速读 | 小 | ⭐⭐⭐⭐ | 中 | **🔴 立刻做** |
| **P4** | 风险自动检测 | 中 | ⭐⭐⭐⭐⭐ | 高 | **🔴 立刻做** |
| **P2** | Webhook 推送 | 中 | ⭐⭐⭐⭐ | 中 | **🟡 尽快做** |
| **P3** | 自然语言查询 | 大 | ⭐⭐⭐⭐⭐ | 高 | **🟡 尽快做** |
| **P5** | AI 反馈闭环 | 小 | ⭐⭐⭐ | 中 | **🟢 有空做** |
| **P2** | 邮件摘要 | 小 | ⭐⭐⭐ | 低 | **🟢 有空做** |
| **P6** | 音频摘要 | 中 | ⭐⭐⭐ | 高 | **🟢 有空做** |
| **P6** | 卡片分享 | 小 | ⭐⭐ | 低 | **🟢 有空做** |
| **P5** | Prompt A/B 测试 | 中 | ⭐⭐⭐ | 低 | **⚪ 后续** |

### 建议实施顺序

```
第 1 波（3 周）: P1 智能汇总 Pro + AI 速读 + P4 风险检测
                 → 立刻提升管理者体验，形成差异化

第 2 波（2 周）: P2 Webhook 推送
                 → 打通 IM 通道，让周报"找人"而不是"等人来看"

第 3 波（3 周）: P3 自然语言查询
                 → 将周报变为可查询知识库，这是长期竞争力

第 4 波（2 周）: P5 反馈闭环 + P6 音频/卡片
                 → 体验打磨，锦上添花
```

---

## 四、技术架构影响

### 新增 MongoDB 集合

| 集合 | 用途 |
|------|------|
| `report_risks` | AI + 规则检测的风险项 |
| `report_webhook_configs` | Webhook 推送配置 |
| `report_query_logs` | 自然语言查询日志（用于优化） |
| `report_prompt_templates` | AI Prompt 版本管理 |

### 新增 AppCallerCode

| Code | 用途 |
|------|------|
| `report-agent.digest::chat` | 单份周报 AI 速读 |
| `report-agent.risk-detect::chat` | AI 辅助风险检测 |
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

### 前端新增 Tab

| Tab | 条件 | 说明 |
|-----|------|------|
| 智能问答 | `report-agent.query.access` | 自然语言查询历史周报 |

现有 Tab 改动：
- **团队面板**：新增健康度卡片、风险预警区块、AI 速读、贡献度热力图
- **我的周报**：AI 生成后显示 👍/👎 反馈按钮

---

## 五、对标定位

升级完成后的定位对比：

| 能力维度 | v2.0 现状 | v3.0 目标 | 市场对标 |
|----------|-----------|-----------|----------|
| 数据采集 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 已领先（工作流 + 多源） |
| AI 生成 | ⭐⭐ | ⭐⭐⭐⭐ | 接近 ClickUp Brain |
| 管理者体验 | ⭐⭐ | ⭐⭐⭐⭐⭐ | 超越飞书（+风险检测） |
| 智能推送 | ⭐ | ⭐⭐⭐⭐ | 对齐 DailyBot |
| 知识查询 | ⭐ | ⭐⭐⭐⭐ | 对齐 Geekbot MCP |
| 风险预测 | ⭐ | ⭐⭐⭐⭐ | 对齐 Stepsize |
| 消费形态 | ⭐⭐ | ⭐⭐⭐ | 接近 Linear Pulse |

**核心定位**：不做"又一个周报工具"，而是做**团队健康度监控平台** — 周报是输入，洞察是输出。
