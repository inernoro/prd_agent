# llmgw/web

独立的 LLM Gateway 租户控制台。自带会话、路由、主题和组件体系，不依赖 `prd-admin` / `prd-api` 的前端源码或全局状态。

## 技术栈

Vite 6 + React 18 + TypeScript（pnpm only）。无 UI 框架，主题由 `src/theme.css` 的暗色与亮色 token 统一管理。

## 启动

```bash
pnpm install
pnpm dev        # http://localhost:8100
pnpm tsc        # 类型检查
pnpm build      # tsc -b && vite build → dist/
```

## 结构

```
src/
├── main.tsx                 入口
├── App.tsx                  独立路由 + 鉴权守卫（/login + /）
├── theme.css                OpenRouter 风格主题 token（暗/亮）
├── lib/
│   ├── api.ts               API 客户端（JWT 存 sessionStorage）
│   ├── auth.tsx             鉴权上下文
│   ├── types.ts             自包含类型（LLM 日志子集）
│   └── logsHelpers.ts       列定义/格式化/协议色/deriveLifecycle 注册表
├── pages/
│   ├── LoginPage.tsx        独立登录页（匿名健康状态、租户数据边界、账号说明）
│   └── LogsPage.tsx         请求记录页（LogsView）
└── components/
    ├── ui.tsx               自包含 UI 原语（Button/Chip/Card/TabBar/Spinner）
    ├── MiniBarChart.tsx     极简柱状图（无 echarts）
    ├── LogsView.tsx         4 tab + 表格 + 筛选 + 分页
    └── GenerationDetailsDrawer.tsx  详情抽屉（createPortal）
```

## API base

走 `import.meta.env.VITE_LLMGW_API_BASE`，默认 `/gw`（dev 由 Vite proxy 反代到 `LLMGW_PROXY_TARGET`，默认 `http://localhost:5090`）。

## 后端端点约定

数据形状与现有 `/api/logs/llm` 对齐，对接时把 base 指过去即可。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `{BASE}/auth/login` | body `{ username, password }` → `{ success, data: { token, username?, displayName? } }` |
| GET | `{BASE}/logs` | query `{ page, pageSize, from, to, model?, status? }` → `{ success, data: { items, total, page, pageSize } }` |
| GET | `{BASE}/logs/meta` | → `{ success, data: { models, statuses } }` |
| GET | `{BASE}/logs/timeseries` | query `{ from, to, model?, status? }` → `{ success, data: { items: [{ date, count }] } }` |
| GET | `{BASE}/logs/sessions` | query `{ from, to, page, pageSize }` → `{ success, data: { items, total } }` |
| GET | `{BASE}/logs/:id` | → `{ success, data: LlmLogDetail }` |

所有响应认 `{ success, data, error }` 信封；401 自动清 session 并跳登录页。

## 未登录页面不是数据首页

未登录访问根路径会跳到 `/login`。页面只调用匿名 `/gw/healthz` 展示服务是否连通，并说明登录后可见的 Quickstart、Activity、模型、密钥和费用范围。租户真实数据不会在未登录页面公开；“看起来没有数据”不能通过硬编码示例或放宽鉴权解决。

正式 `map.ebcone.net/llmgw/`、CDS 命名服务子域和独立品牌域名共用同一构建产物。独立 `*.ebcone.net` 域名上的“返回 MAP 首页”固定回到 `https://map.ebcone.net/`，避免在品牌域名根路径原地循环。
