# 周报 Agent Phase 5 — 用户故事

> **版本**: v1.0 | **创建日期**: 2026-03-05 | **关联 PRD**: `doc/spec.report-agent.v2.md`
>
> **Phase 主题**: Workflow as Data Pipeline — 复用工作流引擎采集数据，AI 一键生成周报

---

## 一、角色定义

| 角色 | 代号 | 说明 |
|------|------|------|
| 团队成员 | Member | 需要提交周报的个人 |
| 团队负责人 | Lead | 管理团队、查看成员产出、触发采集 |
| 系统管理员 | Admin | 管理全局模板和团队 |

---

## 二、用户故事

### US-5.1 多平台身份映射

**作为** 团队负责人，**我希望** 为每个成员配置多平台身份映射（GitHub 用户名、TAPD 邮箱、语雀 ID 等），**以便** 系统能自动将不同平台的采集数据归属到正确的成员。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 负责人编辑成员信息时 | 可以看到 `identityMappings` 配置区域，支持 github / tapd / yuque / gitlab 四种平台 |
| 2 | 提交映射 `{ "github": "zhangsan", "tapd": "zhangsan@company.com" }` | 成功保存，后续查询返回完整映射 |
| 3 | 同一成员的映射不同平台使用不同标识 | 系统按平台名精确匹配，不会交叉混淆 |
| 4 | 成员未配置某平台映射 | 该平台的数据不会归属到此成员（不报错） |

**API**: `PUT /api/report-agent/teams/{id}/members/{userId}/identity-mappings`

**关键代码**: `ReportTeamMember.IdentityMappings` (Dictionary<string, string>)

---

### US-5.2 团队采集工作流绑定

**作为** 团队负责人，**我希望** 将团队绑定到一个采集工作流，**以便** 系统能通过工作流引擎自动采集 TAPD、GitHub 等多平台数据。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 团队模型包含 `DataCollectionWorkflowId` 字段 | 可以关联到 `workflows` 集合中的一个工作流 |
| 2 | 团队模型包含 `WorkflowTemplateKey` 字段 | 标识使用的预置模板类型（如 "dev-team"） |
| 3 | 查询团队工作流信息 | 返回工作流详情 + 最近一次执行状态 |

**API**: `GET /api/report-agent/teams/{id}/workflow`

**关键代码**: `ReportTeam.DataCollectionWorkflowId`, `ReportTeam.WorkflowTemplateKey`

---

### US-5.3 手动触发采集工作流

**作为** 团队负责人，**我希望** 能手动触发团队的采集工作流执行，**以便** 在自动定时之外也能按需获取最新数据。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 调用触发 API，传入目标周信息 | 系统创建 WorkflowExecution，注入 weekYear/weekNumber/dateFrom/dateTo/teamId 变量 |
| 2 | 工作流执行入队后 | API 立即返回 executionId，不阻塞等待完成 |
| 3 | 团队未绑定工作流时触发 | 返回 400 错误，提示未配置采集工作流 |

**API**: `POST /api/report-agent/teams/{id}/workflow/run`

**关键代码**: `WorkflowExecutionService.ExecuteInternalAsync()`

---

### US-5.4 工作流 Artifact 解析

**作为** 系统（内部服务），**我希望** 能解析工作流执行产出的 FinalArtifacts JSON，**以便** 提取各平台的统计数据（commits、PR、Bug 等）。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | Artifact 为标准 JSON 数组格式（多 source） | 按 `source` 字段分类解析，提取 `summary` 和 `details` |
| 2 | Artifact 为单个对象格式 | 自动包装为数组后正常解析 |
| 3 | Artifact 为空列表 | 返回空 TeamCollectedStats（不报错） |
| 4 | Artifact JSON 格式错误 | 返回空结果（不抛异常） |
| 5 | Artifact MimeType 不是 application/json | 自动跳过 |

**关键代码**: `ArtifactStatsParser.Parse()`

**单元测试**: `ReportAgentV2Tests` — 5 个 Artifact 解析测试

---

### US-5.5 按成员拆分统计数据

**作为** 系统（内部服务），**我希望** 将团队级采集数据按成员的身份映射拆分为个人统计，**以便** 每个成员的周报只包含自己的数据。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 团队有 2 名成员，GitHub 数据包含两人的 commits | 按 `details[].assignee` 匹配 `identityMappings["github"]`，正确拆分 |
| 2 | TAPD 数据 assignee 为邮箱格式 | 按 `identityMappings["tapd"]` 匹配邮箱 |
| 3 | 某条 detail 的 assignee 不匹配任何成员 | 该条数据被丢弃，不影响其他数据 |
| 4 | 拆分后的 summary 数字 | 按 details 数量比例重新计算（如原 3 commits 中 2 条属于张三，则张三 commits=2） |

**关键代码**: `ArtifactStatsParser.SplitByMember()`, `ArtifactStatsParser.RecalculateSummary()`

**单元测试**: `ReportAgentV2Tests.SplitByMember_ShouldAttributeDetailsCorrectly`

---

### US-5.6 个人数据源绑定 (CRUD)

**作为** 团队成员，**我希望** 绑定我的个人 GitHub / 语雀 / GitLab 账号，**以便** 系统能采集我在个人仓库或知识库中的产出。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 创建 GitHub 数据源，提供 Token + 仓库地址 | Token 通过 AES-256 加密存储（EncryptedToken） |
| 2 | 创建语雀数据源，提供 Token + 空间 ID | 同样加密存储 |
| 3 | 列出我的数据源 | 只返回当前用户的数据源，按创建时间倒序 |
| 4 | 更新数据源配置 | 支持部分更新（仅传 displayName 不影响 Token） |
| 5 | 删除数据源 | 只能删除自己的数据源 |
| 6 | 数据源默认启用 | `Enabled = true` |
| 7 | 同步状态初始值 | `LastSyncStatus = "never"` |

**API**:
- `GET /api/report-agent/my/sources`
- `POST /api/report-agent/my/sources`
- `PUT /api/report-agent/my/sources/{id}`
- `DELETE /api/report-agent/my/sources/{id}`

**关键代码**: `PersonalSourceService` (CRUD), `PersonalSource` 模型

---

### US-5.7 个人数据源连接测试

**作为** 团队成员，**我希望** 测试我绑定的数据源是否能正常连接，**以便** 确认 Token 有效、仓库可访问。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | GitHub Token 有效，仓库存在 | 返回 true |
| 2 | GitHub Token 无效或仓库不存在 | 返回 false |
| 3 | 语雀 Token 有效 | 返回 true |
| 4 | 数据源 ID 不存在 | 返回 false |

**API**: `POST /api/report-agent/my/sources/{id}/test`

**关键代码**: `PersonalSourceService.TestConnectionAsync()`, `IPersonalSourceConnector.TestConnectionAsync()`

---

### US-5.8 个人数据源同步与统计

**作为** 团队成员，**我希望** 手动同步数据源并预览本周统计数据，**以便** 在生成周报前确认数据完整性。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 同步 GitHub 数据源（仓库模式） | 查询指定仓库指定日期范围的 commits，返回 SourceStats |
| 2 | 同步 GitHub 数据源（用户模式，无仓库 URL） | 查询用户事件 API |
| 3 | 同步语雀数据源 | 枚举用户知识库 → 获取文档列表 → 按日期过滤 |
| 4 | 同步成功 | 更新 `LastSyncAt` 和 `LastSyncStatus = "success"` |
| 5 | 同步失败 | 更新 `LastSyncStatus = "failed"` + `LastSyncError` |
| 6 | 预览本周统计 | 聚合所有启用数据源的统计结果 |

**API**:
- `POST /api/report-agent/my/sources/{id}/sync`
- `GET /api/report-agent/my/stats?weekYear=2026&weekNumber=10`

**关键代码**: `PersonalGitHubConnector`, `PersonalYuqueConnector`, `PersonalSourceService.CollectAllAsync()`

---

### US-5.9 V2.0 团队级周报生成

**作为** 团队负责人，**我希望** 一键为全团队生成本周周报，**以便** 每个成员都能收到基于真实数据的周报草稿。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 团队已绑定采集工作流 | 触发工作流执行 → 等待完成 → 解析 Artifacts → 按成员拆分 → AI 生成 |
| 2 | 工作流执行超时 (>5min) | 使用已有数据继续生成（部分数据模式） |
| 3 | 工作流执行失败 | 日志记录错误，使用空数据继续 |
| 4 | 团队未绑定工作流 | 跳过工作流步骤，仅使用个人数据源 + MAP 活动数据 |
| 5 | 生成的周报包含 StatsSnapshot | 提交时快照统计数据，供后续追溯 |
| 6 | 生成的周报关联 WorkflowExecutionId | 可追溯到原始采集数据 |

**关键代码**: `ReportGenerationService.GenerateForTeamV2Async()`

---

### US-5.10 V2.0 个人周报生成（融合数据）

**作为** 团队成员，**我希望** 我的周报能融合团队采集数据、个人数据源数据和 MAP 平台活动，**以便** 得到最完整的一周产出总结。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | 成员有团队工作流数据 + 个人 GitHub 数据 + MAP 活动 | 三种数据合并后输入 AI 生成 |
| 2 | AI Prompt 包含模板结构 | 按模板段落生成对应内容 |
| 3 | 模板查找优先级 | 岗位匹配模板 → 团队默认模板 → 系统默认模板 |
| 4 | 生成结果为 Draft 状态 | 等待用户确认后提交 |
| 5 | 已存在 Draft 状态的同周周报 | 覆盖更新而非新建 |

**关键代码**: `ReportGenerationService.GenerateForMemberV2Async()`, `FindTemplateAsync()`, `BuildUserPromptV2()`

---

### US-5.11 周报查看状态

**作为** 团队负责人，**我希望** 系统能标记我已查看成员的周报，**以便** 成员知道负责人已阅。

**验收标准 (AC)**:

| # | 条件 | 预期结果 |
|---|------|----------|
| 1 | `WeeklyReportStatus.Viewed` 常量存在 | 值为 `"viewed"` |
| 2 | 该状态在 `WeeklyReportStatus.All` 列表中 | 可用于状态过滤 |

**关键代码**: `WeeklyReportStatus.Viewed`

---

## 三、数据模型变更摘要

| 模型 | 变更类型 | 新增字段 |
|------|----------|----------|
| `ReportTeam` | 扩展 | `DataCollectionWorkflowId`, `WorkflowTemplateKey` |
| `ReportTeamMember` | 扩展 | `IdentityMappings` (Dict) |
| `WeeklyReport` | 扩展 | `WorkflowExecutionId`, `StatsSnapshot`, `Viewed` 状态 |
| `PersonalSource` | **新建** | 完整模型 (Id, UserId, SourceType, Config, EncryptedToken, ...) |
| `TeamCollectedStats` | **新建** | 团队采集统计聚合 |
| `MemberCollectedStats` | **新建** | 成员级统计 + `ToSnapshot()` |
| `SourceStats` / `StatsDetail` | **新建** | 单平台统计 + 明细条目 |

---

## 四、新增 MongoDB 集合

| 集合名 | 说明 | 索引 |
|--------|------|------|
| `report_personal_sources` | 个人数据源绑定 | `(UserId, SourceType)` 复合索引 |

---

## 五、新增 API 端点汇总

| # | 端点 | 方法 | 故事 |
|---|------|------|------|
| 1 | `/api/report-agent/teams/{id}/members/{userId}/identity-mappings` | PUT | US-5.1 |
| 2 | `/api/report-agent/teams/{id}/workflow` | GET | US-5.2 |
| 3 | `/api/report-agent/teams/{id}/workflow/run` | POST | US-5.3 |
| 4 | `/api/report-agent/my/sources` | GET | US-5.6 |
| 5 | `/api/report-agent/my/sources` | POST | US-5.6 |
| 6 | `/api/report-agent/my/sources/{id}` | PUT | US-5.6 |
| 7 | `/api/report-agent/my/sources/{id}` | DELETE | US-5.6 |
| 8 | `/api/report-agent/my/sources/{id}/test` | POST | US-5.7 |
| 9 | `/api/report-agent/my/sources/{id}/sync` | POST | US-5.8 |
| 10 | `/api/report-agent/my/stats` | GET | US-5.8 |

---

## 六、单元测试覆盖

| 测试方法 | 覆盖故事 |
|----------|----------|
| `ReportTeam_NewFields_ShouldHaveDefaults` | US-5.2 |
| `ReportTeamMember_IdentityMappings_ShouldBeEmpty` | US-5.1 |
| `ReportTeamMember_IdentityMappings_ShouldStoreMultiplePlatforms` | US-5.1 |
| `WeeklyReport_NewFields_ShouldHaveDefaults` | US-5.9, US-5.11 |
| `WeeklyReportStatus_ShouldIncludeViewed` | US-5.11 |
| `PersonalSource_DefaultValues_ShouldBeCorrect` | US-5.6 |
| `PersonalSourceType_ShouldHaveAllTypes` | US-5.6 |
| `ParseArtifacts_SingleSource_ShouldExtractStats` | US-5.4 |
| `ParseArtifacts_MultipleSources_ShouldExtractAll` | US-5.4 |
| `ParseArtifacts_EmptyArtifacts_ShouldReturnEmptyStats` | US-5.4 |
| `ParseArtifacts_InvalidJson_ShouldReturnEmptyStats` | US-5.4 |
| `ParseArtifacts_NonJsonArtifact_ShouldSkip` | US-5.4 |
| `SplitByMember_ShouldAttributeDetailsCorrectly` | US-5.5 |
| `MemberCollectedStats_ToSnapshot_ShouldProduceCorrectDict` | US-5.9 |

共 **14 个单元测试**，覆盖全部核心逻辑。

---

## 七、关联文档

| 文档 | 关系 |
|------|------|
| `doc/spec.report-agent.v2.md` | PRD v2.0 (产品需求) |
| `doc/plan.report-agent-impl.md` | 实施进度追踪 |
| `doc/spec.report-agent.md` | PRD v1.0 (存档，已删除) |
