# 周报 Agent (Report Agent) v2.0 - 产品需求文档

> **版本**: v2.0 | **创建日期**: 2026-03-05 | **appKey**: `report-agent`
>
> **一句话定位**: 绑定 GitHub + 知识库源，系统自动统计产出数据，AI 一键生成周报。
>
> **与 v1.0 的关系**: v2.0 是对 v1.0 的方向重构。v1.0 偏"管理系统"（退回/评论/通知），v2.0 聚焦"产出统计"（代码 + 知识库 + 模板）。已实现的底层能力（团队模型、Git 连接器、AI 生成引擎）保留复用。

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
| **配置一次，永久生效** | 绑定 GitHub 地址、TAPD 项目、语雀空间后，每周自动采集 |
| **统计驱动，非文字驱动** | 核心是数字（提交数、任务关闭数、文章发布数），不是大段文字 |
| **3 步完成** | 查看统计 → 补充备注 → 提交 |
| **模板极简** | 默认模板开箱即用，不需要先"创建模板" |

---

## 二、用户角色

| 角色 | 核心动作 |
|------|----------|
| **个人** | 绑定自己的 GitHub/知识库账号 → 每周查看自动统计 → 确认提交 |
| **团队负责人** | 配置团队级数据源 → 查看团队成员产出概览 → 一键生成团队汇总 |
| **管理员** | 管理模板 → 管理团队 |

---

## 三、核心功能

### 3.1 数据源配置（一次性设置）

> 这是产品的**必须性** — 没有数据源，周报就是空壳。

#### 3.1.1 支持的数据源类型

| 数据源 | 绑定级别 | 采集内容 | 认证方式 |
|--------|----------|----------|----------|
| **GitHub** | 个人/团队 | commits、PR、issues | Personal Access Token |
| **GitLab** | 个人/团队 | commits、MR、issues | Private Token |
| **TAPD** | 团队 | 需求状态变更、Bug 关闭数、任务完成数 | Cookie / Basic Auth（复用 Workflow 的 TapdCollector） |
| **语雀** | 个人 | 文章发布数、文档更新数 | Token |
| **SVN** | 团队 | commits | 用户名+密码 |
| **自定义 API** | 团队 | 任意 JSON 统计数据 | 自定义 Header/Token |
| **手动打点** | 个人 | 会议/沟通/调研等非系统化工作 | 无 |

#### 3.1.2 个人数据源绑定

> **关键设计**: 每个人可以绑定自己的 GitHub/GitLab/语雀账号，系统按个人维度采集。

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
| `SourceType` | string | github / gitlab / yuque / custom |
| `DisplayName` | string | 显示名称 (如 "我的 GitHub") |
| `Config` | object | 类型相关配置 |
| `Config.RepoUrl` | string? | 仓库地址 (Git 类) |
| `Config.Username` | string? | 用户名 (用于 commit 匹配) |
| `Config.SpaceId` | string? | 空间 ID (语雀) |
| `Config.ApiEndpoint` | string? | API 地址 (自定义) |
| `EncryptedToken` | string | 加密存储的认证凭据 |
| `Enabled` | bool | 是否启用 |
| `LastSyncAt` | DateTime? | 上次同步时间 |
| `LastSyncStatus` | string | success / failed / never |
| `CreatedAt` | DateTime | 创建时间 |

#### 3.1.3 团队数据源绑定

> 与 v1.0 的 `report_data_sources` 相同，但增加 TAPD 和自定义 API 类型。

团队级数据源用于：
- 共享仓库（monorepo 场景，一个仓库多人提交）
- TAPD 项目（按团队绑定工作空间）
- 自定义统计 API（公司内部系统对接）

#### 3.1.4 数据源连接器架构

```
IDataSourceConnector (接口)
├── GitHubConnector      (已有)
├── GitLabConnector      (新增，类似 GitHub)
├── SvnConnector         (已有)
├── TapdConnector        (新增，复用 CapsuleExecutor.ExecuteTapdCollectorAsync 逻辑)
├── YuqueConnector       (新增)
└── CustomApiConnector   (新增，通用 HTTP JSON 采集)
```

每个连接器实现两个核心方法：
```csharp
public interface IDataSourceConnector
{
    Task<bool> TestConnectionAsync(CancellationToken ct);
    Task<DataSourceStats> CollectStatsAsync(DateRange range, CancellationToken ct);
}
```

`DataSourceStats` 是统一的统计结果：
```csharp
public class DataSourceStats
{
    public string SourceType { get; set; }
    public Dictionary<string, int> Counters { get; set; }     // 如 { "commits": 23, "prs_merged": 3 }
    public List<StatDetail> Details { get; set; }              // 明细列表（可选展开）
}
```

---

### 3.2 模板系统

> **极简模板**: 默认模板开箱即用，大多数团队不需要自定义。

#### 3.2.1 默认模板（系统预置）

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

#### 3.2.2 模板板块类型

| 板块类型 | 数据来源 | 用户操作 |
|----------|----------|----------|
| `auto-stats` | 数据源自动采集的统计数字 | 只读展示，可展开看明细 |
| `auto-list` | AI 基于采集数据生成的条目 | 可编辑、删除、补充 |
| `manual-list` | 用户手动填写 | 必须手动输入 |
| `free-text` | 自由文本 | 手动输入 |

#### 3.2.3 模板定义

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

### 3.3 周报生成流程

> 3 步完成，不是写周报，是确认周报。

```
Step 1: 系统自动采集     Step 2: AI 整理 + 用户补充     Step 3: 确认提交
  [GitHub 23 commits]         [本周完成]                    [提交]
  [TAPD 8 tasks]        -->   * 完成用户登录模块       -->   Done!
  [语雀 2 articles]           * 修复分页 Bug
  [手动打点 3 items]           * ...
                              [下周计划]
                              * (请补充)
```

#### 3.3.1 自动采集时机

| 时机 | 说明 |
|------|------|
| 数据源同步定时任务 | 每小时同步一次（Git/TAPD/语雀），保持数据新鲜 |
| 周五自动生成 | 定时任务触发，采集本周数据 → AI 生成草稿 → 通知用户 |
| 手动触发 | 用户随时可点"刷新数据"重新采集 |

#### 3.3.2 AI 生成策略

输入:
- 本周所有数据源的统计数据 + 明细
- 本周手动打点记录
- 当前模板结构

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

### 3.4 周报状态（极简）

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

### 3.5 团队视图

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
+-----------------------------------------------------------+
```

---

### 3.6 手动打点（保留）

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

## 四、配置流程（用户旅程）

### 4.1 首次使用（管理员）

```
1. 创建团队 → 添加成员
2. (可选) 绑定团队级数据源 (TAPD 项目、共享仓库)
3. (可选) 选择团队模板 (或使用系统默认)
```

### 4.2 首次使用（个人）

```
1. 进入"周报" → 看到引导: "绑定你的数据源，让系统自动帮你写周报"
2. 点击"绑定 GitHub" → 输入仓库地址 + Token → 测试连接 → 成功
3. (可选) 绑定语雀 → 输入空间地址 + Token
4. 完成! 下周五系统会自动生成你的周报草稿
```

### 4.3 每周使用（个人）

```
1. 周五收到通知: "你的周报草稿已生成"
2. 打开周报 → 看到自动统计的数据 + AI 整理的工作项
3. (可选) 补充"下周计划"
4. 点击"提交" → 完成
```

---

## 五、数据模型变更

### 5.1 新增集合

| 集合名 | 说明 |
|--------|------|
| `report_personal_sources` | 个人数据源绑定 (GitHub/语雀等) |

### 5.2 复用集合（无变更）

| 集合名 | 说明 |
|--------|------|
| `report_teams` | 团队 |
| `report_team_members` | 团队成员 |
| `report_templates` | 模板 |
| `report_weekly_reports` | 周报 |
| `report_daily_logs` | 每日打点 |
| `report_data_sources` | 团队数据源 (扩展 TAPD/语雀/自定义) |
| `report_commits` | 代码提交记录 |

### 5.3 模型变更

**WeeklyReport** 简化状态:
- 去掉: `Returned`, `Overdue`, `Vacation`
- 保留: `NotStarted`, `Draft`, `Submitted`
- 新增: `Viewed` (负责人查看后自动标记)
- 新增: `StatsSnapshot` (object) — 提交时快照统计数据，不依赖实时查询

**ReportDataSource** 扩展:
- 新增 SourceType: `tapd`, `yuque`, `custom-api`
- 新增 `Config` (BsonDocument) — 类型相关的额外配置

---

## 六、API 设计

### 6.1 个人数据源

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/report-agent/my/sources` | GET | 我的数据源列表 |
| `/api/report-agent/my/sources` | POST | 绑定数据源 |
| `/api/report-agent/my/sources/{id}` | PUT | 更新配置 |
| `/api/report-agent/my/sources/{id}` | DELETE | 解绑 |
| `/api/report-agent/my/sources/{id}/test` | POST | 测试连接 |
| `/api/report-agent/my/sources/{id}/sync` | POST | 手动同步 |
| `/api/report-agent/my/stats` | GET | 我的本周统计预览 (?weekYear=&weekNumber=) |

### 6.2 简化的周报操作

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/report-agent/reports` | GET | 我的周报列表 |
| `/api/report-agent/reports/current` | GET | 当前周周报 (不存在则返回统计预览) |
| `/api/report-agent/reports/generate` | POST | 生成/刷新当前周周报 |
| `/api/report-agent/reports/{id}` | GET | 周报详情 |
| `/api/report-agent/reports/{id}` | PUT | 编辑周报 |
| `/api/report-agent/reports/{id}/submit` | POST | 提交 |

### 6.3 团队 (保留现有)

现有团队 CRUD、团队汇总、成员管理 API 保持不变。

---

## 七、技术实现要点

### 7.1 TAPD 连接器

复用 `CapsuleExecutor.ExecuteTapdCollectorAsync` 的核心逻辑，封装为 `TapdConnector`:
- 支持 Cookie 模式和 Basic Auth 模式
- 采集: 需求完成数、Bug 关闭数、任务完成数
- 按成员 UserMapping 归属到个人

### 7.2 语雀连接器

使用语雀 Open API:
- `GET /api/v2/repos/{namespace}/docs` — 获取文档列表
- 统计: 新发布文章数、更新文档数
- 按 Token 对应的用户归属

### 7.3 自定义 API 连接器

通用 HTTP 采集器:
- 配置: URL + Method + Headers + Body Template
- 返回 JSON，用 JSONPath 提取统计数字
- 适用于公司内部系统对接

### 7.4 统计快照

周报提交时保存 `StatsSnapshot`，记录提交时刻的统计数据:
```json
{
  "github": { "commits": 23, "prs_merged": 3, "lines_added": 1204, "lines_deleted": 356 },
  "tapd": { "stories_done": 3, "bugs_fixed": 5, "tasks_closed": 8 },
  "yuque": { "articles_published": 2, "docs_updated": 5 },
  "dailyLog": { "items": 3, "totalMinutes": 420 }
}
```

---

## 八、实施计划

### Phase 5: 数据源重构 (v2.0 第一步)

| 功能点 | 说明 | 复用/新建 |
|--------|------|-----------|
| 个人数据源模型 | `report_personal_sources` 集合 | 新建 |
| 个人数据源 API | 7 个端点 (CRUD + test + sync + stats) | 新建 |
| 个人数据源 UI | "我的数据源"面板 (绑定 GitHub/语雀) | 新建 |
| GitLab Connector | 类似 GitHubConnector | 新建 |
| TapdConnector | 复用 CapsuleExecutor 逻辑 | 复用+封装 |
| YuqueConnector | 语雀 Open API | 新建 |
| CustomApiConnector | 通用 HTTP JSON | 新建 |
| 统计预览 API | `/my/stats` 实时聚合 | 新建 |

### Phase 6: 模板与生成简化

| 功能点 | 说明 | 复用/新建 |
|--------|------|-----------|
| 系统预置模板 | 3 个默认模板 (研发/产品/极简) | 新建 |
| auto-stats 板块渲染 | 统计数字卡片式展示 | 新建 |
| AI 生成引擎适配 | 适配新的统计数据格式 | 改造 |
| StatsSnapshot | 提交时快照统计 | 新建 |
| 状态机简化 | 去掉 Returned/Overdue，加 Viewed | 改造 |

### Phase 7: 团队仪表盘升级

| 功能点 | 说明 | 复用/新建 |
|--------|------|-----------|
| 团队产出统计面板 | 成员统计表格 + 团队汇总数字 | 改造 |
| 团队汇总适配 | 基于新统计数据生成 | 改造 |

---

## 九、与 v1.0 的兼容处理

| v1.0 功能 | v2.0 处理 |
|-----------|-----------|
| 团队模型 (Team/TeamMember) | 保留，无变更 |
| 团队数据源 (report_data_sources) | 保留，扩展新类型 |
| Git 连接器 (GitHub/SVN) | 保留 |
| 每日打点 (DailyLog) | 保留 |
| AI 生成引擎 | 保留核心，适配新输入格式 |
| 退回/评论/通知 | 降级为可选功能，默认关闭 |
| 计划比对 | 保留但不在主流程中 |
| 趋势图表 | 保留 |
| Markdown 导出 | 保留 |
| 假期标记 | 移除 |
| 7 种通知事件 | 简化为 2 种 (草稿生成 + 提交通知) |

---

## 附录: 关联文档

| 文档 | 关系 |
|------|------|
| `doc/agent.report-agent.md` | PRD v1.0 (存档) |
| `doc/plan.report-agent-impl.md` | Phase 1-4 实施记录 |
| `CLAUDE.md` | 功能注册表 |
