---
title: 教程小书 — 三场景统一 + 过时检测自动化(交接给后续 Agent)
type: plan
status: 待开发
owner: TBD
created: 2026-04-21
relates: doc/design.daily-tips.md
---

# 交接说明

这是一份**待办交接文档**。当前会话已落地的部分见 `doc/design.daily-tips.md` §5-§8。
本文档只列剩余的 2 个大块:

1. **三场景统一**:新手教程 / 新功能发布 / bug 修复 都走同一个教程小书面板,管理员可以分类查看与推送
2. **过时检测自动化**:tip 关联的功能下线 / 锚点不存在 / 长时间无人点击时,自动标记为 `stale`,管理员一眼能清

接手这份文档的 Agent **不需要**重新理解教程小书的全套架构,直接从 §3 「实施清单」往下读即可。

---

## 1. 当前已具备的基建(可直接复用)

- 数据模型 `DailyTip` + 内嵌 `Deliveries`
- `User.DismissedTipIds` 永久 dismiss
- 后端端点:`/visible` `/track` `/dismiss-forever` `/admin/daily-tips/{push,seed,reset,push?scope=...}`
- 前端组件:`TipsDrawer`(右下角悬浮书,轮播)+ `SpotlightOverlay`(单例,落地页脉冲圈)+ `TipCard`(共享卡片)+ `fireConfetti`(完成撒花)
- 技能:`createzzdemo`(自然语言 → DailyTip JSON + 打断风险分析)

---

## 2. 待办需求摘录(用户原话)

> 3、新手教程, 新功能发布, bug修复, 都需要调用这个面板, 当然过时了的话, 需要告诉用户删除哪些, 有检测方法能检测出哪些过时, 其余的全部自动化是最好的(方便管理员使用)
> 4、用户已经点完了的, 需要清除  ← 这条已落地(SpotlightOverlay 完成最后一步会 dismissTipForever + 撒花)

---

## 3. 实施清单

### 阶段 A:三场景统一(预计 0.5 人天)

#### A.1 数据模型扩展

`prd-api/src/PrdAgent.Core/Models/DailyTip.cs` 已有 `SourceType: string?` 字段,
扩展为枚举式约定:

| `SourceType` | 含义 | 触发方 |
|--------------|------|--------|
| `onboarding` | 新手教程 | 管理员手动建,默认目标新注册用户 |
| `feature-release` | 新功能发布 | 管理员手动建 / `/release-version` 技能自动建 |
| `bug-fix` | 缺陷已修复回执 | 缺陷 Agent 闭环时自动建,定向推给反馈人 |
| `manual` | 兜底,管理员自建无分类 | 现状默认值 |
| `seed` | 内置默认(代码里 BuildDefaultTips) | 不可编辑 |

**不需要改 model 类型**,只是规范 string 取值。`AdminDailyTipsController.Create` 时收
`req.SourceType` 写入即可。前端 DailyTipsEditor 表单加一个下拉选项。

#### A.2 前端管理界面分类筛选

`prd-admin/src/pages/settings/DailyTipsEditor.tsx`:
- 列表上方加分段控件:`全部 / 新手 / 新功能 / 缺陷修复 / 自建`
- 各 tip 卡左上角加场景 chip(色彩区分)

#### A.3 缺陷 Agent 闭环时自动创建

`prd-api/src/PrdAgent.Api/Controllers/Api/DefectController.cs`(具体路径搜
`status === 'fixed'`):
- 缺陷状态变 `fixed` 时,调 `IDailyTipsService.CreateAsync` 写入一条:
  ```
  Kind = "card",
  Title = "你提的「{defect.Title}」已修复",
  Body = "改动见 PR #{prNumber};可以验收一下。",
  ActionUrl = `/defect/{id}`,
  CtaText = "去验收",
  TargetUserId = defect.SubmittedBy,  // 定向给反馈人
  SourceType = "bug-fix",
  ```

#### A.4 release-version 技能自动建

`/release-version` 发版时,扫 changelog 碎片,把每条 `feat` 自动转换为
`feature-release` tip(可选,可让管理员审核后入库)。

---

### 阶段 B:过时检测(预计 1 人天)

#### B.1 检测维度

| 信号 | 阈值 | 处理 |
|------|------|------|
| 锚点 selector 在前端代码里搜不到 | 即时 | 标 `stale: anchor-missing` |
| 创建时间 > 90 天 + 0 次 clicked | 90 天 | 标 `stale: low-engagement` |
| `actionUrl` 路由不在 React Router 里 | 即时 | 标 `stale: dead-link` |
| `relatedFeatureKey` 字段对应的 feature 已下线 | 待 feature flag 系统 | 标 `stale: feature-removed` |

#### B.2 实现方式

**B.2.1 前端代码扫描(锚点 + 路由,本地构建期)**

写一个 `scripts/check-tour-anchors.ts`:
```ts
// 1. 拉取所有线上 DailyTip(API 或 dump JSON)
// 2. grep 前端 src 里所有 data-tour-id 的字符串
// 3. 比对 selector,缺失的输出 stale 报告
// 4. 也扫所有 React Router route,缺失的 actionUrl 标 dead-link
```

接入 CI:每次 build 跑一次,失败仅 warning(不阻塞)。

**B.2.2 数据库定时扫描(低参与度,服务器侧)**

`prd-api/src/PrdAgent.Infrastructure/BackgroundServices/DailyTipsStalenessScanner.cs`:
- `IHostedService`,每天凌晨 03:00 执行
- 扫 DailyTip:`CreatedAt < now - 90d` 且 `Deliveries.None(d => d.Status == "clicked")` → 写
  `Stale: List<string>` 字段
- **不自动删除**,只标记;管理员决定清理

**B.2.3 数据模型扩展**

```csharp
DailyTip {
  ...existing...,
  Stale: List<string>?  // ["anchor-missing", "low-engagement", "dead-link", "feature-removed"]
  StaleScannedAt: DateTime?
}
```

**B.2.4 管理界面**

`DailyTipsEditor`:
- 工具栏加「⚠ 过时清单」按钮 → 弹 modal 显示所有 `Stale.Count > 0` 的 tip
- 每条带「批量删除选中项」+ 「保留」操作
- 现有「清空并重建」按钮可继续用

---

## 4. 验收清单

完成上述阶段 A + B 后,管理员能做:

- [ ] 新建 tip 时选场景(onboarding / feature-release / bug-fix / manual)
- [ ] 列表按场景过滤,清晰看到哪些是新功能教程 / 哪些是缺陷反馈
- [ ] 缺陷修复后,反馈人下次登录看到「你提的 xx 已修复」card
- [ ] 每天自动扫描过时 tip,管理员看到红色 ⚠ 提示
- [ ] 一键删除选中的过时 tip(批量)

---

## 5. 已落地(本会话):用户已点完的清除 + 完成撒花

`SpotlightOverlay.tsx` 已实现:多步 Tour 走到最后一步,用户点「完成 🎉」会:
1. 调用 `fireConfetti()` 撒一阵 emoji 庆祝
2. 调用 `dismissTipForever(tip.id)` 永久不再提示

`fireConfetti` 是独立工具(`components/daily-tips/fireConfetti.ts`),emoji + CSS
animation 实现,~80 行,无第三方依赖,尊重 `prefers-reduced-motion`。

---

## 6. 不要做的事

- **不要重构整个 DailyTip 数据模型** —— 现有结构能装下三场景 + 过时标记
- **不要把 SpotlightOverlay 拆成多个组件** —— 单例已是经过验证的稳定方案(见 design 文档 §5.1 的 Play bug 教训)
- **不要重新设计 SuccessConfettiButton** —— 那是按钮组件,跟 daily-tips 解耦的轻量 fireConfetti() 才是合适的工具

---

## 7. 关联文档

- `doc/design.daily-tips.md` — 现状原理(必读)
- `.claude/skills/createzzdemo/SKILL.md` — 自动生成 tip 的技能
- `.claude/rules/no-localstorage.md` — 必须用 sessionStorage(本场景中 dismissed 走后端 User.DismissedTipIds,不冲突)

---

## 8. 推荐接手方式

1. 读完本文档 + design 文档 1 小时
2. 阶段 A 一次 commit(场景分类 + 缺陷修复闭环)
3. 阶段 B 一次 commit(过时扫描 + 管理界面)
4. 两次 commit 都跟 changelog 碎片
5. push 后 CDS auto-deploy,在预览域名上点「清空并重建」+ 跑 createzzdemo 技能验证

预计总工时:1.5 人天。
