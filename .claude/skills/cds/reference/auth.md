# 认证决策树 & 双层鉴权

## 三种认证方式

| 方式 | 密钥前缀 | 来源 | 优先级 | 交互成本 |
|------|---------|------|--------|----------|
| A. 静态 bootstrap | 任意字符串 | CDS master `process.env.AI_ACCESS_KEY` 或 customEnv | 最高 | 0（配好即用）|
| B. 全局 bootstrap key | `cdsg_` | Dashboard 设置菜单"🔑 Agent 全局通行证" | 等同 A | 1 次签发 |
| C. 项目级 key | `cdsp_<slug>_` | 项目卡片"🔑 授权 Agent" | 仅本项目 | 1 次签发 |
| D. 动态配对 | 随机 token | `/api/ai/request-access` + 用户点批准 | 24h 有效 | 每 24h 1 次 |
| E. Cookie | — | 浏览器登录 | 同用户 | 不推荐 AI 用 |

**AI 应优先用 A/B**（零交互），C 用于"用户粘 3 行代码给你"的场景，D 用于"用户没配静态 key 又不想给全局权限"的场景。

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

**正确处理**：告诉用户"去 `<got>` 项目页点「🔑 授权 Agent」按钮重新生成 key 贴给我"，不要自己尝试换 key。

## 反面案例（禁止复发）

| ❌ 错误 | ✅ 正确 |
|---------|---------|
| 用 `X-Cds-Internal: 1` | 用 `X-AI-Access-Key`，`Internal` 是 CDS 代理内部用的，AI 用会在 Activity Monitor 上没 AI 标志 |
| `X-AI-Impersonate: admin` | 先 `cdscli branch exec <id> --profile api 'curl localhost:5000/api/users'` 拿真实用户名 |
| 项目 key 试图 `POST /api/projects` | 切到 bootstrap 或 global key（cdsg_*）|
| 401 直接说"key 错了" | 按决策树四步定位，区分 env 未注入 / 值错 / 用户不存在 / 端点不存在 |
