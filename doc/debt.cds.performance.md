# debt.cds.performance — CDS 性能债务台账（构建越来越慢 / 前端缓慢）

> 状态：active ｜ owner：CDS ｜ 创建：2026-06-21
> 背景：用户反馈"近几百次构建，运行时间越来越长（以前几分钟，现在 10 分钟以上）"，且"前端还是非常缓慢，彻查是不是 mongodb 索引问题"。本台账记录根因排查结论与"逐步解决"的剩余步骤。

## 实测根因更新（2026-06-21 性能专项，最高优先）

把 CDS 自更新到本分支后在真实实例（cds.miduo.org，18 核）实测，**首要根因不是磁盘/镜像堆积，而是预览调度器被禁用**：

### 基线（优化前）
| 指标 | 值 |
|---|---|
| 主机负载 load1/5/15 | 25.79 / 25.34 / 28.3（loadPercent **143%**，严重过载）|
| 运行容器 | **43 个** |
| 跟踪分支 | 59 |
| 执行器 CPU | 100% |
| 内存 | 42%（**不缺**）|
| 磁盘 | 54%（167GB free / 362GB，**根本不是瓶颈**，推翻原 #1/#3 的"吃满磁盘"判断）|

### 首要根因（#0，压过原表所有项）
**预览调度器（warm-pool SchedulerService）被禁用**：`GET /api/scheduler/state` 实测 `enabled:false, maxHotBranches:0`。后果：空闲分支**永不回收**，59 个分支里 43 个容器一直在跑（如 `mytapd-main` 16 小时没人访问仍在运行），把 18 核主机 CPU/load 拖满（load 28）→ 每次构建都在过载主机上排队 → 几分钟变 10 分钟、甚至 `2 个服务异常 启动失败`。原表的「docker 镜像堆积」是次要因素（磁盘才 54%，没吃满）。

### 修复与实测结果
启用调度器：`PUT /api/scheduler/config {enabled:true, maxHotBranches:14, idleTTLSeconds:1800}`（override 持久化，重启不丢）。实测**运行容器 43 → 10**（5 分钟内），主机负载随之回落。空闲分支被 cool 后下次访问自动冷启，非破坏性。

> 注：这是「优化 CDS 本身」（系统级 warm-pool），未改任何其他项目的项目级配置。

### 观测性（avoid recurrence，本次新增）
此前「调度器被禁用 / 主机过载 / 容器堆积」**完全无告警**，静默melt了不知多久。本次补：
- `GET /api/cds-system/perf-health`：一处算出 host load / 容器数 / 调度器状态 / 各项目构建中位耗时 + warnings（调度器禁用=严重、过载=严重、容器>核数2倍=警告、构建中位>6min=警告）。
- 监控弹窗（运维监控→性能页签）顶部「运维健康告警」红/黄横幅 + 调度器状态 chip + 构建耗时中位。一眼可见。
- 后端每 5 分钟 `perf-health` 自检，命中即 `console.warn`（进日志 + 左上角 Activity Monitor）。

### 下一步（durable）
- [x] **全局部署并发上限（semaphore）**：已于 2026-06-22 交付（见下文「构建并发治理」节与路线步骤 0，`build-gate.ts` + 6 单测）。本段曾与步骤 0 的勾选自相矛盾（旧文字未清），2026-07-09 对账修正。

---

## 构建并发治理 + 两个假设证伪（2026-06-22 专项，实测取证）

用户追问"为什么一个构建要 11 分钟"。在真实实例（18 核 / 96GB RAM）逐项实测：

### 落地：全局构建并发闸（已交付）
- 病根：CDS 每次部署在临时容器里跑 `install + 编译`，**无任何并发上限**。多分支同时部署时 N 个构建一起把 CPU 吃满、彼此饿死。
- 实测铁证：同一分支 admin 构建 isolated ~353s；误触发双部署重叠时被拖到 **636s / 754s**（纯争抢膨胀）。
- 修复：`cds/src/services/build-gate.ts` 全局 FIFO 并发闸（槽位转移防超额），上限 `CDS_MAX_CONCURRENT_BUILDS`（默认 3）。排队状态写进部署日志 + SSE + `/api/cluster/status`，用户看到「排队中，前面还有 N 个」而非疑似卡死。6 个单测覆盖。

### 证伪一：pnpm 跨设备复制 —— 不成立
`/pnpm/store` 与 `/repo/node_modules` 同为 device `2049`（同一 ext4），hardlink 正常工作，**无跨设备复制拖慢**。共享 pnpm store + NuGet 缓存早于 2026-06-20 落地（`cache-catalog.ts`）。

### 证伪二：vite build 并行度被压成 1 拖慢 —— 不成立
同容器顺序 A/B 实测：maxParallelFileOps=1→**353s**，=4→**369s（反而略慢）**。放宽零收益，已 revert。瓶颈在 transform/bundle 的 **CPU 阶段**，非文件 I/O。

### admin 部署构建拆解（baseline 598s）
- vite build ≈ 353s（59%，CPU 固有）；corepack+install+容器开销 ≈ 245s（41%）
- api（.NET）≈ 354s：`dotnet clean`+`--no-incremental` 全量重编，无持久 bin/obj 卷（fresh worktree 必然全编）。改增量无收益且重蹈 MSBuild 增量误判，故不动。

### 结论
admin/api 的编译耗时是 **CPU 固有成本**，I/O/并行旋钮榨不动；可动的是"别让构建互相饿 CPU"=并发闸。再快需减 bundle / 换机器 / 分布式构建。

---

## 根因排查结论（按影响排序）

| # | 根因 | 证据 | 严重度 | 状态 |
|---|------|------|--------|------|
| 1 | **Docker 悬空镜像 + 构建缓存无限堆积**：每次分支 `docker build` 产生中间层，分支删除只清容器/卷不清镜像层与 build cache，几百次后吃满磁盘/IO，每次构建都在膨胀的层上做 context 计算 | 分支删除路径 `branches.ts` 只删 container + volume，无 image/builder prune；janitor 只删过期分支不清 docker 垃圾 | 关键 | **已修首步**：janitor 每次 sweep 安全清理悬空镜像 + 构建缓存（保留 10GB，不碰容器/卷/有 tag 镜像）。见 `cds/src/services/janitor.ts` defaultDockerPrune |
| 2 | **（2026-07-09 核实：表述与代码不符，改写）** 原写「per-branch mongo/redis/mysql 删除时未停」——现行代码中 infra 容器是**项目级共享**（`cds-infra-<projectSlug12>-<serviceId>`，无 branch 标识，删分支绝不能停）；per-branch DB 隔离是共享实例上的**库名后缀**（`db-scope-isolation.ts`），不产生容器；分支自带 mongo/redis（extraProfiles）是 app 容器（`cds-<branchId>-<profileId>`），删除路径已覆盖。真实残留风险是两类：① 不在 CDS 台账上的**孤儿 infra 容器**（历史遗留/手工启动）② 分支改名/删 profile 后不在 `entry.services` 快照里的**遗留 app 容器** | janitor 无 infra 对账；删除循环只遍历 `entry.services` 快照 | 关键 | **已修（2026-07-09）**：janitor sweep 增孤儿 infra 对账报告（只报不删，进 sweep report + server-event warn）；分支显式删除路径增按 `cds.branch.id` label 的遗留 app 容器 sweep（best-effort，失败不阻断） |
| 3 | 无定期 `docker system prune`，悬空网络/卷/缓存长期堆积 | janitor 识别过期分支但不触发 docker 清理 | 高 | 已被 #1 首步部分覆盖（镜像 + 构建缓存）；卷/网络仍未自动清（卷涉数据，谨慎） |
| 4 | **MongoDB 索引**：当前 activity log 等热数据走内存环形缓冲（暂不慢）；若按 mongo-split 迁到独立集合且按 projectId/branchId/ts 查询将走全表扫描 | `mongo-split-store.ts` 仅 `cds_branches` 建 `{projectId:1}`，activity/webhook 无复合索引 | 中（当前非主因，迁移后变关键） | **已修（2026-07-09）**：拆分落地时 `mongo-split-store.init()` 自动创建 `cds_activity_logs {projectId:1,at:-1}` 与 `cds_webhook_deliveries {receivedAt:-1}`（沿该文件既有 init 自建惯例；no-auto-index 针对 prd-api 应用库不适用于 CDS 自持库） |
| 5 | 仪表盘热路径 `GET /api/branches` 对每项目 activity log 做 O(N) 过滤聚合 | `branches.ts:~3499` 循环 projects×200 | 中 | **已旁路缓解（2026-06-22，2026-07-09 对账补记）**：`/api/branches` 已加整包短 TTL 缓存 + 并发去重（`branches.ts:3957` 起，`CDS_BRANCHES_CACHE_TTL_MS` 默认 1s），热路径并发争用已兜住；函数级 5s 记忆化降为低优可选 |

## 回答用户两个问题

- **"是不是 mongodb 索引问题？"**：当前**不是主因**（热数据在内存环形缓冲）。前端缓慢主要来自**主机资源被 docker 垃圾 + 残留 infra 容器拖满**（CPU 100%）。mongo 索引是**迁移后的将来风险**，应提前补但单靠它解决不了现状。
- **"为什么构建越来越长？"**：**Docker 层 + 构建缓存累积 + 残留 infra 容器**三者叠加 → 磁盘/IO/CPU 逐次恶化。首步已清悬空镜像 + 构建缓存；剩余步（停残留 infra、卷清理、索引、热路径缓存）按上表逐步推进。

## 2026-07-09 批次补记（四维扫描 + 债务对账，台账外新修一并登记）

- **前端缓慢的第二根因已修**：BranchListPage 顶层 1s 时钟曾令 5800 行页面 + 全部分支卡每秒整树重渲染（构建期间持续掉帧）——已删页面级 tick，计时下沉 `useNowTick` 到卡片/抽屉内部，BranchCard memo 化 + content-visibility 离屏跳过（commit `3fd5a1e`）。此根因原不在本台账根因表内（表内只讲主机资源），补记。
- **state 膨胀源两处堵住**：容器日志黑匣子加 per-branch 双闸（10 条/2MB）+ 启动孤儿裁剪；JSON 存储 save 从每次同步 stringify+fsync 改为去抖合并异步落盘（commit `d9fb5dc`）——间接减轻本台账「前端缓慢」与 `debt.cds.state-json.md` 的 save 阻塞痛点。
- **报告 IO 异步化 + export-skill 异步打包**：请求路径不再同步阻塞事件循环（commit `d9fb5dc`）。

## 逐步解决路线

0. [x] 全局构建并发闸（2026-06-22）：消除多构建互相饿 CPU 的争抢膨胀（353→636/754s），排队可观测。`cds/src/services/build-gate.ts`
1. [x] janitor 安全清理悬空镜像 + 构建缓存（非破坏性，默认开 `config.janitor.dockerPrune`）
2. [x] 资源回收对账（2026-07-09，降级版——原「停 per-branch infra」前提与代码不符，见根因表 #2 改写）：janitor 孤儿 infra 报告 + 删分支遗留 app 容器 sweep
3. [x] getActivityLogs 热路径：已被 `/api/branches` 整包 TTL 缓存旁路缓解（见根因表 #5），函数级记忆化降为低优可选
4. [x] mongo-split 迁移 activity/webhook 到独立集合（2026-07-09，见 `debt.cds.state-json.md` Phase 1+2）；索引由 `mongo-split-store.init()` 自动创建，DDL 记录备查于 `doc/guide.platform.mongodb-indexes.md` CDS 段
5. [ ] 评估卷/网络的安全自动清理（涉数据，需白名单 `cds.precious`，维持谨慎不动）

## 相关
- `cds/src/services/janitor.ts` — 本次首步落地
- `cds/.claude/rules/` / `no-auto-index.md` — 索引由 DBA 手动建
- 主仓 `CLAUDE.md` 规则 #11 / CDS 自部署
