# 周报 Agent (Report Agent) v2.0 - 产品需求文档

> **版本**: v2.0 | **创建日期**: 2026-03-05 | **appKey**: `report-agent`
>
> **一句话定位**: 复用工作流引擎采集数据，AI 一键生成周报。
>
> **与 v1.0 的关系**: v2.0 是对 v1.0 的方向重构。v1.0 偏"管理系统"（退回/评论/通知），v2.0 聚焦"产出统计"（代码 + 知识库 + 模板）。已实现的底层能力（团队模型、Git 连接器、AI 生成引擎）保留复用。
>
> **v2.0 关键架构决策**: 不再自建数据源连接器，而是复用工作流引擎(Workflow Engine)作为数据采集管道。每个团队绑定一个"采集工作流"，用已有的 TapdCollector、HttpRequest 等胶囊采集数据，产物(Artifact)直接喂给周报生成引擎。

---

## 一、核心理念

> **周报 = 产出统计卡片，不是管理流程工具。**

用户不想"写"周报，他们想要的是：
1. 系统帮我统计本周干了什么（代码提交、TAPD 任务、语雀文章）
2. 用一个模板把统计数据组织好
3. 我扫一眼确认，点提交，完事

### 设计原则

| 原则 | 说明 |
|------|------|
| **配置一次，永久生效** | 绑定采集工作流后，每周自动执行、自动生成 |
| **复用 > 新建** | 数据采集全部复用工作流引擎，不造新的连接器 |
| **统计驱动，非文字驱动** | 核心是数字（提交数、任务关闭数、文章发布数），不是大段文字 |
| **3 步完成** | 查看统计 → 补充备注 → 提交 |

---

## 二、用户角色

| 角色 | 核心动作 |
|------|----------|
| **个人** | 绑定个人 GitHub/语雀 → 每周查看自动统计 → 确认提交 |
| **团队负责人** | 配置团队采集工作流 → 查看成员产出概览 → 一键生成团队汇总 |
| **管理员** | 管理模板 → 管理团队 |

---

## 三、核心架构 — Workflow as Data Pipeline

### 3.1 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                    Report Agent (周报 Agent)                  │
│                                                              │
│  ┌──────────┐         ┌──────────────────┐                   │
│  │ Team     │ ──1:1─→ │ 采集工作流       │ (系统预置模板)      │
│  │ Config   │         │ (Workflow)       │                   │
│  │          │         │                  │                   │
│  │ teamId   │         │ ┌──────────────┐ │                   │
│  │ wfId ────┼────────→│ │TapdCollector │ │                   │
│  └──────────┘         │ │HttpRequest   │──→ DataMerger ──→ Artifact │
│                       │ │(GitHub API)  │ │        (JSON)     │
│       ┌──────────┐    │ │HttpRequest   │ │                   │
│       │ Personal │    │ │(语雀 API)    │ │                   │
│       │ Sources  │    │ └──────────────┘ │                   │
│       │ (Git/语雀)│    └────────┬─────────┘                   │
│       └────┬─────┘             │                             │
│            │                   │ FinalArtifacts               │
│            │                   ▼                             │
│            │         ┌──────────────────┐                   │
│            └────────→│ Report Generator │                   │
│                      │ (AI + Template)  │                   │
│                      │                  │                   │
│                      │ 1. 读取 Artifacts│                   │
│                      │ 2. 合并个人数据源 │                   │
│                      │ 3. 按成员拆分    │                   │
│                      │ 4. AI 归纳       │                   │
│                      │ 5. 填入模板      │                   │
│                      └──────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 为什么复用 Workflow 而不是自建连接器

| 对比维度 | 自建连接器 (v2.0 初版方案) | 复用工作流引擎 (当前方案) |
|----------|--------------------------|--------------------------|
| TAPD 采集 | 重新封装 TapdConnector | 直接用 TapdCollector 胶囊 |
| 语雀/GitHub | 每种写一个 Connector | HttpRequest 胶囊 + 模板配置 |
| 自定义 API | 写 CustomApiConnector | SmartHttp 胶囊（已有） |
| 数据合并 | 写聚合逻辑 | DataMerger 胶囊（已有） |
| 新增数据源 | 开发新 Connector 类 | 在工作流里加一个节点 |
| 执行监控 | 自建日志 | 工作流执行面板天然支持 |
| 灵活性 | 固定逻辑 | 用户可自定义采集流程 |

**结论**: 工作流引擎已经是一个成熟的数据采集框架，周报 Agent 应该做的是**消费**数据，而不是**采集**数据。

### 3.3 衔接机制 — Artifact 管道

**核心问题：工作流产出的 Artifact 如何传递给 Report Agent？**

采用**方案 A — 内部 Service 直接调用**：

```csharp
// ReportGenerationService 直接调用 WorkflowRunWorker 触发执行
public class ReportGenerationService
{
    private readonly WorkflowRunWorker _workflowRunner;
    private readonly MongoDbContext _db;

    public async Task<WeeklyReport> GenerateForTeamAsync(string teamId, int weekYear, int weekNumber)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == teamId).FirstAsync();

        // Step 1: 触发团队的采集工作流
        var execution = await _workflowRunner.ExecuteInternalAsync(
            workflowId: team.DataCollectionWorkflowId,
            variables: new Dictionary<string, string>
            {
                ["weekYear"] = weekYear.ToString(),
                ["weekNumber"] = weekNumber.ToString(),
                ["dateFrom"] = GetWeekStart(weekYear, weekNumber).ToString("yyyy-MM-dd"),
                ["dateTo"] = GetWeekEnd(weekYear, weekNumber).ToString("yyyy-MM-dd"),
            },
            triggeredBy: "report-agent-system"
        );

        // Step 2: 等待执行完成（内部调用，同步等待）
        await _workflowRunner.WaitForCompletionAsync(execution.Id, timeout: TimeSpan.FromMinutes(5));

        // Step 3: 读取 FinalArtifacts
        var completedExecution = await _db.WorkflowExecutions
            .Find(e => e.Id == execution.Id).FirstAsync();

        var artifacts = completedExecution.FinalArtifacts;

        // Step 4: 解析 Artifact → 统计数据
        var teamStats = ParseArtifactsToStats(artifacts);

        // Step 5: 合并个人数据源（GitHub/语雀）
        var personalStats = await CollectPersonalSourcesAsync(teamId, weekYear, weekNumber);

        // Step 6: 按成员拆分 + AI 生成
        return await GenerateReportsAsync(team, teamStats, personalStats);
    }
}
```

**为什么选方案 A：**
- 采集工作流是 Report Agent **拥有**的，不是用户随意创建的
- 内部调用 = 事务可控，不需要跨服务通信
- 失败重试逻辑简单（工作流引擎已有重试机制）

### 3.4 多团队隔离设计

**数据隔离模型：**

```
Team A (前端组)                    Team B (后端组)
    │                                  │
    ▼                                  ▼
Workflow Instance A               Workflow Instance B
(TAPD workspace: 111)             (TAPD workspace: 222)
(GitHub: org/frontend)            (GitHub: org/backend)
    │                                  │
    ▼                                  ▼
Execution A-W10                   Execution B-W10
(executionId: aaa)                (executionId: bbb)
    │                                  │
    ▼                                  ▼
Artifacts A                       Artifacts B
(独立，无交叉)                     (独立，无交叉)
```

**隔离保障点：**

| 隔离层 | 机制 |
|--------|------|
| 工作流实例 | 每个团队有自己的 Workflow 实例（从系统模板 clone），变量独立 |
| 执行隔离 | 每次执行产生独立 `ExecutionId`，Artifacts 天然按 execution 隔离 |
| 成员归属 | TAPD/Git 返回全量数据后，按 `report_team_members` 的用户映射过滤 |
| 时间窗口 | 工作流变量传入 `dateFrom`/`dateTo`，确保只采集目标周的数据 |

**成员归属的关键设计：**

```
report_team_members 扩展字段:
  userId: "user-001"
  displayName: "张三"
  identityMappings:
    github: "zhangsan"          # GitHub username
    tapd: "zhangsan@company.com" # TAPD 账号
    yuque: "zhangsan"           # 语雀 login
    gitlab: "zhangsan"          # GitLab username
```

即使两个团队共享同一个 TAPD 工作空间（如跨组协作项目），Report Agent 按成员映射拆分后，每个团队只看到自己成员的数据。

### 3.5 边界情况处理

| 场景 | 处理 |
|------|------|
| 团队未绑定采集工作流 | 跳过自动采集，仅使用个人数据源 + 手动打点 |
| 工作流执行失败 | 标记 `statsStatus: "partial"`，用已有数据生成 + 在周报顶部显示警告 |
| 工作流超时 (>5min) | 取消执行，使用缓存的上次成功结果 + 警告 |
| 成员无映射 | 该成员的 auto-stats 板块显示"(未配置数据源映射)" |
| 某数据源 Artifact 为空 | 对应板块显示"(本周暂无数据)"，不影响其他板块 |
| 一人属于多个团队 | 各团队独立生成，同一用户可以有多份不同团队的周报 |

---

## 四、数据源配置

### 4.1 团队级 — 采集工作流

> 团队创建时，系统自动从**预置模板**克隆一个采集工作流。负责人可以在工作流编辑器里调整节点。

#### 4.1.1 系统预置工作流模板

**研发团队采集模板** (默认):

```
[定时触发器] ──→ [TapdCollector] ──→ [HttpRequest: GitHub] ──→ [DataMerger] ──→ [输出]
   (每周五)       (需求/Bug/任务)      (commits/PRs)           (合并 JSON)
```

**产品团队采集模板**:

```
[定时触发器] ──→ [HttpRequest: 语雀] ──→ [TapdCollector] ──→ [DataMerger] ──→ [输出]
   (每周五)       (文章/文档统计)          (需求推进状态)     (合并 JSON)
```

**极简模板** (仅 Git):

```
[定时触发器] ──→ [HttpRequest: GitHub] ──→ [输出]
   (每周五)       (commits/PRs)
```

#### 4.1.2 团队工作流配置 UI

团队设置页面新增"数据采集"标签页：

```
+---------------------------------------------------------+
|  数据采集工作流                    [打开工作流编辑器]      |
+---------------------------------------------------------+
|                                                         |
|  当前模板: 研发团队采集模板                                |
|  上次执行: 2026-W09 周五 18:00 (成功, 耗时 32s)          |
|                                                         |
|  数据源节点:                                              |
|  [v] TAPD       工作空间: 12345678    (已连接)            |
|  [v] GitHub     org/frontend          (已连接)            |
|  [ ] 语雀       (未配置)                                  |
|                                                         |
|  [测试运行]  [立即执行]                                    |
+---------------------------------------------------------+
```

负责人可以：
1. 点击"打开工作流编辑器"进入完整的工作流画布，添加/删除节点
2. 在简化面板里直接配置每个数据源节点的参数（TAPD workspace、GitHub repo 等）
3. "测试运行"执行一次采集，预览结果

#### 4.1.3 工作流变量约定

Report Agent 触发采集工作流时，注入以下标准变量：

| 变量名 | 示例值 | 说明 |
|--------|--------|------|
| `weekYear` | `2026` | ISO 周年 |
| `weekNumber` | `10` | ISO 周数 |
| `dateFrom` | `2026-03-02` | 周一 |
| `dateTo` | `2026-03-06` | 周五 |
| `teamId` | `team-001` | 团队 ID |

工作流节点通过 `{{dateFrom}}` / `{{dateTo}}` 引用这些变量来限定采集范围。

#### 4.1.4 Artifact 输出规范

采集工作流的 FinalArtifact 必须遵循以下 JSON Schema：

```json
{
  "source": "tapd",
  "collectedAt": "2026-03-06T18:00:00Z",
  "dateRange": { "from": "2026-03-02", "to": "2026-03-06" },
  "summary": {
    "stories_done": 3,
    "bugs_fixed": 5,
    "tasks_closed": 8
  },
  "details": [
    {
      "id": "1012345",
      "title": "优化首页加载速度",
      "type": "story",
      "status": "done",
      "assignee": "zhangsan@company.com",
      "closedAt": "2026-03-04T10:30:00Z"
    }
  ]
}
```

多个数据源通过 DataMerger 合并后，FinalArtifact 为数组：

```json
[
  { "source": "tapd", "summary": { ... }, "details": [ ... ] },
  { "source": "github", "summary": { ... }, "details": [ ... ] }
]
```

Report Agent 解析 Artifact 时，按 `source` 字段分类，按 `details[].assignee` 归属成员。

### 4.2 个人级 — 轻量数据源

> 个人级数据源不走工作流，保持轻量。适用于个人 GitHub/语雀/GitLab 绑定。

#### 4.2.1 为什么个人级不用工作流

| 考量 | 说明 |
|------|------|
| 粒度太细 | 每个用户一个工作流实例 → 100 用户 = 100 个工作流 |
| 配置太重 | 个人只需要填 Token，不需要画工作流 |
| 采集逻辑简单 | 个人 GitHub/语雀只需一个 API 调用 |

个人数据源保留轻量的 Connector 模式：

```
IPersonalSourceConnector (接口)
├── PersonalGitHubConnector   (API: /users/{username}/events)
├── PersonalGitLabConnector   (API: /users/{id}/events)
└── PersonalYuqueConnector    (API: /api/v2/users/{login}/repos)
```

#### 4.2.2 个人数据源绑定

```
+---------------------------------------------------------+
|  我的数据源                                    [+ 添加]  |
+---------------------------------------------------------+
|                                                         |
|  [GitHub]  github.com/zhangsan                          |
|  Token: ghp_****xxxx    状态: 已连接    上次同步: 3h前    |
|  本周: 23 commits | 3 PRs merged | 1 issue closed       |
|                                                         |
|  [语雀]  yuque.com/zhangsan                              |
|  Token: ****xxxx        状态: 已连接    上次同步: 1h前    |
|  本周: 2 篇文章发布 | 5 次文档更新                        |
|                                                         |
|  [手动打点]                                              |
|  本周: 3 条记录                                          |
|                                                         |
+---------------------------------------------------------+
```

数据模型 (`report_personal_sources`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `Id` | string | 主键 |
| `UserId` | string | 用户 ID |
| `SourceType` | string | github / gitlab / yuque |
| `DisplayName` | string | 显示名称 |
| `Config` | object | 类型相关配置 (RepoUrl/Username/SpaceId) |
| `EncryptedToken` | string | 加密存储的认证凭据 |
| `Enabled` | bool | 是否启用 |
| `LastSyncAt` | DateTime? | 上次同步时间 |
| `LastSyncStatus` | string | success / failed / never |
| `CreatedAt` | DateTime | 创建时间 |

### 4.3 数据合并策略

当团队采集工作流和个人数据源都有 GitHub 数据时：

```
团队工作流 Artifact (org/frontend 全量 commits)
    + 个人数据源 (zhangsan 的个人 side-project commits)
    ──→ 去重 (按 commit SHA)
    ──→ 合并为该成员的完整统计
```

**优先级规则：**
1. 团队工作流的数据是**基础数据**（覆盖工作仓库）
2. 个人数据源是**补充数据**（覆盖个人仓库/外部知识库）
3. 手动打点是**人工补充**（不在任何系统中的工作）
4. 相同来源 + 相同 ID 的记录自动去重

---

## 五、模板系统

> **极简模板**: 默认模板开箱即用，大多数团队不需要自定义。

### 5.1 默认模板（系统预置）

```
+-------------------------------------------+
|  周报  2026-W10 (03-02 ~ 03-06)           |
+-------------------------------------------+
|                                           |
|  -- 代码产出 ---- [自动]                   |
|  Commits: 23  |  PR Merged: 3             |
|  +1,204 / -356 行                         |
|  主要仓库: prd-agent (18), prd-admin (5)   |
|                                           |
|  -- 任务产出 ---- [自动]                   |
|  TAPD 需求完成: 3  |  Bug 修复: 5          |
|  任务关闭: 8                               |
|                                           |
|  -- 知识产出 ---- [自动]                   |
|  语雀文章: 2 篇  |  文档更新: 5 次          |
|                                           |
|  -- 日常工作 ---- [手动+AI]                |
|  * 参加 PRD 评审会 x2                      |
|  * 与设计师对接首页改版方案                  |
|  * 新人 onboarding 指导                    |
|                                           |
|  -- 下周计划 ---- [手动]                   |
|  * 完成邮件渠道适配器                       |
|  * 周三前提交技术方案                       |
|                                           |
|  -- 备注 ---- [选填]                       |
|  (无)                                      |
|                                           |
+-------------------------------------------+
```

### 5.2 模板板块类型

| 板块类型 | 数据来源 | 用户操作 |
|----------|----------|----------|
| `auto-stats` | 工作流 Artifact + 个人数据源的统计数字 | 只读展示，可展开看明细 |
| `auto-list` | AI 基于采集数据生成的条目 | 可编辑、删除、补充 |
| `manual-list` | 用户手动填写 | 必须手动输入 |
| `free-text` | 自由文本 | 手动输入 |

### 5.3 模板定义

一个模板由有序的板块列表构成：

| 字段 | 类型 | 说明 |
|------|------|------|
| `Title` | string | 板块标题 |
| `Type` | enum | auto-stats / auto-list / manual-list / free-text |
| `DataSources` | string[] | 关联的数据源类型 (如 ["github", "gitlab"]) |
| `IsRequired` | bool | 是否必填 |
| `MaxItems` | int? | 最大条目数 |

**系统预置模板**:

| 模板名 | 适用角色 | 板块 |
|--------|----------|------|
| 研发通用 | 开发工程师 | 代码产出(auto-stats) + 任务产出(auto-stats) + 日常工作(auto-list) + 下周计划(manual-list) |
| 产品通用 | 产品经理 | 需求推进(auto-stats) + 文档产出(auto-stats) + 日常工作(auto-list) + 下周计划(manual-list) |
| 极简模式 | 任意 | 本周产出(auto-stats 合并展示) + 备注(free-text) |

---

## 六、周报生成流程

> 3 步完成，不是写周报，是确认周报。

```
Step 1: 系统自动采集     Step 2: AI 整理 + 用户补充     Step 3: 确认提交
  [采集工作流执行]              [本周完成]                    [提交]
  [个人数据源同步]        -->   * 完成用户登录模块       -->   Done!
  [手动打点汇总]                * 修复分页 Bug
                               * ...
                               [下周计划]
                               * (请补充)
```

### 6.1 自动采集时机

| 时机 | 触发者 | 说明 |
|------|--------|------|
| 团队采集工作流定时执行 | 工作流定时触发器 (每周五) | 团队级数据采集 |
| 个人数据源定时同步 | Report Agent 定时任务 | 每小时同步，保持数据新鲜 |
| 周五自动生成 | Report Agent 定时任务 | 采集完成 → AI 生成草稿 → 通知用户 |
| 手动触发 | 用户 | 点"刷新数据"→ 重新执行工作流 + 同步个人源 |

### 6.2 生成时序图

```
                  周五 17:00
                      │
                      ▼
          ┌───────────────────────┐
          │ 1. 触发团队采集工作流  │
          │    (传入 weekYear,     │
          │     weekNumber 变量)   │
          └───────────┬───────────┘
                      │ 等待完成 (max 5min)
                      ▼
          ┌───────────────────────┐
          │ 2. 读取 FinalArtifacts │
          │    解析 JSON 统计数据   │
          └───────────┬───────────┘
                      │
                      ▼
          ┌───────────────────────┐
          │ 3. 采集个人数据源      │
          │    (GitHub/语雀/GitLab) │
          └───────────┬───────────┘
                      │
                      ▼
          ┌───────────────────────┐
          │ 4. 合并 + 按成员拆分   │
          │    团队数据按 identity  │
          │    mapping 归属成员     │
          └───────────┬───────────┘
                      │
                      ▼
          ┌───────────────────────┐
          │ 5. 每个成员生成周报    │
          │    auto-stats → 填数字 │
          │    auto-list → AI 归纳 │
          │    manual → 留空       │
          └───────────┬───────────┘
                      │
                      ▼
          ┌───────────────────────┐
          │ 6. 保存为 Draft 状态   │
          │    发送通知给成员       │
          └───────────────────────┘
```

### 6.3 AI 生成策略

输入:
- 工作流 Artifacts (团队级采集数据)
- 个人数据源统计
- 手动打点记录
- 模板结构

输出:
- `auto-stats` 板块: 直接用统计数字填充，不需要 AI
- `auto-list` 板块: AI 将零散的 commit message / TAPD 任务归纳为有意义的工作项
- `manual-list` 板块: 留空等用户填写

AI Prompt 核心规则:
1. 将多个 commit 归纳为一个功能描述（"完成用户登录模块"而非列出 15 个 commit）
2. 突出成果，不是过程
3. 每条不超过 30 字
4. 无数据的板块标注"(暂无数据)"

---

## 七、周报状态（极简）

```
Draft  --->  Submitted  --->  Viewed
 (草稿)       (已提交)        (已查看)
```

| 状态 | 说明 |
|------|------|
| `Draft` | 自动生成或手动创建的草稿 |
| `Submitted` | 用户确认提交 |
| `Viewed` | 负责人已查看（自动标记） |

没有退回、没有评论、没有逾期。周报的本质是**信息同步**，不是**审批流程**。

---

## 八、团队视图

团队负责人看到的是**产出统计仪表盘**，不是审批列表：

```
+-----------------------------------------------------------+
|  前端组  2026-W10                          [生成团队汇总]   |
+-----------------------------------------------------------+
|                                                           |
|  团队统计                                                  |
|  总 Commits: 87  |  PR Merged: 12  |  Bug Fixed: 18       |
|  TAPD 任务完成: 23  |  文章发布: 5                          |
|                                                           |
|  成员产出                                                  |
|  +---------+----------+--------+--------+--------+        |
|  | 成员    | Commits  | PR     | Bug    | 状态   |        |
|  +---------+----------+--------+--------+--------+        |
|  | 张三    | 23       | 3      | 5      | 已提交 |        |
|  | 李四    | 18       | 4      | 3      | 已提交 |        |
|  | 王五    | 31       | 3      | 7      | 草稿   |        |
|  | 赵六    | 15       | 2      | 3      | 已提交 |        |
|  +---------+----------+--------+--------+--------+        |
|                                                           |
|  采集工作流状态: 上次执行 W10 周五 (成功, 32s)              |
|                                                           |
+-----------------------------------------------------------+
```

---

## 九、手动打点（保留）

每日快速记录非系统化工作，与 v1.0 相同但更极简：

```
+-----------------------------------------+
|  今日打点  03-05 (周三)        [保存]    |
+-----------------------------------------+
|  + 参加 PRD 评审会 (2h)      [会议]     |
|  + 指导新人环境搭建           [协作]     |
|  + _________________________  [    ]     |
+-----------------------------------------+
```

---

## 十、配置流程（用户旅程）

### 10.1 首次使用（管理员/团队负责人）

```
1. 创建团队 → 添加成员
2. 系统自动分配"研发团队采集模板"工作流
3. 配置工作流参数：
   - TAPD 工作空间 ID + Cookie/Token
   - GitHub 组织/仓库地址 + Token
4. 配置成员身份映射：
   - 张三: github=zhangsan, tapd=zhangsan@company.com
   - 李四: github=lisi, tapd=lisi@company.com
5. 点击"测试运行" → 预览采集结果
6. 完成! 每周五系统自动采集 + 生成
```

### 10.2 首次使用（个人）

```
1. 进入"周报" → 看到引导: "绑定你的数据源，让系统自动帮你写周报"
2. 点击"绑定 GitHub" → 输入仓库地址 + Token → 测试连接 → 成功
3. (可选) 绑定语雀 → 输入空间地址 + Token
4. 完成! 下周五系统会自动生成你的周报草稿
```

### 10.3 每周使用（个人）

```
1. 周五收到通知: "你的周报草稿已生成"
2. 打开周报 → 看到自动统计的数据 + AI 整理的工作项
3. (可选) 补充"下周计划"
4. 点击"提交" → 完成
```

---

## 十一、数据模型变更

### 11.1 新增集合

| 集合名 | 说明 |
|--------|------|
| `report_personal_sources` | 个人数据源绑定 (GitHub/语雀等) |

### 11.2 模型变更

**ReportTeam** 新增字段:
- `DataCollectionWorkflowId` (string?) — 绑定的采集工作流 ID
- `WorkflowTemplateKey` (string) — 使用的预置模板 key (默认 "dev-team")

**ReportTeamMember** 新增字段:
- `IdentityMappings` (Dictionary<string, string>) — 多平台身份映射
  - key: 平台名 (github/tapd/yuque/gitlab)
  - value: 该平台上的用户标识

**WeeklyReport** 变更:
- 简化状态: 去掉 `Returned`, `Overdue`, `Vacation`；保留 `NotStarted`, `Draft`, `Submitted`；新增 `Viewed`
- 新增 `StatsSnapshot` (BsonDocument) — 提交时快照统计数据
- 新增 `WorkflowExecutionId` (string?) — 关联的采集工作流执行 ID

### 11.3 复用集合（无变更）

| 集合名 | 说明 |
|--------|------|
| `report_teams` | 团队 (扩展字段) |
| `report_team_members` | 团队成员 (扩展字段) |
| `report_templates` | 模板 |
| `report_weekly_reports` | 周报 |
| `report_daily_logs` | 每日打点 |
| `report_data_sources` | 团队数据源 (v1.0 兼容保留) |
| `report_commits` | 代码提交记录 |
| `workflows` | 工作流定义 (已有) |
| `workflow_executions` | 工作流执行记录 (已有) |

---

## 十二、API 设计

### 12.1 个人数据源

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/report-agent/my/sources` | GET | 我的数据源列表 |
| `/api/report-agent/my/sources` | POST | 绑定数据源 |
| `/api/report-agent/my/sources/{id}` | PUT | 更新配置 |
| `/api/report-agent/my/sources/{id}` | DELETE | 解绑 |
| `/api/report-agent/my/sources/{id}/test` | POST | 测试连接 |
| `/api/report-agent/my/sources/{id}/sync` | POST | 手动同步 |
| `/api/report-agent/my/stats` | GET | 我的本周统计预览 (?weekYear=&weekNumber=) |

### 12.2 团队采集工作流

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/report-agent/teams/{teamId}/workflow` | GET | 获取团队采集工作流详情 |
| `/api/report-agent/teams/{teamId}/workflow/init` | POST | 从模板初始化采集工作流 |
| `/api/report-agent/teams/{teamId}/workflow/test-run` | POST | 测试执行 |
| `/api/report-agent/teams/{teamId}/workflow/run` | POST | 手动触发采集 |
| `/api/report-agent/teams/{teamId}/workflow/status` | GET | 最近一次执行状态 |

### 12.3 成员身份映射

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/report-agent/teams/{teamId}/members/{memberId}/identity-mappings` | PUT | 更新身份映射 |

### 12.4 简化的周报操作

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/report-agent/reports` | GET | 我的周报列表 |
| `/api/report-agent/reports/current` | GET | 当前周周报 |
| `/api/report-agent/reports/generate` | POST | 生成/刷新当前周周报 |
| `/api/report-agent/reports/{id}` | GET | 周报详情 |
| `/api/report-agent/reports/{id}` | PUT | 编辑周报 |
| `/api/report-agent/reports/{id}/submit` | POST | 提交 |

### 12.5 团队 (保留现有)

现有团队 CRUD、团队汇总 API 保持不变。

---

## 十三、实施计划

### Phase 5: Workflow 管道 + 个人数据源 (v2.0 第一步)

| 功能点 | 说明 | 复用/新建 |
|--------|------|-----------|
| 系统预置工作流模板 | 3 个采集模板 (研发/产品/极简) | 新建 (workflow 数据) |
| 团队 → 工作流绑定 | ReportTeam.DataCollectionWorkflowId | 改造 |
| WorkflowRunWorker.ExecuteInternalAsync | 内部触发工作流执行的方法 | 新建 |
| Artifact → Stats 解析器 | 解析 FinalArtifacts 为统计数据 | 新建 |
| 成员身份映射 | IdentityMappings 字段 + API | 新建 |
| 个人数据源模型 | `report_personal_sources` 集合 | 新建 |
| 个人数据源 API | 7 个端点 (CRUD + test + sync + stats) | 新建 |
| PersonalGitHubConnector | 个人 GitHub 统计 | 新建 |
| PersonalYuqueConnector | 个人语雀统计 | 新建 |

### Phase 6: 模板 + 生成引擎适配

| 功能点 | 说明 | 复用/新建 |
|--------|------|-----------|
| 系统预置模板 | 3 个默认模板 | 新建 |
| auto-stats 板块渲染 | 统计数字卡片式展示 | 新建 |
| AI 生成引擎适配 | 适配 Artifact 输入格式 | 改造 |
| StatsSnapshot | 提交时快照统计 | 新建 |
| 状态机简化 | 去掉 Returned/Overdue，加 Viewed | 改造 |

### Phase 7: UI + 团队仪表盘

| 功能点 | 说明 | 复用/新建 |
|--------|------|-----------|
| 个人数据源 UI | "我的数据源"面板 | 新建 |
| 团队工作流配置 UI | 简化配置面板 + 跳转工作流编辑器 | 新建 |
| 成员身份映射 UI | 成员设置里的映射配置 | 新建 |
| 团队产出统计面板 | 成员统计表格 + 团队汇总数字 | 改造 |

---

## 十四、与 v1.0 的兼容处理

| v1.0 功能 | v2.0 处理 |
|-----------|-----------|
| 团队模型 (Team/TeamMember) | 保留，扩展字段 |
| 团队数据源 (report_data_sources) | 保留兼容，新团队用 Workflow 模式 |
| Git 连接器 (GitHub/SVN) | 保留 (个人数据源仍用) |
| 每日打点 (DailyLog) | 保留 |
| AI 生成引擎 | 保留核心，适配新输入格式 |
| 退回/评论/通知 | 降级为可选功能，默认关闭 |
| 趋势图表 | 保留 |
| Markdown 导出 | 保留 |
| 假期标记 | 移除 |
| 7 种通知事件 | 简化为 2 种 (草稿生成 + 提交通知) |

---

## 附录: 关联文档

| 文档 | 关系 |
|------|------|
| `doc/spec.report-agent.md` | PRD v1.0 (存档，已删除) |
| `doc/plan.report-agent-impl.md` | Phase 1-4 实施记录 |
| `CLAUDE.md` | 功能注册表 |
