# Branch Tester (bt) 设计文档

> **版本**：v1.0 | **日期**：2026-02-12 | **状态**：Implementation

## 1. 目标

提供一个独立的 Web + 后端服务，管理 prd_agent 项目的多分支并行验收。用户始终通过 `:5500` 访问，后台可一键切换到任意分支，支持即时回滚。

## 2. 核心原理：Nginx 热切换

```
用户浏览器 ──► :5500 (nginx gateway)     ← 已有的，不新增代理层
                   │
                   ├── /api/*  → proxy_pass http://{active-api-container}:8080
                   └── /*      → root /usr/share/nginx/html  (活跃分支的静态文件)

管理员 ────► :9900 (bt dashboard)         ← 本项目提供
                   │
                   ├── 查看/添加/删除分支
                   ├── 构建分支镜像 + 静态文件
                   ├── 启动/停止分支容器
                   ├── 切换激活分支 (改写 nginx.conf + reload)
                   └── 一键回滚
```

**切换原理**：所有分支的 API 容器预先启动在同一 Docker 网络中。切换 = 改写 `deploy/nginx/nginx.conf` 中的 `proxy_pass` upstream + 替换 `deploy/web/dist/` 中的静态文件 → `docker exec prdagent-gateway nginx -s reload`。Nginx reload 天然原子（新 worker 接新请求，旧 worker 处理完存量后退出），零停机。

## 3. 架构

```
┌────────────────────────────────────────────────────────────────┐
│  Host Machine                                                  │
│                                                                │
│  branch-tester/ (Node.js + TypeScript)                         │
│  ├── :9900 Dashboard API + Web UI                              │
│  ├── git worktree 管理 (~/.bt-worktrees/)                      │
│  ├── docker build / docker run 编排                            │
│  ├── nginx.conf 模板渲染 + reload 触发                         │
│  └── state.json 状态持久化                                     │
│                                                                │
│  ═══════════════ docker (prdagent-network) ════════════════     │
│                                                                │
│  gateway (:5500)  │  mongodb (:27017)  │  redis (:6379)        │
│  nginx            │  共享实例          │  共享实例              │
│                   │                    │                        │
│  api-main         │  DB: prdagent      │                        │
│  api-feature-a    │  DB: prdagent_1    │  ← bt 动态创建        │
│  api-hotfix-b     │  DB: prdagent_2    │  ← bt 动态创建        │
└────────────────────────────────────────────────────────────────┘
```

## 4. 数据模型

### 4.1 State (state.json)

```typescript
interface BtState {
  activeBranchId: string | null;
  history: string[];                // 激活历史栈
  branches: Record<string, BranchEntry>;
  nextPortIndex: number;            // 端口自增计数器 (未使用，预留)
}

interface BranchEntry {
  id: string;                       // slug 化的分支名 (e.g. "feature-new-ui")
  branch: string;                   // 原始分支名 (e.g. "feature/new-ui")
  worktreePath: string;             // git worktree 路径
  containerName: string;            // Docker 容器名
  imageName: string;                // Docker 镜像名
  dbName: string;                   // MongoDB 数据库名
  status: 'idle' | 'building' | 'running' | 'stopped' | 'error';
  buildLog?: string;                // 最近一次构建日志
  createdAt: string;
  lastActivatedAt?: string;
}
```

### 4.2 配置 (bt.config.json)

```json
{
  "repoRoot": "/home/user/prd_agent",
  "worktreeBase": "/home/user/.bt-worktrees",
  "deployDir": "deploy",
  "gateway": {
    "containerName": "prdagent-gateway",
    "port": 5500
  },
  "docker": {
    "network": "prdagent-network",
    "apiDockerfile": "prd-api/Dockerfile",
    "apiImagePrefix": "prdagent-server",
    "containerPrefix": "prdagent-api"
  },
  "mongodb": {
    "containerHost": "mongodb",
    "port": 27017,
    "defaultDbName": "prdagent"
  },
  "redis": {
    "connectionString": "redis:6379"
  },
  "jwt": {
    "secret": "${JWT_SECRET}",
    "issuer": "prdagent"
  },
  "dashboard": {
    "port": 9900
  }
}
```

## 5. 服务层设计

### 5.1 ShellExecutor

可 mock 的 shell 命令执行层，所有外部命令（git/docker/nginx）通过此接口调用。

```typescript
interface IShellExecutor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
```

### 5.2 StateService

状态持久化 + 端口分配 + 激活历史栈。

- `load()` / `save()` — JSON 文件读写
- `addBranch(branch)` — 新增分支条目
- `removeBranch(id)` — 删除分支条目
- `updateStatus(id, status)` — 更新状态
- `activate(id)` — 设置激活 + 压栈
- `rollback()` — 弹栈回退
- `allocateDbName(id)` — 生成唯一库名

### 5.3 WorktreeService

Git worktree 管理。

- `create(branch, targetDir)` — `git worktree add`
- `remove(targetDir)` — `git worktree remove`
- `list()` — `git worktree list`
- `branchExists(branch)` — 验证远程分支是否存在

### 5.4 ContainerService

Docker 容器生命周期。

- `start(entry: BranchEntry, config)` — `docker run`
- `stop(containerName)` — `docker stop && docker rm`
- `isRunning(containerName)` — `docker inspect`
- `healthCheck(containerName)` — HTTP 健康检查
- `getContainerNetwork(containerName)` — 检查网络连接

### 5.5 SwitcherService

Nginx 配置切换核心。

- `generateConfig(upstream, staticRoot)` — 从模板渲染 nginx.conf
- `backup()` — 备份当前 conf
- `applyConfig(config)` — 写入 + `nginx -t` 校验 + `nginx -s reload`
- `rollbackConfig()` — 恢复备份 + reload
- `syncStaticFiles(sourceBuildDir, targetDistDir)` — rsync 静态文件

### 5.6 BuilderService

分支构建编排。

- `buildApiImage(worktreePath, imageName)` — `docker build`
- `buildAdminStatic(worktreePath, outputDir)` — `pnpm install && pnpm build`
- `buildAll(entry)` — 编排 API + Admin 并行构建

## 6. API 接口

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/branches` | 列出所有分支 + 状态 |
| POST | `/api/branches` | 添加分支 `{ branch: "feature/xxx" }` |
| DELETE | `/api/branches/:id` | 删除分支 (停止 + 删 worktree + 删镜像) |
| POST | `/api/branches/:id/build` | 构建分支 (镜像 + 静态文件) |
| POST | `/api/branches/:id/start` | 启动分支容器 |
| POST | `/api/branches/:id/stop` | 停止分支容器 |
| POST | `/api/branches/:id/activate` | 切换激活 (预检 → 备份 → 切换 → 验证) |
| POST | `/api/rollback` | 回滚到上一个激活分支 |
| GET | `/api/history` | 激活历史记录 |
| GET | `/api/config` | 当前配置信息 |

## 7. 切换流程 (activate)

```
POST /api/branches/:id/activate
  │
  ├─ 1. 预检
  │    ├── branch.status === 'running' ?
  │    ├── docker inspect containerName → 容器存在且运行中?
  │    └── 任一失败 → 400 "Branch not running, start it first"
  │
  ├─ 2. 备份当前 nginx.conf
  │    └── cp nginx.conf → nginx.conf.rollback
  │
  ├─ 3. 同步静态文件
  │    └── rsync -a --delete builds/{branch}/ deploy/web/dist/
  │
  ├─ 4. 生成新 nginx.conf
  │    └── 模板渲染: proxy_pass http://{containerName}:8080
  │
  ├─ 5. 语法校验
  │    └── docker exec gateway nginx -t
  │    └── 失败 → 恢复 .rollback → 500
  │
  ├─ 6. 原子 reload
  │    └── docker exec gateway nginx -s reload
  │
  ├─ 7. 更新状态
  │    ├── state.activate(id)
  │    └── state.save()
  │
  └─ 8. 返回 { success, activeUrl }
```

## 8. 回滚流程

```
POST /api/rollback
  │
  ├─ 1. 从 history 取上一条
  │    └── 空栈 → 400 "No history to rollback"
  │
  ├─ 2. 检查目标分支容器是否在运行
  │    └── 没运行 → 自动启动
  │
  ├─ 3. 执行标准 activate 流程
  │    └── (备份 → 同步 → 渲染 → 校验 → reload)
  │
  └─ 4. history 弹出当前条目
```

## 9. Nginx 配置模板

```nginx
server {
    listen 80;
    server_name _;
    client_max_body_size 30m;
    absolute_redirect off;
    port_in_redirect off;

    root /usr/share/nginx/html;
    index index.html;

    # API 反代 — bt 动态切换此 upstream
    location ^~ /api/ {
        proxy_pass http://{{UPSTREAM}}:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 3s;
        proxy_send_timeout 60s;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    location ^~ /assets/ {
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800" always;
    }

    location ~* \.(?:js|css|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|json|txt)$ {
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800" always;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

## 10. 技术栈

| 层面 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript (Node.js 22) | 团队已有 TS 技术栈，零学习成本 |
| 测试 | Vitest | 快速、TS 原生支持、TDD 友好 |
| Web 框架 | Express | 轻量、成熟、仅需简单 REST API |
| 前端 | 原生 HTML + CSS + JS | 工具型项目无需框架，单页即可 |
| 进程执行 | child_process.exec | Node 原生，通过 ShellExecutor 抽象可 mock |
| 状态存储 | JSON 文件 | 简单可靠，无需数据库 |

## 11. 项目结构

```
branch-tester/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── bt.config.example.json
├── src/
│   ├── index.ts              # 入口
│   ├── server.ts             # Express 服务器
│   ├── config.ts             # 配置加载
│   ├── types.ts              # 类型定义
│   ├── services/
│   │   ├── shell-executor.ts # Shell 命令执行 (可 mock)
│   │   ├── state.ts          # 状态持久化
│   │   ├── worktree.ts       # Git worktree 管理
│   │   ├── container.ts      # Docker 容器管理
│   │   ├── switcher.ts       # Nginx 切换核心
│   │   └── builder.ts        # 构建编排
│   ├── routes/
│   │   └── branches.ts       # API 路由
│   └── templates/
│       └── nginx.conf.ts     # Nginx 配置模板
├── tests/
│   ├── services/
│   │   ├── state.test.ts
│   │   ├── worktree.test.ts
│   │   ├── container.test.ts
│   │   ├── switcher.test.ts
│   │   └── builder.test.ts
│   └── routes/
│       └── branches.test.ts
└── web/
    ├── index.html
    ├── app.js
    └── style.css
```

## 12. 对主项目的改动

唯一改动：`prd-admin/vite.config.ts` 中 proxy target 支持环境变量（向后兼容）。

```typescript
// 改动前
target: 'http://localhost:5000'

// 改动后
target: `http://localhost:${process.env.VITE_API_PORT || 5000}`
```

此改动仅影响本地开发模式，不影响生产构建（生产构建为静态文件由 nginx 代理）。
