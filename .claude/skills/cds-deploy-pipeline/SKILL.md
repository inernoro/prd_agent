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
- "更新 CDS" / "CDS 自更新" / "self-update"

## 核心理念

1. **纯 API 驱动**：AI 通过 curl 调用远程 CDS REST API，不依赖本地脚本或 docker 命令
2. **全生命周期**：不只是部署，还包括监控、诊断、重启、清理
3. **链路追踪**：每次操作生成 traceId，所有阶段日志关联同一追踪链
4. **快速失败**：任一阶段失败立即停止，输出容器日志 + 修复建议
5. **零配置**：自动从当前分支名推导 CDS 分支 ID 和预览 URL

## 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `CDS_HOST` | CDS 地址（如 `cds.miduo.org`） | 必填 |
| `AI_ACCESS_KEY` | 通用 AI 认证密钥（CDS + MAP 平台 + 后端 API 共享） | 无 |
| `MAP_AI_USER` | X-AI-Impersonate 用户名（优先级最高，避免 JWT 登录发现） | 无 |

> **前置检查**：Pipeline 启动前必须验证 `CDS_HOST` 已设置。未设置时立即终止并询问用户。
> **`AI_ACCESS_KEY` 是通用密钥**：同一个 key 可同时用于 CDS 管理 API 和 MAP 平台后端 API，无需区分。
> **强烈建议配置 `MAP_AI_USER`**：省去复杂的 root JWT 登录 → 查 users 用户名发现流程。

## AI 认证方式（三种，按优先级）

> **交互要求**：认证失败时，AI **必须**向用户展示选项让用户选择，而不是静默失败。
> 所有 AI 发起的 CDS 请求在监控浮窗中都会标记为 **金色标签 + 紫色 AI 标记**。

### 认证流程（AI 必须遵循）

```
Phase 0 认证：
1. 检查环境变量 AI_ACCESS_KEY 是否存在
   ├─ 存在 → 方式 A（静态密钥），尝试 curl 验证
   │   ├─ 成功 → 认证完成
   │   └─ 失败 → 提示用户选择 ↓
   └─ 不存在 → 提示用户选择 ↓

2. 向用户展示选项（必须明确展示，不可跳过）：
   ────────────────────────────────
   CDS 认证方式，请选择：
   (1) 我已在 CDS Dashboard 批准 → AI 发送配对请求，等待批准
   (2) 输入 Access Key → 用户提供密钥，AI 直接使用
   (3) 输入 Cookie Token → 用户提供 cds_token
   ────────────────────────────────

3. 用户选择后执行对应认证方式
```

### 方式 A：静态密钥（推荐，零交互）

CDS 服务端配置 `AI_ACCESS_KEY` 环境变量，AI 请求时带 `X-AI-Access-Key` header：

```bash
# CDS 服务端 (.bashrc 或 docker env)
export AI_ACCESS_KEY="your-shared-secret"

# AI 请求时
AUTH="-H 'X-AI-Access-Key: $AI_ACCESS_KEY'"
curl -sf $AUTH "$CDS/api/branches"
```

### 方式 B：动态配对（类似路由器连接方式）

AI 向 CDS 发送配对请求，用户在 Dashboard 右上角看到闪烁的 "AI" 标识，点击批准后 AI 获得 24h 有效 token：

```bash
# Step 1: AI 发送配对请求（无需认证）
RESP=$(curl -sf "$CDS/api/ai/request-access" \
  -X POST -H "Content-Type: application/json" \
  -d '{"agentName":"Claude Code","purpose":"CDS 部署流水线"}')
REQUEST_ID=$(echo "$RESP" | jq -r '.requestId')

# Step 2: 提示用户去 CDS Dashboard 批准
echo "⏳ 请在 CDS Dashboard 右上角点击闪烁的 AI 标识并批准连接..."

# Step 3: 等待用户批准（轮询，最多 5 分钟）
for i in $(seq 1 60); do
  STATUS=$(curl -sf "$CDS/api/ai/request-status/$REQUEST_ID" | jq -r '.status')
  case "$STATUS" in
    approved)
      AI_TOKEN=$(curl -sf "$CDS/api/ai/request-status/$REQUEST_ID" | jq -r '.token')
      break ;;
    pending) sleep 5 ;;
    *) echo "配对被拒绝或超时"; exit 1 ;;
  esac
done

# Step 4: 后续所有请求使用 AI token
AUTH="-H 'X-CDS-AI-Token: $AI_TOKEN'"
curl -sf $AUTH "$CDS/api/branches"
```

### 方式 C：Cookie（兜底，手动复制）

登录 CDS Dashboard → 浏览器 DevTools → Application → Cookies → 复制 `cds_token` 值：

```bash
AUTH="-H 'Cookie: cds_token=$CDS_TOKEN'"
```

> **认证优先级**：AI 自动尝试 A → B → C。方式 A 配置后完全静默，方式 B 需要用户在 Dashboard 点一次批准。
> **关键**：当方式 A 失败或未配置时，AI 必须向用户展示选项菜单，不可静默跳过。

## API 操作监控

CDS Dashboard **右下角**有实时操作监控浮窗，通过 SSE (`GET /api/activity-stream`) 推送所有 API 操作。
当 AI 操作 CDS 时，每条操作会标记 **紫色 "AI" 标签**，用户可实时看到 AI 正在做什么。

---

## CDS API 参考（AI 可用的全部接口）

以下是 AI 可调用的 CDS REST API 完整列表。认证方式见上文。

### AI 配对

| 方法 | 路径 | 用途 | 需认证 |
|------|------|------|--------|
| POST | `/api/ai/request-access` | 发送配对请求 | 否 |
| GET | `/api/ai/request-status/:id` | 查询配对状态 | 否 |
| GET | `/api/ai/pending` | 列出待处理请求 | 是 |
| POST | `/api/ai/approve/:id` | 批准配对 | 是 |
| POST | `/api/ai/reject/:id` | 拒绝配对 | 是 |
| GET | `/api/ai/sessions` | 列出活跃 AI 会话 | 是 |
| DELETE | `/api/ai/sessions/:id` | 撤销 AI 会话 | 是 |

### 活动流

| 方法 | 路径 | 用途 | 需认证 |
|------|------|------|--------|
| GET | `/api/activity-stream` | SSE 实时 API 操作流 | 是 |

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

### CDS 自更新

| 方法 | 路径 | 用途 | 需认证 |
|------|------|------|--------|
| GET | `/api/self-branches` | 列出 CDS 自身可切换的分支（含当前分支） | 是 |
| POST | `/api/self-update` | 切换分支 + 拉取 + 重编译 + 重启 CDS（SSE 流） | 是 |

> `POST /api/self-update` body: `{ "branch": "feature/xxx" }`（可选，不传则在当前分支 pull）
> 调用后 CDS 进程会重启，需等待 ~10s 后轮询 `/api/config` 确认恢复。

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
# 0. 前置：验证环境变量
[[ -z "$CDS_HOST" ]] && echo "✗ CDS_HOST 未设置（格式: cds.miduo.org）" && exit 1

# 1. 获取当前分支，禁止在 main/master 上操作
BRANCH=$(git branch --show-current)

# 2. 认证 CDS（三种方式自动尝试）
CDS="https://$CDS_HOST"

# 方式 A: 静态密钥（AI_ACCESS_KEY 环境变量，推荐配置在 .bashrc）
if [[ -n "$AI_ACCESS_KEY" ]]; then
  AUTH="-H 'X-AI-Access-Key: $AI_ACCESS_KEY'"
  curl -sf $AUTH "$CDS/api/config" && echo "✓ 静态密钥认证成功"
fi

# 方式 B: 动态配对（CDS Dashboard 右上角会出现闪烁的 AI 标识）
if [[ -z "$AUTH" ]]; then
  RESP=$(curl -sf "$CDS/api/ai/request-access" \
    -X POST -H "Content-Type: application/json" \
    -d '{"agentName":"Claude Code","purpose":"CDS 部署流水线"}')
  REQUEST_ID=$(echo "$RESP" | jq -r '.requestId')
  echo "⏳ 请在 CDS Dashboard 右上角点击闪烁的 AI 标识并批准连接..."
  for i in $(seq 1 60); do
    CHECK=$(curl -sf "$CDS/api/ai/request-status/$REQUEST_ID")
    STATUS=$(echo "$CHECK" | jq -r '.status')
    if [[ "$STATUS" == "approved" ]]; then
      AI_TOKEN=$(echo "$CHECK" | jq -r '.token')
      AUTH="-H 'X-CDS-AI-Token: $AI_TOKEN'"
      echo "✓ 配对成功"
      break
    fi
    sleep 5
  done
fi

# 方式 C: Cookie 兜底（需手动设置 CDS_TOKEN）
if [[ -z "$AUTH" && -n "$CDS_TOKEN" ]]; then
  AUTH="-H 'Cookie: cds_token=$CDS_TOKEN'"
fi

[[ -z "$AUTH" ]] && echo "✗ 无法认证 CDS" && exit 1

# 3. 查找分支是否已注册
BRANCH_ID=$(echo "$BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
curl -sf $AUTH "$CDS/api/branches"

# 4. 未注册则自动注册
curl -sf $AUTH "$CDS/api/branches" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"branch\": \"$BRANCH\"}"
```

**Phase 3 详细步骤**（关键：部署是异步的）：

```bash
# 触发部署 — deploy 接口是 SSE 流，截断即可
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/deploy" \
  -X POST --max-time 5 || true

# ⚠️ 实战经验：触发后 CDS 状态更新有延迟，必须等 3s 再轮询
sleep 3

# 轮询分支状态（building → starting → running/error）
# 超时 5 分钟
for i in $(seq 1 60); do
  RESP=$(curl -sf $AUTH "$CDS/api/branches")
  STATUS=$(echo "$RESP" | jq -r ".branches[] | select(.id==\"$BRANCH_ID\") | .status")
  case "$STATUS" in
    running) break ;;
    error)   break ;;
    *)
      # ⚠️ 实战经验：CDS 可能长时间报 starting，但容器已实际就绪
      # 双重检查：如果 starting 超过 2 分钟，查容器日志确认
      if [ "$i" -gt 24 ]; then
        LOGS=$(curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/container-logs" \
          -X POST -H "Content-Type: application/json" \
          -d '{"profileId":"api"}')
        if echo "$LOGS" | grep -q "listening on"; then
          echo "CDS 报 starting 但容器已启动，视为成功"
          STATUS="running"
          break
        fi
      fi
      sleep 5 ;;
  esac
done

# 提取各服务状态和端口
echo "$RESP" | jq ".branches[] | select(.id==\"$BRANCH_ID\") | .services"
```

**Phase 4 详细步骤**（关键：CDS 和 AI 不在同一台机器）：

```bash
# 方案 A（推荐，最简单）：直连 MAP 平台预览域名
# AI_ACCESS_KEY 是通用密钥，可直接认证 MAP 平台 API，无需 container-exec 中转
PREVIEW_URL="https://${BRANCH_ID}.miduo.org"
curl -sf "$PREVIEW_URL/"  # 先测根路径（前端静态资源，不需认证）
curl -sf "$PREVIEW_URL/api/shortcuts/version-check"  # 再测不需认证的 API

# 方案 B（兜底）：通过 CDS container-exec 在容器内探测
# ⚠️ 仅当方案 A 被 Cloudflare 干扰时使用
# ⚠️ container-exec 嵌套 JSON 转义复杂，优先使用方案 A
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/container-exec" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"curl -s http://localhost:5000/api/shortcuts/version-check"}'

# 方案 C：通过 CDS Worker 端口 + X-Branch 头路由
curl -sf "http://$CDS_HOST:5500/api/shortcuts/version-check" -H "X-Branch: $BRANCH_ID"
```

**Phase 5 详细步骤**（分层冒烟，从无认证到有认证逐层验证）：

```bash
# ⚠️ 实战经验：采用分层冒烟策略，避免认证问题阻塞整个验证
# ⚠️ 优先直连 MAP 平台预览域名（AI_ACCESS_KEY 通用），减少 container-exec 使用
PREVIEW_URL="https://${BRANCH_ID}.miduo.org"

# Layer 1: 无认证端点（必须通过，直连预览域名）
curl -sf "$PREVIEW_URL/api/shortcuts/version-check"
# 期望：{"version":2,...}

# Layer 2: 代码部署验证（仅此层需要 container-exec，因为要 grep 容器内文件）
CHANGED=$(git diff --name-only HEAD~1 HEAD)
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/container-exec" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"grep -c NewFunctionName /app/src/path/to/file.cs"}'

# Layer 3: 认证端点（直连 MAP 平台，使用 MAP_AI_USER 环境变量）
# ⚠️ 关键：优先从 $MAP_AI_USER 读取用户名，不再需要复杂的 JWT 登录流程
IMPERSONATE="${MAP_AI_USER}"

# 如果 MAP_AI_USER 未设置，才兜底用 container-exec 发现用户名
if [[ -z "$IMPERSONATE" ]]; then
  # 兜底：通过 container-exec 发现（复杂，不推荐）
  echo "⚠️ MAP_AI_USER 未设置，使用 JWT 登录发现用户名..."
  # ... 复杂的 container-exec JWT 登录流程 ...
fi

# 直连 MAP 平台执行认证测试（简单，无嵌套 JSON 问题）
curl -sf "$PREVIEW_URL/api/users?pageSize=3" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "X-AI-Impersonate: $IMPERSONATE"
# 如果 401 → 参考"后端 API 401 快速诊断"决策树

# Layer 4: 更完整的测试可以调用 /smoke 技能
```

---

### 场景 2：诊断部署失败

**触发**：用户说"部署失败了"、"容器报错"、"帮我排查"

**操作步骤**：

```bash
# 1. 获取分支状态，定位失败服务
curl -sf $AUTH "$CDS/api/branches" | \
  jq '.branches[] | select(.status=="error") | {id, status, errorMessage, services}'

# 2. 获取失败服务的容器日志（最关键的诊断手段）
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/container-logs" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api"}'

# 3. 获取操作历史（看部署过程中哪一步出错）
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/logs" | \
  jq '.[-1].events[] | select(.status=="error")'

# 4. 检查容器实际环境变量（排查配置问题）
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/container-env" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api"}'

# 5. 在容器内执行诊断命令
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/container-exec" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"dotnet --info"}'

# 6. 检查基础设施健康（MongoDB/Redis 是否正常）
curl -sf $AUTH "$CDS/api/infra" | jq '.[] | {id, status, errorMessage}'
# 如果基础设施异常：
curl -sf $AUTH "$CDS/api/infra/mongodb/health"
curl -sf $AUTH "$CDS/api/infra/mongodb/logs"
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
curl -sf $AUTH "$CDS/api/branches" | jq '{
  capacity: .capacity,
  branches: [.branches[] | {
    id, branch, status, errorMessage,
    services: (.services | to_entries | map({key, status: .value.status, port: .value.hostPort})),
    lastAccessed: .lastAccessedAt
  }]
}'

# 获取基础设施状态
curl -sf $AUTH "$CDS/api/infra" | jq '.[] | {id, name, status, hostPort}'
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
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/pull" -X POST

# 3. 如果只改了后端，只重建 API 服务（更快）
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/deploy/api" \
  -X POST --max-time 5 || true

# 4. 如果前后端都改了，全量部署
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/deploy" \
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
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/deploy/api" \
  -X POST --max-time 5 || true

# 重启所有（先停后部署）
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/stop" -X POST
# 等待停止
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/deploy" -X POST --max-time 5 || true
```

---

### 场景 6：清理环境

**触发**：用户说"清理灰度"、"环境不用了"

```bash
# 停止分支所有服务
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/stop" -X POST

# 如果确认不再需要，删除分支（不可逆，需用户确认）
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID" -X DELETE

# 清理孤儿容器（定期维护）
curl -sf $AUTH "$CDS/api/cleanup-orphans" -X POST

# 清理过期分支（远程已删除的分支）
curl -sf $AUTH "$CDS/api/prune-stale-branches" -X POST
```

---

### 场景 7：查看 Git 历史和变更

**触发**：用户说"灰度上跑的是什么版本"、"看看灰度的提交记录"

```bash
# 分支的 Git 提交历史
curl -sf $AUTH "$CDS/api/branches/$BRANCH_ID/git-log" | jq '.commits'
```

---

### 场景 8：CDS 自身更新（改了 cds/ 目录的代码）

**触发条件**（AI 自动判断）：当本次提交包含 `cds/` 目录下的文件变更时，部署流水线在 Phase 1（Git Push）后 **必须** 插入 CDS 自更新阶段。

**判断逻辑**：
```bash
# 检查本次改动是否涉及 CDS 自身代码
CDS_CHANGED=$(git diff --name-only HEAD~1 HEAD | grep -c "^cds/" || true)
if [ "$CDS_CHANGED" -gt 0 ]; then
  echo "检测到 CDS 代码变更，需要自更新"
fi
```

**为什么需要**：CDS 运行在宿主机上（不在容器里），`POST /api/branches/:id/deploy` 只更新容器内的应用代码。如果改了 CDS 自身（如 `cds/src/`），必须通过 self-update 让宿主机上的 CDS 加载新代码。

**操作步骤**：

```bash
# 1. 触发自更新（切换到功能分支 + pull + 重启）
curl -sf $AUTH "$CDS/api/self-update" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"branch\": \"$BRANCH\"}" \
  --max-time 10 || true

# 2. 等待 CDS 重启（进程会被 kill 并重启，约 10s）
sleep 10

# 3. 轮询确认 CDS 恢复（最多等 60s）
for i in $(seq 1 12); do
  if curl -sf $AUTH "$CDS/api/config" -o /dev/null --max-time 5; then
    echo "✓ CDS 已恢复"
    break
  fi
  sleep 5
done

# 4. 验证 CDS 运行在正确的分支上
curl -sf $AUTH "$CDS/api/self-branches" | \
  python3 -c "import json,sys;d=json.load(sys.stdin);print(f'当前分支: {d[\"current\"]}')"
```

**完整流水线（含 CDS 自更新）**：

```
Pipeline [trace:{traceId}]
Phase 0: 环境预检
Phase 1: Git Push
Phase 1.5: CDS Self-Update ← 仅当 cds/ 有变更时插入
  ├─ POST /api/self-update（切换分支 + pull + 重启）
  ├─ 等待 CDS 恢复（轮询 /api/config）
  └─ 验证分支正确
Phase 2: CDS Pull（应用代码）
Phase 3: CDS Deploy
Phase 4: Readiness Check
Phase 5: Smoke Test
```

**注意事项**：
- self-update 会重启 CDS 进程，期间所有 API 不可用（~10s）
- 重启后 CDS 会重新加载 state.json，迁移逻辑会自动执行
- 如果 CDS 未恢复，检查宿主机上 `cds/cds.log` 或 `exec_cds.sh` 输出

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
| cds/ 代码变更未生效 | `POST /api/self-update` 切换分支并重启 CDS |

## 安全规则

1. **不在 main/master 上操作**：检测到则终止并警告
2. **密钥不硬编码**：CDS_TOKEN / AI_ACCESS_KEY 仅从环境变量读取
3. **删除操作需确认**：`DELETE /api/branches/:id` 必须先询问用户
4. **生产环境检测**：`CDS_HOST` 非 localhost/内网时输出警告
5. **冒烟测试数据清理**：测试创建的资源必须在测试结束时删除

---

## 双层认证架构（关键！CDS 认证 ≠ 后端 API 认证）

> **核心概念**：CDS 是代理层，后端 API 是业务层，两者有**独立的认证体系**。混淆二者是最常见的诊断弯路。

```
┌──────────────────────────────────────────────────────────────┐
│  AI Agent（本机）                                              │
│                                                                │
│  Layer 1: CDS 认证（管理 CDS 自身功能）                         │
│  ┌──────────────────────────────────────────┐                  │
│  │ Header: X-AI-Access-Key: $AI_ACCESS_KEY  │                  │
│  │ 或: X-CDS-AI-Token: $TOKEN              │                  │
│  │ 读取: CDS master 进程的 env              │                  │
│  │ 用途: 调 CDS API（部署/日志/exec）        │                  │
│  │ 效果: Activity Monitor 显示 AI 标志 🤖    │                  │
│  └─────────────────┬────────────────────────┘                  │
│                    │                                            │
│  Layer 2: 后端 API 认证（测试业务接口）                          │
│  ┌─────────────────┴────────────────────────┐                  │
│  │ Header: X-AI-Access-Key: $API_KEY        │                  │
│  │ Header: X-AI-Impersonate: {真实用户名}    │ ← 必须是 DB 中的 │
│  │ 读取: Docker 容器内的 env                 │   真实 username   │
│  │ 用途: 调后端 API（用户/会话/模型等）       │                  │
│  │ 测试方式: container-exec 容器内 curl       │                  │
│  └──────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

### 常见混淆

| 错误操作 | 后果 | 正确做法 |
|----------|------|---------|
| 用 `X-Cds-Internal: 1` 调 CDS API | 功能正常但 Activity 无 AI 标志 | 用 `X-AI-Access-Key` 或配对 token |
| 用 CDS 的 `AI_ACCESS_KEY` 调后端 API | 可能碰巧相同也可能不同 | 检查容器内 `printenv AI_ACCESS_KEY` |
| `X-AI-Impersonate: admin` | 401（数据库无 "admin" 用户） | 先查 `/api/users` 获取真实用户名 |
| `X-AI-Impersonate: root` | 401（root 是破窗账户，不在 users 集合中） | 用数据库中的真实用户名 |

### 后端 API 401 快速诊断（必须按顺序）

```
收到后端 API 401 响应
│
├─ Step 1: 确认 env 存在（1 条命令排除）
│   POST container-exec: printenv AI_ACCESS_KEY
│   ├─ 空 → env 未注入，检查 CDS customEnv + redeploy
│   └─ 有值 → 继续 Step 2
│
├─ Step 2: 确认 impersonate 用户存在（1 条命令排除）
│   POST container-exec: curl localhost:5000/api/users
│   ├─ 找到用户列表 → 用真实 username 重试
│   └─ 也 401 → 继续 Step 3
│
├─ Step 3: 区分错误类型
│   POST container-exec: curl -v localhost:5000/api/xxx
│   检查响应体的 error.message：
│   ├─ "AI Access Key authentication not configured" → env 未被 .NET 读取
│   ├─ "Invalid AI Access Key" → key 值不匹配
│   ├─ "User 'xxx' not found" → 用户名错误
│   ├─ "User 'xxx' is disabled" → 用户被禁用
│   └─ "未授权"（中文） → AdminPermissionMiddleware 拦截，检查 endpoint 是否存在
│
└─ Step 4: 路径不存在的特殊情况
    如果 endpoint 返回 401（AI key）但 JWT 返回 404：
    → endpoint 不存在，AdminPermissionMiddleware 路径匹配器拦截了请求
    → 检查 Controller 的 [Route] 属性确认正确路径
```

---

## 实战陷阱（2026-03-20 验证）

以下经验来自真实部署验证，每条都有对应的解决方案。

| # | 陷阱 | 表现 | 解决方案 |
|---|------|------|---------|
| 1 | **CDS 仅 Cookie 认证** | `X-CDS-Token` / `Authorization` 均返回 401 | 必须用 `-H "Cookie: cds_token=xxx"` |
| 2 | **deploy 后状态延迟** | 触发后第一次轮询仍为 idle | 触发后 `sleep 3` 再开始轮询 |
| 3 | **starting 状态假死** | CDS 报 `starting` 但容器已 `listening on :5000` | 轮询 2min 后用 `container-logs` 交叉验证 |
| 4 | **Cloudflare 401→500** | 预览域名访问认证失败端点返回 HTTP 500 空 body | 用 `container-exec` 在容器内测试绕过 CDN |
| 5 | **container-exec 引号** | JSON 嵌套 curl 命令时 stdout 为空 | 简单命令用单引号包裹 command；复杂测试分两步 |
| 6 | **X-AI-Impersonate 用户名** | `admin` / `root` 均 401，数据库无此用户 | **必须先查 `/api/users` 获取真实用户名** |
| 7 | **无 jq 环境** | AI 沙箱可能没有 jq | 用 `python3 -c "import json,sys;..."` 替代 |
| 8 | **无 xxd 环境** | traceId 生成 `xxd -p` 不可用 | 用 `openssl rand -hex 4` 替代 |
| 9 | **双层 AI_ACCESS_KEY 混淆** | CDS env 和容器 env 是两个独立变量 | 分清 CDS master env vs Docker container env |
| 10 | **AdminPermissionMiddleware 拦截幽灵 404** | 不存在的路径用 AI key 返回 401 而非 404 | 先用 JWT 验证路径存在，再排查 AI key 问题 |
| 11 | **过度使用 container-exec** | 嵌套 JSON 转义复杂导致命令静默失败 | **优先直连 MAP 平台预览域名**（`AI_ACCESS_KEY` 通用），仅在 CDN 干扰时才用 container-exec |
| 12 | **用户名发现太复杂** | root JWT 登录 + 查 users 多步骤易出错 | **配置 `MAP_AI_USER` 环境变量**，零网络请求直接获取用户名 |
