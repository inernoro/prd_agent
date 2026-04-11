# CDS (Cloud Development Suite) 技术架构文档

> **版本**：v3.2 | **日期**：2026-04-10 | **状态**：已落地
>
> 本文档是 CDS 的**主入口文档**，聚焦**核心思想 + 技术架构**。功能需求见 `doc/spec.cds.md`，容量与故障隔离（含跨机负载均衡）见 `doc/design.cds-resilience.md`。
>
> **v3.2 关键变更**：运维入口统一为单一 `cds/exec_cds.sh init|start|stop|restart` 脚本；Nginx 配置改为启动时按 `.cds.env` 幂等渲染，支持 `CDS_ROOT_DOMAINS` 逗号分隔的多根域名，无需域名迁移即可同时承载 `miduo.org` / `mycds.net` 等多套入口。

## 一、管理摘要

- **解决什么问题**：多分支并行开发时缺乏隔离的测试环境，开发者需手动管理 Docker 容器、端口、路由
- **方案概述**：基于 Node.js + TypeScript 构建云开发套件，自动管理 Git worktree + Docker 容器编排 + 请求代理路由，每个分支独立环境
- **业务价值**：一键创建分支级隔离环境，支持多分支并行测试，消除环境冲突和手动运维成本
- **影响范围**：独立 cds/ 模块,对主项目仅改动 vite.config.ts 的 proxy target 支持环境变量
- **预计风险**：低 — 已落地运行，88+ 个测试用例覆盖核心服务层

---

## 0. 核心思想（Why CDS）

### 一句话定义

> **CDS 是"Git 分支即环境"的单机编排器**。它把一条 Git 分支自动映射为一组隔离的 Docker 容器（API + Web + 基础设施），通过内置反向代理让同一个域名按 Header/Cookie/域名在多个分支间瞬时切换。目标是让 4 人以下小团队在**一台小型服务器**上就能跑起 5-10 个并行特性分支的验收环境，无需 K8s、无需多机集群。

### 和同类方案的区别

| 维度 | docker-compose | K8s / Argo | Gitpod / Coder | **CDS** |
|---|---|---|---|---|
| 分支即环境 | 手动多份 compose | Helm + 命名空间 | ✅ | ✅ |
| 单机可用 | ✅ | ❌ 至少 3 节点 | ❌ 需托管 | ✅ |
| 切换分支 | 改配置 + 重启 | 改 Ingress | 切 workspace | **Header/Cookie 实时切** |
| 运维成本 | 高 | 极高 | 中（有托管费） | **近零** |
| 生产可用 | ❌ | ✅ | ⚠️ | ❌ 定位为开发/验收 |

### 三大设计 DNA

1. **分支隔离 ≠ 基础设施隔离**：MongoDB/Redis 全局共享（单实例），业务容器按分支隔离——用最小的资源代价获得最大的隔离收益
2. **动态路由 > 域名分发**：一个主域名 + Header 解析，避免证书通配 + DNS 泛解析的运维负担
3. **状态可见即可控**：JSON + Dashboard，人类可读可改，不上数据库

### 适用场景

- ✅ 多团队并行特性开发、QA 验收环境、CI/CD 分支预览
- ✅ 目标用户：开发者、QA、产品经理（需要快速切换多分支）
- ❌ 不适合：生产环境高可用、跨地域部署、大规模微服务

---

## 0.5 文档地图

CDS 的文档按职责划分，推荐按以下顺序阅读：

```
主入口：design.cds.md  ← 你在这里
    │
    ├─ 一分钟起步      → guide.quickstart.md
    ├─ 环境变量与多域名 → guide.cds-env.md
    ├─ 功能是什么      → spec.cds.md
    ├─ 怎么不宕机      → design.cds-resilience.md
    ├─ 怎么部署        → plan.cds-deployment.md
    ├─ 路线图          → plan.cds-roadmap.md
    ├─ 一键导入配置    → design.cds-onboarding.md
    ├─ 数据迁移        → design.cds-data-migration.md
    ├─ 认证陷阱        → guide.cds-ai-auth.md
    └─ 历史验收报告    → report.cds-api-full-test-*.md
```

| 文档 | 类型 | 什么时候读 |
|---|---|---|
| **design.cds.md** | design | 首次了解 CDS、理解整体架构 |
| **guide.quickstart.md** | guide | 立刻上手 init/start/stop/restart + 多根域名 |
| **guide.cds-env.md** | guide | 配置 .cds.env、理解 CDS_ROOT_DOMAINS 的路由生成规则 |
| **spec.cds.md** | spec | 想知道 CDS 具体能做什么（功能清单 F1-F11） |
| **design.cds-resilience.md** | design | 在小服务器部署、关心容量/温池调度/跨机负载均衡 |
| **plan.cds-deployment.md** | plan | 要真实上线一台服务器，需要部署步骤 |
| **guide.cds-ai-auth.md** | guide | 遇到认证/JWT 问题排查 |
| **design.cds-onboarding.md** | design | 要做"一键从项目导入 CDS 配置"的功能 |
| **design.cds-data-migration.md** | design | 涉及跨环境数据迁移 |
| **plan.cds-roadmap.md** | plan | 规划下一阶段做什么 |

---

## 1. Quickstart

### 前置条件

- Node.js >= 20
- pnpm
- Docker（用于管理分支容器 + 宿主 nginx 容器）
- Git（用于 worktree 管理）

### 一键启动（v3.2 统一入口）

```bash
cd cds

./exec_cds.sh init        # 首次初始化：交互式写 .cds.env + 渲染 nginx 配置
./exec_cds.sh start       # 默认后台启动 (等同 daemon / --background / -d)
./exec_cds.sh start --fg  # 前台启动 (调试)
./exec_cds.sh stop        # 停止 CDS + Nginx
./exec_cds.sh restart     # 重启
./exec_cds.sh status      # 查看 CDS / Nginx 运行状态
./exec_cds.sh logs        # 跟随 cds.log (Ctrl+C 退出)
./exec_cds.sh cert        # 为 CDS_ROOT_DOMAINS 的每个域名签发 Let's Encrypt 证书
```

根目录下的 `prd_agent/exec_cds.sh` 是转发器，等价于 `cds/exec_cds.sh`——无需 `cd cds/` 也能调用。

所有命令都会 source `cds/.cds.env`（唯一用户配置入口），不再依赖 `.bashrc` 或环境变量。`daemon` / `--background` / `-d` 保留为 `start` 的历史别名，供 CDS 自更新（`branches.ts` 里 spawn `./exec_cds.sh daemon`）继续使用。

### 运行测试

```bash
cd cds && npx vitest run    # 88 tests, 6 files
```

---

## 2. 系统架构

```
┌────────────────────────────────────────────────────────────────┐
│  Host Machine                                                  │
│                                                                │
│  cds/ (Node.js + TypeScript)                                   │
│  ├── :9900 Dashboard API + Web UI                              │
│  ├── git worktree 管理 (~/.cds-worktrees/)                     │
│  ├── docker 容器编排                                           │
│  ├── 代理路由（分支解析 + 请求转发）                            │
│  └── state.json 状态持久化                                     │
│                                                                │
│  ═══════════════ docker (prdagent-network) ════════════════     │
│                                                                │
│  infra-mongodb   │  infra-redis   │  branch-a/api  :9001       │
│  :27017          │  :6379         │  branch-a/web  :9002       │
│                  │                │  branch-b/api  :9003       │
│                  │                │  branch-b/web  :9004       │
└────────────────────────────────────────────────────────────────┘
```

### 请求路由原理

所有分支容器运行在同一 Docker 网络。代理服务根据请求头/Cookie/域名/路径规则解析目标分支，按 `pathPrefixes` 匹配目标服务，将请求转发到对应的 `localhost:{hostPort}`。

分支解析优先级：`X-Branch` header → `cds_branch` cookie → 域名路由规则 → 默认分支

---

## 3. 技术栈

| 层面 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript (Node.js 22) | 团队已有 TS 技术栈 |
| 测试 | Vitest | 快速、TS 原生支持 |
| Web 框架 | Express | 轻量 REST API |
| 进程执行 | child_process.exec | 通过 ShellExecutor 抽象可 mock |
| 状态存储 | JSON 文件 | 简单可靠，无需数据库 |

---

## 4. 项目结构

```
cds/
├── src/
│   ├── index.ts              # 入口，基础设施发现
│   ├── server.ts             # Express 服务器，JWT 认证，静态文件
│   ├── config.ts             # 配置加载
│   ├── types.ts              # 类型定义
│   ├── services/
│   │   ├── shell-executor.ts # Shell 命令执行 (可 mock)
│   │   ├── state.ts          # 状态持久化 + 端口分配
│   │   ├── worktree.ts       # Git worktree 管理
│   │   ├── container.ts      # Docker 容器生命周期
│   │   ├── proxy.ts          # 路由代理 + 分支解析
│   │   ├── compose-parser.ts # Compose YAML 解析
│   │   └── topo-sort.ts      # 依赖拓扑排序
│   ├── routes/
│   │   └── branches.ts       # API 路由 (~600 行)
│   └── templates/
│       └── nginx.conf.ts     # Nginx 配置模板
├── web/                      # Dashboard 前端
├── tests/                    # 88 tests, 6 files
├── nginx/                    # Nginx 配置模板
└── Dockerfile
```

---

## 5. 服务层设计

### 5.1 ShellExecutor

可 mock 的 shell 命令执行层，所有外部命令（git/docker）通过此接口调用。

```typescript
interface IShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
```

### 5.2 StateService

状态持久化 + 端口分配 + 环境变量管理。

- `load()` / `save()` — JSON 文件读写（v3.1 起为**原子写 + 滚动备份**，见 `design.cds-resilience.md §5`）
- `addBranch()` / `removeBranch()` — 分支 CRUD
- `allocatePort()` — 动态端口分配
- `getCdsEnvVars()` — 自动生成 CDS_* 系统变量
- `getMirrorEnvVars()` — 镜像加速变量
- `getCustomEnv()` — 用户自定义变量

### 5.3 WorktreeService

Git worktree 管理。

- `create(branch, targetDir)` — `git worktree add`
- `remove(targetDir)` — `git worktree remove`
- `list()` — `git worktree list`
- `branchExists(branch)` — 验证远程分支

### 5.4 ContainerService

Docker 容器生命周期。

- `start(entry, profile, env, config)` — 创建并启动容器
- `stop(containerName)` — `docker stop && docker rm`
- `isRunning(containerName)` — `docker inspect` 检查
- `getContainerNetwork()` — 网络连接检查
- 环境变量合并：`CDS_*` 自动变量 → 镜像加速变量 → 自定义变量 → Profile 专属变量

### 5.5 ProxyService

请求路由核心。

- `resolveBranch(req)` — 从请求解析目标分支
- `handleRequest(req, res)` — 代理转发
- 路径匹配：按 `pathPrefixes` 分发到不同服务
- 域名路由：支持 switch domain、preview subdomain

### 5.6 ComposeParser

CDS Compose YAML 解析与生成。

- `parseComposeFile()` / `parseComposeString()` — 解析标准 compose
- `parseCdsCompose()` — 解析含 `x-cds-*` 扩展的 compose
- `toCdsCompose()` — 生成 CDS Compose YAML
- `discoverComposeFiles()` — 自动发现项目中的 compose 文件

### 5.7 TopoSort

按 `dependsOn` 关系计算服务启动顺序，使用拓扑排序保证依赖先启动。

### 5.8 SchedulerService（v3.1 新增）

分支温池调度器，在小服务器上按需唤醒/休眠分支，避免资源超售。详见 `doc/design.cds-resilience.md`。

- `start()` / `stop()` — 启动/停止后台 tick
- `touch(slug)` — 代理命中分支时更新 lastAccess
- `markHot(slug)` / `markCold(slug)` — 手动状态迁移
- `evictLruIfOverCapacity()` — 容量超标时驱逐 LRU 分支
- `pin(slug)` / `unpin(slug)` — 保护指定分支不被驱逐
- `getSnapshot()` — Dashboard 展示用的当前状态

默认 `enabled: false`，保持与老版本完全一致的行为。启用后按 `maxHotBranches` / `idleTTLSeconds` / `pinnedBranches` 配置工作。

---

## 6. 环境变量体系

### 两层架构

| 层 | 存储位置 | 用途 | 变量前缀 |
|----|----------|------|----------|
| 系统层 | `cds/.cds.env` | CDS 自身配置 | `CDS_` |
| 项目层 | `.cds/state.json` | 注入业务容器 | 无限制 |

**v3.2 变更**：系统层变量统一收拢到 `cds/.cds.env`，由 `./exec_cds.sh init` 交互式生成；**不再使用 `.bashrc`**，避免与宿主其他 CDS_* 环境变量冲突。所有命令启动时自动 `source` 这一个文件，保证开发机和 systemd 服务的行为一致。

### 系统层变量（收敛为 4 个）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDS_USERNAME` | — | Dashboard 登录用户名（设置后启用认证） |
| `CDS_PASSWORD` | — | Dashboard 登录密码 |
| `CDS_JWT_SECRET` | init 自动生成 | JWT 签名密钥（>= 32 字节，首次运行自动 `openssl rand -base64 32`） |
| `CDS_ROOT_DOMAINS` | — | 根域名列表，逗号分隔（如 `miduo.org,mycds.net`） |

旧的 `CDS_SWITCH_DOMAIN` / `CDS_MAIN_DOMAIN` / `CDS_PREVIEW_DOMAIN` / `CDS_DASHBOARD_DOMAIN` / `CDS_NGINX_ENABLE` 均已废弃。`src/config.ts` 保留对它们的读取作为临时兼容，但 `.cds.env` 只写 4 个变量；新的部署推荐只认 `CDS_ROOT_DOMAINS`。

详细配置指南见 `doc/guide.cds-env.md`，Quickstart 另见 `doc/guide.quickstart.md`。

---

## 7. 配置文件 (cds.config.json)

```json
{
  "repoRoot": "/home/user/prd_agent",
  "worktreeBase": "/home/user/.cds-worktrees",
  "masterPort": 9900,
  "workerPort": 5500,
  "dockerNetwork": "prdagent-network",
  "portStart": 9001,
  "jwt": { "secret": "${CDS_JWT_SECRET}", "issuer": "prdagent" },
  "scheduler": {
    "enabled": true,
    "maxHotBranches": 3,
    "idleTTLSeconds": 900,
    "tickIntervalSeconds": 60,
    "pinnedBranches": ["main"]
  }
}
```

`scheduler` 段为 v3.1 新增，用于启用分支温池调度器。详见 `doc/design.cds-resilience.md §四、八`。

---

## 7.5 运维入口与 Nginx 渲染（v3.2 新增）

### 7.5.1 为什么只留一个脚本

v3.1 之前 CDS 的运维脚本散落成：

```
prd_agent/exec_cds.sh          # 根目录旧转发器，init/daemon 分叉
cds/exec_cds.sh                # cds/ 里另一个 start/daemon 实现
cds/exec_setup.sh              # 交互式配置写 .cds.env
cds/nginx/init_domain.sh       # 从 domain.env 生成 nginx 配置
cds/nginx/start_nginx.sh       # 起 nginx compose 容器
cds/nginx/acme_apply.sh        # 证书签发
cds/host-env.example.sh        # 遗留的环境变量样板
```

三个配置源（`.cds.env` / `domain.env` / `.bashrc`）相互覆盖、命令行参数十几种、每个命令调用链要跨 2-3 个脚本——自更新日志里出现任何 nginx/配置相关字样都无法判断是正常还是异常。

**v3.2 统一为**：

```
cds/exec_cds.sh    # 唯一运维入口，包含 init/start/stop/restart/status/logs/cert
cds/.cds.env       # 唯一用户配置 (只有 4 个变量)
cds/nginx/*.conf   # 纯生成产物，gitignore
```

根目录 `prd_agent/exec_cds.sh` 只是一条 `exec "$SCRIPT_DIR/cds/exec_cds.sh" "$@"` 的转发器，不含任何业务逻辑。

### 7.5.2 Nginx 多根域名路由规则

**硬性规则**：对 `CDS_ROOT_DOMAINS` 中的每一个根域名 `D`，自动生成三条固定路由：

| Host | 目标 | 说明 |
|------|------|------|
| `D` | Dashboard (master) | 例如 `miduo.org` → `http://127.0.0.1:9900` |
| `cds.D` | Dashboard (master) | 别名，例如 `cds.miduo.org` 同样到 Dashboard |
| `*.D` | Preview (worker) | 任意子域名 → `http://127.0.0.1:5500`，典型 `feat-abc.miduo.org` |

nginx 的精确匹配优先级天然高于通配符，`cds.D` 不会被 `*.D` 误吞。多个根域名相互独立，配置 `CDS_ROOT_DOMAINS="miduo.org,mycds.net"` 即**同时**承载 6 组入口，无需域名迁移。

```
                         ┌────────────────┐
  miduo.org ──────┐      │                │
  cds.miduo.org ──┤      │                │
  mycds.net ──────┼──────┤  cds_master    ├──► 127.0.0.1:9900 (Dashboard)
  cds.mycds.net ──┘      │                │
                         └────────────────┘

                         ┌────────────────┐
  *.miduo.org ────┐      │                │
  *.mycds.net ────┼──────┤  cds_worker    ├──► 127.0.0.1:5500 (Preview)
                  │      │                │
                         └────────────────┘
```

### 7.5.3 TLS：每根域名独立签发 + 渐进式 HTTPS

- `cds/nginx/certs/<D>.crt` + `<D>.key` 存在 → 该域名 server block 同时监听 80 和 443
- 不存在 → 该域名只监听 80（HTTP-only 兜底）
- `./exec_cds.sh cert` 遍历 `CDS_ROOT_DOMAINS`，对每个 `D` 用 `acme.sh` webroot 模式签发 `D + cds.D`
- 一个根域名签发失败不影响其它根域名继续用 HTTP；已签发的域名下次 `restart` 自动升级到 HTTPS

通配符 `*.D` 的 HTTPS 需要 DNS 挑战（本脚本未内置）。需要子域名 HTTPS 时，可自行用 DNS API 签发后把证书落到 `cds/nginx/certs/`，渲染器会自动捡起来。

### 7.5.4 幂等渲染：自更新不噪音、不丢配置

`render_nginx()` 的 3 个产物（`nginx.conf` / `cds-site.conf` / `nginx.compose.yml`）都走 `write_if_changed` 对比写入：

```bash
write_if_changed() {
  local target="$1" content="$2"
  if [ -f "$target" ] && printf '%s' "$content" | cmp -s - "$target"; then
    return 0                                 # 内容无变化 → 不触碰文件
  fi
  printf '%s' "$content" > "$target"
  NGINX_CHANGED_FILES+="$(basename "$target") "
}
```

`nginx_up()` 根据 `NGINX_CHANGED_FILES` 的内容分三档响应：

| 变化范围 | 动作 | 用户影响 |
|---------|------|---------|
| 容器未运行 **或** `nginx.compose.yml` 变了 | `docker compose up -d` | 约 1 秒停机（容器重建） |
| 仅 `cds-site.conf` / `nginx.conf` 变了（容器在跑） | `docker exec … nginx -t && nginx -s reload` | 零停机热重载 |
| 什么都没变 | 静默跳过 | 零影响 |

这直接服务于 CDS 自更新：`branches.ts:3341` 里 spawn 的 `./exec_cds.sh daemon` 每次启动都会走 `nginx_up`，但在配置无变化时**完全不打印**任何 nginx 相关日志、也不触碰 nginx 容器，自更新窗口的影响仅限于 `npx tsc` + `node dist/index.js` 的几秒内核切换。

### 7.5.5 单节点 nginx 与跨机 dispatcher 的边界

v3.2 的 `exec_cds.sh` 只解决**单节点 Layer 3 入口**问题，与 v3.3 Phase 3 的分布式 `nginx-template.ts` 互为补充、互不替代：

| 层次 | 由谁生成 | 何时用 |
|------|----------|-------|
| **单节点入口** | `exec_cds.sh render_nginx` | 单机部署；本地/小团队；每根域名 = 一组固定 server block | 
| **跨机入口** | `src/scheduler/nginx-template.ts` | Phase 3 集群调度；Master + N 个 Executor；按 `$http_x_branch` 在 executors 间路由 | 

两者生成的配置文件**不会同时存在**：单机模式下 `exec_cds.sh` 输出 `cds-site.conf`，集群模式下由 dispatcher 下发的 `nginx-template.ts` 结果由运维贴到边缘网关。升级到集群时，只需在边缘网关改用后者即可，CDS 内部的调度器逻辑（Phase 1 的 `SchedulerService`）不变。

详见：

- 单节点入口设计 → 本节
- 温池调度与容量算法 → `doc/design.cds-resilience.md §二、四`
- 跨机 dispatcher + Layer 3 edge nginx 生成器 → `doc/design.cds-resilience.md §八`

---

## 8. 高可用、容量与分布式（v3.1 / v3.2 / v3.3）

小服务器场景下 CDS 有几个致命风险：单分支 runaway、state.json 损坏、Master 崩溃、磁盘爆满、单点宕机。这一块通过**分支温池 + cgroup 限制 + Janitor + Master 容器化 + 分布式调度**逐层解决，详见：

- **设计文档**：`doc/design.cds-resilience.md`（Phase 1-3 完整方案）
- **落地进度**：`doc/plan.cds-resilience-rollout.md`（可续传 checklist）

三个层次的改造：

| 层次 | 内容 | 状态 |
|---|---|---|
| **v3.1 Phase 1** | 调度器（温池 + LRU） + state 原子写 + API | ✅ 已发布 |
| **v3.2 Phase 2** | 容器 cgroup + Janitor + CDS Master 容器化 + `/healthz` + systemd unit | ✅ 代码已落地 |
| **v3.3 Phase 3** | BranchDispatcher（跨机容量派发） + Nginx upstream 模板生成器 + POST /api/executors/dispatch/:branch | ✅ 代码已落地 |
| Phase 3 后续 | 分支迁移 + 共享状态存储 + Webhook 预热 | ⏳ 待规划 |

核心理念：
- **单机层**："CDS 不追求所有分支常驻,而追求按需唤醒、快速命中、永不超载"。`maxHotBranches=3` + LRU 驱逐
- **集群层**："Master 不做单机决策,只做派发决策。它读每个 executor 的 `/api/scheduler/state`,按 `capacityUsage.current/max` 比率选最空闲的"
- **三层独立演进**：Layer 1（per-node warm pool）/ Layer 2（cluster scheduler）/ Layer 3（edge nginx）各自有接口,上层不假设下层实现

**Phase 1 的 SchedulerService 就是 Layer 1**——把它部署到每个 executor 节点,集群能力自动浮现。这是 Phase 1+2+3 一次性交付的战略价值：代码层面三层 ready,运维可以只用单机 Phase 1+2 起步,等团队壮大时无缝升级到 Phase 3 分布式,不需要重写。

---

## 9. 对主项目的改动

唯一改动：`prd-admin/vite.config.ts` 中 proxy target 支持环境变量（向后兼容）。

```typescript
target: `http://localhost:${process.env.VITE_API_PORT || 5000}`
```

---

## 10. 测试覆盖

88+ tests / 7 files，覆盖：state、worktree、container、proxy、compose-parser、topo-sort、scheduler（v3.1 新增）。

---

## 11. 技术债

| 类别 | 优先级 |
|------|--------|
| WebSocket 替代 10s 轮询 | P2 |
| 部署日志持久化 | P3 |
| 前端 E2E 测试 | P2 |
| 容器 cgroup 限制 | P1（见 resilience Phase 2）|
| Master 容器化 + 自愈 | P1（见 resilience Phase 2）|
| worktree/磁盘 janitor | P2（见 resilience Phase 2）|
| 双实例 + 共享状态 | P3（见 resilience Phase 3）|

---

## 12. 关联文档

| 文档 | 内容 |
|---|---|
| `guide.quickstart.md` | init/start/stop/restart 快速上手 + 多根域名速查 |
| `guide.cds-env.md` | `.cds.env` 配置、`CDS_ROOT_DOMAINS` 多域名路由规则 |
| `spec.cds.md` | 功能规格 F1-F11 |
| `design.cds-resilience.md` | 容量预算、LRU 调度、故障矩阵、跨机负载均衡 |
| `design.cds-onboarding.md` | 一键导入配置 + AI 项目扫描 |
| `design.cds-data-migration.md` | 跨环境数据迁移 |
| `plan.cds-deployment.md` | 三种部署模式对比 + 端口分配 |
| `plan.cds-roadmap.md` | Phase 0-3 里程碑 |
| `plan.cds-resilience-rollout.md` | 高可用改造落地进度（可续传）|
| `guide.cds-ai-auth.md` | 认证问题故障排查 |
