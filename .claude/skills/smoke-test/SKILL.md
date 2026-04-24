---
name: smoke-test
description: 自动生成冒烟测试 curl 命令。扫描目标模块的 Controller 端点，生成链式 curl 命令（前一步的输出 ID 传给后续请求），读取环境变量 AI_ACCESS_KEY 作为认证凭据。触发词："冒烟测试"、"smoke test"、"跑个冒烟"。
---

# Smoke Test - 自动化冒烟测试生成

> ℹ️ **CDS 分支冒烟请优先用 `cds` 技能** (2026-04-18)：`cdscli smoke <branchId>` 覆盖了
> 分层冒烟（L1 根路径 / L2 无认证 API / L3 认证 API）+ 预览域名自动推断。
>
> 本技能继续服务于**非 CDS 场景**：给单一模块 Controller 生成链式
> curl（前一步的 ID 传给后续），比如本地起了 prd-api 想跑个冒烟。

---

为指定模块自动生成链式冒烟测试 curl 命令，验证 CRUD + 核心业务流程的端到端可用性。

## 触发词

- "冒烟测试"
- "smoke test"
- "跑个冒烟"
- "帮我测试一下接口"

## 核心理念

1. **零配置**：从环境变量读取认证信息，不需要用户手动填写
2. **链式执行**：前一步创建的资源 ID 自动传递给后续步骤
3. **自包含**：每次生成完整的测试脚本，复制粘贴即可执行
4. **可观测**：每步都有清晰的预期结果说明

## 配置

### 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `AI_ACCESS_KEY` | API 认证密钥（CDS 和 MAP 平台通用） | 无，必须设置 |
| `MAP_AI_USER` | **X-AI-Impersonate 用户名**（优先级最高） | 无 |
| `SMOKE_TEST_HOST` | API 服务地址 | `http://localhost:5000` |
| `CDS_HOST` | CDS 地址（CDS 模式时使用） | 无 |

> **`AI_ACCESS_KEY` 是通用密钥**：同一个 key 可用于 CDS 管理 API、MAP 平台 API、以及后端业务 API 的认证，无需为不同平台维护多个密钥。

### 三种执行模式

#### 模式 A：本地模式（默认）

直接 curl 本地或远程 API：

```bash
-H "X-AI-Access-Key: $AI_ACCESS_KEY"
-H "X-AI-Impersonate: ${MAP_AI_USER}"   # ← 优先从环境变量读取
```

#### 模式 B：MAP 平台直连模式（推荐远程测试）

> **优先使用此模式**，减少 container-exec 调用。`AI_ACCESS_KEY` 是通用密钥，可直接认证 MAP 平台 API。

通过预览域名直连 MAP 平台 API（无需 container-exec 中转）：

```bash
PREVIEW_URL="https://${BRANCH_ID}.miduo.org"
IMPERSONATE="${MAP_AI_USER}"

# 直接调用（AI_ACCESS_KEY 通用认证）
curl -sf "$PREVIEW_URL/api/users?pageSize=3" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "X-AI-Impersonate: $IMPERSONATE"
```

**何时使用 MAP 直连模式**：
- 用户说 "在线冒烟" / "CDS 冒烟" / "线上验证"
- `SMOKE_TEST_HOST` 是 CDS 预览域名（`*.miduo.org`）
- `MAP_AI_USER` 已配置（省去用户名发现步骤）

#### 模式 C：CDS container-exec 模式（兜底）

仅当 MAP 直连失败（Cloudflare/CDN 干扰或端点特殊）时使用 container-exec：

```bash
# 仅在直连失败时才用 container-exec
curl -sf "$CDS/api/branches/$BRANCH_ID/container-exec" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"curl -s http://localhost:5000/api/..."}'
```

> ⚠️ **减少 container-exec 使用**：container-exec 有嵌套 JSON 转义复杂、调试困难等问题。优先使用模式 B 直连。

### X-AI-Impersonate 用户名发现（关键！）

> ⚠️ **严禁硬编码 `admin` 或 `root`**。`admin` 通常不是真实数据库用户名，`root` 是破窗账户不在 users 集合中。

**自动发现流程**（每次冒烟测试开始前必须执行，按优先级尝试）：

```bash
# 方法 1（最推荐，零网络请求）：读取环境变量 MAP_AI_USER
IMPERSONATE="${MAP_AI_USER:-}"
if [[ -n "$IMPERSONATE" ]]; then
  echo "✓ 从 MAP_AI_USER 获取用户名: $IMPERSONATE"
fi

# 方法 2（兜底）：通过 root 登录 + JWT 查询用户列表
if [[ -z "$IMPERSONATE" ]]; then
  TOKEN=$(curl -s "$HOST/api/v1/auth/login" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"root\",\"password\":\"$ROOT_ACCESS_PASSWORD\",\"clientType\":\"admin\"}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
  IMPERSONATE=$(curl -s "$HOST/api/users?pageSize=1" \
    -H "Authorization: Bearer $TOKEN" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['items'][0]['username'])")
fi
```

> **强烈建议**：在 AI 运行环境中配置 `MAP_AI_USER` 环境变量，避免每次冒烟测试都通过 root JWT 登录来发现用户名。

### 认证方式

```bash
# 请求头（使用自动发现的用户名）
-H "X-AI-Access-Key: $AI_ACCESS_KEY"
-H "X-AI-Impersonate: $IMPERSONATE"
```

## 执行流程

### Step 1: 确定测试目标

用户说 "冒烟测试" 时，需要判断测试范围：

- 如果用户指定了模块名（如 "冒烟测试 automations"）→ 只测试该模块
- 如果用户没指定 → 询问要测试哪个模块，或者测试当前正在开发的功能
- 如果用户说 "全部" → 对所有核心模块生成测试

### Step 2: 扫描目标 Controller

读取目标模块的 Controller 文件，提取：
- 所有 HTTP 端点（`[HttpGet]`, `[HttpPost]`, `[HttpPut]`, `[HttpDelete]`）
- 路由模式（`[Route("api/xxx")]`）
- 请求/响应 DTO 结构
- 必填字段和验证规则

```bash
# Controller 文件位置
prd-api/src/PrdAgent.Api/Controllers/Api/{ModuleName}Controller.cs
```

### Step 3: 生成链式 curl 脚本

根据扫描结果，生成一个完整的 bash 脚本，包含：

1. **环境检查** - 验证 AI_ACCESS_KEY 已设置
2. **只读查询** - 先测试列表/元数据接口（无副作用）
3. **创建资源** - 测试 POST 创建，提取返回的 ID
4. **读取验证** - 用创建的 ID 测试 GET 详情
5. **更新资源** - 测试 PUT 更新
6. **业务操作** - 测试模块特有的操作（如 toggle、trigger）
7. **清理** - 测试 DELETE 删除创建的资源

### Step 4: 输出脚本

输出完整的可执行 bash 脚本，格式如下：

```bash
#!/bin/bash
# ============================================
# 冒烟测试: {模块名}
# 生成时间: {当前时间}
# ============================================

set -e

# --- 配置 ---
HOST="${SMOKE_TEST_HOST:-http://localhost:5000}"
KEY="${AI_ACCESS_KEY:?请设置环境变量 AI_ACCESS_KEY}"
AUTH=(-H "X-AI-Access-Key: $KEY" -H "X-AI-Impersonate: admin" -H "Content-Type: application/json")

echo "=========================================="
echo "冒烟测试: {模块名}"
echo "目标: $HOST"
echo "=========================================="

# --- 1. 只读查询 ---
echo ""
echo ">>> [1/N] 查询元数据..."
RESULT=$(curl -sf "$HOST/api/{module}/metadata" "${AUTH[@]}")
echo "$RESULT" | jq -r '.data'
echo "✅ 元数据查询成功"

# --- 2. 创建资源 ---
echo ""
echo ">>> [2/N] 创建测试资源..."
RESULT=$(curl -sf "$HOST/api/{module}/items" "${AUTH[@]}" \
  -X POST \
  -d '{
    "name": "smoke-test-临时",
    "field1": "value1"
  }')
ITEM_ID=$(echo "$RESULT" | jq -r '.data.id')
echo "✅ 创建成功, ID: $ITEM_ID"

# --- 3. 读取验证 ---
echo ""
echo ">>> [3/N] 读取刚创建的资源..."
curl -sf "$HOST/api/{module}/items/$ITEM_ID" "${AUTH[@]}" | jq '.data'
echo "✅ 读取成功"

# --- 4. 更新 ---
echo ""
echo ">>> [4/N] 更新资源..."
curl -sf "$HOST/api/{module}/items/$ITEM_ID" "${AUTH[@]}" \
  -X PUT \
  -d '{"name": "smoke-test-已更新"}'
echo "✅ 更新成功"

# --- 5. 业务操作 ---
# (根据模块生成特有操作)

# --- 6. 清理 ---
echo ""
echo ">>> [N/N] 清理测试资源..."
curl -sf "$HOST/api/{module}/items/$ITEM_ID" "${AUTH[@]}" -X DELETE
echo "✅ 清理完成"

echo ""
echo "=========================================="
echo "🎉 所有冒烟测试通过!"
echo "=========================================="
```

### Step 5: 用户执行并反馈

1. 用户复制脚本到终端执行
2. 将输出结果贴回对话
3. 分析结果，如有失败则定位问题

## 模块测试模板

### 已知模块的测试要点

| 模块 | Controller | 关键测试点 |
|------|-----------|-----------|
| automations | AutomationRulesController | CRUD + toggle + trigger + event-types + action-types |
| open-platform | OpenPlatformController | 应用 CRUD + webhook 配置 + 密钥轮换 |
| users | UsersController | 列表 + 详情 |
| mds (模型管理) | ModelGroupsController | 模型组 CRUD + 平台列表 |
| authz | AuthzController | 角色列表 + 权限分配 |
| logs | LogsController | LLM 日志查询 |
| visual-agent | VisualAgentController | 工作区列表 + 会话 |
| defect-agent | DefectAgentController | 模板 CRUD + 缺陷提交 |

### Automations 模块示例

完整的链式测试脚本（已验证通过）：

```bash
#!/bin/bash
set -e

HOST="${SMOKE_TEST_HOST:-http://localhost:5000}"
KEY="${AI_ACCESS_KEY:?请设置环境变量 AI_ACCESS_KEY}"
AUTH=(-H "X-AI-Access-Key: $KEY" -H "X-AI-Impersonate: admin" -H "Content-Type: application/json")

echo "=========================================="
echo "冒烟测试: Automations (自动化规则引擎)"
echo "目标: $HOST"
echo "=========================================="

# 1. 获取事件类型列表
echo ""
echo ">>> [1/7] 获取事件类型列表..."
curl -sf "$HOST/api/automations/event-types" "${AUTH[@]}" | jq '.data.items | length | "事件类型数量: \(.)"'
echo "✅ 事件类型查询成功"

# 2. 获取动作类型列表
echo ""
echo ">>> [2/7] 获取动作类型列表..."
curl -sf "$HOST/api/automations/action-types" "${AUTH[@]}" | jq '.data.items[] | .type + " - " + .label'
echo "✅ 动作类型查询成功"

# 3. 创建测试规则
echo ""
echo ">>> [3/7] 创建测试规则..."
RESULT=$(curl -sf "$HOST/api/automations/rules" "${AUTH[@]}" \
  -X POST \
  -d '{
    "name": "smoke-test-规则",
    "enabled": true,
    "eventType": "test.manual",
    "actions": [
      {
        "type": "webhook",
        "webhookUrl": "https://httpbin.org/post",
        "webhookSecret": "test-secret"
      },
      {
        "type": "admin_notification",
        "notifyLevel": "info"
      }
    ],
    "titleTemplate": "冒烟测试: {{title}}",
    "contentTemplate": "事件: {{eventType}}, 来源: {{sourceId}}"
  }')
RULE_ID=$(echo "$RESULT" | jq -r '.data.id')
echo "✅ 创建成功, ID: $RULE_ID"

# 4. 查询规则列表
echo ""
echo ">>> [4/7] 查询规则列表..."
curl -sf "$HOST/api/automations/rules?page=1&pageSize=5" "${AUTH[@]}" | jq '.data | "总数: \(.total), 当前页: \(.items | length) 条"'
echo "✅ 列表查询成功"

# 5. 切换启用/禁用
echo ""
echo ">>> [5/7] 切换规则状态..."
curl -sf "$HOST/api/automations/rules/$RULE_ID/toggle" "${AUTH[@]}" -X POST | jq '.data'
echo "✅ 状态切换成功"
# 切回启用
curl -sf "$HOST/api/automations/rules/$RULE_ID/toggle" "${AUTH[@]}" -X POST > /dev/null
echo "   (已切回启用状态)"

# 6. 手动触发规则
echo ""
echo ">>> [6/7] 手动触发规则..."
curl -sf "$HOST/api/automations/rules/$RULE_ID/trigger" "${AUTH[@]}" \
  -X POST \
  -d '{
    "eventType": "test.manual",
    "title": "冒烟测试触发",
    "content": "这是一条冒烟测试通知"
  }' | jq '.data | "所有动作成功: \(.allSucceeded), 动作数: \(.actionResults | length)"'
echo "✅ 触发成功"

# 7. 删除测试规则
echo ""
echo ">>> [7/7] 清理测试规则..."
curl -sf "$HOST/api/automations/rules/$RULE_ID" "${AUTH[@]}" -X DELETE
echo "✅ 清理完成"

echo ""
echo "=========================================="
echo "所有 Automations 冒烟测试通过!"
echo "=========================================="
```

## 生成规则

### curl 命令规范

1. 使用 `-sf` 标志（静默 + 失败时退出）
2. 使用 `"${AUTH[@]}"` 数组展开认证头
3. JSON body 使用 `-d '{...}'` 单引号包裹
4. 提取 ID 使用 `jq -r '.data.id'`
5. 验证结果使用 `jq` 格式化关键字段

### 链式传值

```bash
# 创建后提取 ID
ITEM_ID=$(echo "$RESULT" | jq -r '.data.id')

# 后续步骤使用该 ID
curl ... "$HOST/api/module/$ITEM_ID" ...
```

### 测试数据命名

- 创建的资源名称统一使用 `smoke-test-` 前缀
- 便于识别和手动清理残留数据

### 错误处理

- `set -e` 使脚本在任何命令失败时立即停止
- 每步都有 echo 输出，方便定位失败位置
- 失败时用户将输出贴回对话，由 AI 分析原因

## CDS 远程冒烟模式

当用户说 "在线冒烟" / "CDS 冒烟" / "线上验证"，或目标是 CDS 预览环境时，采用以下模式。

### CDS 模式执行流程

```
Step 0: 环境准备
├─ 推导 BRANCH_ID（git branch → slugify）
├─ 确认 CDS 认证（AI_ACCESS_KEY 通用密钥）
├─ 确认分支状态为 running
└─ 读取 MAP_AI_USER 环境变量获取用户名

Step 1: 用户名确认
├─ 优先：读取 $MAP_AI_USER 环境变量（零网络请求）
└─ 兜底：通过 root JWT 登录查询用户列表

Step 2: 分层冒烟测试（优先直连预览域名，失败时才用 container-exec）
├─ Layer 1: 无认证端点（健康检查、版本等）
├─ Layer 2: 认证端点-只读（用户列表、模型列表、会话等）
└─ Layer 3: 认证端点-写入（创建+查询+删除，可选）
```

### CDS 模式脚本模板（推荐：直连 MAP 平台）

> **优先直连**：`AI_ACCESS_KEY` 是通用密钥，可直接认证 MAP 平台的后端 API。只在 Cloudflare 干扰时才回退到 container-exec。

```bash
#!/bin/bash
# CDS 远程冒烟测试 — MAP 直连模式（推荐）
BRANCH_ID="claude-xxx-yyy"  # 从分支名推导
PREVIEW_URL="https://${BRANCH_ID}.miduo.org"
IMPERSONATE="${MAP_AI_USER:?请设置环境变量 MAP_AI_USER}"

AUTH=(-H "X-AI-Access-Key: $AI_ACCESS_KEY" -H "X-AI-Impersonate: $IMPERSONATE" -H "Content-Type: application/json")

echo ">>> [1] 健康检查（直连 MAP 平台）..."
curl -sf "$PREVIEW_URL/api/shortcuts/version-check"

echo ">>> [2] 用户列表..."
curl -sf "$PREVIEW_URL/api/users?pageSize=3" "${AUTH[@]}"
# ... 更多端点
```

### 兜底：container-exec 模式

仅当预览域名被 Cloudflare 干扰时使用：

```bash
#!/bin/bash
# CDS 远程冒烟测试 — container-exec 兜底模式
CDS="https://$CDS_HOST"
BRANCH_ID="claude-xxx-yyy"

cds_exec() {
  local cmd="$1"
  curl -sf "$CDS/api/branches/$BRANCH_ID/container-exec" \
    -H "X-AI-Access-Key: $AI_ACCESS_KEY" -X POST -H "Content-Type: application/json" \
    -d "{\"profileId\":\"api\",\"command\":\"$cmd\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['stdout'])" 2>/dev/null
}

# 仅在直连失败时使用
cds_exec "curl -s http://localhost:5000/api/shortcuts/version-check"
```

### 三种模式对比

| 维度 | 本地模式 | MAP 直连模式（推荐） | container-exec 兜底 |
|------|---------|-------------------|-------------------|
| 执行位置 | AI 沙箱直接 curl | AI 沙箱 → 预览域名 | AI 沙箱 → CDS API → 容器内 |
| 网络 | 直连 localhost | 直连预览域名 | 经 CDS proxy → 容器 localhost |
| 认证 | 单层（API key） | 单层（API key 通用） | 双层（CDS key + 容器 key） |
| 用户名 | `$MAP_AI_USER` | `$MAP_AI_USER` | 需容器内发现或 `$MAP_AI_USER` |
| CDN 影响 | 无 | 有（极少数端点） | 无 |
| JSON 转义 | 简单 | 简单 | 复杂（嵌套转义） |
| 适用场景 | 本地开发 | **远程验证首选** | 直连失败时兜底 |

## 注意事项

1. **不要硬编码密钥**：始终从 `$AI_ACCESS_KEY` 读取
2. **不要硬编码用户名**：优先从 `$MAP_AI_USER` 读取，严禁使用 `admin` 或 `root`
3. **优先直连 MAP 平台**：`AI_ACCESS_KEY` 是通用密钥，减少 container-exec 使用（嵌套 JSON 转义复杂易出错）
4. **清理测试数据**：脚本最后一步必须删除创建的资源
5. **幂等设计**：脚本可重复执行，不会产生残留
6. **最小权限**：只测试必要的端点，不做破坏性操作
7. **生产环境警告**：如果 HOST 不是 localhost，输出警告提示
8. **container-exec 仅作兜底**：仅当预览域名直连被 CDN 干扰时才使用 container-exec
