# 更新中心（终身存储 + 推送）· 债务台账

> **版本**：v0.1 | **日期**：2026-06-04 | **状态**：open / 待规划

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 4 |
| in-progress | 0 |
| paid | 0 |

模块范围：`prd-api/.../Services/Changelog/*`（ChangelogReader / ChangelogSnapshotStore /
ChangelogPushHub / ChangelogRefreshWorker）、`ChangelogController` 的 `/api/changelog/stream`、
`prd-admin/src/pages/changelog/ChangelogPage.tsx`。

## 背景

2026-06-04 用户要求更新中心「永远缓存、后台固定周期（4h）自动刷新、终身存数据库避免加载空白、
加载只读存量、有更新由服务器 push 到页面」。本次落地：
- `changelog_snapshots` 集合做终身存储，加载只读存量（内存缓存 → DB hydrate → 真冷启动才拉）
- `ChangelogRefreshWorker` 固定周期 force 刷新，与访问解耦（解决「第一个看的人吃亏」）
- `IChangelogPushHub` + `/api/changelog/stream` SSE，内容变化主动推送，前端静默重读存量

## 已知边界（open）

| # | 边界 | 说明 | 偿还建议 |
|---|------|------|----------|
| 1 | 推送中枢是进程内单例 | `ChangelogPushHub` 用进程内 Channel 广播。多实例水平扩展时，A 实例的 Worker 刷新只能推给连到 A 的浏览器，连到 B 的收不到。当前单实例部署无影响。**另**：多实例并发 upsert `changelog_snapshots` 需 `Key` 唯一索引兜底（已在 `doc/guide.platform.mongodb-indexes.md` + `MongoDbContext.CreateIndexes()` 登记 `uniq_changelog_snapshots_key`，DBA 手建；`GetAsync` 已加 `SortByDescending(UpdatedAt)` 防御性读，重复行也只取最新）。 | 多实例化时：(a) 改用 Redis pub/sub 或 Mongo change stream 做跨实例广播，订阅端不变；(b) 上线前由 DBA 建好 `uniq_changelog_snapshots_key` 唯一索引。 |
| 2 | 刷新周期为全局，不分视图冷热 | 三个视图（待发布/历史发布/GitHub 日志）共用同一刷新周期。GitHub 日志变化最频繁、历史发布最稳定，统一 4h 对日志略保守。 | 如需更实时，可拆分各视图独立周期，或接 GitHub push webhook 触发即时刷新（仓库已有 webhook 基建）。 |
| 3 | GitHub 日志前端仍保留 35s 轮询 | `ChangelogPage` 既有的 `GITHUB_LOGS_LIVE_POLL_MS` 客户端轮询未移除，与新的 SSE 推送并存（轮询 force=true 仍会触发真实拉取）。本次为控制改动面未动它。已加 trailing-edge：在途轮询期间到达的 SSE update 不再被吞，待在途请求结束补跑一次。 | 评估改为依赖 SSE 推送后下调/移除该轮询，进一步贴合「加载只读存量、刷新交给服务器」。 |
| 4 | 分支预览环境拿不到「仓库总提交数」 | 2026-06-10 新增 `repoTotalCommitCount`（本地 `git rev-list --count`，浅克隆/无 `.git` 时用 GitHub `commits?per_page=1` 的 Link header rel="last" 反推）。CDS 分支容器既无完整本地仓库、又未配 `Changelog:GitHubToken`，匿名调 GitHub 被 403 限流 → 字段为 null，前端降级显示「最近一周」条数。生产环境有 token，不受影响（实测 main 全历史 7282 次提交）。 | 在 CDS 分支 env 注入只读 `Changelog:GitHubToken`，或接受预览环境降级展示。 |

## 偿还触发条件

- 边界 1：一旦更新中心需要多实例部署，必须先偿还（否则推送只覆盖部分用户）。
- 边界 2/3：用户反馈「更新不够实时」或要做 push-webhook 即时刷新时偿还。
