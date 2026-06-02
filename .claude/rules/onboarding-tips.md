# 页面新手指引（小技巧）维护规则

> 每个大型智能体页面右下角的「小技巧」抽屉，点开应能看到**本页**的完整新手指引（约 8-15 步 Tour）。本规则保证：页面 UI 变了，指引和锚点必须同步更新，不留断点。

---

## 一、SSOT 与触发范围

- **唯一数据源**：`prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs` 的 `BuildDefaultTips(now)`。每个页面一条 `*-page-guide` 的 `card` 类型 seed，`DisplayOrder = 0`（保证该页打开抽屉时本页教程排第一）。
- **锚点**：页面上的 `data-tour-id="..."` 属性。Tour 每一步的 `Selector` 必须能在对应页面 `document.querySelector` 命中。
- 已落地的页面教程（截至 2026-06-01）：
  | 页面 | route | seed id | 步数 |
  |------|-------|---------|------|
  | 网页托管 | `/web-pages` | `webpages-page-guide` | 14 |
  | 视觉创作 | `/visual-agent` | `visual-page-guide` | 11 |
  | 知识库 | `/document-store` | `document-store-page-guide` | 8 |
  | 文学创作 | `/literary-agent` | `literary-page-guide` | 8 |

  周报（`/report-agent`）按用户要求**不做**本页教程。

## 二、强制更新钩子（改页面就得改教程）

当你改动上表任一页面（重排布局、删按钮、改 `data-tour-id`、加核心功能）时，**同一个 PR 内必须**：

1. **锚点对账**：grep 该页所有 `data-tour-id`，逐一比对对应 `*-page-guide` 的每个 `Selector`。删了锚点 → 删/改对应步骤；移了锚点 → 步骤 Body 文案同步；加了核心功能 → 新增锚点 + 步骤。
2. **常驻校验**：Tour 锚点必须是**页面常驻元素**（含空状态占位卡），不能指向 modal/dropdown 里只在交互后出现的元素，否则新用户（空数据）跑到那步会卡 10 秒超时。详情页内的按钮（如知识库的「上传/发布」）用列表页常驻锚点承载，靠 Body 文案指引。
3. **自检**：`grep -o 'data-tour-id="[^"]*"' <page>` 的集合 ⊇ 该页教程所有 `Selector` 引用集合。

## 三、新增页面教程的标准流程

1. 给页面加 ~8-15 个 `data-tour-id`（常驻元素优先；自定义组件如 `TabBar`/`GlassCard` **不转发** `data-*`，需包一层 `div`/`span` 或锚到原生 DOM；`design/Button` 会转发，可直接加）。
2. 在 `BuildDefaultTips` 新增一条 `*-page-guide` seed：`kind="card"`、`tier="basic"`、`DisplayOrder=0`、`actionUrl` 指向该 route、第 1 步带 `NavigateTo`。
3. 步数控制在 8-15（少于 6 步意义不大——用户本来就能点）。
4. 更新本规则上表 + 跑视觉验收。

## 四、为什么用 seed-in-code 而非手动 POST

`*-page-guide` 写进 `BuildDefaultTips` 后随代码版本走、对全体用户自动可见、不依赖管理员手动 POST，也天然满足「功能更新 → 教程更新」走同一条 PR 审查。临时/活动类 tip 才走 `POST /api/admin/daily-tips`（见 `createzzdemo` 技能）。

## 五、相关

- `.claude/skills/createzzdemo/SKILL.md` — 生成单条教程小书的技能
- `prd-admin/src/components/daily-tips/TipsDrawer.tsx` — 右下角抽屉，按 `location.pathname === actionUrl` 优先展示本页教程
- `prd-admin/src/components/daily-tips/SpotlightOverlay.tsx` — 按 `autoAction.steps` 执行高亮引导
- CLAUDE.md 规则 #9 — `data-tour-id` 锚点命名规范
