# CDS 高可用改造落地进度（可续传）

> **最后更新**：2026-04-09 | **状态**：Phase 1 实施中
>
> 本文档是 `doc/design.cds-resilience.md` 的**执行面**。每一步都带复选框和文件路径，下次接手的 Agent 直接读这个文件就能续上。
>
> **阅读建议**：先读设计文档了解"为什么"，再读本文档找"做到哪里了"。

---

## 快速续传指引（给下次接手的 Agent）

如果你是下次接手的 Agent，按以下顺序进入工作状态：

1. **先读** `doc/design.cds-resilience.md` 了解整体设计意图（10 分钟）
2. **再读本文档的"进度总览"** 看做到哪里了（2 分钟）
3. **找到第一个未勾选项** 开始动手
4. **每完成一项** 立即勾选本文档对应复选框并 commit
5. **Phase 1 验收标准**：`cd cds && npx vitest run` 全绿 + 启用 `scheduler.enabled=true` 后代理请求能 touch 成功、容量超限能 LRU 驱逐

### 关键代码位置速查

| 想改什么 | 文件 |
|---|---|
| 调度器主逻辑 | `cds/src/services/scheduler.ts` |
| 类型扩展 | `cds/src/types.ts` (BranchEntry.heatState, CdsConfig.scheduler) |
| State 原子写 | `cds/src/services/state.ts` save() |
| 代理 touch 钩子 | `cds/src/services/proxy.ts` routeToBranch() |
| 调度器启动 | `cds/src/index.ts` 约 line 145 附近 |
| API 端点 | `cds/src/routes/branches.ts`（搜索 `/scheduler`）|
| 单元测试 | `cds/tests/scheduler.test.ts` |
| 配置默认值 | `cds/src/config.ts` DEFAULT_CONFIG |

---

## 进度总览

| Phase | 状态 | 备注 |
|---|---|---|
| **Phase 1：调度器 + 原子写** | 🟡 实施中 | 本次 session 目标 |
| Phase 2：cgroup + Master 容器化 | ⏳ 待启动 | 下次 session |
| Phase 3：双实例 + 共享状态 | ⏳ 待启动 | 远期 |

---

## Phase 1：调度器 + 原子写（本次交付）

### 1.1 文档

- [x] 新增 `doc/design.cds-resilience.md`（核心设计）
- [x] 更新 `doc/design.cds.md`（补核心思想 + 文档地图 + §8 高可用章节）
- [x] 新增本文档 `doc/plan.cds-resilience-rollout.md`

### 1.2 类型与配置

- [x] `cds/src/types.ts` 扩展：
  - [x] `BranchEntry.heatState?: 'hot' | 'warming' | 'cooling' | 'cold'`
  - [x] `BranchEntry.pinnedByUser?: boolean`
  - [x] `CdsConfig.scheduler?: SchedulerConfig` 新类型
  - [x] `SchedulerConfig` 接口（enabled、maxHotBranches、idleTTLSeconds、tickIntervalSeconds、pinnedBranches）
- [x] `cds/src/config.ts` `DEFAULT_CONFIG.scheduler` 默认值（enabled: false，兼容老用户）

### 1.3 调度器核心

- [x] 新建 `cds/src/services/scheduler.ts`
  - [x] class `SchedulerService`
  - [x] 构造函数接收 `StateService`、`SchedulerConfig`、`Clock`；wakeFn/coolFn 通过 setter 注入
  - [x] `start()` — 启动 setInterval tick（`unref` 不阻塞事件循环）
  - [x] `stop()` — 停止 tick（用于测试和 server shutdown）
  - [x] `touch(slug)` — 更新 lastAccessedAt + **15s 节流持久化**（高频请求不每次都落盘）
  - [x] `markHot(slug)` — 标记 heatState=hot + 保存
  - [x] `markCold(slug)` — 调用 coolFn + heatState=cold + 保存（失败时回滚到 hot）
  - [x] `wake(slug)` — 驱逐 LRU + warming → wakeFn → hot
  - [x] `pin(slug)` / `unpin(slug)` — 设置 pinnedByUser
  - [x] `isPinned(branch)` — 判断是否 pinned（用户 pin / 默认分支 / colorMarked / pinnedBranches 配置）
  - [x] `selectLruVictim()` — 找最久未访问的非 pinned HOT 分支
  - [x] `evictLruIfOverCapacity(excludeSlug)` — 容量超限时驱逐
  - [x] `tick()` — 扫描 idleTTL 过期 + 容量超限
  - [x] `getSnapshot()` — 返回 hot/cold 列表和容量使用
- [x] 单元测试 `cds/tests/services/scheduler.test.ts`（24 用例全绿）
  - [x] touch 更新时间戳
  - [x] 容量未满直接 markHot
  - [x] 容量满时 LRU 驱逐
  - [x] pinnedByUser / defaultBranch / isColorMarked / config.pinnedBranches 四种 pin 源
  - [x] 全部 pinned 时拒绝驱逐
  - [x] idleTTL tick 自动 cool
  - [x] 传统分支（无 heatState，status=running）视为 hot
  - [x] scheduler.enabled=false 时所有方法 no-op

### 1.4 状态持久化加固

- [x] `cds/src/services/state.ts`
  - [x] `save()` 改为**原子写**：openSync → writeSync → fsyncSync → closeSync → rename
  - [x] `save()` 成功后滚动备份到 `state.json.bak.<timestamp>`（保留最近 10 份）
  - [x] `load()` 失败时回退最近的 `.bak.*`（新增 `tryLoadStateFile()`）
  - [x] 既有 23 个 state.test.ts 用例全绿，原子写不破坏外部契约

### 1.5 代理集成

- [x] `cds/src/services/proxy.ts`
  - [x] 新增 `setScheduler(s)` 方法
  - [x] `routeToBranch()` 成功路由后调用 `scheduler.touch(slug)`（try/catch 包裹保障不影响转发）
- [x] `cds/src/index.ts`
  - [x] 实例化 `SchedulerService`
  - [x] **coolFn 就地实现**：遍历 services → containerService.stop → svc.status='stopped' → branch.status='idle'
  - [x] **wakeFn 暂不设置**：复用现有 `onAutoBuild` 路径（见 ADR-1）
  - [x] 调用 `proxyService.setScheduler(scheduler)`
  - [x] 基础设施 reconcile 后，为历史 running 分支回填 `heatState='hot'`
  - [x] `scheduler.start()` 仅在 enabled 时启动
  - [x] SIGTERM/SIGINT 触发 `scheduler.stop()`

### 1.6 API 端点

- [x] `cds/src/routes/branches.ts`
  - [x] `GET /api/scheduler/state` — 返回 getSnapshot()；scheduler 缺失时返回 enabled=false 占位
  - [x] `POST /api/scheduler/pin/:slug` — scheduler.pin；不存在返回 404
  - [x] `POST /api/scheduler/unpin/:slug` — scheduler.unpin
  - [x] `POST /api/scheduler/cool/:slug` — scheduler.markCold；pinned 返回 409
- [x] `cds/src/server.ts` 注入 `schedulerService` 到 `ServerDeps` 并透传给 `createBranchRouter`

### 1.7 验收

- [x] `cd cds && npm run build` 无 error
- [x] `cd cds && npx vitest run` 全绿（**127 tests / 7 files**，scheduler 新增 24 个）
- [x] `cd cds && npx tsc --noEmit` 零 type error
- [x] `changelogs/2026-04-09_cds-resilience-phase1.md` 已写
- [x] git commit + push 到 `claude/cds-load-balancing-design-O6feg`

---

## Phase 2：cgroup + Master 容器化（下次）

**前提**：Phase 1 已合入主分支并在一台真实服务器验证至少 48 小时无异常。

### 2.1 容器资源限制

- [ ] `cds/src/types.ts` `BuildProfile.resources?: { memoryMB?: number; cpus?: number }`
- [ ] `cds/src/services/compose-parser.ts` 从 `x-cds-resources` 读取
- [ ] `cds/src/services/container.ts` `runService` 传 `--memory`/`--cpus`
- [ ] 默认值：API 600MB / Web 300MB

### 2.2 Master 容器化

- [ ] 新增 `cds/Dockerfile.master`
- [ ] 新增 `cds/systemd/cds-master.service`
- [ ] `exec_cds.sh` 增加 `--via-systemd` 模式
- [ ] 新增 `GET /healthz`（state 可读 + docker 可达）

### 2.3 Janitor

- [ ] 新增 `cds/src/services/janitor.ts`
- [ ] 每日清理 30 天未访问的 worktree
- [ ] `docker image prune` 定时任务
- [ ] 磁盘使用率 > 80% 时 Dashboard 告警条

### 2.4 基础设施资源上限

- [ ] `cds-compose.yml` 为 MongoDB 加 `mem_limit: 1.5g`
- [ ] Redis 加 `mem_limit: 200m`
- [ ] RDB 持久化配置
- [ ] 验证重启后数据不丢失

---

## Phase 3：双实例 + 共享状态（远期）

**前提**：Phase 2 稳定运行至少 2 周。

### 3.1 共享状态

- [ ] 选型：SQLite WAL（更简单）vs Redis（更通用）
- [ ] `StateService` 抽象成 `IStateStore` 接口
- [ ] 新增 `SqliteStateStore` 或 `RedisStateStore`
- [ ] 原 JSON 存储作为 `FileStateStore`，保留作为 fallback

### 3.2 双实例

- [ ] `exec_cds.sh` 支持同机启 2 份 worker（5500/5501）
- [ ] 调度器加 Leader Election（基于 SQLite/Redis 锁）
- [ ] Nginx upstream 配 `max_fails`/`fail_timeout`

### 3.3 Webhook 预热

- [ ] 新增 `POST /api/webhook/warm`
- [ ] Git push hook 模板
- [ ] scheduler 预热队列（受 maxHotBranches 约束）

---

## 环境变量 / 配置 cheatsheet

```json
// cds.config.json
{
  "scheduler": {
    "enabled": true,        // 设为 false 可完全禁用调度器
    "maxHotBranches": 3,    // 4GB 机器默认 3，8GB 机器推荐 12
    "idleTTLSeconds": 900,  // 15 分钟无访问即自动 cool
    "tickIntervalSeconds": 60,
    "pinnedBranches": ["main"]
  }
}
```

```bash
# 运行测试
cd cds && npx vitest run

# 启动 CDS
cd cds && ./exec_cds.sh

# 查看调度器状态
curl http://localhost:9900/api/scheduler/state | jq

# 手动 pin 一个分支
curl -X POST http://localhost:9900/api/scheduler/pin/feature-a

# 手动 cool 一个分支
curl -X POST http://localhost:9900/api/scheduler/cool/feature-a
```

---

## 已知陷阱 / 经验记录

> 这一节专门记录实施过程中踩过的坑，方便下次接手的 Agent 避开。

- **`docker rm -f` vs `docker stop`**：`ContainerService.runService` 会先 `docker rm -f`，所以 cool 路径用 `stop(containerName)` 就够了，不需要保留容器。下次 wake 时 `runService` 会重建一个。
- **`branch.status` 与 `heatState` 的区别**：`branch.status` 是原有字段，反映当前运行态（'running'/'idle' 等）；`heatState` 是调度器新增的维度。两者同时维护。cool 后应设 `branch.status='idle'` + `heatState='cold'`。
- **现有 `onAutoBuild` 路径已经处理了 status != 'running' 的分支**：所以 cool 后的分支被访问时会自动走 SSE 构建页，无需新增唤醒 UI。这就是 ADR-1 的依据。
- **defaultBranch 必须 pinned**：否则冷启动期间可能找不到默认分支。
- **`scheduler.enabled = false` 是默认值**：老用户升级 CDS 时不会感知任何变化，必须显式打开才启用温池。

## Phase 1.5 验证记录（2026-04-10）

> 触发 `/cds-deploy` pipeline 验证本次改动时发现的 **3 个 pre-existing bug** + **1 个设计自证故障**。

### Pipeline 结果

| # | 阶段 | 状态 | 备注 |
|---|------|------|------|
| 0 | 环境预检 | ✓ | |
| 1 | Git Push | ✓ | commit 4abcdc9 |
| 1.5 | CDS Self-Update | ⚠️ 人工介入 | 遇到 bug #1（见下），用户手动 `./exec_cds.sh` 拉起 |
| 1.5v | 验证新分支 + scheduler API | ✓ | `/api/scheduler/state` 返回 `enabled:false, capacityUsage:{current:5, max:3}` — **代码已加载，API 存活** |
| 2 | CDS Pull | ✓ | HEAD=4abcdc95 |
| 3 | CDS Deploy | ❌ 阻塞 | **设计自证故障**（见下） |
| 4-5 | Readiness + Smoke | ⊘ | 未执行 |

### 暴露的 3 个 pre-existing bug（commit `<待补>`）

#### Bug #1：`exec_cds.sh` 不认识 `--background` 参数

- **根因**：`cds/src/routes/branches.ts` self-update handler 调用 `spawn('bash', ['./exec_cds.sh', '--background'])`，但 exec_cds.sh 的 case 语句只识别 `start|daemon|dev|fg|stop|restart|status|logs|help`，`--background` 进 `*)` 分支 exit 1。
- **后果**：self-update 成功 checkout + pull + 老进程 exit，但新进程从未启动 → CDS 宿主机整体 502 → 必须 SSH 手动拉起。
- **静默性**：`stdio: 'ignore'` 把 exec_cds.sh 的报错吞掉，无任何日志。
- **修复**：
  1. `exec_cds.sh` 的 case 加 `start|daemon|--background) start_daemon ;;` 作为别名
  2. 同时把 self-update 的 spawn 参数从 `--background` 改为更规范的 `daemon`
  3. `stdio: ['ignore', out, errFd]` 把子进程输出写到 `.cds/self-update-error.log` 留痕

#### Bug #2：self-update spawn 失败静默

- **根因**：`stdio: 'ignore'` + 无 `child.on('error')` 监听 + 无 PID 探测 = 任何 spawn 失败都是无声的。
- **修复**：新增 `.cds/self-update-error.log` 记录所有 spawn 尝试 + stdout/stderr 重定向到该文件 + `child.on('error')` 兜底。

#### Bug #3：deploy 端点无容量检查

- **根因**：`GET /api/branches` 的响应体里有 `capacity: { maxContainers, runningContainers }` 字段，但 `POST /branches/:id/deploy` 完全不看这个值，即使已经 10/6 超售 167% 也照样创建新容器。
- **后果**：宿主机 OOM → 所有分支级联死亡。
- **修复**：新增 `computeCapacity()` 辅助函数，deploy 入口在 pull 之前发一个 SSE `capacity-warn` 事件。**非阻塞**（保持向后兼容），但至少用户能看到警告。Phase 2 再考虑硬拒绝或自动调度。

### 设计自证故障：Phase 3 deploy 阻塞

部署触发后宿主机被彻底拖垮（HTTP=000 > 3 分钟）。根因：

```
GET /api/branches → capacity: {maxContainers: 6, runningContainers: 10, totalMemGB: 4}
  ↑
  已经 167% 超售，再 +2 个新容器（.NET SDK 1.5GB + Vite 500MB）直接 OOM
```

这 **100% 是本次 Phase 1 要解决的故障模式**。scheduler 代码已部署但 `enabled:false`，所以没生效。

### 对 Phase 2 的启示

原本计划 Phase 2 才做的"cgroup 资源限制 + Master 容器化 + janitor"，**必要性从"P1"升级到"P0"**。特别是：

1. **cgroup limit 是硬性必须**：就算不启用 scheduler，单容器也必须有 `--memory` 上限，否则一个 runaway .NET 编译就能杀死整台机
2. **deploy 入口容量硬拒绝**：Bug #3 的 warning 不够，`scheduler.enabled=false` 且超售时应该 **硬拒绝 deploy** 并给出明确修复指引（手动停哪些容器）
3. **Master 自愈**：本次 CDS 死了两次都必须人工拉起。systemd Restart=always 优先级提到 Phase 2 第一项
