# 每日小贴士功能 — 剩余工作交接文档 · 计划

> **文档版本**：v1.0
> **创建日期**：2026-04-21
> **作者**：前一位 AI Agent(Claude Opus 4.7)交接
> **分支**：`claude/add-daily-tips-feature-dLBUr`
> **预览**：`https://claude-add-daily-tips-feature-dLBUr.miduo.org`(push 后 CDS 自动就位)
> **状态**:🟡 前期改动已提交(2 commits),3 个 issue 中 2 个部分完成,1 个未开工;**Issue 3 方案需用户二次确认**

---

## 一、管理摘要(30 秒版)

用户对刚上线的「每日小贴士」提了 3 条改进。其中 **Issue 1 已做了 50%(首页 Quick Links 左对齐已完成,但小贴士后台的 PushDialog 宽度 + 列表页面的左右留白还没改)**,**Issue 2 已完成(三桶分类 + 全局智能体改名)**,**Issue 3 完全未改 —— 因为方案存在两种解读,我拿不准用户想要哪种,必须由下一位 Agent 和用户确认后再动手**。

Issue 3 的歧义点:用户原话是"除了跳转,一点作用都没有"。可以解读为:
- **轻量版(A+C)**:跳转后出现脉冲光晕就算解决 —— 补 4 个 `data-tour-id` 锚点 + 4 条 seed tip 的 targetSelector,约 2 小时;
- **重量版(A+C+D)**:跳转后**真正帮用户做点事** —— 自动滚动到目标、展开面板、预填示例、点击 CTA、多步 Tour。需要扩展数据模型,约 1-2 天。

前一位 Agent 倾向用户想要**重量版**,但没有证据,请下一位 Agent 与用户确认。

---

## 二、用户原始需求(重述 + 我的理解)

下面把用户的 3 条原话逐条列出来,每条都标明**我如何解读**和**哪里可能偏**,请新 Agent 带着警惕读。

### Issue 1 — 布局偏窄 / 居中留白

**用户原话**:

> 建议再拉宽一些,目前左右两边很空旷(或者直接居左排列)

**我的解读**:用户嫌宽屏下内容挤在中央,两侧黑/留白。**范围覆盖**以下 3 处:

1. ✅ 首页 Quick Links 四卡(海鲜市场/智识殿堂/作品广场/更新中心)—— **已修**(commit `281b00f`)
   - 路径:`prd-admin/src/pages/AgentLauncherPage.tsx:882-895`
   - 做法:去掉 `mx-auto` / `maxWidth: 1440` / `justifyContent: center` / `minmax(220px, 320px)`
   - 改为:`grid` + `repeat(auto-fit, minmax(260px, 1fr))`(与下方 AGENTS 分组一致)
2. ⚠️ **小贴士后台 PushDialog 弹窗**(推送给用户的弹窗)—— **未改**
   - 路径:`prd-admin/src/pages/settings/DailyTipsEditor.tsx:604`
   - 当前:`width: 'min(640px, 100%)'` + `height: 'min(640px, 100%)'`
   - 建议:宽度 `min(860px, 100%)` 或 `min(960px, 100%)`,左右两栏(左挑用户 + 右显示投递列表)
3. ⚠️ **小贴士后台列表页**(/settings?tab=daily-tips)—— **未改**
   - 路径:`prd-admin/src/pages/settings/DailyTipsEditor.tsx:162`
   - 当前根容器:`<div className="h-full min-h-0 flex flex-col gap-4 overflow-y-auto">` 已撑宽,但其 **父容器** `SettingsPage.tsx:303` 的 `<div className="flex-1 min-h-0">` 也无 max-width ——
   - 经实测父级链路已全宽,如果用户仍觉得"左右空旷",根因可能是**卡片内部 `maxWidth` 或 padding 太保守**,下一位 Agent 要先打开页面**截图对照**再动手,不要盲目拉宽。

**可能偏的地方**:Issue 1 看似简单,但"哪里空旷"这件事前一位 Agent 已经误判过一次(原以为只有 PushDialog/列表,实际还包括首页 Quick Links)。新 Agent 务必**逐个页面截图给用户确认覆盖范围**。

---

### Issue 2 — 智能体 / 工具 / 基础设施 三桶分类 + 统一命名

**用户原话(精简)**:

> 智能体 = AI + 完备生命周期 + 有存储;缺一即降级为"工具"。请全局把"智能助手"改为"智能体",各 Agent 短名也要有"智能体"后缀。

**状态**:✅ **已完成**(commit `5921143`)。详见 `changelogs/2026-04-21_agent-taxonomy-rename.md`。

变更摘要(7 条):

- `ToolboxItem.kind?: 'agent' | 'tool' | 'infra'`,`BUILTIN_TOOLS` 9 项标 `kind: 'agent'`、6 项标 `kind: 'tool'`
- `AgentLauncherPage` 首页新增「基础设施」分组(知识库/我的资源/海鲜市场/模型中心/团队协作/工作流引擎/网页托管/更新中心)
- `launcherCatalog.ts` 新增 `buildInfraItems()`,`LauncherGroup` 扩 `'infra'`
- `AgentSwitcher` 浮层同步增「基础设施」分区
- 12 个 Agent 全部改名 + 页面标题 + landing mocks + homepageAssetSlots 全同步
- 后端 `AdminPermissionCatalog` 权限标签统一加「智能体」后缀(12 条)
- `AiToolboxController` 兜底 systemPrompt「智能助手」→「智能体」

**可能偏的地方**:前一位 Agent 自测仅 `pnpm tsc --noEmit` + `pnpm lint` 通过,**本地无 dotnet SDK,C# 没跑 build**。下一位 Agent 接手时务必走 CDS 部署验证后端改动(规则 `.claude/rules/cds-first-verification.md`)。

---

### Issue 3 — 小贴士点击后"除了跳转一点作用都没有" ⚠️ **方案歧义,待确认**

**用户原话**:

> 小贴士,我点击之后虽然可以跳转,但是没用啊,除了跳转,一点作用都没有

**当前行为**(代码已验证):

1. `TipsRotator.tsx:58-68` / `TipsDrawer.tsx:73-82`:点击 tip 时,若 `targetSelector` 非空,写入 `sessionStorage[SPOTLIGHT_TARGET_KEY]`,然后 `navigate(actionUrl)`
2. `SpotlightOverlay.tsx`:挂载时读 session key,`document.querySelector` 找元素 → 滚动到中心 → 画脉冲光圈 → 5 秒淡出
3. `AppShell.tsx:1321`:`<SpotlightOverlay key={location.pathname} />` 按路径重挂载

**8 条 seed tips 现状**(代码见 `prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs:222-280`):

| seed id | 目的页 | targetSelector | 目的页有无 data-tour-id 锚点 |
|---|---|---|---|
| search-agent | `/` | `[data-tour-id=home-search]` | ✅ `AgentLauncherPage.tsx:854` |
| marketplace | `/marketplace` | `[data-tour-id=quicklink-marketplace]` | ⚠️ **该锚点只在首页 `AgentLauncherPage.tsx:907` 存在,marketplace 自己的页面内没有** |
| library | `/library` | `[data-tour-id=quicklink-library]` | ⚠️ 同上,只在首页存在 |
| updates | `/changelog` | `[data-tour-id=quicklink-updates]` | ⚠️ 同上,只在首页存在 |
| toolbox | `/ai-toolbox` | **null** | ❌ 无 selector,无锚点 |
| defect-feedback | `/defect-agent` | **null** | ❌ 无 selector,无锚点 |
| report-agent | `/report-agent` | **null** | ❌ 无 selector,无锚点 |
| emergence | `/emergence` | **null** | ❌ 无 selector,无锚点 |

**根因分析**:

- 8 条 tips 里有 **4 条没有 targetSelector**,点击后纯跳转、零反馈 —— 这是"一点作用都没有"的直接诱因
- 另 3 条(marketplace/library/updates)的 selector 指向**首页的 Quick Links 卡片**而非目的页内元素,**跳转到目的页后 querySelector 找不到** —— 也是"一点作用都没有"的诱因(SpotlightOverlay 轮询 3 秒超时静默退出)
- 只有 1 条(search-agent)完全正常(目的页 = 首页,selector 匹配)

**方案选项**(请与用户确认):

#### 方案 A+C(轻量,~2h):**补锚点 + 修 selector**

- 在 4 个目的页内挑合适的元素,补 `data-tour-id`:
  - `/marketplace` 首屏第一个分类 tab → `data-tour-id="marketplace-category-tabs"`
  - `/library` 创建/上传按钮 → `data-tour-id="library-create"`
  - `/changelog` 最新版本卡 → `data-tour-id="changelog-latest"`
  - `/ai-toolbox` 搜索框或第一个工具卡 → `data-tour-id="toolbox-search"`
  - `/defect-agent` 新建缺陷按钮 → `data-tour-id="defect-create"`
  - `/report-agent` 首屏模板选择 → `data-tour-id="report-template-picker"`
  - `/emergence` 种子输入区 → `data-tour-id="emergence-seed-input"`
- 把 4 条 null selector 的 seed tips 填上对应新锚点
- 把 3 条跨页 selector 指向各自目的页内的新锚点
- **效果**:跳转后 100% 出现脉冲光晕,用户"感知到 tip 确实教他了点什么"

#### 方案 A+C+D(重量,~1-2d):**真的替用户做点事**

在方案 A+C 之上,扩展 tip 数据模型:

```typescript
interface DailyTip {
  // ...已有字段
  autoAction?: {
    scroll?: 'center' | 'top';       // 滚动位置
    expand?: string;                  // 展开某个 CSS 选择器对应的折叠面板
    prefill?: { selector: string; value: string }; // 自动填充示例
    autoClick?: string;               // 自动点击某个 selector(如 CTA 按钮)
    steps?: Array<{ selector: string; text: string; }>; // 多步 Tour
  };
}
```

`SpotlightOverlay` 读到 `autoAction` 时执行对应动作,然后再画脉冲光晕。后端 `DailyTipsController` 的 DTO / seed tips 都要同步扩展。

**这是我倾向的解读 —— 但证据薄弱**。用户原话"除了跳转一点作用都没有"既可以指"没有视觉反馈",也可以指"没有实质动作"。**下一位 Agent 必须先问用户**。

---

## 三、当前提交状态(Git 已落地)

| Commit | 范围 | 状态 |
|---|---|---|
| `5921143` | Issue 2 — 三桶分类 + 统一智能体命名(前后端)| ✅ 已 push |
| `281b00f` | Issue 1 部分 — 首页 Quick Links 左对齐铺满 | ✅ 已 push |

**未提交的改动**:无(工作区干净)。

**可验证状态**:

- `pnpm tsc --noEmit`:通过(前一位 Agent 本地验证)
- `pnpm lint`:前一位 Agent 未引入新告警(既有 19 条历史告警与本次改动无关)
- `dotnet build`:**未本地验证**(沙箱无 SDK),依赖 CDS 编译
- CDS 自动部署:push 后 webhook 触发,预览域名 2-5 分钟就位(详见 `.claude/rules/cds-auto-deploy.md`)

---

## 四、剩余工作清单(按优先级)

### P0 — 阻塞用户体验,必须做

| # | 未完成项 | 现状 | 差什么 | 影响 |
|---|---|---|---|---|
| 1 | **Issue 3:小贴士点击无实质作用** | 4 条 seed tips 无 selector + 3 条 selector 只在首页可匹配 | 需要用户确认方案 A+C 还是 A+C+D,然后补锚点 + 修 selector(+/- 扩数据模型)| 影响所有首次上线用户对"每日小贴士"这个功能的第一印象 |
| 2 | **Issue 1 剩余:PushDialog 宽度** | `DailyTipsEditor.tsx:604` 宽度 640px,弹窗偏挤 | 改为 `min(860px, 100%)` 或 `min(960px, 100%)`,左右两栏布局(左用户选择、右投递列表)| 影响后台运营人员的推送操作体验 |
| 3 | **Issue 1 剩余:列表页左右留白**(**待确认**)| 父容器已全宽,若仍空旷则需检查卡片 padding/maxWidth | 先截图确认,再动手 | 影响后台运营人员的日常编辑体验 |

### P1 — 建议做,但非紧急

| # | 未完成项 | 差什么 |
|---|---|---|
| 4 | 补单元测试覆盖 `SpotlightOverlay` 和 `DailyTipsController.Track` 的 seed-* 兜底 | 当前只有手工验收 |
| 5 | `DailyTip.Deliveries` 定向推送功能虽已实现后端 + 前端,但**缺真人走通**的端到端验收记录 | 按 `/uat` 流程生成验收清单,真人打勾 |

---

## 五、Issue 3 两种方案对比(必读)

### 方案 A+C:补锚点 + 修 selector(轻量)

**改动范围**:
- 前端:7 个页面各加 1-2 个 `data-tour-id` 锚点(代码增量 < 20 行)
- 后端:`DailyTipsController.cs:222-280` 把 4 条 null selector 填上、3 条跨页 selector 改成目的页内锚点
- 无数据模型变更

**交付物**:

```
用户点小贴士 → 跳转到目的页 → 3 秒内出现脉冲光圈指向关键元素 → 5 秒淡出
```

**优点**:改动小、风险低、2 小时能完成 + 验收。

**缺点**:如果用户期望的是"自动帮我做一步",这个方案不够 —— 用户看到脉冲可能还是会问"然后呢?"。

**适合的用户原话**:如果用户说"我想知道点击后**应该看什么地方**,光跳转过去我找不到",选这个。

### 方案 A+C+D:补锚点 + 修 selector + autoAction(重量)

**改动范围**:
- 前端:同上 + 扩展 `SpotlightOverlay`(~100 行)支持 scroll/expand/prefill/autoClick/多步 Tour
- 后端:`DailyTip` Model 加 `AutoAction` 字段;`DailyTipsController` DTO 同步;seed tips 填充
- 数据模型变更(需同步 admin 管理界面的表单)

**交付物**:

```
用户点"试试周报" → 跳到 /report-agent → 自动滚到模板选择区 → 
自动展开「技术周报」模板 → 在编辑区预填示例内容 → 脉冲光圈指向「开始生成」按钮 → 
(可选) 再次点击可继续走 Tour 下一步
```

**优点**:小贴士从"提示"升级为"引导",真正"替用户做一步",符合规则 `.claude/rules/guided-exploration.md` 的 L3/L4 引导层级。

**缺点**:工作量 1-2 天,需要给每条 tip 配具体 autoAction,运营成本上升。

**适合的用户原话**:如果用户说"点了不仅要给我指路,还要**真的动起来**",选这个。

---

## 六、必守约束(别踩坑)

新 Agent 接手前**必读**以下规则,否则会返工:

| 规则 | 为什么必读 |
|---|---|
| `.claude/rules/frontend-modal.md` | PushDialog 已用 inline style + createPortal + min-h-0,**继续保持三硬约束**,不要退回 Tailwind `h-[xxvh]` |
| `.claude/rules/cds-first-verification.md` | 本地无 dotnet SDK 时**不能以"环境缺"为由不验证**,必须走 `/cds-deploy` |
| `.claude/rules/cds-auto-deploy.md` | push 后 **CDS 自动建分支 + 构建 + 部署**,不要再手动跑 `/cds-deploy-pipeline` |
| `.claude/rules/frontend-architecture.md`(注册表模式)| 若扩展 autoAction,新类型要走 `*_REGISTRY` 映射,禁止组件里硬编码 switch |
| `.claude/rules/no-localstorage.md` | spotlight 复用 `sessionStorage`,**不要**改成 `localStorage` |
| `CLAUDE.md` 规则 #4 | 改完必须在 `changelogs/` 新增碎片文件(禁止直接改 `CHANGELOG.md`) |
| `CLAUDE.md` 规则 #5.2 | push 前必须跑 `pnpm tsc --noEmit` + `pnpm lint`,任意一项失败不得推送 |
| `CLAUDE.md` 规则 #5.3 | **禁止自动创建 PR**,除非用户明说要 PR |
| `CLAUDE.md` 规则 #8 | "完成"标准 = 预览域名可打开 + 核心流程端到端跑通,仅 CRUD 编译通过**不算完成** |
| `CLAUDE.md` 规则 #9 + `.claude/rules/navigation-registry.md` | 若新增锚点或工具,交付消息必须含【位置】+【路径】两行 |

---

## 七、验证路径(新 Agent 接手后的 checklist)

### 7.1 本地静态验证

```bash
# 前端类型 + lint
cd prd-admin
pnpm tsc --noEmit                                       # 必须 0 error
pnpm lint --max-warnings=0 2>&1 | grep -c "error"       # 本次改动相关文件必须 0

# 后端(有 dotnet 时)
cd ../prd-api
dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

### 7.2 CDS 远端验证

push 触发自动部署。预览域名(分支 `/` 替换为 `-`):

```
https://claude-add-daily-tips-feature-dLBUr.miduo.org
```

2-5 分钟后 Check 面板绿灯即可访问。

### 7.3 人工验收(UAT)

走以下 5 条核心路径:

- [ ] 登录后首页 → 点顶部轮播的 text tip(副标题位) → 跳转正确 + **出现脉冲光晕**
- [ ] 登录后首页 → 点右上角「小贴士」入口 → TipsDrawer 打开 → 点卡片 CTA → 跳转 + 脉冲
- [ ] 后台`/settings?tab=daily-tips` → 创建 tip → 推送给测试用户 → 该用户首页能看到置顶
- [ ] 后台推送弹窗(PushDialog) → 宽度观感良好 + 用户列表 + 投递记录同屏展示不拥挤
- [ ] seed-* tip 点击后不报 404(走 track 接口的 seed- 兜底分支)

### 7.4 若方案选 A+C+D,额外验收

- [ ] AutoAction 的 scroll / expand / prefill / autoClick 四类都各跑一个 tip
- [ ] 多步 Tour 走完后 sessionStorage 被清理(不留脏数据)
- [ ] 用户中途切走 → 不会卡在 Tour 中间步骤

---

## 八、附录:代码坐标速查

### 8.1 小贴士前端主要文件

```
prd-admin/src/
├── components/daily-tips/
│   ├── SpotlightOverlay.tsx     // 136 行, 跳转后的脉冲光圈
│   ├── TipsDrawer.tsx           // 328 行, 右侧抽屉(卡片列表 + 关闭)
│   └── TipsRotator.tsx          // 114 行, 首页副标题位文字轮播
├── stores/dailyTipsStore.ts     // zustand store, 加载 + 缓存 tip
├── services/real/dailyTips.ts   // API 客户端
├── pages/settings/DailyTipsEditor.tsx  // 后台管理(列表 + 编辑 + PushDialog)
└── layouts/AppShell.tsx:1321    // <SpotlightOverlay key={pathname} /> 挂载点
```

### 8.2 小贴士后端主要文件

```
prd-api/src/PrdAgent.Api/Controllers/Api/
├── DailyTipsController.cs       // 用户端(list / track)+ seed-* 兜底
└── AdminDailyTipsController.cs  // 管理端(CRUD / push / stats)
prd-api/src/PrdAgent.Core/Models/
└── DailyTip.cs                  // 含 Deliveries: List<DailyTipDelivery>
```

### 8.3 前一位 Agent 修改过的非小贴士文件(用于 git log 排查)

详见 `changelogs/2026-04-21_agent-taxonomy-rename.md`(7 条)和 `changelogs/2026-04-21_quicklinks-left-align.md`(1 条)。

### 8.4 data-tour-id 锚点现状(Issue 3 实施基线)

当前仅 3 处(全在 `AgentLauncherPage.tsx`):

| 锚点 | 位置 | 命中哪条 seed tip |
|---|---|---|
| `home-subtitle` | 首页副标题容器 | (暂未被使用)|
| `home-search` | 首页搜索框 | `seed-search-agent` ✅ |
| `quicklink-${link.id}` | 首页 Quick Links 四卡(marketplace/library/showcase/updates)| `seed-marketplace` / `seed-library` / `seed-updates` ⚠️(只在首页匹配,跨页跳转后失效)|

**注意**:方案 A+C 需要新增的 7 个锚点**都在目的页内**,不在首页,否则跳转后 querySelector 仍然找不到。

---

## 九、交接结语

1. **优先把 Issue 3 的方案选型和用户对齐**,再动手。这是本交接文档的最大价值。
2. Issue 1 剩余两项改动简单,但**先截图给用户过目**避免重复误判(前一位 Agent 已经误判过一次范围)。
3. Issue 2 需要 CDS 部署验证后端改动,**不要拖到其他改动一起跑**,保持 commit 粒度清晰。
4. 所有改动完成后,**务必调 `task-handoff-checklist`(/handoff)技能**生成正式交接清单。

祝顺利。前一位 Agent 2026-04-21 交接。
