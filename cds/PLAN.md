# CDS 调度端/执行端拆分方案

## 当前问题

1. **单机瓶颈**：所有分支的容器运行在同一台机器，内存不够就全挂（502）
2. **单点故障**：CDS 进程和容器在同一机器，OOM 时调度本身也挂
3. **无法水平扩展**：新增服务器无法接入

## 目标架构

```
┌─────────────────────────────────────────────┐
│  CDS Scheduler (调度端)                      │
│  端口 9900 (Dashboard + API)                 │
│  端口 5500 (Worker Proxy)                    │
│                                             │
│  职责:                                      │
│  - Web 管理面板                              │
│  - 全局状态管理                              │
│  - 路由规则 & 请求分发                        │
│  - 执行器注册/心跳监控                        │
│  - 部署任务调度 (选择执行器)                   │
│  - 基础设施服务管理 (集中定义)                 │
│                                             │
│  部署: 轻量，内存 ~100MB                      │
└─────────┬───────────────────────────────────┘
          │ HTTP API + WebSocket (状态推送)
          │
    ┌─────┴─────┐
    │           │
┌───▼───┐  ┌───▼───┐
│Executor│  │Executor│  ...可横向扩展
│ 节点 A │  │ 节点 B │
│ :9901  │  │ :9901  │
│        │  │        │
│ 职责:  │  │ 职责:  │
│ - Docker│  │ - Docker│
│ - Git   │  │ - Git   │
│ - 构建  │  │ - 构建  │
│ - 健康  │  │ - 健康  │
│ 检查    │  │ 检查    │
└────────┘  └────────┘
```

## 通信协议

```
Scheduler ──HTTP POST──► Executor    (部署/停止/拉取 指令)
Executor  ──HTTP POST──► Scheduler   (注册/心跳/状态上报)
Executor  ──WebSocket──► Scheduler   (构建日志实时推送)
Scheduler ──HTTP Proxy─► Executor    (用户流量反向代理)
```

## 实施计划

### Phase 1: 执行端抽取 (Executor Agent)

**改动范围**: 新建 `cds/src/executor/`

1. **创建 ExecutorAgent 类** (`cds/src/executor/agent.ts`)
   - 启动时向 Scheduler 注册: `POST /api/executors/register`
     ```json
     {
       "id": "executor-{hostname}-{port}",
       "host": "192.168.1.100",
       "port": 9901,
       "capacity": { "maxBranches": 10, "memoryMB": 8192, "cpuCores": 4 },
       "labels": ["gpu", "high-mem"],   // 可选，用于调度亲和性
       "repoRoot": "/home/user/prd_agent",
       "worktreeBase": "/home/user/.cds-worktrees"
     }
     ```
   - 每 15 秒心跳: `POST /api/executors/{id}/heartbeat`
     ```json
     {
       "load": { "memoryUsedMB": 3200, "cpuPercent": 45 },
       "branches": { "main": { "status": "running", "services": {...} } }
     }
     ```

2. **Executor HTTP API** (`cds/src/executor/routes.ts`, 端口 9901)
   - `POST /exec/deploy` — 接收部署指令，执行构建
   - `POST /exec/stop` — 停止分支
   - `POST /exec/pull` — 拉取代码
   - `GET  /exec/logs/:branchId` — 获取日志
   - `GET  /exec/status` — 返回当前负载和分支状态
   - `POST /exec/infra/start` — 启动基础设施服务
   - `POST /exec/infra/stop` — 停止基础设施服务

3. **复用现有服务**
   - `ContainerService` → 不变，Executor 直接调用
   - `WorktreeService` → 不变，Executor 本地操作
   - `ShellExecutor` → 不变
   - `StateService` → 拆分: Executor 只维护本地分支的状态

### Phase 2: 调度端改造 (Scheduler)

**改动范围**: 修改 `cds/src/index.ts`, 新建 `cds/src/scheduler/`

1. **ExecutorRegistry** (`cds/src/scheduler/executor-registry.ts`)
   - 管理已注册执行器列表
   - 心跳超时检测 (30 秒无心跳 → 标记离线)
   - 执行器选择策略:
     - `least-branches`: 分支数最少的执行器优先
     - `least-load`: CPU/内存负载最低优先
     - `label-match`: 按标签匹配 (如 GPU 分支选 GPU 节点)

2. **改造部署流程** (`routes/branches.ts`)
   - `POST /api/branches/:id/deploy` 改为:
     1. 选择执行器 (调度策略)
     2. 发送 `POST executor:9901/exec/deploy`
     3. 建立 WebSocket 转发构建日志 SSE
     4. 更新全局状态 (分支 → 执行器映射)

3. **改造代理路由** (`services/proxy.ts`)
   - `resolveUpstream` 不再指向 `127.0.0.1:port`
   - 改为指向 `executor-host:port` (从全局状态查询)

4. **全局状态扩展** (`types.ts`)
   ```typescript
   interface BranchEntry {
     // ...现有字段
     executorId?: string;       // 部署在哪个执行器
   }

   interface ExecutorNode {
     id: string;
     host: string;
     port: number;
     status: 'online' | 'offline' | 'draining';
     capacity: { maxBranches: number; memoryMB: number; cpuCores: number };
     load: { memoryUsedMB: number; cpuPercent: number };
     labels: string[];
     branches: string[];         // 该执行器上的分支 ID 列表
     lastHeartbeat: string;
     registeredAt: string;
   }

   interface CdsState {
     // ...现有字段
     executors: Record<string, ExecutorNode>;
   }
   ```

### Phase 3: 安装与接入

1. **Executor 安装脚本** (`scripts/install-executor.sh`)
   ```bash
   #!/bin/bash
   # 在新服务器上一键安装 CDS Executor

   # 1. 安装 Docker + Node 20 + pnpm + git
   # 2. Clone 仓库 (或只拉 cds/ 目录)
   # 3. pnpm install && pnpm build
   # 4. 配置 executor.config.json:
   #    {
   #      "schedulerUrl": "http://scheduler-host:9900",
   #      "executorPort": 9901,
   #      "repoRoot": "/opt/prd_agent",
   #      "worktreeBase": "/opt/cds-worktrees",
   #      "token": "shared-secret"
   #    }
   # 5. 创建 systemd service 自动启动
   # 6. 注册到 Scheduler
   ```

2. **Dashboard UI 变更** (`web/`)
   - 顶部新增 "执行器" 面板: 在线状态、负载仪表盘
   - 分支卡片新增标签: 显示部署在哪个执行器
   - 部署时可选择目标执行器 (或自动调度)
   - 执行器管理页: 添加/移除/排空(draining)

3. **安全**: Scheduler ↔ Executor 通信用共享 Token 认证
   - Executor 注册时带 Token
   - Scheduler 下发指令时带 Token
   - 后续可升级为 mTLS

### Phase 4: 向后兼容 (单机模式)

**关键**: 不破坏现有单机部署

- 默认启动模式: `node dist/index.js` → 检测 `executor.config.json`
  - **不存在** → 单机模式 (Scheduler + 内嵌 Executor)，行为完全兼容当前
  - **存在** → 执行器模式 (只启动 Executor Agent)
- Scheduler 默认注册一个 "local" 执行器 (127.0.0.1)
- 配置 `cds.config.json` 新增: `"mode": "standalone" | "scheduler" | "executor"`

## 启动命令

```bash
# 单机模式 (默认，向后兼容)
cd cds && node dist/index.js

# 调度端
cd cds && CDS_MODE=scheduler node dist/index.js

# 执行端 (新服务器)
cd cds && CDS_MODE=executor \
  CDS_SCHEDULER_URL=http://scheduler:9900 \
  CDS_EXECUTOR_TOKEN=xxx \
  node dist/index.js
```

## 文件结构变更

```
cds/src/
├── index.ts                    # 入口: 根据 mode 启动对应模式
├── scheduler/
│   ├── executor-registry.ts    # 执行器注册与心跳管理
│   ├── job-dispatcher.ts       # 部署任务调度 (选择执行器)
│   └── routes.ts               # Scheduler 专有 API (/api/executors/*)
├── executor/
│   ├── agent.ts                # Executor 生命周期 (注册/心跳/上报)
│   └── routes.ts               # Executor 本地 API (/exec/*)
├── services/                   # 共享服务 (不变)
│   ├── container.ts
│   ├── worktree.ts
│   ├── state.ts
│   ├── proxy.ts                # 改造: upstream 支持远程地址
│   └── ...
└── types.ts                    # 新增 ExecutorNode 类型
```

## 实施顺序建议

| 步骤 | 内容 | 风险 |
|------|------|------|
| 1 | Phase 4 先做: 添加 mode 配置，单机模式为默认 | 低 — 纯加法 |
| 2 | Phase 1: Executor API 抽取 | 中 — 核心拆分 |
| 3 | Phase 2: Scheduler 改造 | 中 — 路由改变 |
| 4 | Phase 3: 安装脚本 + UI | 低 — 锦上添花 |

预计 Phase 1-2 合计约需修改/新建 8-10 个文件。
