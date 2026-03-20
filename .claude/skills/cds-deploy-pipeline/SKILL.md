---
name: cds-deploy-pipeline
description: AI 开发提交代码后自动触发 CDS 部署、等待就绪、执行冒烟测试的全链路流水线。每个阶段带链路追踪 ID，失败自动定位。触发词："部署流水线"、"cds deploy"、"推送并测试"、"deploy pipeline"、"/cds-deploy"。
---

# CDS Deploy Pipeline — AI 灰度环境全生命周期管理

AI 作为 DevOps 操作员，通过 HTTP API 远程驱动 CDS 完成代码部署、状态监控、故障诊断、环境清理的完整生命周期。CDS 和 AI 不在同一台服务器上，所有操作通过 HTTP API 完成。

## 触发词

- "部署流水线" / "cds deploy" / "推送并测试" / `/cds-deploy`
- "帮我部署到灰度" / "提交后帮我部署" / "推到 CDS 上验证"
- "灰度环境什么状态" / "看看部署情况"
- "容器报错了" / "部署失败了" / "帮我排查"
- "重启服务" / "更新灰度" / "清理环境"

## 核心理念

1. **纯 API 驱动**：AI 通过 curl 调用远程 CDS REST API，不依赖本地脚本或 docker 命令
2. **全生命周期**：不只是部署，还包括监控、诊断、重启、清理
3. **链路追踪**：每次操作生成 traceId，所有阶段日志关联同一追踪链
4. **快速失败**：任一阶段失败立即停止，输出容器日志 + 修复建议
5. **零配置**：自动从当前分支名推导 CDS 分支 ID 和预览 URL

## 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `CDS_DASHBOARD_URL` | CDS Dashboard 地址（远程） | 必填 |
| `CDS_TOKEN` | CDS 认证 token | 无 |
| `AI_ACCESS_KEY` | 冒烟测试 API 认证密钥 | 无 |

> 提示：如果环境变量未设置，询问用户获取 CDS 地址和认证信息。

---

## CDS API 参考（AI 可用的全部接口）

以下是 AI 可调用的 CDS REST API 完整列表。所有请求需带认证头 `-H "Cookie: cds_token=$CDS_TOKEN"` 或 `-H "X-CDS-Token: $CDS_TOKEN"`。

### 分支管理

| 方法 | 路径 | 用途 | 响应要点 |
|------|------|------|---------|
| GET | `/api/branches` | 列出所有分支及状态 | `{ branches: [...], capacity: { maxContainers, runningContainers } }` |
| POST | `/api/branches` | 注册新分支 | body: `{ "branch": "feature/xxx" }` |
| DELETE | `/api/branches/:id` | 删除分支（停止容器+删除 worktree） | 不可逆 |
| PATCH | `/api/branches/:id` | 更新元数据 | body: `{ notes, tags, isFavorite, isColorMarked }` |
| POST | `/api/branches/:id/set-default` | 设为默认分支 | 影响路由 |

### 部署与构建

| 方法 | 路径 | 用途 | 响应要点 |
|------|------|------|---------|
| POST | `/api/branches/:id/pull` | 拉取最新代码 | `{ head, changes }` |
| POST | `/api/branches/:id/deploy` | 全量部署（SSE 流） | 触发后轮询状态 |
| POST | `/api/branches/:id/deploy/:profileId` | 重新部署单个服务 | 仅重建指定服务 |
| POST | `/api/branches/:id/stop` | 停止所有服务 | 释放端口 |
| POST | `/api/branches/:id/reset` | 重置错误状态 | 清除 error 标记 |

### 日志与诊断

| 方法 | 路径 | 用途 | 响应要点 |
|------|------|------|---------|
| GET | `/api/branches/:id/logs` | 操作历史日志 | `[{ type, status, events }]` |
| POST | `/api/branches/:id/container-logs` | 容器运行日志 | body: `{ "profileId": "api" }` → `{ logs }` |
| POST | `/api/branches/:id/container-env` | 容器实际环境变量 | body: `{ "profileId": "api" }` → `{ env }` |
| POST | `/api/branches/:id/container-exec` | 在容器内执行命令 | body: `{ "profileId": "api", "command": "ls" }` → `{ stdout, stderr, exitCode }` |
| GET | `/api/branches/:id/git-log` | Git 提交历史 | 最近提交列表 |

### 基础设施

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/infra` | 列出基础设施服务（MongoDB/Redis 等） |
| POST | `/api/infra/:id/start` | 启动基础设施服务 |
| POST | `/api/infra/:id/stop` | 停止基础设施服务 |
| POST | `/api/infra/:id/restart` | 重启基础设施服务 |
| GET | `/api/infra/:id/logs` | 基础设施日志 |
| GET | `/api/infra/:id/health` | 基础设施健康检查 |

### 构建配置

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/build-profiles` | 列出所有构建配置 |
| GET | `/api/env` | 获取自定义环境变量 |
| PUT | `/api/env/:key` | 设置单个环境变量 |
| GET | `/api/config` | 获取 CDS 全局配置 |

### 路由规则

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/routing-rules` | 列出路由规则 |
| POST | `/api/routing-rules` | 创建路由规则 |

### 配置导入导出

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/export-config` | 导出当前配置为 YAML |
| POST | `/api/import-config` | 导入 CDS Compose YAML |
| GET | `/api/remote-branches` | 列出远程 Git 分支 |

### 维护

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/cleanup` | 清理停止的容器 |
| POST | `/api/cleanup-orphans` | 清理孤儿容器 |
| POST | `/api/prune-stale-branches` | 清理过期分支 |

---

## 用户故事场景

AI 根据用户意图自动选择对应的操作场景。以下每个场景都通过人类验证方式推导完成。

### 场景 1：首次部署（开发完成后）

**触发**：用户说"部署到灰度"、"推送并测试"、`/cds-deploy`

**完整流程**：

```
Pipeline [trace:{traceId}]
Phase 0: 环境预检 → 检查 CDS 连通性、分支注册状态
Phase 1: Git Push → 推送代码到远端
Phase 2: CDS Pull → 调用 API 拉取最新代码
Phase 3: CDS Deploy → 触发部署，轮询等待完成
Phase 4: Readiness → 通过 CDS 验证服务就绪
Phase 5: Smoke Test → 通过 CDS 对部署的服务执行冒烟测试
```

**Phase 0 详细步骤**：

```bash
# 1. 获取当前分支，禁止在 main/master 上操作
BRANCH=$(git branch --show-current)

# 2. 检查 CDS 连通性（远程服务器）
CDS="$CDS_DASHBOARD_URL"
AUTH_HEADER="-H 'X-CDS-Token: $CDS_TOKEN'"
curl -sf $AUTH_HEADER "$CDS/api/config"

# 3. 查找分支是否已注册
# CDS 的分支 ID 是分支名的 slug（/ → -）
curl -sf $AUTH_HEADER "$CDS/api/branches"
# 在 .branches[] 中查找 .branch == $BRANCH

# 4. 未注册则自动注册
curl -sf $AUTH_HEADER "$CDS/api/branches" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"branch\": \"$BRANCH\"}"
```

**Phase 3 详细步骤**（关键：部署是异步的）：

```bash
# 触发部署 — deploy 接口是 SSE 流，AI 不需要消费全部事件
# 方案 A：直接 POST 触发，然后轮询
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/deploy" \
  -X POST --max-time 5 || true  # 触发即可，不等 SSE 结束

# 轮询分支状态直到完成（building → starting → running/error）
while true; do
  RESP=$(curl -sf $AUTH_HEADER "$CDS/api/branches")
  STATUS=$(echo "$RESP" | jq -r ".branches[] | select(.id==\"$BRANCH_ID\") | .status")
  case "$STATUS" in
    running) break ;;  # 成功
    error)   break ;;  # 失败
    *) sleep 5 ;;      # building/starting，继续等
  esac
done

# 提取各服务状态和端口
echo "$RESP" | jq ".branches[] | select(.id==\"$BRANCH_ID\") | .services"
```

**Phase 4 详细步骤**（关键：CDS 和 AI 不在同一台机器）：

```bash
# 方案 A（推荐）：通过 CDS 的 container-exec 间接探测
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/container-exec" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"curl -sf http://localhost:5000/api/health || echo FAIL"}'

# 方案 B：如果 CDS 有预览域名，直接请求预览地址
PREVIEW_URL="https://${BRANCH_SLUG}.${PREVIEW_DOMAIN}/"
curl -sf "$PREVIEW_URL/api/users/me" -H "X-AI-Access-Key: $AI_ACCESS_KEY"

# 方案 C：通过 CDS Worker 端口 + X-Branch 头路由
curl -sf "http://$CDS_HOST:5500/api/health" -H "X-Branch: $BRANCH_ID"
```

**Phase 5 详细步骤**：

```bash
# 冒烟测试通过预览域名或 CDS Worker 路由访问部署的服务
# 推断模块（从 git diff 的文件路径）
CHANGED=$(git diff --name-only HEAD~1 HEAD)

# 基础健康检查
curl -sf "$TARGET_URL/api/users/me" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "X-AI-Impersonate: admin"

# 更完整的测试可以调用 /smoke 技能
```

---

### 场景 2：诊断部署失败

**触发**：用户说"部署失败了"、"容器报错"、"帮我排查"

**操作步骤**：

```bash
# 1. 获取分支状态，定位失败服务
curl -sf $AUTH_HEADER "$CDS/api/branches" | \
  jq '.branches[] | select(.status=="error") | {id, status, errorMessage, services}'

# 2. 获取失败服务的容器日志（最关键的诊断手段）
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/container-logs" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api"}'

# 3. 获取操作历史（看部署过程中哪一步出错）
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/logs" | \
  jq '.[-1].events[] | select(.status=="error")'

# 4. 检查容器实际环境变量（排查配置问题）
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/container-env" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api"}'

# 5. 在容器内执行诊断命令
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/container-exec" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"dotnet --info"}'

# 6. 检查基础设施健康（MongoDB/Redis 是否正常）
curl -sf $AUTH_HEADER "$CDS/api/infra" | jq '.[] | {id, status, errorMessage}'
# 如果基础设施异常：
curl -sf $AUTH_HEADER "$CDS/api/infra/mongodb/health"
curl -sf $AUTH_HEADER "$CDS/api/infra/mongodb/logs"
```

**诊断决策树**：

```
status == error
├─ services.api.status == error
│   ├─ 容器日志包含 "error CS" → C# 编译错误 → 提示修复代码
│   ├─ 容器日志包含 "connection refused" → 基础设施问题 → 检查 MongoDB/Redis
│   ├─ 容器日志包含 "port already in use" → 端口冲突 → POST /cleanup-orphans
│   └─ 容器不存在 → POST /branches/:id/reset 后重新部署
├─ services.admin.status == error
│   ├─ 容器日志包含 "ENOENT" → 依赖未安装 → 检查 pnpm install
│   └─ 容器日志包含 "vite" → 前端构建错误 → 检查 TypeScript 错误
└─ 所有服务都 error
    └─ 基础设施问题（Docker/网络/磁盘空间）→ 提示人工检查 CDS 服务器
```

---

### 场景 3：查看环境状态

**触发**：用户说"灰度什么状态"、"看看部署情况"、"环境怎么样"

**操作步骤**：

```bash
# 获取所有分支状态 + 服务器容量
curl -sf $AUTH_HEADER "$CDS/api/branches" | jq '{
  capacity: .capacity,
  branches: [.branches[] | {
    id, branch, status, errorMessage,
    services: (.services | to_entries | map({key, status: .value.status, port: .value.hostPort})),
    lastAccessed: .lastAccessedAt
  }]
}'

# 获取基础设施状态
curl -sf $AUTH_HEADER "$CDS/api/infra" | jq '.[] | {id, name, status, hostPort}'
```

**输出示例**：

```
## 灰度环境状态

**服务器容量**: 3/12 容器运行中 (16GB)

| 分支 | 状态 | API | Admin | 最后访问 |
|------|------|-----|-------|---------|
| claude/fix-xxx | running | :10003 ✓ | :10004 ✓ | 5 分钟前 |
| feature/yyy | idle | - | - | 2 天前 |

**基础设施**:
- MongoDB (:10001): ✓ running
- Redis (:10002): ✓ running
```

---

### 场景 4：增量更新（代码改了，重新部署）

**触发**：用户说"更新灰度"、"重新部署"

**操作步骤**：

```bash
# 1. Push 新代码
git push -u origin "$BRANCH"

# 2. CDS 拉取
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/pull" -X POST

# 3. 如果只改了后端，只重建 API 服务（更快）
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/deploy/api" \
  -X POST --max-time 5 || true

# 4. 如果前后端都改了，全量部署
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/deploy" \
  -X POST --max-time 5 || true

# 5. 轮询等待 + readiness check
```

**智能判断**：根据 `git diff --name-only` 判断是全量部署还是单服务部署：
- 只改 `prd-api/` → 仅部署 `api` profile
- 只改 `prd-admin/` → 仅部署 `admin` profile
- 混合改动 → 全量部署

---

### 场景 5：重启服务

**触发**：用户说"重启 API"、"重启灰度"

```bash
# 重启单个服务（通过 redeploy 单 profile 实现）
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/deploy/api" \
  -X POST --max-time 5 || true

# 重启所有（先停后部署）
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/stop" -X POST
# 等待停止
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/deploy" -X POST --max-time 5 || true
```

---

### 场景 6：清理环境

**触发**：用户说"清理灰度"、"环境不用了"

```bash
# 停止分支所有服务
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/stop" -X POST

# 如果确认不再需要，删除分支（不可逆，需用户确认）
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID" -X DELETE

# 清理孤儿容器（定期维护）
curl -sf $AUTH_HEADER "$CDS/api/cleanup-orphans" -X POST

# 清理过期分支（远程已删除的分支）
curl -sf $AUTH_HEADER "$CDS/api/prune-stale-branches" -X POST
```

---

### 场景 7：查看 Git 历史和变更

**触发**：用户说"灰度上跑的是什么版本"、"看看灰度的提交记录"

```bash
# 分支的 Git 提交历史
curl -sf $AUTH_HEADER "$CDS/api/branches/$BRANCH_ID/git-log" | jq '.commits'
```

---

## 链路追踪规范

### traceId 生成

每次执行生成 8 位随机 hex 作为 traceId，贯穿所有阶段输出。

### 输出格式

```
[trace:{traceId}] Phase N: {阶段名}
  ├─ {关键信息}: {值}
  ├─ {关键信息}: {值}
  └─ 耗时: {N.N}s
```

### 状态符号

| 符号 | 含义 |
|------|------|
| `✓` | 成功 |
| `✗` | 失败 |
| `⏳` | 进行中 |
| `⊘` | 已跳过 |

---

## 成功报告模板

```markdown
## CDS Deploy Pipeline Report

**Trace ID**: `{traceId}`
**分支**: `{branch}`
**触发时间**: {datetime}

| # | 阶段 | 状态 | 耗时 |
|---|------|------|------|
| 0 | 环境预检 | ✓ | 1.2s |
| 1 | Git Push | ✓ | 3.5s |
| 2 | CDS Pull | ✓ | 2.1s |
| 3 | CDS Deploy | ✓ | 45.2s |
| 4 | Readiness Check | ✓ | 9.3s |
| 5 | Smoke Test | ✓ | 12.5s |

**总耗时**: 73.8s
**预览地址**: https://{branch-slug}.miduo.org/
```

## 失败报告模板

```markdown
## CDS Deploy Pipeline Report

**Trace ID**: `{traceId}` | **失败阶段**: Phase 3

| # | 阶段 | 状态 | 耗时 |
|---|------|------|------|
| 0 | 环境预检 | ✓ | 1.0s |
| 1 | Git Push | ✓ | 2.8s |
| 2 | CDS Pull | ✓ | 1.5s |
| 3 | CDS Deploy | ✗ | 30.2s |
| 4-5 | (已跳过) | ⊘ | - |

**容器日志 (api)**:
{logs from container-logs API}

**建议修复**:
1. {具体修复步骤}
2. 修复后执行 `/cds-deploy` 重新部署
```

---

## 异常处理

| 场景 | AI 操作 |
|------|---------|
| CDS 不可达 | 终止，询问用户 CDS 地址 |
| 分支未注册 | 自动 `POST /api/branches` 注册 |
| Git Push 失败 | 指数退避重试 4 次（2s, 4s, 8s, 16s） |
| Deploy 超时 (>5min) | 获取容器日志，分析失败原因 |
| 部分服务失败 | 获取失败服务日志，如 API 正常仍执行 readiness |
| Readiness 超时 | 通过 container-exec 在容器内诊断 |
| 冒烟测试失败 | 输出失败请求和响应，建议修复 |
| 基础设施异常 | 检查 infra health，尝试重启 |

## 安全规则

1. **不在 main/master 上操作**：检测到则终止并警告
2. **密钥不硬编码**：CDS_TOKEN / AI_ACCESS_KEY 仅从环境变量读取
3. **删除操作需确认**：`DELETE /api/branches/:id` 必须先询问用户
4. **生产环境检测**：CDS_DASHBOARD_URL 非 localhost/内网时输出警告
5. **冒烟测试数据清理**：测试创建的资源必须在测试结束时删除
