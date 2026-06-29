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
| `StreamingText` | `components/streaming/StreamingText.tsx` | 统一流式文本动效（默认 Blur focus），所有 LLM 流式输出必须用它替代自行实现的 typing/markdown 重渲染。详见 `doc/rule.frontend.streaming-text.md` |
| `DocBrowser` | `components/doc-browser/DocBrowser.tsx` | 统一左右分栏文档阅读/编辑器。受控组件，**不传写操作 callback 自动 readonly**。三处调用方共享同一份代码：① `pages/document-store/DocumentStorePage.tsx`（私人知识库编辑）② `pages/library/LibraryShareViewPage.tsx`（分享链只读，`sortMode="created-desc"` + `?entry=` 高亮）③ `pages/changelog/components/WeeklyReportsTab.tsx`（更新中心-周报，`appearance="cards"` 双卡片 + 自定义 NEW 徽章规则）。关键 props：`sortMode`（default/created-desc/updated-desc）、`appearance`（inset/cards）、`isEntryFresh`（自定义 NEW 徽章判定）、`sidebarHeader`（左 sidebar 顶部自定义头部 slot）。新建第四处左右分栏阅读页必须先复用 DocBrowser，留债条件见 `doc/debt.knowledge-base.library-doc-reader.md` 和 `doc/debt.report-agent.detail.md`。 |
