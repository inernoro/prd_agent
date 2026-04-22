---
title: 每日小贴士 / 路径式教程系统 设计
type: design
status: 落地
owner: daily-tips
updated: 2026-04-21
---

# 每日小贴士 / 路径式教程系统

> 右下角悬浮「教程小书」+ 落地页 SpotlightOverlay 引导 + 管理后台推送/调试闭环。
> 2 分钟让新用户学会某个功能的标准套件。

---

## 1. 管理摘要(30 秒懂)

平台对用户的教育有两种场景:
- **全局发布**:每周告诉所有用户"新功能 X 上线了,按这 3 步操作"
- **定向修复**:某个用户反馈了一个 bug,修好后点一下"推给 Ta",他下次登录就看到"你反馈的问题已修复,点这里查看"

两者都通过 **右下角悬浮的教程小书 + 可多步的页面引导(Tour)** 实现,不需要弹弹窗打扰用户,也不需要专门开会讲。

**三类角色的入口都沉淀了**:
- 用户:点书 → 看到为自己推的教程 → 点"从头开始" → 跟着光圈走完流程
- 管理员:系统设置 → 小技巧 → 新建 / 编辑 / 试播 / 推送
- 开发者:说"创建 XX 演示" → 技能生成 JSON → 一键入库

---

## 2. 产品定位

| 维度 | 选择 | 理由 |
|------|------|------|
| 出现方式 | 右下角悬浮书,常驻 + 推送自动弹 | 不跟通知铃铛抢右上角位置;不打断当前任务 |
| 单步 vs 多步 | **只接受 ≥ 2 步的 Tour**(规则硬约束) | "一步的事人类不需要教" |
| 引导形式 | 脉冲光圈 + 气泡卡 + "下一步"按钮 | JetBrains 风格,用户点下一步时自动 click 当前按钮推进流程 |
| 永久 dismiss | 🔕 按钮写 `User.DismissedTipIds` | 一条 tip 看腻了可以彻底关闭,不再打扰 |
| 本 session dismiss | X 按钮写 sessionStorage | 今天不想看,明天再说 |

---

## 3. 用户场景

### 3.1 新用户第一次登录
1. 首页加载完成,右下角书自动展开抽屉一次(`tipsBookFirstVisitShown` 兜底)
2. 看到 1-3 条 seed tip,每条都是多步 Tour
3. 点"从头开始" → 页面跳转 → 光圈引导 → 4 步学会提缺陷

### 3.2 管理员定向推送
1. 管理员在系统设置 → 小技巧,编辑 tip 保存
2. 点「播放」按钮自测一次(当前账号立即跑)
3. 点「推给我自己」再验一次端到端
4. 点「批量推送」选「全体」或「role:DEV」一键群发
5. 收件用户下一次点书图标或 60s 轮询到,自动弹 → 看到"为你"徽章的新 tip

### 3.3 用户永久关闭
- 🔕 → `POST /api/daily-tips/{id}/dismiss-forever` → 写 `User.DismissedTipIds` → 以后 /visible 过滤

---

## 4. 核心能力

### 4.1 数据模型(MongoDB)

```csharp
DailyTip {
  Id, Kind("text"|"card"|"spotlight"), Title, Body?, CoverImageUrl?,
  ActionUrl("/defect-agent"), CtaText("从头开始"),
  TargetSelector("[data-tour-id=defect-create]"),
  AutoAction {
    Scroll("center"|"top"|"none"),
    Expand?("selector 先点一下展开"),
    Prefill? { Selector, Value },
    AutoClick?("selector"), AutoClickDelayMs?,
    Steps?: [{ Selector, Title, Body? }]  // ← 多步 Tour
  },
  TargetUserId?, TargetRoles?,
  Deliveries: [{ UserId, Status, ViewCount, MaxViews, PushedAt, ... }],
  DisplayOrder, IsActive, StartAt?, EndAt?, SourceType, SourceId
}

User {
  ...existing...,
  DismissedTipIds: string[]  // 永久不再提示
}
```

### 4.2 组件拓扑

```
AppShell
├── <TipsDrawer />              右下角悬浮书 + 抽屉
│     └── <TipCard />           每条 tip 统一卡片(共享 Article Illustration 教程)
├── <SpotlightOverlay />        单例!读 sessionStorage 执行引导
│                               (禁用 key={pathname},否则 Play bug)
└── <AppShell toast bell />     铃铛跟随 floatingDockCollapsed 联动贴边
```

### 4.3 引导动作流水线(SpotlightOverlay)

```
payload 就绪
  │
  ▼
for each step:
  1. autoAction.expand  → click 一下把折叠面板打开(非必须)
  2. autoAction.prefill → 用原生 setter + input event 触发 React onChange
  3. scrollIntoView     → 把目标 selector 居中到视口
  4. 查 rect → 画脉冲光圈 + 气泡卡片(title/body/步骤进度)
  5. 等用户动作:
     - 「下一步」:先帮 click() 当前可交互元素(按钮/链接),再 stepIndex++
     - 「知道了」/X/ESC:dismissed = true,overlay 消失
     - autoClick(可选):延迟 N ms 自动点击,然后 dismissed
```

### 4.4 Admin 批量推送

```
PushDialog
├── 单个用户推送:UserSearchSelect + 最大展示次数 + reset
├── 推给我自己:一键推到当前账号(reset=true 方便反复测)
└── 按 scope 批量:
    - all           → 所有 Status=Active 用户
    - role:PM/DEV/QA/ADMIN
    后端展开 userIds 与手动选的取并集
```

---

## 5. 架构决策

### 5.1 SpotlightOverlay 必须是单例(否则 Play 会挂)

**反面教材**:`<SpotlightOverlay key={location.pathname} />` 每次路由切换 unmount。
**失败场景**:管理员在 `/settings` 点 Play:
1. writeSpotlightPayload 写 sessionStorage + dispatch 事件
2. 当前 Overlay 监听事件,读出 payload,**消费清理 sessionStorage**
3. navigate('/defect-agent') → key 变 → 旧 Overlay unmount,state 丢
4. 新 Overlay mount,读 sessionStorage,已被清理 → 不启动

**正解**:单例 + `readAndStart()` 在事件或 mount 时重置 state;轮询找 selector 时间延长到 8s,覆盖页面 lazy load。

### 5.2 sessionStorage 消费语义

- 写:`SPOTLIGHT_ACTION_KEY`(JSON payload) + 广播 `spotlight-payload-updated` CustomEvent
- 读:读完立刻清理,防止同路由二次触发
- 兼容:旧 `SPOTLIGHT_TARGET_KEY` 还读(只读 selector 字符串)

### 5.3 「下一步」按钮自动 click 前进

旧行为:只 stepIndex++,期待下一步元素已经渲染。
真相:多数多步 Tour 的第 N 步依赖第 N-1 步**点击**后才出现(打开 modal、展开 accordion)。
新行为:`onClick` 里先 `el.click()` 当前 selector(若是 button/anchor/role=button),再 stepIndex++;保留旧 rect 不闪烁。

### 5.4 自动弹条件 ≠ 静态"首次弹一次"

| 场景 | 条件 |
|------|------|
| 新用户兜底 | `!tipsBookFirstVisitShown && tips.length > 0` → 弹一次 |
| 管理员推送 | `tips.find(t => t.isTargeted && !autoOpenedIds.has(t.id))` → 每条新 id 弹一次 |
| 手动打开 | 点书图标,同时 `load({ force: true })` 立即刷新,不等 60s 轮询 |

---

## 6. 数据设计

### 6.1 DailyTip.Deliveries 内嵌,不开新集合

按奥卡姆剃刀原则:deliveries 的查询模式是「按 tipId 查所有用户」,跟 tip 生命周期强绑定,内嵌 + 数组即可。
百万级用户时才考虑抽 `daily_tip_deliveries` 集合。

### 6.2 `/visible` 过滤顺序

```
IsActive=true
& Start/End 发布窗口有效
& (TargetUserId=null OR TargetUserId=me OR Deliveries.UserId=me)
& !User.DismissedTipIds.Contains(Id)
if Deliveries 非空:
  - 没我 → 只有 TargetUserId 匹配或全局才显示
  - 有我 dismissed / ViewCount ≥ MaxViews → 不显示
兜底:items=0 → BuildDefaultTips (仍按 DismissedTipIds 过滤)
```

---

## 7. 接口设计

### 7.1 公共端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/daily-tips/visible` | 当前用户可见 tip 列表 |
| POST | `/api/daily-tips/{id}/track` | seen / clicked / dismissed |
| POST | `/api/daily-tips/{id}/dismiss-forever` | 追加到 User.DismissedTipIds |

### 7.2 管理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET / POST / PUT / DELETE | `/api/admin/daily-tips` | CRUD |
| POST | `/api/admin/daily-tips/{id}/push` | 推送(支持 userIds / scope=all / scope=role:XX) |
| GET | `/api/admin/daily-tips/{id}/stats` | 投递统计 |
| POST | `/api/admin/daily-tips/seed` | 幂等植入 seed(按 SourceId 判重) |
| POST | `/api/admin/daily-tips/reset` | 清空并用最新 seed 重建 |

---

## 8. 扩展指南(如何加新教程)

### 8.1 零代码:用 skill

对 Claude Code 说 **"创建 XX 演示"** / **"增加教程"** → `createzzdemo` 技能:
1. 匹配内置模板(缺陷 / Ctrl+K / Ctrl+B / 更新中心 / 知识库)
2. 产出「步骤清单 + 打断风险分析」
3. 输出 JSON + curl,一键 POST 到 `/api/admin/daily-tips`

### 8.2 需要补锚点时

在目标页面的关键按钮 / 输入框加 `data-tour-id="xxx-yyy"`:

```tsx
<Button data-tour-id="defect-submit" onClick={handleSubmit}>提交</Button>
<input data-tour-id="defect-description" value={...} />
```

命名规范见 `CLAUDE.md` 规则 #9 / `.claude/rules/navigation-registry.md`。

### 8.3 需要复杂交互(如选人 dropdown)

Tour 无法模拟复杂 UI 操作(如 dropdown 选择)。应对:
- 在 step body 里明确说明"默认负责人就够了"让用户手动跳过
- 或把该步骤拆成"高亮 + 知道了",不强求用户操作

---

## 9. 已知约束 / 风险

| 风险 | 缓解 |
|------|------|
| step selector 找不到(如 modal 未渲染) | 轮询 8s,新的下一步会自动 click 前一步按钮帮用户推进 |
| 同路由 navigate 不 re-mount | writeSpotlightPayload 广播 CustomEvent 让 SpotlightOverlay 重读 |
| 60s 轮询延迟 | 点书立即 `load({ force })`;visibilitychange 重拉 |
| 大数据 User.DismissedTipIds 膨胀 | 百万级时改成独立集合 + 索引,目前数组足够 |
| 多步 Tour 的 dropdown / 异步加载步骤无法自动化 | 保留用户手动完成,body 提示到位 |
| 键盘快捷键(Ctrl+B/K)不适合走 tour | 改用静态 key-hint(首页 UI 显眼位置挂 `⌘+K`),不属于教程小书范畴 |
| 管理员「清空并重建」后 Id 变化,用户已 dismiss 的 seed 重新推 | dismiss 时同时存 `SourceId` 和 `Id`(包括 `seed-{x}` 自动 extract x),`/visible` 按双维度过滤;即使 `/reset` 重建过,用户点过完成的还是不推 |

---

## 12. 跨版本更新通知策略(待实现,见交接文档)

当 tip 内容**破坏性更新**(新增步骤、重写文案等)时,需要**再推一次**给已 dismiss
的用户。当前未实现,设计方案见 `doc/plan.daily-tips-scenarios-and-staleness.md`:

- `DailyTip.Version: int`(默认 1),内容大改时 bump
- `User.DismissedTipIds` 升级为 `DismissedTipKeys: List<{key, version}>`
- `/visible` 过滤:如 `dismissed.version < tip.Version` 则**重新显示**
- 非破坏性更新(如改图标)不 bump,保持沉默

这个机制同时解决「清空重建不打扰已完成的用户」和「新功能上线时全员再收到一次」。

---

## 10. 关联设计文档

- `.claude/skills/createzzdemo/SKILL.md` — 自动化创建演示的技能
- `.claude/rules/navigation-registry.md` — data-tour-id 命名规范
- `.claude/rules/frontend-modal.md` — TipCard 浮层约束

---

## 11. 文件索引

**后端:**
- `prd-api/src/PrdAgent.Core/Models/DailyTip.cs`
- `prd-api/src/PrdAgent.Core/Models/User.cs`(DismissedTipIds)
- `prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs`(`/visible`, `/track`, `/dismiss-forever`, `BuildDefaultTips`)
- `prd-api/src/PrdAgent.Api/Controllers/Api/AdminDailyTipsController.cs`(CRUD + `/push` + `/stats` + `/seed` + `/reset`)

**前端组件:**
- `prd-admin/src/components/daily-tips/TipsDrawer.tsx` — 右下角悬浮书 + 抽屉
- `prd-admin/src/components/daily-tips/TipCard.tsx` — 共享卡片组件
- `prd-admin/src/components/daily-tips/SpotlightOverlay.tsx` — 落地页引导 **单例**
- `prd-admin/src/components/daily-tips/TipsRotator.tsx` — 首页副标题轮播 + `writeSpotlightPayload`

**前端管理页:**
- `prd-admin/src/pages/settings/DailyTipsEditor.tsx` — CRUD + 模板模式 + 试播 + 推送弹窗 + 批量

**其他:**
- `prd-admin/src/stores/dailyTipsStore.ts` — 60s 轮询 + visibilitychange 自动刷新
- `prd-admin/src/layouts/AppShell.tsx`(SpotlightOverlay 挂载 + toast 铃铛联动)
