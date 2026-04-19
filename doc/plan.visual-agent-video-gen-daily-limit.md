# 视觉创作 - 视频生成（每日限额体验）实施 · 计划

## 需求概述

在视觉创作（Visual Agent）中增加"视频生成"功能入口，复用已有的 Video Agent 后端能力，但限制每人每天仅能体验 1 次。

---

## 方案设计思路

### 核心决策：**不新建视频生成引擎，复用 Video Agent 后端**

视频生成的完整链路（文章 → 分镜 → Remotion 渲染）已在 `VideoAgentController` + `VideoGenRunWorker` 中实现。视觉创作只需作为一个新的**入口 Controller**，底层共享同一套 Worker 和 `video_gen_runs` 集合。

### 每日限额方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A. Redis 滑动窗口** | 高性能、已有 `RedisRateLimitService` 基础 | 现有接口是 RPM/并发模型，不适合"每天 N 次"语义 |
| **B. MongoDB 计数查询** | 实现简单，直接 count 当日 runs | 每次请求查 DB，但视频生成频率极低无所谓 |
| **C. 新建通用 DailyQuota 服务 (Redis)** | 语义清晰，可复用于其他"每日 N 次"场景 | 需要新建接口+实现 |

**推荐方案 B**：视频生成是低频操作（每人每天最多 1 次），直接查 MongoDB 即可，不需要 Redis 高性能计数。实现最简单，代码量最少。

---

## 详细实施步骤

### Phase 1: 后端 - 视觉创作视频生成 Controller

#### 1.1 新建 `VisualAgentVideoController`

遵循**应用身份隔离原则**，在视觉创作下新建独立 Controller：

```
路由: api/visual-agent/video-gen
appKey: visual-agent（与图片生成共用，同一个应用下的不同功能）
```

**文件**: `prd-api/src/PrdAgent.Api/Controllers/Api/VisualAgentVideoController.cs`

**端点设计**:

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/runs` | 创建视频生成任务（含每日限额检查） |
| GET | `/runs` | 列出当前用户的视频生成任务 |
| GET | `/runs/{runId}` | 获取任务详情 |
| GET | `/runs/{runId}/stream` | SSE 事件流 |
| PUT | `/runs/{runId}/scenes/{idx}` | 编辑分镜 |
| POST | `/runs/{runId}/scenes/{idx}/regenerate` | 重新生成分镜 |
| POST | `/runs/{runId}/scenes/{idx}/preview` | 分镜预览 |
| POST | `/runs/{runId}/scenes/{idx}/generate-bg` | 分镜背景图 |
| POST | `/runs/{runId}/render` | 触发渲染 |
| POST | `/runs/{runId}/cancel` | 取消任务 |
| GET | `/runs/{runId}/download/{type}` | 下载产出 |
| GET | `/quota` | 查询当前用户今日剩余额度 |

#### 1.2 每日限额实现

在 `CreateRun` 方法中，创建 run 之前检查：

```csharp
// 查询今日该用户通过 visual-agent 创建的视频 run 数量
var todayStart = DateTime.UtcNow.Date;
var todayCount = await _db.VideoGenRuns.CountDocumentsAsync(
    x => x.OwnerAdminId == adminId
      && x.AppKey == "visual-agent"    // 只统计视觉创作入口的
      && x.CreatedAt >= todayStart);

if (todayCount >= dailyLimit)  // dailyLimit = 1
{
    return BadRequest(ApiResponse<object>.Fail(
        ErrorCodes.QUOTA_EXCEEDED,
        $"每日视频生成体验次数已达上限（{dailyLimit}次/天），明天再来试试吧"));
}
```

#### 1.3 `VideoGenRun` 模型补充

在 `VideoGenRun` 中，`AppKey` 字段已存在（默认值 `"video-agent"`），视觉创作入口创建时设为 `"visual-agent"`，用于区分来源和限额计算。

#### 1.4 `/quota` 端点

返回当前用户今日剩余额度，前端用于展示提示：

```json
{
  "dailyLimit": 1,
  "usedToday": 0,
  "remaining": 1
}
```

### Phase 2: 后端 - 管理员可配置限额（可选增强）

在 `appsettings` 集合中存储配置：

```json
{
  "key": "visual-agent.video-gen.daily-limit",
  "value": 1,
  "description": "视觉创作-视频生成每日免费体验次数"
}
```

初期可以先硬编码 `const int DailyLimit = 1`，后续再做可配置。

### Phase 3: 前端 - 视觉创作工作区增加视频入口

#### 3.1 API Service 层

**文件**: `prd-admin/src/services/real/visualAgentVideo.ts`

复用 `videoAgent.ts` 的接口契约，但路由指向 `api/visual-agent/video-gen/...`。

#### 3.2 UI 入口

在视觉创作工作区编辑器页面中增加"视频生成"Tab 或按钮入口，跳转到独立的视频生成子页面。

**方案选择**:
- **方案 A**: 在 VisualAgentWorkspaceEditorPage 中增加一个"生成视频"按钮 → 弹出 Dialog/抽屉
- **方案 B**: 在视觉创作区增加一个独立的 Tab "视频生成" → 新页面

两种都可以，建议先用 **方案 A（按钮 + Dialog）** 做 MVP，后续再考虑独立 Tab。

#### 3.3 限额 UI 展示

- 页面加载时调 `/quota` 获取剩余额度
- 当 remaining = 0 时，按钮置灰 + 提示"今日体验次数已用完"
- 创建成功后刷新额度显示

---

## 关键设计决策

### Q1: 为什么不直接让前端调 Video Agent 的 API？

遵循**应用身份隔离原则**：视觉创作和视频 Agent 是两个不同的应用，权限控制、限额策略互不影响。视频 Agent 入口不受每日限额约束，视觉创作入口才有。

### Q2: Worker 是否需要改动？

**不需要**。`VideoGenRunWorker` 轮询 `video_gen_runs` 集合中 `Status = Queued` 的任务，不关心 `AppKey` 是什么。两个入口创建的 run 都会被同一个 Worker 处理。

### Q3: 每日限额重置时间？

使用 UTC 零点（`DateTime.UtcNow.Date`）作为每日重置点。考虑到用户主要在中国时区，也可以用 `UTC+8` 的零点。建议初期用 UTC，后续可配置。

### Q4: 管理员是否也受限？

初期所有用户统一限额。后续可以通过角色判断（如 `SystemRole.SuperAdmin`）跳过限额检查。

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `prd-api/.../Controllers/Api/VisualAgentVideoController.cs` | 新增 | 视觉创作视频生成 Controller |
| `prd-api/.../Core/Security/AdminPermissionCatalog.cs` | 修改 | 新增 `VisualAgentVideoGenUse` 权限 |
| `prd-admin/src/services/api.ts` | 修改 | 新增 visual-agent video-gen 路由 |
| `prd-admin/src/services/real/visualAgentVideo.ts` | 新增 | API 调用层 |
| `prd-admin/src/services/contracts/visualAgentVideo.ts` | 新增 | 类型契约 |
| `prd-admin/src/services/index.ts` | 修改 | 注册新 service |
| `prd-admin/src/pages/visual-agent/...` | 修改 | 增加视频生成入口 UI |

---

## 不做的事情

- ❌ 不新建视频渲染引擎（复用 VideoGenRunWorker + Remotion）
- ❌ 不新建 MongoDB 集合（复用 `video_gen_runs`，通过 `AppKey` 区分）
- ❌ 不改动现有 Video Agent 的任何逻辑
- ❌ 不引入 Redis 计数（低频操作，MongoDB 查询足够）
