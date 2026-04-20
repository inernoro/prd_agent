# 页面必须撑开高度（Full-Height Layout）

宽屏 / 桌面端 / 管理后台类页面必须撑满视口可用高度，禁止内容猥琐在屏幕中心或上部留一大片黑底。

---

## 核心主张

> 用户打开一个页面看到屏幕下半部分是纯黑色（或 bg-base 纯色），就是体验缺陷。
> 页面 = 视口可用区域。主布局必须把可用高度吃满，内部再做滚动/分区。

---

## 硬约束

### 1. 页面根组件必须 `h-full min-h-0 flex flex-col`

不允许只写 `flex flex-col gap-N` 当作根。AppShell 已经把 `<Outlet />` 挂在 `flex-1 min-h-0` 容器里，页面根 `h-full min-h-0 flex flex-col` 才能拿到全部高度。

```tsx
// ✅ 正确
return (
  <div className="flex flex-col gap-5 h-full min-h-0">
    <Header />
    <MainArea />  {/* 内部用 flex-1 min-h-0 吃剩余高度 */}
  </div>
);

// ❌ 错误（内容高度由自己决定，宽屏下底部一片黑）
return (
  <div className="flex flex-col gap-5">
    <Header />
    <MainArea />
  </div>
);
```

### 2. 禁止 `height: calc(100vh - Npx)` 魔数

`100vh` 不包含安全区、mobile 虚拟键盘、AppShell 导航。页面嵌套层级改一次就对不上。

```tsx
// ❌ 禁止
<div style={{ height: 'calc(100vh - 160px)' }}>...</div>
<div className="h-[calc(100vh-160px)]">...</div>

// ✅ 走 flex 链
<div className="flex-1 min-h-0 flex flex-col">...</div>
```

### 3. Tab 切换时每个 tab 内容都要撑开

TabBar + 多 tab 的场景，每个 tab 的容器都必须 `flex-1 min-h-0`，不能只有其中一个 tab 撑开。

```tsx
// ✅
<div className="h-full min-h-0 flex flex-col">
  <TabBar />
  {tab === 'A' && (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <LongList />
    </div>
  )}
  {tab === 'B' && (
    <div className="flex-1 min-h-0 flex flex-col">
      <TwoColumnLayout />
    </div>
  )}
</div>
```

### 4. 滚动永远发生在最靠近内容的那一层

- 长列表 → 列表容器 `flex-1 min-h-0 overflow-y-auto`
- 两栏独立滚动 → 每栏自己 `flex-1 min-h-0 overflow-y-auto`
- 禁止依赖页面外层 `<main>` 的滚动作为唯一滚动源（会让内部分区布局崩溃）

### 5. 滚动容器必须 `overscrollBehavior: 'contain'`

避免滚到边界时事件穿透到下层 body 造成整页弹跳。

```tsx
<div
  className="flex-1 min-h-0 overflow-y-auto"
  style={{ overscrollBehavior: 'contain' }}
>
  {content}
</div>
```

---

## 判定标准

在不同分辨率（1280 × 800 / 1440 × 900 / 1920 × 1080 / 2560 × 1440）下打开页面：

- [ ] 页面内容**完全填满**视口可用高度
- [ ] 底部没有大块纯色留白
- [ ] 内容超长时有清晰的滚动区（不是整页滚动）
- [ ] 调整窗口大小时布局平滑响应，不跳变
- [ ] 切 tab 时高度保持（不会因为另一个 tab 内容少就缩短）

---

## 典型反面案例

| 症状 | 根因 |
|------|------|
| 页面底部一大片黑 | 根容器缺 `h-full min-h-0`，内容按自己高度摆 |
| 窗口放大反而出现底部空白 | 用了 `calc(100vh - Npx)` 魔数，没覆盖到当前嵌套 |
| 左右两栏高度不一 | 内部没走 `flex-1 min-h-0`，高度被内容决定 |
| 切 tab 后高度塌陷 | Tab 内容 wrapper 没 `flex-1 min-h-0` |
| Chrome 滚动时整页抖动 | 滚动容器缺 `overscrollBehavior: contain` |

---

## 例外

以下场景**允许**不撑满高度：

- 真正内容极短的只读说明页（< 300px 高度）且设计稿明确「居中展示」
- Modal / Drawer / Popover 内部（已经由浮层框架限定大小）
- 移动端视口高度本就等于内容（非宽屏）
- 全屏沉浸式封面 / 登录页（有明确的 hero 层）

对非例外场景，一律走本规则。

---

## 与其他规则的关系

- `frontend-modal.md`：浮层内部布局的 3 硬约束（inline style 高度、createPortal、min-h-0）
- `frontend-architecture.md`：组件复用 / SSOT
- `guided-exploration.md`：空状态要有引导——撑开后的空间正好摆引导内容，而不是留白

空间越大，越要有内容。高度必须撑开，是本规则；撑开后填什么，看 `guided-exploration`。
