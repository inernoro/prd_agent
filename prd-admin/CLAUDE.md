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

## 热点组件结构基线

`src/components/web-hosting/__snapshots__/` 存着几个高频共享组件的**结构基线**（`.snap` 文本）。
它记的是几何——尺寸/弹性/定位/间距/溢出/对齐/可点可见——与契约属性（`data-hoverbar`、
`aria-label` 这些别的代码按它找元素的标记），不记颜色圆角字号。抽取判据在
`src/lib/structuralSnapshot.ts`，两头都有用例钉着（太宽会让基线沦为橡皮图章，太窄则拦不住真事故）。

**为什么有它**：共享组件改一笔会同时影响好几屏，改的人当场看不到影响面。真实栽过三次——
hover 条以整条宽度接管指针把勾选框吞掉、卡片少了 `h-full` 高度不再一致、分享档整块摞到顶栏上面，
三次都是「代码看着对、测试全绿、只有真人打开才看得见」。

**看到 diff 怎么办**：先问「我这次是不是有意改布局」。是 →
`pnpm vitest -u src/components/web-hosting/__snapshots__` 更新，并在 PR 里说明哪几屏会跟着变；
否 → 你刚改坏了一处几何，diff 那几行就是现场。**不要习惯性 -u。**

加新组件进基线：在 `hotComponents.test.tsx` 里加一条 `toMatchFileSnapshot`。渲染走
`renderToStaticMarkup`（本仓库既有做法，不需要 DOM 环境）；组件里若有相对时间这类随时钟变的
文案，测试文件顶部已经把时钟钉死了，别再引入第二个时间源。

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
| `DocBrowser` | `components/doc-browser/DocBrowser.tsx` | 统一左右分栏文档阅读/编辑器。受控组件，**不传写操作 callback 自动 readonly**。三处调用方共享同一份代码：① `pages/document-store/DocumentStorePage.tsx`（私人知识库编辑）② `pages/library/LibraryShareViewPage.tsx`（分享链只读，`sortMode="created-desc"` + `?entry=` 高亮）③ `pages/changelog/components/WeeklyReportsTab.tsx`（更新中心-周报，`appearance="cards"` 双卡片 + 自定义 NEW 徽章规则）。关键 props：`sortMode`（default/created-desc/updated-desc）、`appearance`（inset/cards）、`isEntryFresh`（自定义 NEW 徽章判定）、`sidebarHeader`（左 sidebar 顶部自定义头部 slot）。新建第四处左右分栏阅读页必须先复用 DocBrowser，留债条件见 `doc/debt.knowledge-base.md「知识库文档阅读器」` 和 `doc/debt.report-agent.md「周报 Agent 详情页」`。 |
