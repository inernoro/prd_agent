# CDS 移动端布局回退（Desktop-Fill 必须有 Mobile-Flow 兜底）

> CDS web 是桌面优先的。它的富面板（数据库工作台、拓扑详情、浮动徽章）默认用一套
> 「填满有界视口」的高度契约——`h-full` + 固定 px 网格行 + `lg:grid-cols-[…]` + `whitespace-nowrap`。
> 这套契约**只在桌面那个有界容器里成立**；一旦塞进手机窄屏，没有任何回退，面板就会
> **重叠、塌陷、结果区消失、浮层溢出到屏幕外**。本规则把「desktop-fill 必须配 mobile-flow 兜底」
> 固化为 CDS 的纪律。触发：编辑 `cds/web/src/**/*.tsx`、`cds/web/src/index.css`。

---

## 一、根因（为什么会「无法使用」）

桌面富面板靠**有界高度**才能工作：模态是 `h-full`，内部用 `grid-rows-[245px_minmax(0,1fr)]`
或 `lg:grid-cols-[320px_minmax(0,1fr)]` 把空间分给各窗格，每个窗格 `h-full overflow-auto`
**在自己那一格内部滚动**。这一切的前提是「父级给了一个确定的高度」。

手机窄屏（< `lg`）下这个前提**全部失效**：

1. **多窗格网格塌成单列，但子级还按桌面高度契约渲染**：`minmax(0,1fr)` 行在没有
   高度上界时塌成 0（结果区直接消失），固定 `245px` 行照常占位，`h-full` 子级
   对着「内容高度」解析 → 窗格互相**堆叠重叠**（IMG_0419 里「SQL Console」压住表树就是这个）。
2. **全屏模态 `fixed inset-0` + `overflow-hidden` 从不让堆叠内容竖向滚动** → 溢出被裁剪、够不到。
3. **浮动 pill 里的 `whitespace-nowrap` 长文案溢出视口** → 把操作按钮（立即更新/刷新/关闭）
   挤出屏幕右侧，用户点不到（IMG_0418 的更新徽章就是这个）。

**一句话根因**：CDS 此前**没有移动端布局纪律**（prd-admin 有 `mobile-first-density.md`，CDS 没有），
于是每个桌面优先的富面板都**只写了 fill、没写 mobile 兜底**就发布了。

---

## 二、强制规则：< lg 必须从「fill」切到「flow」

任何「填满视口」的富面板/模态/浮层，必须提供手机回退——**默认（mobile）走自然流，`lg:` 再叠桌面 fill**：

### 1. 多窗格容器：mobile `flex flex-col`，desktop `lg:grid`
```tsx
// ❌ 只有 desktop fill,手机塌陷
<div className="grid min-h-0 lg:grid-cols-[320px_minmax(0,1fr)]">

// ✅ 手机自然堆叠,desktop 再填满
<div className="flex min-h-0 flex-col lg:grid lg:h-full lg:grid-cols-[320px_minmax(0,1fr)]">
```

### 2. 固定 px / `1fr` 网格行：只在 `lg:` 生效
```tsx
// ❌ 245px 固定行 + 1fr 在手机单列里 → 1fr 塌成 0,结果区消失
<main className="grid grid-rows-[245px_minmax(0,1fr)]">

// ✅ 手机 flex-col 自然高度,desktop 再回到固定行布局
<main className="flex min-h-0 flex-col lg:grid lg:grid-rows-[245px_minmax(0,1fr)]">
```

### 3. 内部滚动区：手机给**有界高度**（max-h / min-h），desktop 再 `flex-1`/`h-full` 填满
```tsx
// 左树:手机 max-h 限高 + 自身滚动,desktop 填满列高
<div className="min-h-0 max-h-[40vh] overflow-auto lg:max-h-none lg:flex-1">

// 结果区:手机给 min-h 兜底(否则塌成 0),desktop 由 1fr 填满
<div className="grid min-h-[300px] grid-rows-[auto_minmax(0,1fr)] lg:min-h-0">
```
> 注意 flexbox 陷阱：在「无界高度的 mobile flex 列」里用 `flex-1`（basis 0%）会把子级塌成 0。
> 手机用 `max-h`/`min-h`，把 `flex-1` 收进 `lg:`。

### 4. 全屏模态：body 必须可滚（mobile），desktop 再内部填满
```tsx
<div className="fixed inset-0 z-[90] p-0 sm:p-3 md:p-5">
  <div className="flex h-full flex-col overflow-hidden border bg-background sm:rounded-lg">
    <div className="shrink-0 …header…" />
    {/* body: 手机整体竖滚,desktop 各窗格内部滚 */}
    <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">{children}</div>
  </div>
</div>
```
手机全屏（`p-0` + `sm:rounded-lg`）让窄屏多拿空间。

### 5. 浮动 pill / 徽章：限宽 + 截断,别 `whitespace-nowrap`
```tsx
// ❌ 长文案把按钮挤出屏幕
<div className="fixed bottom-4 left-4"><span className="whitespace-nowrap">{label}</span>…buttons</div>

// ✅ 限宽 + min-w-0 链 + 截断,按钮 shrink-0 永远够得到
<div className="fixed bottom-4 left-4 max-w-[calc(100vw-2rem)]">
  <div className="flex min-w-0 …">
    <button className="flex min-w-0 …"><span className="truncate">{label}</span></button>
    <button className="shrink-0">立即更新</button>
  </div>
</div>
```

### 6. 宽表格：包一层 `overflow-x-auto`，表自身 `min-w-[Npx]`（横滚而非撑破）
已是惯例（如 ProjectSettings 缓存表），新表照做。

---

## 三、交付前自审（任何富面板/模态/浮层）

在 375px / 390px 宽下走查（可用 Playwright 无头 + `viewport:{width:390}` 截图，见
`scripts`/scratchpad 里的 harness 思路）：

- [ ] 多窗格在手机是**单列自然堆叠**、互不重叠？
- [ ] 每个区块（树/控制台/结果）在手机都**可见且有合理高度**（结果区没塌成 0）？
- [ ] 模态/页面内容在手机**整体可竖向滚动**，没被 `overflow-hidden` 裁掉？
- [ ] 浮动徽章/pill 在手机**不溢出右边**，操作按钮都点得到？
- [ ] 桌面（≥1024px）观感**零回归**（所有 mobile 处理都在 `lg:` 之下渐进增强）？

两条以上不达标 = 手机不可用，返工。

---

## 四、与其他规则的关系

- `content-fills-canvas.md` / `full-height-layout.md`：管「桌面把高度填满」——本规则是它们的**移动端兜底**：
  填满是桌面契约，手机必须有 flow 回退，二者通过 `lg:` 断点共存，不冲突。
- prd-admin 的 `.claude/rules/mobile-first-density.md`：同源纪律的 admin 版；CDS 此前缺失，本规则补齐。
- `cds-theme-tokens.md`：手机回退同样禁止暗色字面量,所有颜色走 token。

---

## 五、历史背景

2026-06-26 用户在真机上反馈三处「不太自然 / 异常 / 无法使用」：
(1) 落地页底部 chips 居中换行成参差不齐的阶梯；
(2) 左下角更新徽章长文案溢出屏幕、按钮够不到；
(3) 数据库工作台（MySQL 工作台 `BranchDetailDrawer` 的 `ResourceWorkbenchModal`）
在手机上窗格重叠、结果区看不到、无法使用。
归因后发现三者同根：**desktop-fill 无 mobile-flow 兜底**。本规则与三处修复同 PR 落地。
