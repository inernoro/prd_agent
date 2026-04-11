---
globs: ["prd-admin/src/**/*.tsx", "prd-desktop/src/**/*.tsx"]
---

# 前端模态框布局硬约束

任何浮层组件（Modal / Dialog / Drawer / Popover / Toast）都必须满足 3 条物理约束，否则会在内容增多时超出屏幕。**不是 Tailwind 类名技巧，是物理要求**。

## 三条必守规则

### 1. 尺寸关键属性用 inline style，不依赖 Tailwind JIT

模态框的 `height` / `maxHeight` / `top` / `bottom` 等 **布局关键** 属性一律用 inline `style={{}}`，不用 `h-[90vh]` / `max-h-[90vh]` 这类 arbitrary value。

**理由**：Tailwind v4（`@tailwindcss/vite` + Oxide 引擎）在不同构建模式下对 arbitrary value 的扫描行为有差异；v3 JIT 也有边缘情况。布局关键尺寸一旦没生效，视觉表现就是"内容撑破屏幕"。inline style 直接走 DOM，不受任何 CSS 预处理 / 类名扫描 / 构建缓存影响。

```tsx
// ✅ 正确
<div
  style={{ height: '90vh', maxHeight: '90vh' }}
  className="rounded-xl border border-white/10 bg-[#0f1014]"
>

// ❌ 错误（布局关键类走 Tailwind arbitrary value）
<div className="h-[90vh] max-h-[90vh] rounded-xl ...">
```

**Tailwind className 只保留非布局关键属性**：颜色、边框、hover 效果、字体、圆角、padding 这些都继续走 className。

### 2. 模态框必须 createPortal 到 document.body

所有全屏浮层用 `createPortal(modal, document.body)` 挂到 body 根部，**不要直接 return 在父组件 JSX 里**。

**理由**：React tree 里任何祖先的 `overflow: hidden` / `transform` / `filter` / `will-change` 都会影响 `position: fixed` 的视觉效果（transform 会把 fixed 变成 absolute，overflow-hidden 会裁剪）。createPortal 把渲染目标切到 body 根，物理脱离祖先影响。

```tsx
import { createPortal } from 'react-dom';

export function MyModal({ onClose }: Props) {
  const modal = (
    <div className="fixed inset-0 z-[100] ...">
      ...
    </div>
  );
  return createPortal(modal, document.body);
}
```

**适用范围**：Modal / Dialog / 右键菜单 / 全屏 Loading / Toast / Tooltip（如果 tooltip 需要溢出父容器）。

### 3. Flex 滚动容器必须 `min-h-0` + inline overflow

Flex 子元素的 `min-height` 默认是 `auto`，这会阻止它收缩到内容尺寸以下，导致 `overflow-auto` **不生效**（子元素把父容器撑开，overflow 没机会触发）。必须显式设 `min-height: 0`。

```tsx
// ✅ 正确
<div className="flex flex-col" style={{ height: '90vh' }}>
  <Header />  {/* shrink-0 */}
  <TabBar />  {/* shrink-0 */}
  <div
    className="flex-1 px-5 py-4"
    style={{
      minHeight: 0,              // ← 这一笔必须有
      overflowY: 'auto',
      overscrollBehavior: 'contain', // 防止滚到边界时穿透到下层 body
    }}
  >
    {longContent}
  </div>
</div>

// ❌ 错误（缺 min-h-0，overflow-auto 失效，内容撑破父容器）
<div className="flex flex-col h-[90vh]">
  <Header />
  <div className="flex-1 overflow-auto">{longContent}</div>
</div>
```

**为什么同样用 inline style**：`min-h-0` 是 Tailwind 内置类（不是 arbitrary value），通常生效没问题。但既然 #1 已经走 inline style，顺手一起 inline 保证可预测性。

## 检查清单

新增或修改任何模态框 / 浮层时：

- [ ] 外层 fixed 容器用 `createPortal(..., document.body)` 挂到 body
- [ ] 内层 modal 容器的 `height` / `maxHeight` 走 inline style（不是 `h-[xxvh]`）
- [ ] Header / TabBar 等固定高度部分用 `className="shrink-0"`
- [ ] 滚动区用 `flex-1` + inline `minHeight: 0` + inline `overflowY: 'auto'`
- [ ] 滚动区加 `overscrollBehavior: 'contain'` 防止滚动链穿透
- [ ] z-index 使用 `z-[100]` 或更高，避免被页面其他元素盖住
- [ ] ESC 键关闭（`keydown` listener）+ 点击蒙版关闭（`onClick={onClose}` + 子元素 `e.stopPropagation()`）
- [ ] **手动测试**：内容塞到 100 条以上，确认滚动区可以滚，不撑破屏幕

## 真实案例

**2026-04-11 pr-review 历史弹窗**：先用 `h-[90vh]` + `max-h-[90vh]`，用户反馈两次"超出屏幕无法滚动"。定位发现 Tailwind v4 下 arbitrary value 在某些路径上没被应用，modal 容器没有高度约束，内容一多就撑破整个视口。改用 inline style `{ height: '90vh', maxHeight: '90vh' }` + inline `minHeight: 0` + `createPortal` 后一次修复。

> 详细：`doc/rule.frontend-modal.md`
