# prd-admin — React 18 管理后台 (Vite, TypeScript, Zustand, Radix UI)

## 构建命令

```bash
pnpm install
pnpm dev          # Dev server (port 8000, proxies /api → localhost:5000)
pnpm build        # tsc && vite build → dist/
pnpm lint         # ESLint
pnpm tsc          # Type check only
pnpm test         # vitest
```

## 已注册共享组件

| 组件 | 路径 | 数据源 |
|------|------|--------|
| `ModelTypePicker` | `components/model/ModelTypePicker.tsx` | `lib/appCallerUtils.ts → MODEL_TYPE_DEFINITIONS` |
| `ModelTypeFilterBar` | `components/model/ModelTypePicker.tsx` | 同上 |
