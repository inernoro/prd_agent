# 前端模态框布局硬约束

所有浮层组件（Modal / Dialog / Drawer / Popover / Toast）必须遵守的 3 条物理约束。**不是样式偏好，是物理要求**——违反任何一条都会在内容变多时出现"超出屏幕、无法滚动"的故障。

## 适用范围

- 全屏蒙版 + 居中弹窗（Modal / Dialog）
- 侧边抽屉（Drawer / Sheet）
- 覆盖层浮层（右键菜单、下拉面板、Tooltip 如果需要溢出父容器）
- 全屏 Loading 蒙版
- 右下角 Toast / 通知

## 三条规则

### 规则 1：布局关键尺寸走 inline style，不走 Tailwind arbitrary value

**要求**：模态框容器的 `height` / `maxHeight` / `width` / `maxWidth` / `top` / `bottom` 等 **决定视觉边界** 的属性必须用 inline `style={{}}` 设置，不用 Tailwind 的 `h-[90vh]` / `max-h-[90vh]` 这类 arbitrary value。

**反例**：

```tsx
// ❌ 依赖 Tailwind 对 arbitrary value 的正确扫描
<div className="fixed inset-0 z-50 flex items-center justify-center">
  <div className="w-full max-w-5xl h-[90vh] rounded-xl bg-[#0f1014] flex flex-col">
    ...
  </div>
</div>
```

这段代码在某些构建模式下会失败：`h-[90vh]` 类没被生成到 CSS，modal 容器没有高度约束，内容一多就撑破视口。

**正例**：

```tsx
// ✅ inline style 直接走 DOM，不受 Tailwind 处理链影响
<div
  className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
  style={{ padding: '16px' }}
>
  <div
    className="w-full max-w-5xl rounded-xl border border-white/10 bg-[#0f1014] flex flex-col overflow-hidden"
    style={{ height: '90vh', maxHeight: '90vh' }}
  >
    ...
  </div>
</div>
```

**原则**：
- **布局关键属性** → inline style
- **视觉属性**（颜色、边框、阴影、圆角、padding、字体、hover 效果）→ 继续走 className

**为什么**：
- Tailwind v4 用 Oxide 引擎 + `@tailwindcss/vite` 插件，和 v3 JIT 行为有细微差异
- Arbitrary value 需要 Tailwind 的 content path 扫描到源文件，偶尔会漏（尤其在 monorepo / 多入口 / HMR 场景）
- 布局关键属性一旦失效，视觉表现是"内容撑破屏幕"这种严重 bug
- inline style 直接走 DOM，不受 CSS 预处理 / JIT / 类名扫描 / 构建缓存影响，是最后一道防线

### 规则 2：必须 createPortal 到 document.body

**要求**：所有浮层组件的 JSX 必须通过 `createPortal(modal, document.body)` 挂到 body 根部，**不要直接 return 在父组件 JSX 里**。

**反例**：

```tsx
// ❌ Modal 渲染在 PrItemCard JSX 内部
export function PrItemCard({ item }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <div className="rounded-xl overflow-hidden">   {/* ← 祖先 overflow-hidden */}
      <button onClick={() => setModalOpen(true)}>打开</button>
      {modalOpen && (
        <div className="fixed inset-0 z-50">
          {/* 虽然用了 fixed，但因为 JSX 位置在 overflow-hidden 父容器内，
              视觉上会被裁剪 */}
          ...
        </div>
      )}
    </div>
  );
}
```

**正例**：

```tsx
import { createPortal } from 'react-dom';

export function MyModal({ onClose }: Props) {
  const modal = (
    <div className="fixed inset-0 z-[100] ..." onClick={onClose}>
      <div className="..." onClick={(e) => e.stopPropagation()}>
        ...
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}
```

**为什么**：React tree 里任何祖先满足以下条件之一，都会影响 `position: fixed` 的视觉边界：

| 祖先 CSS 属性 | 影响 |
|---|---|
| `overflow: hidden` | 可能视觉裁剪 fixed 子元素 |
| `transform: *`（非 none） | 把 fixed 变成相对于该祖先的 absolute |
| `filter: *`（非 none） | 同 transform |
| `will-change: transform` | 同 transform |
| `perspective: *` | 同 transform |

`createPortal` 把渲染目标切到 `document.body`，物理脱离所有祖先影响。

### 规则 3：Flex 滚动容器必须 `min-h-0` / `minHeight: 0`

**要求**：在 `display: flex` 容器内，任何需要滚动的子元素必须显式设 `min-height: 0`（或 `min-h-0`），否则 `overflow-auto` 不生效。

**反例**：

```tsx
// ❌ 缺 min-h-0，overflow 失效
<div className="flex flex-col" style={{ height: '90vh' }}>
  <Header />
  <div className="flex-1 overflow-y-auto">   {/* ← overflow 不会生效 */}
    {longContent}  {/* 把父容器撑开，撑破 90vh */}
  </div>
</div>
```

**正例**：

```tsx
// ✅ min-h-0 解锁 flex 子元素的 overflow
<div className="flex flex-col" style={{ height: '90vh' }}>
  <Header />
  <div
    className="flex-1 px-5 py-4"
    style={{
      minHeight: 0,                    // ← 关键一笔
      overflowY: 'auto',
      overscrollBehavior: 'contain',   // 防止滚到边界时穿透到下层 body
    }}
  >
    {longContent}
  </div>
</div>
```

**为什么 min-h-0 是必须的**：

Flex 子元素的 CSS 规范默认值：
- `min-width: auto`（横向 flex 时）
- `min-height: auto`（纵向 flex 时）

`auto` 的含义是"不小于内容尺寸"。所以当子元素有 `flex-1`（允许收缩）但内容比可分配空间大时：
1. 子元素的"最小尺寸"变成"内容尺寸"
2. 子元素就不能真的收缩到可分配尺寸以下
3. 整个 flex 容器被撑开，超出父容器的高度约束
4. 子元素自己的 `overflow: auto` 根本没机会触发（因为子元素本身没被压缩）

显式设 `min-height: 0` 告诉浏览器"允许我收缩到 0 以上任意尺寸"，这样 `flex-1` 才能真的起作用，子元素被压缩到可分配空间，内容溢出时 `overflow: auto` 才能生效。

**这是 flex + overflow 最著名的坑**。熟悉 CSS 的前端老手也经常漏这一笔。

**关于 `overscroll-behavior: contain`**：当用户在模态框内滚到边界后继续滚动，默认会触发"滚动链"传到下一层可滚动祖先（通常是 body）。`overscroll-behavior: contain` 阻止这种穿透，滚到边界就停止。对模态框、侧边栏、抽屉等覆盖层都应该加。

## 参考实现

```tsx
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
  children: React.ReactNode;
  title: string;
}

export function StandardModal({ onClose, children, title }: Props) {
  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-5xl rounded-xl border border-white/10 bg-[#0f1014] shadow-2xl flex flex-col overflow-hidden"
        style={{
          height: '90vh',
          maxHeight: '90vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header —— shrink-0 不参与压缩 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10 shrink-0">
          <div className="flex-1 text-sm font-semibold text-white truncate">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body —— flex-1 + minHeight:0 + overflowY:auto 三件套 */}
        <div
          className="flex-1 px-5 py-4"
          style={{
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
```

## Checklist

新增或修改任何浮层组件时，**提交前必须逐项确认**：

- [ ] 外层容器用 `createPortal(..., document.body)` 挂到 body 根部
- [ ] 内层容器的 `height` / `maxHeight` 走 inline `style={{}}`，不用 `h-[xxvh]`
- [ ] Header / Footer / 固定尺寸部分用 `className="shrink-0"`
- [ ] 滚动区用 `flex-1` + inline `minHeight: 0` + inline `overflowY: 'auto'`
- [ ] 滚动区加 `overscrollBehavior: 'contain'`
- [ ] z-index ≥ `z-[100]`
- [ ] ESC 键关闭（`keydown` listener，unmount 时清理）
- [ ] 点击蒙版关闭（外层 `onClick={onClose}` + 内层子元素 `onClick={(e) => e.stopPropagation()}`）
- [ ] **手动测试**：塞 100 条以上内容，确认：
  - 模态框边缘完全在视口内
  - 滚动条在模态框内部出现（不是 body 级）
  - 滚到底再滚不会拖动下层 body（overscroll contain 生效）
  - 手机 / 小屏幕（移动模式）也不超出

## 真实案例

**2026-04-11 PR 审查历史弹窗**：

- **第一版**：用 `h-[90vh]` + `max-h-[90vh]` + Tailwind `min-h-0`，用户反馈"超出屏幕无法滚动"。
- **第二版**：加 `createPortal` + 还是 Tailwind `h-[90vh]`，用户再次反馈同样问题。
- **第三版**：切换到 inline style `{ height: '90vh', maxHeight: '90vh' }` + inline `{ minHeight: 0, overflowY: 'auto' }`，一次修复。

根因：Tailwind v4 的 Oxide 引擎在本项目的构建路径上扫描到 `h-[90vh]` 类名但没生成对应 CSS。inline style 绕过这条链路后问题消失。

**教训**：模态框这种有物理约束的组件，布局关键属性不能依赖任何构建链条的正确性。直接走 DOM 才能保证"写什么就是什么"。

## 关联规则

- `rule.frontend-architecture`：前端整体架构原则
- `rule.no-localstorage`：禁止使用 localStorage
- `rule.default-editable`：默认可编辑原则
