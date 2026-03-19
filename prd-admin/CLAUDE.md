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
| `UserSearchSelect` | `components/UserSearchSelect.tsx` | `getUsers()` API（自动获取）或外部传入 `users` |
| `useSseStream` | `lib/useSseStream.ts` | 通用 SSE 流式 hook（连接管理、认证、状态追踪） |
| `SsePhaseBar` | `components/sse/SsePhaseBar.tsx` | 阶段状态栏（连接中/分析中/完成/失败） |
| `SseTypingBlock` | `components/sse/SseTypingBlock.tsx` | LLM 打字效果区块（原始流式输出展示） |
| `SseStreamPanel` | `components/sse/SseStreamPanel.tsx` | 组合面板（PhaseBar + TypingBlock + 业务内容） |
