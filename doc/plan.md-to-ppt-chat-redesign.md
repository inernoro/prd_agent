# MD 转网页 PPT → 对话式 artifact 工作台 · 改造计划

> 交接给执行智能体的任务书。目标：把现有「上传/知识库 → 一次性生成」的表单式 PPT 工具，
> 改造成 2026 主流的「**对话 + 实时预览（artifact）**」范式（对标 Gamma 3.0 Agent /
> Beautiful.ai Context-Aware）。原则：**先能跑，再打磨**；分期落地，不要一次性堆崩。

---

## 1. 为什么改（范式判断，已调研）

现状是「左侧表单（粘贴/上传 + 风格/页数/引擎）→ 点生成 → 右侧出图」。这套已过时。

2026 主流（调研结论）：
- **Gamma 3.0 + Gamma Agent**：输入 → 生成 → **对话式精修**（自然语言改全局/单页，AI 改完预览可接受/撤销），内容是可拖拽卡片。
- **Beautiful.ai Context-Aware**：**大纲先行**——先出低保真纯文本大纲让用户审 narrative、加减页，确认后才出精美页。
- **通用最佳实践**：用对话做规划/大纲（LLM 擅长）+ 专门设计步骤出图（LLM 直接写单页内容平庸）——两段式。
- **Tome 演示产品已关停** → 纯一次性生成不够，要可控 + 可迭代。

三条核心：**①对话驱动迭代 ②大纲先行可审可改 ③聊天在左 / PPT artifact 实时预览在右**。
用户截图里的 "+"（展开附件 / 连接器）就是这套交互的输入入口（万物互联）。

---

## 2. 目标 UX（改造后）

```
┌──────────────────────────┬───────────────────────────────┐
│  对话线程（左）            │  PPT artifact 实时预览（右）    │
│  ───────────────          │  ───────────────────────       │
│  用户：把这篇做成 PPT       │  [reveal.js iframe 预览]        │
│   （附件/知识库引用）       │   ◀ 上一页  下一页 ▶  1/8       │
│  AI：建议大纲 8 页：        │                                 │
│     1. 封面 …              │  （生成中显示进度；生成后实时    │
│     2. 现状 …  [确认/改]    │    渲染，可翻页）                │
│  用户：第3页改两栏 / 换商务蓝 │                                 │
│  AI：已更新 →             │  （右侧预览跟着变）              │
│  ┌──────────────────────┐  │                                 │
│  │ [+] 输入框…    [发送]  │  │  顶部：风格/引擎设置(收起)      │
│  └──────────────────────┘  │  发布为网页 / 下载              │
│  + 菜单：添加文件/图片、     │                                 │
│         引用知识库、连接器   │                                 │
└──────────────────────────┴───────────────────────────────┘
```

流程：① 用户输入需求（可带附件/KB）→ ② AI **先回大纲**（N 页 + 每页标题）让用户确认/加减页 →
③ 确认后出图，右侧 artifact 预览 → ④ 用户继续对话精修（"第3页改两栏""整体换商务蓝""加一页讲 ROI"）→
AI patch，右侧实时更新。引擎（MAP/CDS Agent）+ 风格模板收进设置弹层，不挤占对话。

---

## 3. 已经做好的（不要重做，直接复用）

当前分支 `claude/cds-agent-integration-x6rCK` 已落地，改造时**复用**别推翻：

| 能力 | 位置 | 说明 |
|---|---|---|
| 双引擎生成 SSE | `prd-api .../MdToPptController.cs` `Convert`/`Patch` | engine=map(ILlmGateway)/agent(CDS sidecar)，已修 524/流式/出图质量 |
| **多风格设计系统** | 同上 `BuildPptSystemPrompt(theme)` + `ThemeTokens` | 5 套配色 token，新 UI 的"风格"沿用 theme 值 |
| **局部修改（patch）** | 同上 `Patch` 端点 + `streamMdToPptPatch` | 对话式精修直接复用：把自然语言指令喂给 patch |
| **落库可重连** | `MdToPptRun` 模型 + `GET runs/{id}` + `GET runs` | 已有运行记录；改造后对话/版本可挂在 run 上 |
| 预览渲染 + 翻页 | `prd-admin .../MdToPptAgentPage.tsx` iframe + `deckNav` | iframe 沙箱/nav-guard/InjectDeckCssFix 都已踩平，**照搬这套渲染** |
| 发布为网页 | `Publish` 端点 + `publishMdToPpt` | 出图后一键托管 |
| 服务端兜底 | `StripCodeFences`(去 emoji) + `InjectDeckCssFix`(orb 绝对定位) | 任何新出图路径都要过这两步，否则会复现整页空白/emoji |

**已知坑（务必遵守，否则复现历史 bug）**：
- 预览 iframe 必须 `sandbox="allow-scripts allow-same-origin"` + `withNavGuard()` 注入（去 same-origin 会让 reveal 渲染空白；不加 nav-guard 会递归显示整个应用）。
- 标题/正文一律实色 `var(--ink)`，**禁止** `color:transparent + background-clip:text`（嵌入式渲染会整页消失）。
- 生成 HTML 落库走 server-authority：用 `CancellationToken.None`，客户端断开不取消（见 `RunMapStreamAsync` 的 `clientGone` 模式）。

---

## 4. 分期任务

### Phase 1（先做，能跑就行）：聊天 + artifact 骨架 + 大纲先行 + 附件/KB

**后端**
1. 新增 `POST /api/md-to-ppt/outline`（SSE 或一次性 JSON）：输入 content/附件文本/KB 引用 → LLM 产**大纲**（JSON：`[{title, bullets[]}]` + 建议页数）。复用 `ILlmGateway`，AppCallerCode 走 `AppCallerRegistry`（新增一条 `md-to-ppt.outline::chat`，按 `app-caller-registry.md` 规则注册，别裸字符串）。
2. 复用现有 `Convert`：把"确认后的大纲"作为 content 传入出图（可在 prompt 里带上大纲结构）。
3. 会话落库：扩展 `MdToPptRun`（或新 `MdToPptConversation` 集合）存 messages（user/assistant、附件引用、产出的 runId/html 版本），供刷新重连 + 历史。参考现有 Run/Worker + `MdToPptRun` 写法（**先读一个现有 Model 再写**，见规则 #7）。

**前端**（`prd-admin/src/pages/md-to-ppt-agent/`）
1. 页面重构为**左聊天 + 右 artifact** 双栏（沿用 `full-height-layout.md`：根 `h-full min-h-0 flex`）。
2. 聊天线程组件：渲染 user/assistant 气泡；assistant 的"大纲"消息带【确认生成】【加一页】【减一页】【改页数】交互。
3. 输入框 + **"+" 菜单**：先接两个最实用入口——**添加文件/图片**（复用现有 attachment 上传，FormData 直传，见规则 #7 "FormData 不能走 apiRequest"）+ **引用知识库**（复用 document-store：`GET /api/document-store/stores` 选库选文 → 取 content 进上下文）。
4. 右侧 artifact：**照搬现有** iframe 渲染（`withNavGuard` + sandbox + 翻页按钮 + 落库重连）。
5. 流式可视化遵守 `CLAUDE.md §6`：大纲/出图过程要有进度，不空白等待。
6. 旧表单可作为"高级/经典模式"入口保留（可选），或直接替换。

**Phase 1 验收（能跑标准）**：
- 在对话框输入"把这段内容做成 PPT"（带一个附件或 KB 引用）→ 出大纲 → 确认 → 右侧出真 reveal 网页 PPT，可翻页。
- 刷新页面对话 + 结果还在（复用落库重连）。
- 用真实知识库文章走通一遍（用 `.claude/skills/create-visual-test-to-kb/scripts/harness.mjs` 走真人路径取证）。

### Phase 2：对话式多轮精修（自然语言 patch）

1. assistant 出图后，用户自然语言指令（"第3页改两栏对比""整体换商务蓝""封面副标题改成X""加一页讲 ROI"）→ 后端把指令 + 当前 HTML 喂给 `Patch` 端点 → 出新版本，右侧预览实时更新。
2. 版本管理：每次 patch 存一个版本（挂在 conversation/run 上），支持撤销/对比（参考 Gamma 的"接受/撤销"）。
3. 把现有"局部修改"面板下线，统一收进对话。

### Phase 3：更多连接器 + 卡片化

1. "+" 接更多连接器（GitHub/Figma/Drive 等，按用户截图那套；优先复用平台已有连接器基础设施，没有的明确标注"需借用"，见 `no-rootless-tree.md`）。
2. 卡片化编辑（可选，重）：把 reveal 单页抽象成可拖拽/增删的卡片。

---

## 5. 技术约束 / 质量门

- **遵守 CLAUDE.md 全部强制规则**：禁 emoji（含代码字面量）；LLM 调用走 `ILlmGateway` + `LlmRequestContext.BeginScope`（规则见 `llm-gateway.md`）；AppCallerCode 注册（`app-caller-registry.md`）；server-authority（`CancellationToken.None`）；前端无业务状态 SSOT；模态/全高布局规则。
- **改完先视觉验收再说"好了"**（血泪教训）：用 `.claude/skills/create-visual-test-to-kb` 的真人路径取证（`harness.mjs` / `example-driver.mjs`），本地 inline reveal 渲染核对自己写临时脚本即可，别再往技能 scripts 目录里堆一次性 driver。
- 后端无本地 dotnet → 走预览部署编译验证（`cds-first-verification.md`）。前端 `pnpm tsc --noEmit` + `pnpm lint` 零新增告警。
- 任何新出图 HTML 必须过 `StripCodeFences`(去 emoji) + `InjectDeckCssFix`(orb 修复)。

## 6. 关键文件清单

- 前端页面：`prd-admin/src/pages/md-to-ppt-agent/MdToPptAgentPage.tsx`
- 前端服务：`prd-admin/src/services/real/mdToPptService.ts`
- 后端控制器：`prd-api/src/PrdAgent.Api/Controllers/Api/MdToPptController.cs`
- 后端模型：`prd-api/src/PrdAgent.Core/Models/MdToPptRun.cs`（+ 可能新增 Conversation）
- 集合注册：`prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs`
- 附件 / 知识库 / 连接器复用：grep `document-store`、`attachment`、现有 "+" 菜单组件
- 验收脚手架：`.claude/skills/create-visual-test-to-kb/scripts/`（harness / example-driver / verify-open / archive_report）

## 7. 一句话给执行者

把这页从「表单一次性生成」改成「**对话→大纲确认→artifact 实时预览→对话精修**」，"+"接附件和知识库。
Phase 1 先能跑通（出大纲 → 确认 → 出图 → 翻页 → 刷新不丢），用真实 KB 文章视觉验收过关再交付。
复用清单（第 3 节）里的东西别重造，已知坑（沙箱/实色标题/落库）别再踩。
