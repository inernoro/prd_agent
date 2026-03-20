---
name: cds-deploy-pipeline
description: AI 开发提交代码后自动触发 CDS 部署、等待就绪、执行冒烟测试的全链路流水线。每个阶段带链路追踪 ID，失败自动定位。触发词："部署流水线"、"cds deploy"、"推送并测试"、"deploy pipeline"、"/cds-deploy"。
---

# CDS Deploy Pipeline — AI 开发全链路部署流水线

提交代码 → 推送分支 → 触发 CDS 拉取 & 部署 → 等待服务就绪 → 执行冒烟测试。全程带链路追踪，每阶段耗时可观测。

## 目录

- [触发词](#触发词)
- [核心理念](#核心理念)
- [前置条件](#前置条件)
- [执行流程](#执行流程)
- [链路追踪规范](#链路追踪规范)
- [输出模板](#输出模板)
- [端到端示例](#端到端示例)
- [异常处理](#异常处理)
- [安全规则](#安全规则)

## 触发词

- "部署流水线"
- "cds deploy"
- "推送并测试"
- "deploy pipeline"
- `/cds-deploy`
- "提交后帮我部署"
- "推到 CDS 上验证"

## 核心理念

1. **全链路追踪**：每次执行生成唯一 traceId，所有阶段日志关联同一追踪链，失败可溯源
2. **阶段可观测**：每个阶段（push → pull → deploy → readiness → smoke）都有开始/结束/耗时输出
3. **快速失败**：任一阶段失败立即停止，输出失败阶段 + 日志 + 建议修复方向
4. **零配置**：自动从当前分支名推导 CDS 分支 ID 和预览 URL，无需手动填写

## 前置条件

| 依赖 | 说明 | 检测方式 |
|------|------|---------|
| CDS 运行中 | CDS Dashboard 可访问 | `curl -sf $CDS_HOST/api/config` |
| 分支已注册 | 当前分支已在 CDS 中添加 | `curl -sf $CDS_HOST/api/branches` 查找匹配 |
| AI_ACCESS_KEY | 冒烟测试认证密钥 | 环境变量 `$AI_ACCESS_KEY` |
| jq | JSON 解析 | `which jq` |

### 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `CDS_DASHBOARD_URL` | CDS Dashboard 地址 | `http://localhost:9900` |
| `CDS_TOKEN` | CDS 认证 token（如开启了认证） | 无 |
| `AI_ACCESS_KEY` | 冒烟测试 API 密钥 | 无 |
| `SMOKE_TEST_HOST` | 冒烟测试目标 API 地址 | 从 CDS 分支部署结果自动推导 |

## 执行流程

复制此 checklist 跟踪进度：

```
CDS Deploy Pipeline [traceId: {8位随机hex}]
- [ ] Phase 0: 环境预检
- [ ] Phase 1: Git Push
- [ ] Phase 2: CDS Pull（拉取最新代码）
- [ ] Phase 3: CDS Deploy（构建 & 启动服务）
- [ ] Phase 4: Readiness Check（等待服务就绪）
- [ ] Phase 5: Smoke Test（冒烟测试）
- [ ] 输出链路追踪报告
```

---

### Phase 0: 环境预检

检查所有前置条件，任一不满足则终止并给出修复指引。

```bash
# 1. 获取当前分支
BRANCH=$(git branch --show-current)

# 2. CDS 可用性
CDS_HOST="${CDS_DASHBOARD_URL:-http://localhost:9900}"
curl -sf "$CDS_HOST/api/config" > /dev/null

# 3. 查找分支是否已注册
# CDS 使用分支名的 slug 形式作为 ID（/ → -，特殊字符移除）
BRANCHES_JSON=$(curl -sf "$CDS_HOST/api/branches")
# 在返回的 branches 数组中查找 .branch == $BRANCH 的条目
```

**分支未注册时的处理**：

```bash
# 自动注册分支到 CDS
curl -sf "$CDS_HOST/api/branches" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"branch\": \"$BRANCH\"}"
```

**预检输出格式**：

```
[trace:{traceId}] Phase 0: 环境预检
  ├─ 分支: claude/fix-xxx-yyyyy
  ├─ CDS: http://localhost:9900 ✓
  ├─ 分支注册: ✓ (ID: claude-fix-xxx-yyyyy)
  ├─ AI_ACCESS_KEY: ✓
  └─ 耗时: 1.2s
```

---

### Phase 1: Git Push

将当前分支推送到远端。

```bash
git push -u origin "$BRANCH"
```

如果推送失败（网络错误），按指数退避重试最多 4 次（2s, 4s, 8s, 16s）。

**输出**：

```
[trace:{traceId}] Phase 1: Git Push
  ├─ 分支: claude/fix-xxx-yyyyy → origin
  ├─ 提交: abc1234 "修复 XX 问题"
  └─ 耗时: 3.5s
```

---

### Phase 2: CDS Pull

调用 CDS API 让目标分支拉取最新代码。

```bash
BRANCH_ID="分支在CDS中的ID"
PULL_RESULT=$(curl -sf "$CDS_HOST/api/branches/$BRANCH_ID/pull" -X POST)
```

**校验**：检查返回的 JSON 中 `head` 字段是否匹配刚推送的 commit。

**输出**：

```
[trace:{traceId}] Phase 2: CDS Pull
  ├─ 目标: $BRANCH_ID
  ├─ HEAD: abc1234
  ├─ 变更文件数: 5
  └─ 耗时: 2.1s
```

---

### Phase 3: CDS Deploy

触发 CDS 全量部署。CDS deploy 端点返回 SSE 流，需要消费流式事件。

```bash
# CDS deploy 是 SSE 流
curl -sf "$CDS_HOST/api/branches/$BRANCH_ID/deploy" \
  -X POST \
  -H "Accept: text/event-stream" \
  --no-buffer
```

**SSE 事件消费策略**：

由于 AI 执行环境不适合直接消费长时间 SSE 流，采用以下策略：

1. 触发部署（POST 请求，不等待 SSE 完成）
2. 轮询分支状态直到部署完成

```bash
# 触发部署（后台）
curl -sf "$CDS_HOST/api/branches/$BRANCH_ID/deploy" -X POST &
DEPLOY_PID=$!

# 轮询状态
while true; do
  STATUS_JSON=$(curl -sf "$CDS_HOST/api/branches")
  BRANCH_STATUS=$(echo "$STATUS_JSON" | jq -r ".branches[] | select(.id==\"$BRANCH_ID\") | .status")

  case "$BRANCH_STATUS" in
    "running")  echo "部署成功"; break ;;
    "error")    echo "部署失败"; break ;;
    "building"|"starting") sleep 5 ;;
    *) sleep 3 ;;
  esac
done
```

**输出**：

```
[trace:{traceId}] Phase 3: CDS Deploy
  ├─ 触发时间: 14:30:05
  ├─ 服务 api: running (:10003)
  ├─ 服务 admin: running (:10004)
  ├─ 总耗时: 45.2s
  └─ 状态: ✓ 所有服务已启动
```

---

### Phase 4: Readiness Check

部署完成后，验证服务确实可以响应 HTTP 请求。

```bash
# 从 CDS 分支状态中提取各服务的 hostPort
API_PORT=$(echo "$STATUS_JSON" | jq -r ".branches[] | select(.id==\"$BRANCH_ID\") | .services.api.hostPort")

# 对 API 服务执行健康检查
# 尝试最多 10 次，每次间隔 3 秒
for i in $(seq 1 10); do
  if curl -sf "http://localhost:$API_PORT/api/health" > /dev/null 2>&1; then
    echo "API 服务就绪"
    break
  fi
  sleep 3
done
```

**如果没有 /api/health 端点**，使用任意轻量 GET 端点作为探针。

**输出**：

```
[trace:{traceId}] Phase 4: Readiness Check
  ├─ api (:10003): 就绪 (第 3 次探测)
  ├─ admin (:10004): 就绪 (第 1 次探测)
  └─ 耗时: 9.3s
```

---

### Phase 5: Smoke Test

服务就绪后，执行冒烟测试。

**策略选择**：

1. **如果用户指定了模块** → 仅对该模块执行冒烟测试
2. **如果当前开发上下文能推断出模块**（从 git diff 的文件路径推断）→ 自动选择模块
3. **否则** → 对核心健康端点做基本验证

**模块推断规则**：

```bash
# 从最近提交的文件路径推断测试模块
CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD)

# 推断规则：
# prd-api/src/.../Controllers/Api/AutomationsController.cs → automations
# prd-api/src/.../Controllers/Api/DefectAgentController.cs → defect-agent
# prd-api/src/.../Controllers/Api/VisualAgentController.cs → visual-agent
```

**冒烟测试执行**：

```bash
SMOKE_HOST="http://localhost:$API_PORT"
KEY="${AI_ACCESS_KEY:?请设置环境变量 AI_ACCESS_KEY}"
AUTH=(-H "X-AI-Access-Key: $KEY" -H "X-AI-Impersonate: admin" -H "Content-Type: application/json")

# 基础健康检查（始终执行）
curl -sf "$SMOKE_HOST/api/users/me" "${AUTH[@]}" | jq '.data.name'

# 如果推断出了模块，调用 /smoke 技能生成并执行完整测试
```

**输出**：

```
[trace:{traceId}] Phase 5: Smoke Test
  ├─ 目标: http://localhost:10003
  ├─ 模块: automations (从 git diff 推断)
  ├─ 测试用例: 7/7 通过
  └─ 耗时: 12.5s
```

---

## 链路追踪规范

### traceId 生成

```bash
TRACE_ID=$(openssl rand -hex 4)  # 8位十六进制，如 "a3f7c012"
```

### 日志格式

所有阶段输出统一使用 `[trace:{traceId}]` 前缀：

```
[trace:a3f7c012] Phase N: {阶段名}
  ├─ {关键信息}: {值}
  ├─ {关键信息}: {值}
  └─ 耗时: {N.N}s
```

### 阶段状态标记

| 符号 | 含义 |
|------|------|
| `✓` | 阶段成功 |
| `✗` | 阶段失败 |
| `⏳` | 进行中 |
| `⊘` | 已跳过 |

---

## 输出模板

### 成功报告

```markdown
## CDS Deploy Pipeline Report

**Trace ID**: `a3f7c012`
**分支**: `claude/fix-xxx-yyyyy`
**触发时间**: 2026-03-19 14:30:00

| # | 阶段 | 状态 | 耗时 |
|---|------|------|------|
| 0 | 环境预检 | ✓ | 1.2s |
| 1 | Git Push | ✓ | 3.5s |
| 2 | CDS Pull | ✓ | 2.1s |
| 3 | CDS Deploy | ✓ | 45.2s |
| 4 | Readiness Check | ✓ | 9.3s |
| 5 | Smoke Test | ✓ | 12.5s |

**总耗时**: 73.8s

**预览地址**: https://claude-fix-xxx-yyyyy.miduo.org/
```

### 失败报告

```markdown
## CDS Deploy Pipeline Report

**Trace ID**: `b2e8d045`
**分支**: `claude/fix-xxx-yyyyy`
**失败阶段**: Phase 3: CDS Deploy

| # | 阶段 | 状态 | 耗时 |
|---|------|------|------|
| 0 | 环境预检 | ✓ | 1.0s |
| 1 | Git Push | ✓ | 2.8s |
| 2 | CDS Pull | ✓ | 1.5s |
| 3 | CDS Deploy | ✗ | 30.2s |
| 4 | Readiness Check | ⊘ | - |
| 5 | Smoke Test | ⊘ | - |

**失败原因**: 服务 api 构建失败
**容器日志** (最后 20 行):
```text
error CS1002: ; expected
src/PrdAgent.Api/Controllers/FooController.cs(42,5)
Build FAILED.
```

**建议修复**:
1. 检查 `FooController.cs:42` 的语法错误
2. 本地运行 `cd prd-api && dotnet build` 验证
3. 修复后重新执行 `/cds-deploy`
```

---

## 端到端示例

**场景**：AI 完成了 AutomationRules 模块的 bug 修复，想部署验证。

**用户输入**：`/cds-deploy`

**AI 执行流程**：

1. 生成 traceId: `c4a92f71`
2. Phase 0: 检测分支 `claude/fix-automation-toggle-BxKj9`，CDS 运行中，分支已注册
3. Phase 1: `git push -u origin claude/fix-automation-toggle-BxKj9` 成功
4. Phase 2: `POST /api/branches/claude-fix-automation-toggle-BxKj9/pull` → HEAD 匹配
5. Phase 3: `POST /api/branches/claude-fix-automation-toggle-BxKj9/deploy` → 轮询 → api: running, admin: running
6. Phase 4: `curl localhost:10003/api/health` → 200 OK（第 2 次探测）
7. Phase 5: 从 git diff 推断模块 `automations`，执行 `/smoke automations`，7/7 通过

**最终输出**：完整的链路追踪报告 + 预览地址

---

## 异常处理

| 场景 | 处理策略 |
|------|---------|
| CDS 不可达 | 终止，提示检查 CDS 是否运行 (`./exec_cds.sh status`) |
| 分支未注册 | 自动调用 `POST /api/branches` 注册，然后继续 |
| Git Push 失败 | 指数退避重试 4 次，仍失败则终止 |
| CDS Pull HEAD 不匹配 | 警告但继续（可能是 rebase 场景） |
| Deploy 超时 (>5min) | 终止，输出容器日志 |
| Deploy 部分失败 | 标记失败服务，如 API 正常则继续 readiness + smoke |
| Readiness 超时 (>60s) | 输出容器日志，终止 |
| 冒烟测试失败 | 输出失败的具体 curl 和响应，建议修复方向 |
| 无 AI_ACCESS_KEY | 跳过 Phase 5，标记 ⊘ |

## 安全规则

1. **不自动推送到 main/master**：如果当前分支是 main 或 master，终止并警告
2. **不存储密钥**：AI_ACCESS_KEY 等仅从环境变量读取
3. **CDS Token 传递**：如 CDS 开启认证，通过 `-H "X-CDS-Token: $CDS_TOKEN"` 或 cookie 传递
4. **生产环境检测**：如 CDS_DASHBOARD_URL 指向非 localhost，输出警告
5. **冒烟测试数据清理**：所有测试创建的资源必须在测试结束时删除
