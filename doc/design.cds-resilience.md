# CDS 容量预算与故障隔离设计（小服务器负载均衡 → 分布式集群）

> **版本**：v2.0 | **日期**：2026-04-10 | **状态**：Phase 1+2+3 代码已落地,Phase 3 等运维上线
>
> 本文档回答两个问题：
> 1. **怎样让 CDS 在一台 4GB/2vCPU 的小服务器上跑 5-10 个并行分支验收环境而不宕机？**（Phase 1-2）
> 2. **怎样把多台小服务器组成一个分布式集群，分支按容量派发、故障时迁移、无单点？**（Phase 3）
>
> 关联主文档：`doc/design.cds.md`（CDS 整体架构）

---

## 一、管理摘要

- **解决什么问题**：CDS 在小服务器上随着分支数增长会遇到 OOM 级联、state.json 损坏、单进程宕机等致命风险，没有容量上限也没有故障隔离
- **方案概述**：引入"休眠池调度器"——只保留固定数量的分支常驻运行（HOT），其他分支按 LRU 休眠到 COLD 状态，请求到达时懒唤醒。同时加固状态持久化、容器资源限制、单点自愈
- **业务价值**：4GB 机器从"能跑 2 个分支"提升到"能承载 5-10 个分支"，宕机恢复从"需人工介入"降到"5 秒自愈"
- **影响范围**：`cds/` 模块新增 `scheduler.ts`，`state.ts` 增原子写，`proxy.ts` 增 touch 钩子，`types.ts` 扩展分支热度状态。对主项目零改动
- **预计风险**：低 — 休眠/唤醒复用现有 auto-build 流程，无新容器协议；降级路径保持可用（未启用调度器时行为与今日完全一致）

---

## 二、核心思想：分支温池（Branch Warm Pool）

### 一句话定义

> **CDS 不追求"所有分支常驻"，而追求"按需唤醒、快速命中、永不超载"。把小服务器当作一个带容量预算的分支温池，用 LRU 调度 + cgroup 隔离换取可预测的资源消耗。**

### 为什么不是横向扩容

| 方案 | 为什么不适合小服务器 |
|---|---|
| K8s + HPA | 至少 3 节点控制面，资源开销 ≥ 2GB，反客为主 |
| Docker Swarm | 多机集群，违背"单机部署"假设 |
| 纯手动启停 | 用户心智负担高，容易忘记关闭陈旧分支 |
| **Warm Pool（本方案）** | **单机内榨取容量，零运维，对用户透明** |

### 三个设计原则

1. **容量预算可计算**：`maxHotBranches = floor((TotalRAM - 基础设施预留) / 单分支平均内存)`，从机器规格反推承载上限，不拍脑袋
2. **LRU 是最公平的驱逐策略**：最久未访问 = 最不重要；对用户而言"谁在用谁保留"的语义自洽
3. **冷启动可视化**：用户访问冷分支时必须看到进度（符合 `CLAUDE.md §6 禁止空白等待`），不静默转圈

---

## 三、分支状态机

```
         ┌──────────┐
         │   COLD   │ ← 容器不存在，只有 worktree 和 state 记录
         └────┬─────┘
              │ 收到请求 / 预热 webhook
              ▼
         ┌──────────┐
         │ WARMING  │ ← docker run 中，等待 readiness
         └────┬─────┘
              │
              ▼
         ┌──────────┐
   ┌────►│   HOT    │ ← 容器运行中，可直接响应请求
   │     └────┬─────┘
   │          │ 闲置 > idleTTL (默认 15 分钟)
   │          │ 或 HOT 池达到 maxHotBranches 且本分支是 LRU
   │          ▼
   │     ┌──────────┐
   │     │ COOLING  │ ← docker stop 中
   │     └────┬─────┘
   │          │
   │          ▼
   │     ┌──────────┐
   │     │   COLD   │
   │     └──────────┘
   │
   └── 再次访问（懒唤醒）
```

### 状态映射到现有字段

复用现有 `BranchEntry.status` 和 `ServiceState.status` 枚举，新增 `heatState` 作为调度器视角：

| `heatState` | `branch.status` | 所有 `service.status` | 语义 |
|---|---|---|---|
| `hot` | `running` | `running` | 常驻响应请求 |
| `warming` | `building` / `starting` | `building` / `starting` | 唤醒中 |
| `cooling` | `stopping` | `stopping` | 休眠中 |
| `cold` | `idle` | `stopped` | 仅保留 worktree + state |

`heatState = undefined` 代表"未被调度器管理"（degraded 模式），保持与现有行为完全兼容。

### 用户控制

- `pinnedByUser: true` → **永不驱逐**，即便超过 `maxHotBranches` 也不会被选中
- 默认分支（`state.defaultBranch`）自动被视为 pinned
- `isColorMarked: true`（已有字段）→ **优先级保留**，正在调试的分支不驱逐

---

## 四、调度器算法

### 4.1 容量预算公式

```
maxHotBranches = floor(
  (TotalRAM_MB - InfraReservedMB - CdsMasterMB) / AvgBranchMB
)

默认参数（4GB 机器）：
  TotalRAM_MB        = 4096
  InfraReservedMB    = 2000  (MongoDB 1500 + Redis 200 + Docker daemon 300)
  CdsMasterMB        = 400   (Node.js + 两份实例)
  AvgBranchMB        = 450   (.NET API 300 + Vite 150)
  → maxHotBranches  = floor((4096 - 2000 - 400) / 450) = 3

8GB 机器：
  → maxHotBranches  = floor((8192 - 2000 - 400) / 450) = 12

16GB 机器：
  → maxHotBranches  = floor((16384 - 2000 - 400) / 450) = 31
```

配置项在 `cds.config.json`，可被用户覆盖：

```json
{
  "scheduler": {
    "enabled": true,
    "maxHotBranches": 3,
    "idleTTLSeconds": 900,
    "tickIntervalSeconds": 60,
    "pinnedBranches": ["main"]
  }
}
```

### 4.2 LRU 驱逐策略

1. 维护 `HOT` 集合 `H`（当前所有 `heatState=hot` 的分支）
2. 当新分支要 warm 时：
   - 若 `|H| < maxHotBranches`：直接 warm
   - 否则：找 `H` 中 `lastAccessedAt` 最早且 **非 pinned、非 colorMarked** 的分支 → cool 它 → 再 warm 新分支
   - 若找不到可驱逐的（全部被 pinned）：warm 新分支但记录告警（容量超支）

### 4.3 后台 tick（每 60 秒）

```
for branch in state.branches:
  if branch.heatState != 'hot': continue
  if branch.pinnedByUser or branch.isColorMarked: continue
  if now - branch.lastAccessedAt > idleTTLSeconds:
    cool(branch)  // 空闲超时自动休眠
```

### 4.4 触发点清单

| 触发点 | 动作 | 位置 |
|---|---|---|
| 代理请求命中分支 | `scheduler.touch(slug)` 更新 lastAccess | `proxy.ts` 成功路由后 |
| 代理请求命中 cold/stopped 分支 | 复用现有 `onAutoBuild` 流程（已有） | `proxy.ts` |
| 手动部署分支 | `scheduler.markHot(slug)` + 容量检查 | `routes/branches.ts POST /deploy` |
| 手动停止分支 | `scheduler.markCold(slug)` | `routes/branches.ts POST /stop` |
| CDS 启动 | `scheduler.start()` 启动 tick | `index.ts` |
| 后台 tick | `scheduler.tick()` 扫描空闲 + 容量 | `scheduler.ts` setInterval |

---

## 五、状态持久化加固

### 5.1 原子写

```
write(state.json):
  1. 写临时文件 state.json.tmp
  2. fsync 临时文件
  3. rename state.json.tmp → state.json (POSIX 原子)
```

### 5.2 滚动备份

- 每次 save() 成功后，将旧 `state.json` 复制到 `state.json.bak.<timestamp>`
- 保留最近 10 份，超出自动删除

### 5.3 启动自检

```
load():
  1. 尝试读 state.json
  2. 若 JSON.parse 失败 → 尝试最近的 state.json.bak.*
  3. 全部失败 → 启动 emptyState() 并在日志中标红警告
```

---

## 六、故障矩阵（此方案解决 vs 未解决）

| 风险 | 严重程度 | Phase 1 是否解决 | 备注 |
|---|---|---|---|
| 单分支 runaway 内存吃光全机 | 🔴 致命 | ⚠️ 部分（通过 maxHotBranches 限制并发） | Phase 2 加 cgroup |
| state.json 损坏无法启动 | 🔴 致命 | ✅ 是（原子写 + 滚动备份） | |
| Node.js Master 崩溃 | 🔴 致命 | ❌ 未解决 | 需容器化 + systemd（Phase 2） |
| worktree + docker layer 填满磁盘 | 🟡 中 | ❌ 未解决 | 需 janitor（Phase 2） |
| MongoDB OOM | 🟡 中 | ❌ 未解决 | 需改 cds-compose 内存上限（Phase 2） |
| Host Nginx 单点 | 🟡 中 | ❌ 未解决 | 需双实例 upstream（Phase 3） |
| 分支总数超容量 | 🟢 低 | ✅ 是（LRU 驱逐） | 本设计主解决项 |
| 空闲分支长期占资源 | 🟢 低 | ✅ 是（idleTTL 自动 cool） | 本设计主解决项 |
| 冷分支请求空白等待 | 🟢 低 | ✅ 是（复用现有 SSE transit page） | |

---

## 七、分阶段落地

### Phase 1（v3.1,已发布）— 单机温池

- [x] 文档：本文档 + `plan.cds-resilience-rollout.md` 进度追踪
- [x] 类型扩展：`BranchEntry.heatState`、`BranchEntry.pinnedByUser`、`CdsConfig.scheduler`
- [x] 新增 `scheduler.ts`（容量预算 + LRU 驱逐 + idleTTL tick + pinning）
- [x] 集成 `proxy.ts` touch 钩子
- [x] `state.ts` 原子写 + 滚动备份
- [x] API：`GET/POST /api/scheduler/*`（pin、unpin、cool、state）
- [x] vitest 单元测试（24 用例）

### Phase 2（v3.2,已落地）— 单机加固

- [x] **容器 cgroup 限制** — `BuildProfile.resources?.memoryMB/cpus`,docker run 追加 `--memory/--memory-swap/--cpus` 标志
- [x] **compose 解析支持两种格式**：`x-cds-resources`（我们的扩展,数字）+ `deploy.resources.limits`（标准 compose,带单位）
- [x] **JanitorService** — 每小时扫描 `lastAccessedAt > worktreeTTLDays` 的分支,跳过 pinned,通过 callback 删除 worktree + 容器。同时检查磁盘使用率触发告警
- [x] **CDS Master 容器化** — `cds/Dockerfile.master`（multi-stage build + docker CLI + healthcheck）
- [x] **systemd unit** — `cds/systemd/cds-master.service`（Restart=always + cgroup 限制 + security hardening）
- [x] **`GET /healthz` 健康检查** — state 可读 + docker 可达,供 Docker/systemd/Nginx 主动探测
- [x] 单元测试：cgroup 参数（5）、compose 解析（14）、janitor（18）,共 37 个新用例

### Phase 3（v3.3,代码已落地,等待运维部署）— 分布式集群

- [x] **BranchDispatcher** — 读取每个 executor 的 `/api/scheduler/state`（Phase 1 API!）,按 `capacityUsage.current/max` 比率选最空闲的 executor,这是 Phase 1 与 Phase 3 的桥梁
- [x] **`POST /api/executors/dispatch/:branch`** — 调度 API,支持 `capacity-aware` / `least-branches` 两种策略
- [x] **Nginx 模板生成器** — `nginx-template.ts` 生成 upstream block + 分支→executor map + 完整 server block,支持 draining → backup,offline 直接排除
- [x] 单元测试：dispatcher（12）、nginx-template（11）,共 23 个新用例
- [ ] **运维部署**：至少 2 台小机,一台 `mode=scheduler`,其他 `mode=executor`（代码已就绪,只等实操）
- [ ] **共享状态存储**（SQLite WAL / Redis）— 目前 Master 的 state.json 仍是单点,Phase 3 真正高可用需要共享存储
- [ ] **分支迁移** — executor A 过载时把 LRU 分支搬到 B（cool → worktree 删除 → B 重建 → deploy）
- [ ] **Webhook 预热接口** — `POST /api/webhook/warm` 在 git push 后主动预热目标分支

---

## 八、Phase 3 分布式架构（接入系统的 3 层模型）

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: 公网入口 (Edge Routing)                              │
│  ┌────────────────────────────────────────┐                   │
│  │  Nginx / Caddy                         │                   │
│  │  - upstream cds_executors              │                   │
│  │    + max_fails=3, fail_timeout=30s     │                   │
│  │  - map $http_x_branch → executor       │                   │
│  │  - draining → backup server            │                   │
│  │  → nginx-template.ts 动态生成          │                   │
│  └──┬──────┬──────┬───────────────────────┘                   │
└─────┼──────┼──────┼───────────────────────────────────────────┘
      ▼      ▼      ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 2: 集群调度 (Cluster Coordination)                      │
│  ┌────────────────────────────────────────┐                   │
│  │  Master (mode=scheduler)                │                   │
│  │  - ExecutorRegistry: 注册 + 心跳 + 健康  │                   │
│  │  - BranchDispatcher: 读 Phase 1 快照     │                   │
│  │    按 current/max 比率选最空闲 executor   │                   │
│  │  - /api/executors/dispatch/:branch      │                   │
│  └──┬─────────┬─────────┬───────────────────┘                 │
│     │         │         │                                     │
│  ┌──▼──┐   ┌──▼──┐   ┌──▼──┐                                  │
│  │Exec │   │Exec │   │Exec │ (mode=executor)                  │
│  │  A  │   │  B  │   │  C  │                                  │
│  │┌───┐│   │┌───┐│   │┌───┐│                                  │
│  ││LP1││   ││LP1││   ││LP1││ ← Layer 1 per-node scheduler     │
│  │└───┘│   │└───┘│   │└───┘│                                  │
│  └─────┘   └─────┘   └─────┘                                  │
└──────────────────────────────────────────────────────────────┘
```

### 三层的职责切分

| 问题 | 归谁解决 | 机制 |
|---|---|---|
| "分支太多，单机装不下" | **Layer 1** (Phase 1) | LRU 驱逐 + idleTTL |
| "单容器内存爆炸" | **Layer 1/2 交界** (Phase 2) | cgroup `--memory`/`--cpus` |
| "worktree + docker layer 填满磁盘" | **Layer 2** (Phase 2) | Janitor `sweepIntervalSeconds` 循环 |
| "CDS Master 崩溃" | **Layer 2** (Phase 2) | systemd `Restart=always` + `/healthz` |
| "分支总数超过单机极限" | **Layer 2** (Phase 3) | BranchDispatcher 派给空闲 executor |
| "Executor 挂了" | **Layer 2** (Phase 3) | 心跳超时 → 分支重新派发 |
| "公网入口挂了" | **Layer 3** (Phase 3) | Nginx upstream `max_fails` + backup |
| "用户不知道分支在哪台机" | **Layer 3** (Phase 3) | Nginx map `$http_x_branch` 路由 |

### 关键洞察：Phase 1 的 SchedulerService **就是** Layer 1

**把 Phase 1 代码部署到每个 executor 节点上,每个节点自动有 LRU 容量管理,根本不需要改一行代码**。Master 只需要在 Layer 2 做"派发决策"。

BranchDispatcher 的伪代码：
```typescript
const snapshots = await Promise.all(
  executors.map(e => fetch(`http://${e.host}:${e.port}/api/scheduler/state`))
);
const ranked = snapshots.sort((a, b) =>
  (a.capacityUsage.current / a.capacityUsage.max) -
  (b.capacityUsage.current / b.capacityUsage.max)
);
return ranked[0].executor;  // 最空闲的 executor
```

**Layer 1 的 getSnapshot() 就是 Layer 2 的决策数据源**。今天交付的 `pin/cool` API 同样是未来"手动迁移"工具链的接口。`heatState` 状态机是未来"分支在集群间漂移"的状态基础。

这是**真正的系统性接入**：三层独立演进,每层只读上层 API,不假设下层实现。Phase 2 的 janitor 不知道集群存在,Phase 3 的 dispatcher 不关心单机内部如何驱逐。

> **与单节点入口的边界**：本节的 Layer 3 说的是 **跨机 edge routing**——Master 用 `nginx-template.ts` 动态生成 upstream block + `map $http_x_branch → executor`，由运维部署到外层 nginx。
>
> 对于 **单机部署**，这一切都不需要：`cds/exec_cds.sh` 启动时根据 `CDS_ROOT_DOMAINS` 直接渲染一组固定的 `server_name D cds.D;` + `server_name *.D;` 到本机 nginx 容器，单节点入口由单节点自己解决。详见 `doc/design.cds.md §7.5`。
>
> 从单机升级到集群时：`cds/exec_cds.sh` 仍然在每个 executor 节点上运行（Layer 1 + 单节点 Layer 3），Master 只需额外部署 `nginx-template.ts` 生成的跨机 upstream 到边缘网关即可。两套 nginx 配置互不覆盖、互不替代。

---

## 九、小服务器集群部署 runbook

### 单节点（最常见场景）
```bash
cd cds

# 1. 首次初始化 (写 .cds.env + 渲染 nginx)
./exec_cds.sh init
#   CDS_USERNAME     [admin]: admin
#   CDS_PASSWORD     : ****
#   CDS_ROOT_DOMAINS : miduo.org,mycds.net

# 2. 编辑 cds.config.json 打开温池 + janitor
{
  "scheduler": { "enabled": true, "maxHotBranches": 3 },
  "janitor":   { "enabled": true, "worktreeTTLDays": 30, "diskWarnPercent": 80 }
}

# 3. 启动 (默认后台)
./exec_cds.sh start
# 或 systemd
sudo systemctl enable --now cds-master
```

### 双节点主从
```bash
# 机器 A (Master, 8GB): cds.config.json
{ "mode": "scheduler", "janitor": { "enabled": true } }
# 机器 B (Executor, 4GB): cds.config.json
{
  "mode": "executor",
  "schedulerUrl": "http://machine-a:9900",
  "executorToken": "shared-secret",
  "scheduler": { "enabled": true, "maxHotBranches": 3 }
}
# Nginx 配置由 Master 在 /api/executors/dispatch/:branch 调用后生成,
# 手动 reload 或通过 CI/CD
```

### 三节点以上
同双节点模式,只是执行 `executor` 角色的机器更多。`capacity-aware` 策略会自动平衡负载。

---

## 十、单机 vs 集群决策树

```
想解决的问题？
├─ "一台 4GB 机装不下我的 5 个分支" → Phase 1（启用 scheduler）
├─ "一个容器爆内存拖垮全机" → Phase 2 (cgroup limit)
├─ "磁盘被老 worktree 塞满" → Phase 2 (janitor)
├─ "CDS 崩了没人拉起" → Phase 2 (Dockerfile + systemd)
├─ "两个团队 10 个分支,单机扛不住" → Phase 3（加第二台机）
├─ "Nginx 是单点，挂了全停" → Phase 3 (upstream backup)
└─ "要跨地域部署" → Phase 3+ (多地域 executor + GeoDNS)
```

**反直觉的真相**：大多数"分布式部署"问题,其实是"一台机器没用好"的问题。在没有把 Phase 1 + Phase 2 榨干之前谈分布式,就是给没学会走路的婴儿买跑鞋。但**代码层面**的 Layer 1/2/3 必须提前设计好,否则将来改造成本很高——这就是本次 Phase 1+2+3 一次性交付的理由。

---

## 八、配置速查

```json
// cds.config.json 样例
{
  "repoRoot": "/home/user/prd_agent",
  "worktreeBase": "/home/user/.cds-worktrees",
  "masterPort": 9900,
  "workerPort": 5500,
  "dockerNetwork": "cds-network",
  "portStart": 10001,
  "scheduler": {
    "enabled": true,
    "maxHotBranches": 3,
    "idleTTLSeconds": 900,
    "tickIntervalSeconds": 60,
    "pinnedBranches": ["main"]
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `scheduler.enabled` | `false` | 未设置时保持现有行为（所有分支常驻），设为 true 后启用温池 |
| `scheduler.maxHotBranches` | `3` | 同时 HOT 的分支数上限。0 = 无限制（退化为传统模式） |
| `scheduler.idleTTLSeconds` | `900` | 超过此时间未访问则自动 cool |
| `scheduler.tickIntervalSeconds` | `60` | 后台扫描频率 |
| `scheduler.pinnedBranches` | `[]` | 强制 pinned 的分支 slug 列表（除了 defaultBranch） |

---

## 九、API 契约

### GET /api/scheduler/state

```json
{
  "enabled": true,
  "config": { "maxHotBranches": 3, "idleTTLSeconds": 900 },
  "hot": [
    { "slug": "main", "lastAccessedAt": "2026-04-09T10:00:00Z", "pinned": true },
    { "slug": "feature-a", "lastAccessedAt": "2026-04-09T09:55:12Z", "pinned": false }
  ],
  "cold": [
    { "slug": "feature-b", "lastAccessedAt": "2026-04-09T08:30:00Z" }
  ],
  "capacityUsage": { "current": 2, "max": 3 }
}
```

### POST /api/scheduler/pin/:slug
设置 `pinnedByUser = true`，响应 `{ ok: true, slug, pinned: true }`

### POST /api/scheduler/unpin/:slug
取消 pin，响应 `{ ok: true, slug, pinned: false }`

### POST /api/scheduler/cool/:slug
手动触发休眠（若已 pinned，返回 `409 Conflict`）

---

## 十、设计决策记录（ADR 摘要）

### ADR-1：为什么复用 auto-build 流程做唤醒，而不是新建 wake 协议

`cds/src/index.ts` 的 `onAutoBuild` 已经实现了"分支不存在/未运行 → SSE 构建"的完整用户体验。冷分支唤醒与首次构建在用户视角一致（看到进度条 → 完成 → 刷新），没有理由引入第二套协议。调度器只负责"cool（停止服务）"和"提示什么时候该 cool"，wake 完全委托给现有路径。

### ADR-2：为什么 heatState 字段可选而非必填

保持向后兼容：`scheduler.enabled=false` 时，整个温池机制绕过，行为与今日完全一致。升级 CDS 无需迁移老 state.json。

### ADR-3：为什么 pinning 不放在 scheduler 配置而放在 BranchEntry

用户通过 Dashboard UI 对单个分支点 pin 的交互远比修改 config 文件自然。`config.scheduler.pinnedBranches` 仅作为 bootstrap 默认值，启动时合并进 `BranchEntry.pinnedByUser`。

### ADR-4：为什么 tick 是被动触发 cool 而非主动平衡

主动平衡（周期性重排 HOT 集合）容易产生抖动——某分支刚被访问就被 cool 再次 warm。被动策略（只在达到上限或 idleTTL 到期时动作）更稳定，也符合 LRU 语义。

---

## 十一、参考代码路径

| 功能 | 路径 |
|---|---|
| 调度器主逻辑 | `cds/src/services/scheduler.ts` |
| 状态持久化加固 | `cds/src/services/state.ts` |
| 唤醒触发点（复用） | `cds/src/index.ts` `proxyService.setOnAutoBuild()` |
| touch 钩子 | `cds/src/services/proxy.ts` `routeToBranch()` |
| API 端点 | `cds/src/routes/branches.ts` `/api/scheduler/*` |
| 配置加载 | `cds/src/config.ts` `DEFAULT_CONFIG.scheduler` |
| 类型定义 | `cds/src/types.ts` `BranchEntry.heatState`, `CdsConfig.scheduler` |
| 单元测试 | `cds/tests/scheduler.test.ts` |
