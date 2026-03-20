---
name: cds-deploy-pipeline
description: AI 远程驱动 CDS 灰度环境全生命周期：部署、观测、诊断、操作、验证、清理。纯 HTTP API 驱动，跨服务器架构。触发词："/cds-deploy"、"部署流水线"、"灰度环境"、"cds deploy"。
---

# CDS Deploy Pipeline — AI 灰度环境生命周期管理

AI 通过 HTTP API 远程驱动 CDS 灰度环境的完整生命周期。AI 和 CDS 不在同一台服务器上——所有操作通过 CDS Dashboard API 完成，验证通过预览域名访问。

## 触发词

- `/cds-deploy` — 推送并部署（最常用）
- "部署流水线"、"推送并测试"、"deploy pipeline"
- "灰度环境"、"灰度状态"、"灰度日志"
- "重启灰度"、"清理灰度"

---

## 核心架构：跨服务器模型

```
┌─ AI 服务器 ─────────────────────┐     ┌─ CDS 服务器 ──────────────────────┐
│                                  │     │                                    │
│  AI Agent                        │     │  CDS Dashboard (:9900)             │
│   ├─ git push → remote ─────────────→  │   ├─ /api/branches (管理)          │
│   ├─ curl CDS_DASHBOARD_URL ─────────→  │   ├─ /api/branches/:id/deploy     │
│   │                              │     │   ├─ /api/branches/:id/logs        │
│   │                              │     │   └─ ... (50+ API 端点)            │
│   │                              │     │                                    │
│   └─ curl PREVIEW_URL ───────────────→  │  CDS Worker Proxy (:5500)         │
│      (验证/冒烟测试)             │     │   ├─ X-Branch header 路由          │
│                                  │     │   ├─ *.preview.domain 子域名路由   │
│                                  │     │   └─ → 容器 (:10001, :10002...)    │
└──────────────────────────────────┘     └────────────────────────────────────┘
```

**关键约束**：
- AI 无法直接访问容器端口（localhost:10003 是 CDS 服务器的 localhost）
- 验证和冒烟测试必须通过 **预览域名** 或 **Worker Proxy + X-Branch** 访问
- 所有 CDS 管理操作通过 `CDS_DASHBOARD_URL` 的 HTTP API

---

## 环境变量

| 变量 | 用途 | 示例 |
|------|------|------|
| `CDS_DASHBOARD_URL` | CDS Dashboard 地址（必填） | `https://cds.miduo.org` |
| `CDS_TOKEN` | CDS 认证 token | 登录后的 JWT |
| `CDS_PREVIEW_DOMAIN` | 预览域名后缀 | `preview.miduo.org` |
| `CDS_WORKER_URL` | Worker Proxy 地址（备选） | `https://miduo.org` |
| `AI_ACCESS_KEY` | 业务 API 认证密钥 | 冒烟测试用 |

---

## MECE 生命周期维度与 API 映射

以下按 MECE 原则划分为 6 个不重叠的生命周期维度，覆盖灰度环境从创建到销毁的全过程。

### 1. Provision（供给）— 环境准备

| 操作 | API | 方法 | 说明 |
|------|-----|------|------|
| 列出远端分支 | `/api/remote-branches` | GET | 可注册的分支列表 |
| 列出已注册分支 | `/api/branches` | GET | 含 status, services, capacity |
| 注册分支 | `/api/branches` | POST | `{"branch": "feature/xxx"}` → 自动创建 worktree |
| 删除分支 | `/api/branches/:id` | DELETE | 清理 worktree + 容器 |
| 查看远端更新 | `/api/check-updates` | GET | 各分支 behind 数量 |

### 2. Deploy（部署）— 构建与启动

| 操作 | API | 方法 | 说明 |
|------|-----|------|------|
| 拉取最新代码 | `/api/branches/:id/pull` | POST | 返回 `{head, behind, changes}` |
| 全量部署 | `/api/branches/:id/deploy` | POST | SSE 流，返回构建+启动过程 |
| 单服务重部署 | `/api/branches/:id/deploy/:profileId` | POST | SSE 流，仅重建单个服务 |
| 停止所有服务 | `/api/branches/:id/stop` | POST | 停止容器但保留环境 |
| 重置错误状态 | `/api/branches/:id/reset` | POST | 从 error 恢复到 idle |

### 3. Observe（观测）— 状态与进度

| 操作 | API | 方法 | 说明 |
|------|-----|------|------|
| 查看分支列表+状态 | `/api/branches` | GET | status: idle/building/starting/running/error |
| 查看操作日志 | `/api/branches/:id/logs` | GET | 历史部署记录及事件 |
| 查看 Git 历史 | `/api/branches/:id/git-log` | GET | 分支上的提交记录 |
| 查看构建配置 | `/api/build-profiles` | GET | 所有服务的构建定义 |
| 查看基础设施 | `/api/infra` | GET | MongoDB/Redis 等状态 |
| 基础设施健康 | `/api/infra/:id/health` | GET | 基础设施健康检查 |
| 系统配置 | `/api/config` | GET | 含 previewDomain, workerPort 等 |

### 4. Diagnose（诊断）— 排错与调试

| 操作 | API | 方法 | 说明 |
|------|-----|------|------|
| 容器日志 | `/api/branches/:id/container-logs` | POST | `{"profileId":"api"}` 查看容器输出 |
| 容器环境变量 | `/api/branches/:id/container-env` | POST | `{"profileId":"api"}` 查看实际注入的 env |
| 容器内执行命令 | `/api/branches/:id/container-exec` | POST | `{"profileId":"api","command":"ls /app"}` |
| 基础设施日志 | `/api/infra/:id/logs` | GET | MongoDB/Redis 等日志 |

### 5. Operate（操作）— 配置变更

| 操作 | API | 方法 | 说明 |
|------|-----|------|------|
| 查看环境变量 | `/api/env` | GET | 全局自定义环境变量 |
| 批量设置环境变量 | `/api/env` | PUT | 覆盖所有环境变量 |
| 设置单个环境变量 | `/api/env/:key` | PUT | `{"value":"xxx"}` |
| 删除环境变量 | `/api/env/:key` | DELETE | |
| 更新分支元数据 | `PATCH /api/branches/:id` | PATCH | isFavorite, notes, tags |
| 设置默认分支 | `/api/branches/:id/set-default` | POST | |
| 路由规则管理 | `/api/routing-rules` | CRUD | 域名/Header/Pattern 路由 |
| 基础设施启停 | `/api/infra/:id/{start\|stop\|restart}` | POST | |
| 镜像加速 | `/api/mirror` | GET/PUT | npm/Docker 镜像源 |
| 清理孤儿容器 | `/api/cleanup-orphans` | POST | |
| 清理过期分支 | `/api/prune-stale-branches` | POST | |

### 6. Validate（验证）— 通过预览域名访问

**跨服务器验证方式**（AI 不能直接访问容器端口）：

```bash
# 方式 1: 预览子域名（推荐）
# 分支 claude/fix-xxx → slug: claude-fix-xxx
curl https://claude-fix-xxx.${CDS_PREVIEW_DOMAIN}/api/users/me

# 方式 2: Worker Proxy + X-Branch 头
curl -H "X-Branch: claude-fix-xxx" ${CDS_WORKER_URL}/api/users/me

# 方式 3: 切换 cookie（有状态，不推荐 AI 使用）
# GET /_switch/claude-fix-xxx → 设置 cds_branch cookie
```

**分支名 → slug 规则**: `/` → `-`，特殊字符移除，全部小写。

---

## 用户故事与验证

以下 8 个用户故事覆盖全生命周期，用于推导和验证 API 完整性。

### US-1: 首次部署 — "代码写完了，帮我部署到灰度"

最常见场景。AI 完成开发后一键部署验证。

```
前置: AI 在 claude/fix-xxx-Yyyyy 分支上完成了代码修改并提交

步骤:
1. git push -u origin claude/fix-xxx-Yyyyy
2. GET  /api/branches → 查找分支是否已注册
3. (未注册) POST /api/branches {"branch":"claude/fix-xxx-Yyyyy"} → 自动注册
4. POST /api/branches/{id}/pull → 确认 head 匹配推送的 commit
5. POST /api/branches/{id}/deploy → 消费 SSE 或轮询状态
6. (轮询) GET /api/branches → 等待 status == "running"
7. curl https://{slug}.{previewDomain}/api/users/me → 验证服务就绪
8. (可选) 执行冒烟测试

产出: 预览地址 + 部署状态报告
```

### US-2: 增量更新 — "改了一行代码，更新灰度"

分支已部署，只需拉取新代码重部署。

```
步骤:
1. git push
2. POST /api/branches/{id}/pull → 确认新代码
3. POST /api/branches/{id}/deploy → 全量重部署
   或 POST /api/branches/{id}/deploy/{profileId} → 只重部署改动的服务
4. 轮询等待 running
5. 验证
```

### US-3: 诊断失败 — "灰度环境报错了，帮我看看"

部署后 status 为 error，需要排查原因。

```
步骤:
1. GET  /api/branches → 定位 status=error 的分支和服务
2. GET  /api/branches/{id}/logs → 查看部署操作日志（含 SSE 事件记录）
3. POST /api/branches/{id}/container-logs {"profileId":"api"} → 查看容器输出
4. POST /api/branches/{id}/container-env {"profileId":"api"} → 确认环境变量正确
5. (需要时) POST /api/branches/{id}/container-exec {"command":"dotnet --info"} → 容器内调试
6. 分析错误 → 修复代码 → US-2 流程更新

常见错误模式:
- "error CS*" → C# 编译失败，检查代码语法
- "Connection refused :27017" → MongoDB 未启动，GET /api/infra 检查
- "port already in use" → 端口冲突，POST /api/cleanup-orphans 清理
```

### US-4: 观测状态 — "灰度现在什么状态？"

检查所有灰度环境的健康度。

```
步骤:
1. GET /api/branches → 获取所有分支 + services + capacity
   返回:
   - branches[]: 每个分支的 status, services (含 hostPort, status, containerName)
   - capacity: { maxContainers, runningContainers, totalMemGB }
   - 每个分支的 subject (最新 commit 信息)
2. GET /api/infra → 基础设施状态
3. GET /api/infra/{id}/health → 逐个检查健康

输出示例:
  容量: 6/14 容器运行中 (8GB)
  分支:
    claude-fix-xxx: running (api:10003 ✓, admin:10004 ✓)
    claude-add-yyy: error (api:10005 ✗ — 编译失败)
    feature-zzz:    idle
  基础设施:
    mongodb: running ✓
    redis: running ✓
```

### US-5: 重启单个服务 — "重启一下灰度的 API"

不需要全量重部署，只重启单个服务。

```
步骤:
1. POST /api/branches/{id}/deploy/api → 单服务重部署 (SSE 流)
2. GET /api/branches → 确认 api 服务 status == running
3. 验证

注意: CDS 没有 "restart" 语义，重部署单个 profile 等效于重启。
```

### US-6: 容器内调试 — "帮我在容器里跑个命令"

在运行中的容器内执行命令（远程 docker exec）。

```
步骤:
1. POST /api/branches/{id}/container-exec
   {"profileId":"api", "command":"ls -la /app/bin/Debug"}
   → 返回 {exitCode, stdout, stderr}

2. POST /api/branches/{id}/container-exec
   {"command":"cat /app/appsettings.json"}
   → 查看配置文件

3. POST /api/branches/{id}/container-exec
   {"command":"curl -s localhost:5000/api/health"}
   → 容器内部健康检查（绕过外部网络）

超时: 30 秒
```

### US-7: 环境变量变更 — "灰度的 MongoDB 连接串改一下"

修改环境变量后需要重部署生效。

```
步骤:
1. GET /api/env → 查看当前环境变量
2. PUT /api/env/MongoDB__ConnectionString {"value":"mongodb://new-host:27017"}
3. POST /api/branches/{id}/deploy → 重部署以加载新环境变量
4. POST /api/branches/{id}/container-env → 确认注入成功
```

### US-8: 清理环境 — "这个分支合并了，清理灰度"

分支合并后释放资源。

```
步骤:
1. POST /api/branches/{id}/stop → 停止所有容器
2. DELETE /api/branches/{id} → 删除分支 + worktree
3. (可选) POST /api/cleanup-orphans → 清理残留容器
4. (可选) POST /api/prune-stale-branches → 批量清理已删除分支
```

---

## /cds-deploy 执行流程（Phase 详解）

当用户触发 `/cds-deploy` 时，按以下阶段执行：

### 链路追踪

每次执行生成唯一 traceId，所有阶段输出关联同一追踪链：

```
[trace:{8位hex}] Phase N: {阶段名}
  ├─ {关键信息}: {值}
  └─ 耗时: {N.N}s
```

### Phase 0: 环境预检

```
检查项:
1. 当前分支 (禁止 main/master)
2. CDS 可达性: GET $CDS_DASHBOARD_URL/api/config
3. 分支注册状态: GET /api/branches → 查找匹配
4. (未注册) 自动注册: POST /api/branches
5. 基础设施: GET /api/infra → 确认 MongoDB/Redis running
6. 预览域名: 从 /api/config 获取 previewDomain
```

### Phase 1: Git Push

```
git push -u origin $BRANCH
失败重试: 2s → 4s → 8s → 16s (最多 4 次)
```

### Phase 2: CDS Pull

```
POST /api/branches/{id}/pull
校验: 返回的 head 应匹配推送的 commit hash
```

### Phase 3: CDS Deploy

```
POST /api/branches/{id}/deploy (SSE 流)

SSE 消费策略（AI 环境下）:
- 方案 A: 用 curl --max-time 300 消费 SSE，解析 event: step/log/complete/error
- 方案 B: 后台触发部署，轮询 GET /api/branches 等待状态变化

轮询间隔: 每 5 秒
超时: 300 秒
终态: status == "running" (成功) 或 status == "error" (失败)

失败时自动获取诊断信息:
- GET /api/branches/{id}/logs → 操作日志
- POST /api/branches/{id}/container-logs → 容器输出
```

### Phase 4: Readiness Check

```
通过预览域名验证服务真正可用（不是 localhost!）:

PREVIEW_URL="https://{branch-slug}.{previewDomain}"
# 或
WORKER_URL="${CDS_WORKER_URL}" + Header "X-Branch: {branch-id}"

探针: GET ${PREVIEW_URL}/api/users/me (或其他轻量端点)
重试: 最多 15 次，每次间隔 3 秒
超时: 45 秒
```

### Phase 5: Smoke Test

```
前置: AI_ACCESS_KEY 环境变量存在

BASE_URL 使用预览域名（同 Phase 4）
AUTH: -H "X-AI-Access-Key: $KEY" -H "X-AI-Impersonate: admin"

基础测试:
- GET /api/users/me → 200 + 有 data.name

模块推断:
- 从 git diff --name-only HEAD~1 推断变更模块
- 如果推断出模块 → 建议执行 /smoke {module} 做完整冒烟

跳过条件: 无 AI_ACCESS_KEY、无 previewDomain
```

### 输出报告

```markdown
## CDS Deploy Pipeline Report

**Trace ID**: `a3f7c012`
**分支**: `claude/fix-xxx-yyyyy`

| # | 阶段 | 状态 | 耗时 |
|---|------|------|------|
| 0 | 环境预检 | ✓ | 1.2s |
| 1 | Git Push | ✓ | 3.5s |
| 2 | CDS Pull | ✓ | 2.1s |
| 3 | CDS Deploy | ✓ | 45.2s |
| 4 | Readiness Check | ✓ | 9.3s |
| 5 | Smoke Test | ✓ 1/1 | 2.5s |

**总耗时**: 63.8s
**预览地址**: `https://claude-fix-xxx-yyyyy.preview.miduo.org/`
```

失败报告额外输出:
- 失败阶段的详细日志
- 容器错误日志（自动拉取）
- 建议修复方向

---

## 异常处理

| 场景 | 处理 |
|------|------|
| CDS 不可达 | 终止，提示检查网络/URL |
| 分支未注册 | 自动 POST /api/branches 注册 |
| Git Push 失败 | 指数退避重试 4 次 |
| Pull HEAD 不匹配 | 警告但继续 |
| Deploy 超时 (>5min) | 终止，拉取 container-logs |
| Deploy 部分失败 | 拉取失败服务的 logs，如有正常服务继续 readiness |
| Readiness 超时 | 拉取 container-logs，检查 infra 健康 |
| 预览域名不可达 | 回退到 container-exec 内部检查 |
| 冒烟测试失败 | 输出请求/响应详情 |
| 容量已满 | 提示停止闲置分支释放资源 |

---

## 安全规则

1. **禁止推送 main/master**
2. **密钥不落盘** — AI_ACCESS_KEY / CDS_TOKEN 仅从环境变量读取
3. **CDS 认证** — 通过 `-H "Cookie: cds_token=$CDS_TOKEN"` 或 `-H "X-CDS-Token: $CDS_TOKEN"` 传递
4. **冒烟测试数据清理** — 测试创建的资源必须在测试结束时删除
5. **非 localhost 警告** — CDS_DASHBOARD_URL 指向生产环境时输出醒目警告
