# CDS (Cloud Development Suite) 技术架构文档

> **版本**：v3.1 | **日期**：2026-04-09 | **状态**：已落地
>
> 本文档是 CDS 的**主入口文档**，聚焦**核心思想 + 技术架构**。功能需求见 `doc/spec.cds.md`，容量与故障隔离见 `doc/design.cds-resilience.md`。

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
    ├─ 功能是什么      → spec.cds.md
    ├─ 怎么装          → guide.cds-env.md
    ├─ 怎么不宕机      → design.cds-resilience.md   【本次新增】
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
| **spec.cds.md** | spec | 想知道 CDS 具体能做什么（功能清单 F1-F11） |
| **design.cds-resilience.md** | design | 在小服务器部署、关心容量与宕机恢复 |
| **plan.cds-deployment.md** | plan | 要真实上线一台服务器，需要部署步骤 |
| **guide.cds-env.md** | guide | 配置环境变量、调试启动问题 |
| **guide.cds-ai-auth.md** | guide | 遇到认证/JWT 问题排查 |
| **design.cds-onboarding.md** | design | 要做"一键从项目导入 CDS 配置"的功能 |
| **design.cds-data-migration.md** | design | 涉及跨环境数据迁移 |
| **plan.cds-roadmap.md** | plan | 规划下一阶段做什么 |

---

## 1. Quickstart

### 前置条件

- Node.js >= 20
- Docker（用于管理分支容器）
- Git（用于 worktree 管理）

### 一键启动

```bash
cd cds

./exec_cds.sh              # 前台
./exec_cds.sh dev          # 开发（热重载）
./exec_cds.sh --background # 后台
./exec_cds.sh stop         # 停止
./exec_cds.sh status       # 查看状态
./exec_cds.sh logs         # 查看日志
```

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
| 系统层 | `.bashrc` | CDS 自身配置 | `CDS_` |
| 项目层 | `.cds/state.json` | 注入业务容器 | 无限制 |

### 系统层变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDS_USERNAME` | — | Dashboard 登录用户名 |
| `CDS_PASSWORD` | — | Dashboard 登录密码 |
| `CDS_JWT_SECRET` | dev 默认值 | JWT 签名密钥 (>= 32 字节) |
| `CDS_SWITCH_DOMAIN` | — | 分支切换域名 |
| `CDS_MAIN_DOMAIN` | — | 主域名 |
| `CDS_PREVIEW_DOMAIN` | — | 预览域名后缀 |
| `CDS_NGINX_ENABLE` | — | 启用 Nginx 反向代理 |

> 向后兼容：旧前缀 `BT_*` / 无前缀变量仍可使用，`CDS_` 优先。

详细配置指南见 `doc/guide.cds-env.md`。

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

## 8. 高可用与容量（v3.1）

小服务器场景下 CDS 有几个致命风险：单分支 runaway、state.json 损坏、Master 崩溃、磁盘爆满。v3.1 通过**分支温池 + 原子写 + 滚动备份**解决其中一部分，详见：

- **设计文档**：`doc/design.cds-resilience.md`
- **落地进度**：`doc/plan.cds-resilience-rollout.md`

三个层次的改造：

| 层次 | 内容 | 状态 |
|---|---|---|
| Phase 1 | 调度器（温池 + LRU） + state 原子写 + API | 本版本 ✅ |
| Phase 2 | cgroup 限制 + Master 容器化 + janitor | 下版本 ⏳ |
| Phase 3 | 双实例 + Nginx upstream + 共享状态 | 远期 ⏳ |

核心理念：**CDS 不追求"所有分支常驻"，而追求"按需唤醒、快速命中、永不超载"**。在 4GB 机器上默认 `maxHotBranches=3`，通过 LRU 驱逐让温池保持可预测的资源消耗。

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
| `spec.cds.md` | 功能规格 F1-F11 |
| `design.cds-resilience.md` | 容量预算、LRU 调度、故障矩阵 |
| `design.cds-onboarding.md` | 一键导入配置 + AI 项目扫描 |
| `design.cds-data-migration.md` | 跨环境数据迁移 |
| `plan.cds-deployment.md` | 三种部署模式对比 + 端口分配 |
| `plan.cds-roadmap.md` | Phase 0-3 里程碑 |
| `plan.cds-resilience-rollout.md` | 高可用改造落地进度（可续传）|
| `guide.cds-env.md` | 环境变量配置指南 |
| `guide.cds-ai-auth.md` | 认证问题故障排查 |
