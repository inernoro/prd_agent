# prd-llmgw-web

独立的 LLM 网关观测前端 mini-app。**完全隔离**：自带账号体系、路由、组件风格，不依赖 `prd-admin` / `prd-api` 的任何源码或全局状态。

## 技术栈

Vite 6 + React 18 + TypeScript（pnpm only）。无 UI 框架，OpenRouter 风格走自带的 CSS token（`src/theme.css`，暗色默认，`[data-theme="light"]` 预留浅色）。

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
│   ├── LoginPage.tsx        独立登录页
│   └── LogsPage.tsx         观测主页（头部 + LogsView）
└── components/
    ├── ui.tsx               自包含 UI 原语（Button/Chip/Card/TabBar/Spinner）
    ├── MiniBarChart.tsx     极简柱状图（无 echarts）
    ├── LogsView.tsx         4 tab + 表格 + 筛选 + 分页
    └── GenerationDetailsDrawer.tsx  详情抽屉（createPortal）
```

## API base

走 `import.meta.env.VITE_LLMGW_API_BASE`，默认 `/gw`（dev 由 vite proxy 反代到 `LLMGW_PROXY_TARGET`，默认 `http://localhost:5000`）。

## 后端端点约定（后端另做，stub 即可）

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
