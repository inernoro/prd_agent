# 认证决策树 & 双层鉴权

## 认证方式

| 方式 | 密钥前缀 | 来源 | 优先级 | 交互成本 |
|------|---------|------|--------|----------|
| A. 页面批准的项目授权 | `cdsp_<slug>_` | `cdscli connect --project` + 用户批准 | 最高 | 用户点 1 次 |
| B. 页面批准的一次性建项目授权 | `cdsg_` | `cdscli connect --new-project` + 用户批准 | 首次接入 | 用户点 1 次 |
| C. 旧版环境变量 | 任意 / `cdsp_` / `cdsg_` | 当前进程环境 | 兼容 | 已配置即用 |
| D. Cookie | — | 浏览器登录 | 人类操作 | AI 禁用 |

Agent 必须优先使用 A/B。不得要求用户把长期密钥粘进对话；不得默认写 `~/.cdsrc` 或终端启动文件。

项目凭据由 CLI 静默保存到当前仓库 `.cds/credentials.json` 并加入本地 git exclude。显式环境变量仍可覆盖项目配置，但仅用于 CI 或旧版兼容。

## 双层认证：CDS 层 vs 后端业务层

```
┌─────────────────────────────────────────────────────┐
│                    AI Agent                         │
│                                                     │
│  Layer 1: CDS 管理层                                │
│   Header: X-AI-Access-Key: $AI_ACCESS_KEY          │
│   用途: 调 /api/branches /api/projects 等 CDS API   │
│   读取: CDS master 进程 env                         │
│                                                     │
│  Layer 2: 业务后端层（部署到 CDS 的应用）             │
│   Header: X-AI-Access-Key: $APP_KEY                │
│   Header: X-AI-Impersonate: <真实用户名>            │
│   用途: 调 api.xxx.com/api/users 等业务 API         │
│   读取: Docker 容器内 env                           │
└─────────────────────────────────────────────────────┘
```

**关键**：两个 `AI_ACCESS_KEY` 可能相同也可能不同。容器内的 env 由 CDS 的 customEnv 注入，不自动等于 CDS master 的 env。排查 401 时第一步就是 `cdscli branch exec <id> --profile api 'printenv AI_ACCESS_KEY'` 比对。

## 401 快速诊断决策树（层 2）

```
收到业务 API 401
│
├─ Step 1: 容器里 AI_ACCESS_KEY 存在吗？
│   $ cdscli branch exec <id> --profile api 'printenv AI_ACCESS_KEY'
│   ├─ 空 → CDS customEnv 未注入 → `cdscli env set AI_ACCESS_KEY=xxx --scope <projectId>` 后 redeploy
│   └─ 有 → Step 2
│
├─ Step 2: X-AI-Impersonate 的用户真的存在吗？
│   $ cdscli branch exec <id> --profile api 'curl -s localhost:5000/api/users'
│   ├─ 拿到用户列表 → 用真实 username 替换（禁止 "admin" / "root" 猜测）
│   └─ 也 401 → Step 3
│
├─ Step 3: 看错误体精确文案
│   "AI Access Key authentication not configured" → .NET 没读到 env
│   "Invalid AI Access Key"                       → 值不匹配
│   "User 'xxx' not found"                        → 用户名错
│   "User 'xxx' is disabled"                      → 用户被禁用
│   "未授权" (中文)                                → Admin 权限中间件拦截，检查端点是否存在
│
└─ Step 4: 端点可能根本不存在
    AdminPermissionMiddleware 会把未知路径也返 401（而非 404）。
    用 JWT 验证路径存在后再排查 AI key。
```

## 项目 key 403 project_mismatch

用户粘的 `CDS_PROJECT_KEY` 与当前操作的项目 ID 不匹配时，CDS 返回：

```json
{
  "error": "project_mismatch",
  "expected": "prd-agent-2",
  "got": "defect-agent",
  "message": "这把 key 只能操作 prd-agent-2 项目，请让用户在目标项目页重新「授权 Agent」"
}
```

**正确处理**：在目标项目目录重新运行 `cdscli connect --project <got>`，让用户在页面批准；不要索要或展示 key。

## 反面案例（禁止复发）

| [FAIL] 错误 | [OK] 正确 |
|---------|---------|
| 用 `X-Cds-Internal: 1` | 用 `X-AI-Access-Key`，`Internal` 是 CDS 代理内部用的，AI 用会在 Activity Monitor 上没 AI 标志 |
| `X-AI-Impersonate: admin` | 先 `cdscli branch exec <id> --profile api 'curl localhost:5000/api/users'` 拿真实用户名 |
| 项目 key 试图 `POST /api/projects` | 切到 bootstrap 或 global key（cdsg_*）|
| 401 直接说"key 错了" | 按决策树四步定位，区分 env 未注入 / 值错 / 用户不存在 / 端点不存在 |
