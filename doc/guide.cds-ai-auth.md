# CDS + 后端 API 双层认证诊断指南

> **类型**: guide | **创建日期**: 2026-03-20 | **作者**: AI + 人工验证
>
> 本指南源于 2026-03-20 CDS 冒烟测试中的实际踩坑经验，将调试过程中的弯路固化为标准化诊断流程。

---

## 核心概念：双层认证

CDS 环境中存在**两个独立的认证层**，是最容易混淆的地方。

```
AI Agent
│
├─ Layer 1: CDS 认证 ─── 管理 CDS 自身（部署/日志/exec）
│   ├─ 谁验证: CDS master 进程 (Node.js)
│   ├─ 读取: CDS master 的 process.env.AI_ACCESS_KEY
│   ├─ Header: X-AI-Access-Key 或 X-CDS-AI-Token
│   └─ 效果: Activity Monitor 显示 AI 标志 🤖
│
└─ Layer 2: 后端 API 认证 ─── 测试业务接口（用户/会话/模型）
    ├─ 谁验证: .NET API 进程 (Docker 容器内)
    ├─ 读取: 容器内的 AI_ACCESS_KEY 环境变量
    ├─ Header: X-AI-Access-Key + X-AI-Impersonate
    └─ 效果: 以指定用户身份调用 API
```

### 关键区别

| 维度 | CDS 认证 (Layer 1) | 后端 API 认证 (Layer 2) |
|------|-------------------|----------------------|
| 认证对象 | CDS 管理 API | .NET 业务 API |
| Key 来源 | CDS master 进程 env | Docker 容器 env |
| 额外 Header | 无 | `X-AI-Impersonate: {用户名}` |
| 用户名要求 | 无 | **必须是数据库中真实存在的 username** |
| 失败表现 | CDS 返回 401 | 后端返回 `{"code":"UNAUTHORIZED"}` |

---

## 诊断流程图

### 场景 A：CDS API 返回 401

```
CDS API 401
│
├─ 检查 Header
│   ├─ 用了 X-Cds-Internal: 1 → 功能正常但无 AI 标志，换用 X-AI-Access-Key
│   ├─ 用了 X-AI-Access-Key → 确认 CDS master 是否配置了 AI_ACCESS_KEY env
│   └─ 用了 X-CDS-AI-Token → 确认 token 未过期（24h 有效）
│
└─ 解决方案
    ├─ 方式 A: 在 CDS 服务器设置 AI_ACCESS_KEY 环境变量
    ├─ 方式 B: POST /api/ai/request-access → Dashboard 审批
    └─ 方式 C: Cookie 兜底（cds_token）
```

### 场景 B：后端 API 返回 401

```
后端 API 401（最常见的踩坑场景）
│
├─ Step 1: 确认 AI_ACCESS_KEY 在容器内存在
│   命令: POST container-exec → printenv AI_ACCESS_KEY
│   ├─ 空 → 通过 CDS PUT /api/env/AI_ACCESS_KEY 设置 + redeploy
│   └─ 有值 → 继续
│
├─ Step 2: 确认 X-AI-Impersonate 用户名正确  ← 最常见的坑！
│   命令: POST container-exec → curl /api/users (用 JWT 登录)
│   ├─ 用了 "admin" → ❌ 数据库通常没有此用户名
│   ├─ 用了 "root" → ❌ 破窗账户不在 users 集合中
│   └─ 用真实用户名（如 "Yuruipeng"）→ ✅
│
├─ Step 3: 检查 401 具体错误信息
│   .NET 返回的 error.message 不同含义：
│   ├─ "AI Access Key authentication not configured" → env 未被读取
│   ├─ "Invalid AI Access Key" → key 值不匹配
│   ├─ "User 'xxx' not found" → 用户名错误
│   ├─ "User 'xxx' is disabled" → 用户被禁用
│   └─ "未授权"（中文） → AdminPermissionMiddleware，见 Step 4
│
└─ Step 4: "未授权" 中文错误的特殊处理
    来源: AdminPermissionMiddleware (不是 AiAccessKeyAuthenticationHandler)
    ├─ 可能原因 1: endpoint 路径不存在，被 middleware 拦截
    │   验证: 用 JWT 访问同一路径，如返回 404 则确认路径错误
    ├─ 可能原因 2: auth scheme 未触发
    │   验证: 确认 Controller 有 [Authorize] 属性
    └─ 可能原因 3: UseAuthorization 未正确合并 principal
        验证: 检查 Program.cs DefaultPolicy 是否包含 AiAccessKey scheme
```

---

## 自动发现用户名

每次冒烟测试前**必须**执行用户名自动发现，禁止硬编码。

### 方法 1：Root JWT 登录 → 查询用户列表

```bash
# 容器内执行（通过 container-exec）
TOKEN=$(curl -s http://localhost:5000/api/v1/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"username":"root","password":"'$ROOT_ACCESS_PASSWORD'","clientType":"admin"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")

USERNAME=$(curl -s "http://localhost:5000/api/users?pageSize=1" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['items'][0]['username'])")

echo "Impersonate as: $USERNAME"
```

### 方法 2：已知一个用户名后获取完整列表

```bash
curl -s "http://localhost:5000/api/users" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "X-AI-Impersonate: $KNOWN_USERNAME" \
  | python3 -c "
import sys,json
users = json.load(sys.stdin)['data']['items']
for u in users[:5]:
    print(f\"{u['username']} ({u['displayName']}) - {u['role']}\")
"
```

---

## CDS Activity Monitor 的 AI 标志

### 为什么没有 AI 标志

| 操作方式 | AI 标志 | 原因 |
|----------|---------|------|
| `X-AI-Access-Key` Header | ✅ 显示 | CDS `resolveAiSession()` 识别为 AI |
| `X-CDS-AI-Token` Header | ✅ 显示 | 配对 token 识别为 AI |
| `X-Cds-Internal: 1` Header | ❌ 不显示 | 内部请求，绕过 AI 识别 |
| `Cookie: cds_token=xxx` | ❌ 不显示 | 被识别为人类用户 |
| 无认证 Header | ❌ 不显示 | 匿名请求 |

### 确保 AI 标志显示的正确做法

```bash
# ✅ 正确：使用 AI 认证 Header
curl -sf "$CDS/api/branches" \
  -H "X-AI-Access-Key: $AI_ACCESS_KEY"

# ❌ 错误：使用内部 Header（功能正常但无 AI 标志）
curl -sf "$CDS/_cds/api/branches" \
  -H "X-Cds-Internal: 1"
```

---

## 常见陷阱速查表

| # | 陷阱 | 症状 | 快速修复 |
|---|------|------|---------|
| 1 | `X-AI-Impersonate: admin` | 401 | 换成数据库中真实用户名 |
| 2 | `X-AI-Impersonate: root` | 401 | root 是破窗账户，不在 users 集合 |
| 3 | 混淆 CDS env 和容器 env | env 看到了但 API 还是 401 | `container-exec printenv` 验证容器内 |
| 4 | 不存在的路径返回 401 而非 404 | 误以为是认证问题 | 用 JWT 验证路径存在性 |
| 5 | `X-Cds-Internal: 1` 无 AI 标志 | Activity 无 AI badge | 换用 `X-AI-Access-Key` |
| 6 | Cloudflare 将 401 转为 500 | 预览域名返回空 500 | 用 `container-exec` 绕过 CDN |
| 7 | 设了 env 但没 redeploy | 容器用旧 env 启动 | CDS stop + deploy 重建容器 |

---

## 诊断命令速查

```bash
CDS="https://xxx.miduo.org"
BRANCH_ID="claude-xxx"
AUTH="-H 'X-AI-Access-Key: $AI_ACCESS_KEY'"

# 1. 查看 CDS 自定义环境变量
curl -sf "$CDS/api/env" $AUTH

# 2. 查看容器内实际环境变量
curl -sf "$CDS/api/branches/$BRANCH_ID/container-exec" $AUTH \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"printenv AI_ACCESS_KEY"}'

# 3. 容器内测试 API 认证
curl -sf "$CDS/api/branches/$BRANCH_ID/container-exec" $AUTH \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"curl -s http://localhost:5000/api/users -H \"X-AI-Access-Key: $AI_ACCESS_KEY\" -H \"X-AI-Impersonate: Yuruipeng\" -w \"\\nHTTP %{http_code}\""}'

# 4. 容器内 root 登录获取 JWT（不依赖 AI_ACCESS_KEY）
curl -sf "$CDS/api/branches/$BRANCH_ID/container-exec" $AUTH \
  -X POST -H "Content-Type: application/json" \
  -d '{"profileId":"api","command":"curl -s http://localhost:5000/api/v1/auth/login -X POST -H \"Content-Type: application/json\" -d \"{\\\"username\\\":\\\"root\\\",\\\"password\\\":\\\"$ROOT_ACCESS_PASSWORD\\\",\\\"clientType\\\":\\\"admin\\\"}\""}'
```

---

## 经验教训（2026-03-20 复盘）

### 走弯路的根因

1. **缺乏最小验证思维**：收到 401 后直接假设是 env 问题，没有先用 `printenv` 排除
2. **混淆双层认证**：把 CDS 的 `AI_ACCESS_KEY` 和容器的 `AI_ACCESS_KEY` 当作同一个
3. **忽略 impersonate 用户名**：默认用 "admin" 而没有先验证数据库中是否存在该用户

### 正确的诊断顺序

```
1. printenv → 确认 env 存在（10 秒排除）
2. 换用户名 → 确认 impersonate 目标正确（10 秒排除）
3. 检查错误信息 → 区分具体失败原因（30 秒定位）
4. 读源码 → 仅在以上 3 步无法解决时才需要
```

> **原则**：每次排查先做最廉价的验证。一条 `printenv` 命令能排除的问题，不要去读 300 行源码。
