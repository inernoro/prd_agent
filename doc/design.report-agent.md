# 周报管理 Agent (Report Agent) 架构设计

> **版本**：v1.0 | **日期**：2026-03-28 | **状态**：已实现
>
> **appKey**：`report-agent`

## 一、管理摘要

- **解决什么问题**：团队周报撰写依赖人工汇总，管理者需逐篇阅读成员周报才能掌握全局进展，且缺乏数据驱动的工作量度量
- **方案概述**：提供团队 → 成员 → 日报 → 周报 → AI 团队汇总的全链路管理，自动对接 Git 仓库获取代码提交数据，AI 生成团队级周报汇总
- **业务价值**：管理者一键查看团队全貌，成员日常打点自动聚合为周报，AI 汇总替代人工阅读 10+ 篇周报的时间成本
- **影响范围**：prd-api（ReportAgentController，3700+ 行）、prd-admin（20+ 前端页面）、LLM Gateway（AI 汇总调用）、工作流引擎（数据采集）
- **当前状态**：Phase 1-4 已实现，含团队管理、模板、日报、周报、数据源、AI 汇总、评论互动、趋势分析、导出

## 二、产品定位

**一句话**：让团队周报从"负担"变成"资产"——成员轻松写、管理者秒懂、数据自动来。

**目标用户**：

| 角色 | 核心需求 | 使用频率 |
|------|----------|----------|
| 团队成员 | 每日打点记录工作、周末自动聚合为周报 | 每天 |
| 团队管理者 | 一键查看团队整体进展、AI 汇总关键信息 | 每周 |
| 高层管理者 | 跨团队趋势分析、计划完成率对比 | 每周/每月 |

**设计理念**：日报驱动周报，数据驱动汇总，AI 驱动洞察。

## 三、核心能力矩阵

| 能力 | 说明 | 阶段 |
|------|------|------|
| **团队管理** | 创建/编辑/删除团队，支持上下级团队树结构 | Phase 1 |
| **成员管理** | 邀请/移除成员，角色（owner/admin/member），休假标记 | Phase 1 |
| **身份映射** | Git 提交者邮箱 ↔ 系统用户 ID 映射，自动归属代码提交 | Phase 2 |
| **周报模板** | 自定义周报模板（章节结构），团队维度绑定 | Phase 1 |
| **每日打点** | 成员记录每日工作日志，自动按日期分组 | Phase 2 |
| **周报撰写** | 基于日报 + 代码提交自动生成周报草稿，支持手动编辑 | Phase 2 |
| **数据源对接** | Git 仓库连接、commit 同步、自动统计代码量 | Phase 3 |
| **工作流采集** | 通过工作流引擎采集外部数据源（Jira、飞书等） | Phase 3 |
| **AI 团队汇总** | LLM 读取全员周报 → 生成团队级摘要，可自定义 prompt | Phase 4 |
| **评论与互动** | 段落级评论（支持回复）、点赞、浏览记录 | Phase 4 |
| **趋势分析** | 个人/团队维度的工作量趋势图（按周聚合） | Phase 4 |
| **计划对比** | 上周计划 vs 本周完成对比分析 | Phase 4 |
| **Markdown 导出** | 周报和团队汇总支持导出为 Markdown 文件 | Phase 4 |

## 四、整体架构

```
┌─────────────────────────────────────────────────┐
│                  prd-admin (前端)                 │
│  TeamPage → MemberPage → DailyLogPage → Report  │
│  TemplateEditor    TrendChart    SummaryView     │
└───────────────────────┬─────────────────────────┘
                        │ HTTP API
┌───────────────────────▼─────────────────────────┐
│          ReportAgentController (3700+ 行)         │
│  appKey = "report-agent"                         │
├──────────────────────────────────────────────────┤
│  团队 CRUD │ 成员管理 │ 模板 │ 日报 │ 周报      │
│  数据源    │ Commit 同步 │ AI 汇总 │ 互动       │
│  趋势统计  │ 计划对比 │ 导出 │ 休假管理          │
└───────────┬──────────┬───────────┬──────────────┘
            │          │           │
     ┌──────▼──┐  ┌───▼────┐ ┌───▼──────────┐
     │ MongoDB │  │ LLM    │ │ Workflow     │
     │ 11 集合  │  │Gateway │ │ Engine       │
     └─────────┘  └────────┘ └──────────────┘
```

### 核心流程

**日常使用流程**：
1. 成员每天通过「每日打点」记录工作内容
2. 系统自动从 Git 数据源同步当日代码提交
3. 周末成员点击「生成周报」→ 系统聚合日报 + commit 数据 → 生成周报草稿
4. 成员编辑确认后提交周报
5. 管理者点击「生成团队汇总」→ AI 读取全员周报 → 生成团队摘要
6. 其他成员可浏览、评论、点赞

**数据源同步流程**：
1. 管理员配置 Git 仓库地址和认证信息
2. 系统定期（或手动触发）拉取 commit 记录
3. 通过身份映射（邮箱 → 用户 ID）将 commit 归属到团队成员
4. 归属后的 commit 数据自动出现在成员的周报素材中

**AI 汇总流程**：
1. 管理者触发「生成团队汇总」
2. 系统收集该周期内所有成员的已提交周报
3. 拼装系统提示词（可自定义）+ 全员周报内容
4. 通过 ILlmGateway 调用 LLM 生成汇总
5. 汇总结果存入 `report_team_summaries` 集合
6. 管理者可查看、导出 Markdown

## 五、数据设计

| 集合 | 用途 | 关键字段 |
|------|------|----------|
| `report_teams` | 团队信息 | Name, ParentTeamId（树结构）, CreatorUserId |
| `report_team_members` | 团队成员关系 | TeamId, UserId, Role(owner/admin/member) |
| `report_templates` | 周报模板 | Name, Description, Sections（章节定义） |
| `report_daily_logs` | 每日打点 | UserId, Date, Content, TeamId |
| `report_weekly_reports` | 周报 | UserId, TeamId, WeekYear, Sections, Status |
| `report_data_sources` | 数据源配置 | TeamId, SourceType(git/svn), RepoUrl, Credentials |
| `report_commits` | 代码提交缓存 | DataSourceId, MappedUserId, CommitHash, Message, Date |
| `report_comments` | 段落级评论 | ReportId, SectionIndex, Content, ParentCommentId（回复） |
| `report_likes` | 点赞记录 | ReportId, UserId（唯一约束：一人一赞） |
| `report_view_events` | 浏览事件 | ReportId, UserId, ViewedAt（允许重复，统计频次） |
| `report_team_summaries` | AI 团队汇总 | TeamId, WeekYear, Summary, GeneratedBy(AI) |

## 六、接口设计

### 团队管理

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/report/teams` | 列出当前用户的团队 |
| GET | `/api/report/teams/{id}` | 获取团队详情 |
| POST | `/api/report/teams` | 创建团队 |
| PUT | `/api/report/teams/{id}` | 更新团队信息 |
| DELETE | `/api/report/teams/{id}` | 删除团队 |

### 成员管理

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/report/teams/{id}/members` | 添加成员 |
| PUT | `/api/report/teams/{id}/members/{userId}` | 更新成员角色 |
| DELETE | `/api/report/teams/{id}/members/{userId}` | 移除成员 |
| POST | `/api/report/teams/{id}/leave` | 主动退出团队 |
| PUT | `/api/report/teams/{id}/members/{userId}/identity-mappings` | 设置身份映射 |
| POST | `/api/report/teams/{teamId}/members/{userId}/vacation` | 标记休假 |
| DELETE | `/api/report/teams/{teamId}/members/{userId}/vacation` | 取消休假 |

### 模板

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/report/templates` | 列出模板 |
| GET | `/api/report/templates/{id}` | 获取模板详情 |
| POST | `/api/report/templates` | 创建模板 |
| PUT | `/api/report/templates/{id}` | 更新模板 |

### 日报 & 周报

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/report/daily-logs` | 查询日报列表 |
| POST | `/api/report/daily-logs` | 创建/更新日报 |
| GET | `/api/report/reports` | 查询周报列表 |
| GET | `/api/report/reports/{id}` | 获取周报详情 |
| POST | `/api/report/reports` | 创建周报 |
| PUT | `/api/report/reports/{id}` | 更新周报 |
| GET | `/api/report/reports/{id}/plan-comparison` | 计划完成对比 |
| GET | `/api/report/reports/{id}/export/markdown` | 导出 Markdown |

### AI 汇总 & 团队视图

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/report/teams/{id}/summary/generate` | 生成 AI 团队汇总 |
| GET | `/api/report/teams/{id}/summary` | 获取团队汇总 |
| GET | `/api/report/teams/{id}/summary/view` | 团队汇总视图（含成员列表） |
| GET | `/api/report/teams/{id}/reports/view` | 团队周报列表视图 |
| GET | `/api/report/teams/{id}/summary/export/markdown` | 导出团队汇总 |
| GET | `/api/report/teams/{id}/ai-summary-prompt` | 获取 AI 汇总 prompt |
| PUT | `/api/report/teams/{id}/ai-summary-prompt` | 自定义 AI 汇总 prompt |
| POST | `/api/report/teams/{id}/ai-summary-prompt/reset` | 重置为默认 prompt |

### 数据源 & 采集

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/report/teams/{id}/workflow` | 获取团队工作流配置 |
| POST | `/api/report/teams/{id}/workflow/run` | 手动触发数据采集 |
| GET | `/api/report/activity` | 获取采集到的活动数据 |

### 互动

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/report/reports/{id}/comments` | 获取评论列表 |
| POST | `/api/report/reports/{id}/comments` | 发表评论 |
| DELETE | `/api/report/reports/{reportId}/comments/{commentId}` | 删除评论 |
| GET | `/api/report/reports/{id}/likes` | 获取点赞列表 |
| POST | `/api/report/reports/{id}/likes` | 点赞 |
| DELETE | `/api/report/reports/{id}/likes` | 取消点赞 |
| POST | `/api/report/reports/{id}/views` | 记录浏览 |
| GET | `/api/report/reports/{id}/views-summary` | 浏览统计 |

### 趋势

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/report/trends/personal` | 个人工作量趋势（默认 12 周） |
| GET | `/api/report/trends/team/{teamId}` | 团队工作量趋势 |

## 七、关联文档

| 文档 | 关系 |
|------|------|
| `design.ai-report-systems.md` | 市场调研 — Phase 1 前的竞品分析，为功能设计提供灵感 |
| `design.executive-dashboard.md` | 总裁面板消费周报数据，展示团队级聚合指标 |
| `design.workflow-engine.md` | 工作流引擎为周报提供外部数据源采集能力 |

## 八、影响范围与风险

### 影响范围

| 影响模块 | 变更内容 | 需要配合的团队 |
|----------|----------|---------------|
| LLM Gateway | AI 汇总调用，appCallerCode = `report-agent.summary::chat` | 模型运维 |
| 工作流引擎 | 数据源采集走工作流执行 | 工作流团队 |
| 用户系统 | 团队成员关联用户 ID | 用户团队 |
| 总裁面板 | 消费周报聚合数据 | 数据团队 |

### 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Git 仓库认证信息泄露 | 低 | 高 | Credentials 加密存储，API 不返回明文 |
| AI 汇总生成质量不稳定 | 中 | 中 | 支持自定义 prompt + 重新生成 |
| 大团队周报数据量大导致汇总超 token 限制 | 中 | 中 | 分批汇总或摘要后再汇总 |
| 身份映射不准导致 commit 归属错误 | 中 | 低 | 管理界面支持手动修正映射 |
