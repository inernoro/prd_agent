# 团队动态（工作日志时间线）设计 · 设计

> **版本**：v1.0 | **日期**：2026-06-11 | **状态**：已实现

## 一、管理摘要

- **解决什么问题**：管理员无法一眼看到团队成员每天在平台上做了什么（谁发布了文档、谁修复了缺陷、谁交了周报），缺少类似飞书「动态」tab 的工作日志视图
- **方案概述**：复用项目已验证的「白名单审计 ActionFilter」模式（PmAuditActionFilter），升级为全局过滤器：白名单内的写操作成功后自动留痕到 `activity_logs` 集合，前端以按天分组的时间线流展示
- **业务价值**：管理层零成本掌握团队工作脉搏；操作留痕兼具合规/追溯价值
- **影响范围**：后端全局 MVC 管道加一个过滤器（白名单外请求一次字典查找即逃逸）、新集合 `activity_logs`、新权限 `team-activity.read`、管理后台新页面 `/team-activity`
- **预计风险**：低 — 留痕写入失败不影响主请求；白名单有 CI 守卫测试防漂移

## 2. 产品定位

一期定位为**管理员视图**：仅持有 `team-activity.read` 权限的用户（admin 角色自动获得）可在左侧导航「系统管理 → 团队动态」查看全员动态。普通用户不可见。

每条动态渲染为：

```
[头像] 张坤 在 知识库 发布了文档 《技术规范及文档》        3 分钟前
```

按天分组（今天 / 昨天 / 6月9日），支持按成员、模块、时间范围（今天/本周/本月）筛选，加载更多分页。

## 3. 采集原理（核心机制）

### 3.1 为什么不用全量请求日志推导

系统已有 `apirequestlogs`（中间件全量记录每个 API 请求），但它语义太弱：只有 Method/Path，无法翻译成"发布了文档《XX》"，且充满读请求和心跳噪音。动态需要的是**有业务语义的精选事件**，所以走白名单声明式留痕，不走日志推导。

### 3.2 三层结构

```
请求进入 MVC 管道
    │
    ▼
ActivityLogActionFilter（全局挂载，Program.cs options.Filters.Add）
    │  1. 非 GET/HEAD/OPTIONS？
    │  2. "{Controller}.{Action}" 命中白名单字典？——未命中即逃逸（一次字典查找，零负担）
    │  3. 条目声明了 TitleDb？→ 在 next() 之前按路由 TargetId 预读标题（删除前快照）
    ▼
await next()  执行真正的业务 Action
    │  4. 响应 2xx？JWT sub 存在？
    │  5. 标题兜底：DB 预读结果 → TitleArgs 参数反射 → null（前端降级）
    ▼
InsertOne activity_logs（CancellationToken.None，try/catch 包裹，失败仅 LogWarning）
```

三个关键文件：

| 文件 | 职责 |
|------|------|
| `prd-api/src/PrdAgent.Api/Filters/ActivityActionRegistry.cs` | 白名单 SSOT：31 个动作条目 + 模块清单导出 |
| `prd-api/src/PrdAgent.Api/Filters/ActivityLogActionFilter.cs` | 全局过滤器：匹配、预读、落库 |
| `prd-api/src/PrdAgent.Core/Models/ActivityLog.cs` | 留痕实体（含 TargetTitle 标题快照） |

### 3.3 白名单条目的声明式设计

每个条目用一个 record 声明"这个动作怎么留痕"：

```csharp
["DocumentStore.AddEntry"] = new(
    Module: "document-store", ModuleLabel: "知识库", ActionLabel: "发布了文档",
    TargetRouteKey: "storeId",                  // 路由里取操作对象 id
    TitleArgs: new[] { "request.Title" });      // 标题从请求 DTO 反射取
```

标题来源两条路，按动作类型选用：

- **TitleArgs（创建类动作）**：标题就在请求体里（`request.Title` / 裸参数 `title` / `IFormFile` 取文件名），从 action arguments 反射提取，零额外查询
- **TitleDb（更新/删除/状态流转类动作）**：请求体里没有标题，按 TargetId 查一次库。**预读发生在业务执行之前**——这是设计关键，保证"删除了文档《XX》"在对象物理删除后依然带标题

复合键用 `Controller.Action` 而非裸 Action 名，因为 `CreateWorkspace` / `CreateTemplate` 等方法名跨 Controller 重名。

### 3.4 一期覆盖范围（31 个动作 / 6 个模块）

| 模块 | 动作 |
|------|------|
| 知识库 | 创建/删除知识库、发布/更新/删除/上传文档 |
| 缺陷管理 | 创建/提交/指派/修复/验证通过/驳回/关闭/重开/评论/删除缺陷 |
| 周报 | 创建/发布/审阅/退回/评论周报、提交日报 |
| 视觉创作 | 创建/删除工作区、发起图片生成 |
| 文学创作 | 创建/删除工作区、生成配图 |
| 网页托管 | 发布（上传/从内容创建）/更新/删除站点 |

刻意排除的噪音动作：点赞、收藏、置顶、移动、文件夹管理、分享链管理、webhook 配置、视图打点（LogEntryView 等高频端点禁止入表）。

### 3.5 防漂移守卫

`prd-api/tests/PrdAgent.Api.Tests/Controllers/ActivityActionRegistryGuardTests.cs` 在 CI 强制：白名单每个 `Controller.Action` 键必须能在 API 程序集反射找到对应公开方法。Controller/Action 一旦重命名而白名单未同步，CI 直接 fail——否则字典匹配不到只是"不留痕"，动态会静默断流，没人发现。

## 4. 数据设计

集合 `activity_logs`（注册于 `MongoDbContext.ActivityLogs`）：

| 字段 | 说明 |
|------|------|
| Id | Guid N 格式 |
| ActorId | 操作人 UserId（JWT sub）；显示名/头像读取时批量解析，不冗余存储 |
| Module / ModuleLabel | 模块 key + 中文名快照（写入时固化，key 改名不影响历史） |
| Action / ActionLabel | `DocumentStore.AddEntry` 复合键 + 「发布了文档」 |
| TargetId / TargetTitle | 操作对象 id + 标题快照（截断 200 字符，可空） |
| TargetUrl | 深链预留，一期留空 |
| Method / Path | 排障用 |
| CreatedAt | UtcNow |

索引（DBA 手工执行，见 `doc/guide.mongodb-indexes.md`）：`{CreatedAt:-1}`、`{ActorId:1,CreatedAt:-1}`、`{Module:1,CreatedAt:-1}`。

## 5. 接口设计

| 端点 | 说明 |
|------|------|
| `GET /api/team-activity/logs?page&pageSize&userId&module&from&to` | 时间倒序分页；返回 items（含批量解析的 actorName/actorAvatarFileName）+ total |
| `GET /api/team-activity/modules` | 模块筛选清单，从白名单注册表导出，前后端不漂移 |

权限：Controller 标注 `[AdminController("team-activity", TeamActivityRead)]`，由 AdminPermissionMiddleware 路由级强制；菜单可见性经 `AdminMenuCatalog` Controller 扫描自动生效。

## 6. 前端

- 页面：`prd-admin/src/pages/team-activity/TeamActivityPage.tsx`（navRegistry 注册 `/team-activity`）
- 复用组件：`UserAvatar` + `resolveAvatarUrl`、`RelativeTime`、`UserSearchSelect`、`PageHeader`、`GlassCard`、`MapSectionLoader`
- service：`services/real/teamActivity.ts` + `contracts/teamActivity.ts`，经 `services/index.ts` 以 `withAuth` 导出

## 7. 关联文档

- `doc/guide.mongodb-indexes.md` — activity_logs 手工索引
- `.claude/rules/data-audit.md` / `prd-api/src/PrdAgent.Api/Filters/PmAuditActionFilter.cs` — 本设计复用的审计模式源头

## 8. 已知边界与后续

- 动态从功能上线后开始留痕，无历史回填
- 同人连续操作不聚合折叠；无 SSE 实时推送（页面手动刷新/重新筛选获取最新）
- TargetUrl 深链未填充，点击动态暂不能跳转到对象详情
- 二期开放普通用户可见时：放宽权限分配 + 查询端按数据可见性过滤即可，模型无需变更
