# CDS (Cloud Development Suite) 技术架构文档

> **版本**：v3.0 | **日期**：2026-03-15 | **状态**：已落地
>
> 本文档聚焦**技术架构与实现设计**。功能需求见 `doc/spec.cds.md`。

## 一、管理摘要

- **解决什么问题**：多分支并行开发时缺乏隔离的测试环境，开发者需手动管理 Docker 容器、端口、路由
- **方案概述**：基于 Node.js + TypeScript 构建云开发套件，自动管理 Git worktree + Docker 容器编排 + 请求代理路由，每个分支独立环境
- **业务价值**：一键创建分支级隔离环境，支持多分支并行测试，消除环境冲突和手动运维成本
- **影响范围**：独立 cds/ 模块，对主项目仅改动 vite.config.ts 的 proxy target 支持环境变量
- **预计风险**：低 — 已落地运行，88 个测试用例覆盖核心服务层

---

## 0. Quickstart

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

## 1. 系统架构

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

## 2. 技术栈

| 层面 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript (Node.js 22) | 团队已有 TS 技术栈 |
| 测试 | Vitest | 快速、TS 原生支持 |
| Web 框架 | Express | 轻量 REST API |
| 进程执行 | child_process.exec | 通过 ShellExecutor 抽象可 mock |
| 状态存储 | JSON 文件 | 简单可靠，无需数据库 |

---

## 3. 项目结构

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

## 4. 服务层设计

### 4.1 ShellExecutor

可 mock 的 shell 命令执行层，所有外部命令（git/docker）通过此接口调用。

```typescript
interface IShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
```

### 4.2 StateService

状态持久化 + 端口分配 + 环境变量管理。

- `load()` / `save()` — JSON 文件读写
- `addBranch()` / `removeBranch()` — 分支 CRUD
- `allocatePort()` — 动态端口分配
- `getCdsEnvVars()` — 自动生成 CDS_* 系统变量
- `getMirrorEnvVars()` — 镜像加速变量
- `getCustomEnv()` — 用户自定义变量

### 4.3 WorktreeService

Git worktree 管理。

- `create(branch, targetDir)` — `git worktree add`
- `remove(targetDir)` — `git worktree remove`
- `list()` — `git worktree list`
- `branchExists(branch)` — 验证远程分支

### 4.4 ContainerService

Docker 容器生命周期。

- `start(entry, profile, env, config)` — 创建并启动容器
- `stop(containerName)` — `docker stop && docker rm`
- `isRunning(containerName)` — `docker inspect` 检查
- `getContainerNetwork()` — 网络连接检查
- 环境变量合并：`CDS_*` 自动变量 → 镜像加速变量 → 自定义变量 → Profile 专属变量

### 4.5 ProxyService

请求路由核心。

- `resolveBranch(req)` — 从请求解析目标分支
- `handleRequest(req, res)` — 代理转发
- 路径匹配：按 `pathPrefixes` 分发到不同服务
- 域名路由：支持 switch domain、preview subdomain

### 4.6 ComposeParser

CDS Compose YAML 解析与生成。

- `parseComposeFile()` / `parseComposeString()` — 解析标准 compose
- `parseCdsCompose()` — 解析含 `x-cds-*` 扩展的 compose
- `toCdsCompose()` — 生成 CDS Compose YAML
- `discoverComposeFiles()` — 自动发现项目中的 compose 文件

### 4.7 TopoSort

按 `dependsOn` 关系计算服务启动顺序，使用拓扑排序保证依赖先启动。

---

## 5. 环境变量体系

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

## 6. 配置文件 (cds.config.json)

```json
{
  "repoRoot": "/home/user/prd_agent",
  "worktreeBase": "/home/user/.cds-worktrees",
  "masterPort": 9900,
  "workerPort": 5500,
  "dockerNetwork": "prdagent-network",
  "portStart": 9001,
  "jwt": { "secret": "${CDS_JWT_SECRET}", "issuer": "prdagent" }
}
```

---

## 7. 对主项目的改动

唯一改动：`prd-admin/vite.config.ts` 中 proxy target 支持环境变量（向后兼容）。

```typescript
target: `http://localhost:${process.env.VITE_API_PORT || 5000}`
```

---

## 8. 测试覆盖

88 tests / 6 files，覆盖：state、worktree、container、proxy、compose-parser、topo-sort。

---

## 9. 技术债

| 类别 | 优先级 |
|------|--------|
| WebSocket 替代 10s 轮询 | P2 |
| 部署日志持久化 | P3 |
| 前端 E2E 测试 | P2 |
