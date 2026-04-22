# 海报工坊 — 设计器重构交接 · 计划

> **文档版本**：v1.0
> **创建日期**：2026-04-21
> **交接分支**：`claude/weekly-updates-carousel-XXJ7r`
> **最近 commit**：`c0ab8fe` (服务器权威化 + 从智能体搬到资源管理)
> **状态**：UI 重构为「左列表 + 中页面 + 右图文」设计器布局尚未完成,Controller/Model/Service 相关后端已就绪,前端仍是老的「一键生成 + 网格卡片」形态

---

## 一、本次需求（用户最新反馈）

参考图（图 2）布局：

```
┌─────────────────────────────────────────────┐
│  新建海报      预览/详情编辑页                 │
├──────────┬─────────────────────────────────┤
│ 当前海报 │  ┌────┐                         │
│ 周报五周 │  │图片1│        文案              │
│ □ □ □    │  └────┘    ┌──────────────┐    │
│          │  ┌────┐    │ 标题         │    │
│          │  │图片2│    │              │    │
│          │  └────┘    │ 正文(Markdown)│    │
│          │            │              │    │
│          │            └──────────────┘    │
└──────────┴─────────────────────────────────┘
```

功能诉求（用户原话拆解）：

| # | 能力 | 实现建议 |
|---|------|----------|
| ① | 创建（新建海报） | 左上角「新建海报」按钮 → 打开小 modal 选模板 + 数据源 + 生成 |
| ② | 选择数据源 | 复用现有 4 种:changelog-current-week / github-commits / knowledge-base / freeform |
| ③ | AI 生成 | 复用 `/api/weekly-posters/autopilot/stream` SSE(已做) |
| ④ | 微调设计 | 右栏图文编辑,debounce 1s 自动 PATCH |
| ⑤ | 编辑增加真实图片/视频 | 新增「上传图片」file input → base64 → 写入 `page.imageUrl` 或 `page.secondaryImageUrl` |
| ⑥ | 发布到某页面（绑定地址） | 顶栏「发布设置」抽屉编辑 `ctaUrl` |
| ⑦ | 可以预览 | 复用现有 `<PosterCarousel />` 组件 |
| ⑧ | 可以截图上传 | FileReader + 剪贴板 paste 事件监听 |

---

## 二、当前完成度

### ✅ 已就绪（可以基于现状动工）

**后端**

- [x] `WeeklyPosterAnnouncement` Model（prd-api/src/PrdAgent.Core/Models/WeeklyPosterAnnouncement.cs）
  - 含 TemplateKey / PresentationMode / SourceType / SourceRef
  - `WeeklyPosterPage` 含 Order / Title / Body / ImagePrompt / ImageUrl / **SecondaryImageUrl** / AccentColor
- [x] `WeeklyPosterController` 完整 REST（prd-api/src/PrdAgent.Api/Controllers/Api/WeeklyPosterController.cs）
  - `GET /api/weekly-posters/current` 主页弹窗取最新已发布
  - `GET /api/weekly-posters` 列表 / `GET /:id` 详情 / `POST` 创建 / `PATCH /:id` 更新 / `DELETE /:id`
  - `POST /:id/publish` / `POST /:id/unpublish`
  - `GET /templates` 模板元数据
  - **`POST /autopilot/stream` SSE 流式生成**（真 LLM 流式 + 逐 page 增量 emit）
  - `POST /:id/pages/:order/generate-image` 单页生图（同步）
  - `GET /knowledge-entries` 知识库文档选择器数据源
- [x] `PosterAutopilotService`（prd-api/src/PrdAgent.Infrastructure/Services/Poster/PosterAutopilotService.cs）
  - `LoadSourceAsync` 4 种数据源适配
  - `InvokeLlmAsync` 非流 + `StreamLlmChunksAsync` 流式
  - `ParseAccumulatedContent` + `ExtractClosedPagesSoFar` Markdown 分段增量解析
  - `BuildSystemPrompt` 请求 `# Title / > Sub / ## Page N · title · #color / body / [IMG] prompt` 格式
- [x] `PosterTemplateRegistry` 4 模板（release / hotfix / promo / sale，带色板 + imageStyleKeywords）
- [x] `AppCallerRegistry.ReportAgent.WeeklyPoster.Autopilot` / `.Image` 两常量已注册
- [x] 防同类注册遗漏单元测试 `AppCallerCodeRegistryGuardTests`（扫源码中字面量 vs registry）

**前端 — 已稳定的组件**

- [x] `components/weekly-poster/WeeklyPosterModal.tsx`：
  - `PosterCarousel({ poster, onDismiss, navigateOnCta })` 无状态组件 — **可以直接在设计器里复用做预览**
  - `WeeklyPosterModal()` 薄封装,主页弹窗自动拉取 + 弹出
- [x] `stores/weeklyPosterStore.ts`：sessionStorage 存 dismissed 海报 id
- [x] `services/real/weeklyPoster.ts`：所有 REST + SSE 调用（已加 `secondaryImageUrl` 类型）
- [x] `lib/posterTemplates.ts`：4 模板种子 + 4 种数据源元数据 + 3 种展示形态
- [x] `AssetsManagePage.tsx` 新增「海报设计」tab（`activeTab === 'poster'` → `<PosterDesignSection />`）— **就是这个 tab 打开时应该进入设计器，不再跳转到单独路由**
- [x] 登录主页 `AgentLauncherPage.tsx` 挂载 `<WeeklyPosterModal />`,已发布海报自动弹

**前端 — 需要重构的**

- ⚠️ `pages/weekly-poster/WeeklyPosterWizardPage.tsx`：目前是「一键生成 + 网格结果卡片」,要改成左中右 3 栏设计器布局
- ⚠️ `pages/weekly-poster/WeeklyPosterEditorPage.tsx`：手动编辑器（老的，支持多页 CRUD + 单页生图）— 接下来的设计器是它的升级版，可以参考里面的 `PageEditor` 做图文编辑的 pattern

### ❌ 未完成（下一个 Agent 的任务）

1. **重构 WeeklyPosterWizardPage 为 3 栏设计器** — 最大块
2. **上传图片功能** — FileReader + paste 事件
3. **自动保存** — 编辑时 debounce 1s PATCH
4. **「新建海报」modal** — 把旧向导 UI 压缩成一个 modal
5. **路由调整** — `AssetsManagePage` 的「海报设计」tab 是否直接 inline 渲染设计器（推荐）还是跳 `/weekly-poster`

---

## 三、推荐实现路径

### Phase A — 新设计器页（估 1 天）

**文件**：新建 `pages/weekly-poster/PosterDesignerPage.tsx`（不要改老 Wizard，保留作为回退路径）

**骨架**：

```tsx
// 布局
<div className="h-full flex">
  <aside className="w-[260px] border-r">  {/* 左栏 */}
    <button onClick={openCreateModal}>新建海报</button>
    <section>
      <h3>我的海报</h3>
      {posters.map(p => <PosterListItem active={p.id===currentId} ... />)}
    </section>
  </aside>

  <main className="flex-1 flex flex-col">  {/* 右栏(中+顶) */}
    {/* 顶栏 */}
    <header className="h-12 border-b flex items-center justify-between px-4">
      <PageTabs pages={poster.pages} current={pageOrder} onPick={setPageOrder} />
      <div>
        <button onClick={openPreview}>预览</button>
        <button onClick={openPublishSettings}>发布设置</button>
        <button onClick={publish}>发布到主页</button>
      </div>
    </header>

    {/* 详情编辑(按参考图 2 左图右文) */}
    <div className="flex-1 grid grid-cols-[40%_60%] gap-4 p-6 overflow-auto">
      <div className="space-y-3">  {/* 左列:图片区 */}
        <ImageSlot
          url={currentPage.imageUrl}
          onAIGenerate={() => generatePageImage(posterId, order)}
          onUpload={(file) => handleUpload(file, 'primary')}
          onPastePrompt={...}
          accent={currentPage.accentColor}
        />
        <ImageSlot
          url={currentPage.secondaryImageUrl}
          label="副图(可选)"
          onUpload={(file) => handleUpload(file, 'secondary')}
        />
      </div>
      <div className="space-y-3">  {/* 右列:文案区 */}
        <input value={currentPage.title} onChange={...} placeholder="页面标题" />
        <div className="grid grid-cols-2 gap-2 h-[calc(100%-100px)]">
          <textarea value={currentPage.body} onChange={...} />  {/* 左编辑 */}
          <MarkdownContent content={currentPage.body} />         {/* 右预览 */}
        </div>
        <input type="color" value={currentPage.accentColor} onChange={...} />
      </div>
    </div>
  </main>
</div>
```

### Phase B — 上传图片

```tsx
const handleUpload = async (file: File, slot: 'primary' | 'secondary') => {
  if (file.size > 2 * 1024 * 1024) {
    toast.error('图片不能大于 2MB(base64 编码会膨胀到 MongoDB 文档,先压一压)');
    return;
  }
  const dataUri = await fileToDataUri(file);  // FileReader
  updatePage(order, {
    [slot === 'primary' ? 'imageUrl' : 'secondaryImageUrl']: dataUri,
  });
};

// 监听剪贴板
useEffect(() => {
  const onPaste = (e: ClipboardEvent) => {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) void handleUpload(file, 'primary');
      }
    }
  };
  window.addEventListener('paste', onPaste);
  return () => window.removeEventListener('paste', onPaste);
}, [order]);
```

**⚠️ 注意**：base64 data URI 存在 Mongo 里会膨胀数据库，2MB 图上限是软限制。下阶段应改成：上传到 `/api/visual-agent/upload-artifact` 拿回 URL（查 `UploadArtifactController` 现有接口或新增 `POST /api/weekly-posters/:id/pages/:order/image`），MVP 先用 base64 够用。

### Phase C — 自动保存

```tsx
const debouncedSave = useDebouncedCallback(
  async (posterDraft: WeeklyPoster) => {
    const res = await updateWeeklyPoster(posterDraft.id, {
      title: posterDraft.title,
      subtitle: posterDraft.subtitle,
      pages: posterDraft.pages,
      ctaText: posterDraft.ctaText,
      ctaUrl: posterDraft.ctaUrl,
    });
    if (res.success) setSaved(true);
  },
  1000,
);

// 每次编辑 → setPoster(draft) → useEffect(watching poster) → debouncedSave(poster)
```

顶栏显示保存状态：`● 已保存 15 秒前` / `正在保存…` / `⚠ 保存失败，重试`。

### Phase D — 新建 modal

```tsx
function CreatePosterModal({ open, onClose, onCreated }) {
  // 复用现有模板/数据源 UI(lib/posterTemplates.ts 的 POSTER_TEMPLATES_SEED, SOURCE_TYPES)
  // 点「生成」 → sse.start({ body: { templateKey, sourceType, freeformContent, sourceRef } })
  // onDone: 新 posterId → onCreated(posterId) → 父组件 setCurrentId(newId)
  // 期间显示 TypingPanel 流式原文(复用现有)
}
```

**推荐**：新建 modal 的 SSE 处理直接从现有 `WeeklyPosterWizardPage.tsx` 里拷过来（SSE hook 配置 + page handler + done handler）,逻辑完全一样,只是容器从整页换成 modal。

### Phase E — 路由调整

推荐：`AssetsManagePage` 的 `<PosterDesignSection />` tab 内容**直接渲染** `<PosterDesignerPage />`（不跳路由）。老的 `/weekly-poster` 和 `/weekly-poster/advanced` 保留做深链入口（URL 带 `?id=xxx` 仍有效）。

---

## 四、关键数据契约

**前端关心的类型**（`services/real/weeklyPoster.ts`）：

```ts
interface WeeklyPosterPage {
  order: number;
  title: string;
  body: string;
  imagePrompt: string;
  imageUrl?: string | null;
  secondaryImageUrl?: string | null;  // 已在后端落地,前端拉出来就能用
  accentColor?: string | null;
}
```

**已提供的 API 调用**：

```ts
listWeeklyPosters({ status?, page?, pageSize? })
getWeeklyPoster(id)
createWeeklyPoster(input)
updateWeeklyPoster(id, input)  // ← 自动保存调这个
deleteWeeklyPoster(id)
publishWeeklyPoster(id)
unpublishWeeklyPoster(id)
listWeeklyPosterTemplates()
autopilotWeeklyPoster(input)               // 非流(可不用)
generateWeeklyPosterPageImage(posterId, order, overridePrompt?)
listWeeklyPosterKnowledgeEntries(keyword?, limit?)
```

SSE 流式没有封装 helper（直接用 `useSseStream` hook 订阅 `/api/weekly-posters/autopilot/stream`）。

---

## 五、陷阱 & 坑

1. **React key 用 `p.order`** — 必须加 fallback `${p.order ?? idx-${i}}`,否则某些中间态 undefined 会警告
2. **poster.pages 访问加 `?? []`** — SSE 期间 poster 可能是 stub 缺 pages
3. **服务器权威** — 页面挂载时优先看 URL `?id=`,其次 sessionStorage `weekly-poster-wizard-draft-id`,调 `getWeeklyPoster(id)` 重建状态
4. **useSseStream POST 体** — `start({ body: {...} })` 会自动 JSON.stringify,不要手工 stringify
5. **图片 base64 上限** — MongoDB doc 16MB,5 页 × 2MB base64 ≈ 13MB,容易爆,要么压缩要么上传到 attachments
6. **AppCallerCode** — `report-agent.weekly-poster.autopilot::chat` 和 `...image::generation` 已注册；新增 LLM 调用记得去 `AppCallerRegistry.cs` 加 `[AppCallerMetadata]` 常量
7. **前端模态框 3 硬约束**（规则 `.claude/rules/frontend-modal.md`）：新建 modal 必须 createPortal + inline style 高度 + `min-h-0` flex 滚动
8. **MarkdownContent 组件** — `components/ui/MarkdownContent.tsx`,预览 body 直接用,支持 GFM 表格 + 代码块
9. **CDS 部署** — push 后 GitHub webhook 自动触发部署,几分钟后预览域名 `https://claude-weekly-updates-carousel-xxj7r.miduo.org` 就位。**规则 `cds-first-verification.md`**:后端 `.cs` 改动必须通过 CDS 容器日志确认编译 + 容器 running 后才能声称完成
10. **本地 tsc/lint** — `cd prd-admin && pnpm tsc --noEmit && pnpm lint`。前者必过零错误,后者本次改动文件零新增告警

---

## 六、验收清单

下一个 Agent 做完后应该满足：

- [ ] 进入「我的资源 → 海报设计」tab 直接看到设计器（不跳页）
- [ ] 左栏列出所有我的海报，点任一切到那张海报
- [ ] 点「新建海报」弹 modal，选模板+数据源，点「生成」→ 看到打字机流式 + 卡片逐张冒出 → done 后 modal 关闭 + 自动跳到该新海报
- [ ] 右栏图片区可以：A) 点「AI 生成」重生图；B) 点「上传」选本地图；C) 直接 Ctrl+V 粘贴截图
- [ ] 右栏文案区左编辑右 markdown 实时预览
- [ ] 任何字段修改 1 秒后自动保存（顶栏状态指示），**刷新页面内容不丢**
- [ ] 顶栏「预览」弹出轮播（复用 `<PosterCarousel />`）
- [ ] 顶栏「发布到主页」→ 状态变已发布 → 登录用户下次访问主页看到弹窗
- [ ] 本地 `pnpm tsc --noEmit` 零错误，`pnpm lint` 本次文件零新增告警
- [ ] CDS api 容器 running，`/api/v1/auth/login` 返回 400/401（不是 500）
- [ ] 交付消息含【位置】+【路径】两行（规则 `navigation-registry.md`）

---

## 七、涉及的文件清单

**可直接编辑**：

```
prd-admin/src/pages/weekly-poster/PosterDesignerPage.tsx   ← 新建(主工作量)
prd-admin/src/pages/AssetsManagePage.tsx                    ← 让 PosterDesignSection 直接 inline 渲染设计器
changelogs/2026-04-21_weekly-poster.md                      ← 追加本波改动
```

**可参考不一定改**：

```
prd-admin/src/pages/weekly-poster/WeeklyPosterWizardPage.tsx  ← 老向导,拆其中 SSE 处理逻辑复用
prd-admin/src/pages/weekly-poster/WeeklyPosterEditorPage.tsx  ← 老编辑器,PageEditor 组件的图文编辑 pattern
prd-admin/src/components/weekly-poster/WeeklyPosterModal.tsx  ← PosterCarousel 预览复用
prd-admin/src/lib/posterTemplates.ts                          ← 模板/数据源/形态元数据
prd-admin/src/services/real/weeklyPoster.ts                   ← 所有 API 已就绪
prd-admin/src/lib/useSseStream.ts                             ← SSE hook
prd-admin/src/components/ui/MarkdownContent.tsx               ← markdown 渲染器
```

**后端完全不用动**（除非加专用上传图片 endpoint 替代 base64）：

```
prd-api/src/PrdAgent.Core/Models/WeeklyPosterAnnouncement.cs       ← 已含 SecondaryImageUrl
prd-api/src/PrdAgent.Api/Controllers/Api/WeeklyPosterController.cs ← 全部端点就绪
prd-api/src/PrdAgent.Infrastructure/Services/Poster/PosterAutopilotService.cs ← 流式 + 解析就绪
```

---

## 八、最近的 commit 历史（branch `claude/weekly-updates-carousel-XXJ7r`）

```
c0ab8fe refactor(poster): 服务器权威化 + 从智能体搬到「资源管理 → 海报设计」
b0d380d refactor(poster): LLM 输出改 Markdown 分段 + 修 runtime error + body 真 markdown 预览
1456985 feat(poster): LLM 真·流式 — 打字机面板替代静态「正在写文案」
70fff2d feat(poster): 5 项人工验收反馈整顿 — 去「周报」绑定 / SSE 流式 / 多数据源 / 预览 fix / 返回按钮
a89e85c fix(weekly-poster): AppCallerCode 补注册 + 向导页换皮到液态玻璃
5616982 fix(weekly-poster): AppCallerMetadata 修 ModelTypes.Generation → ImageGen
2fcaaa1 feat(weekly-poster): AI 周报海报工坊向导 — 选三下一键生成
5ca7927 feat(weekly-poster): 海报编辑器「生成图片」按钮改为真点击即生成
f5b3865 feat(weekly-poster): 新增登录后主页周报海报轮播弹窗
```

下一个 Agent 请基于 `c0ab8fe` 往后做，分支名保持 `claude/weekly-updates-carousel-XXJ7r`。
