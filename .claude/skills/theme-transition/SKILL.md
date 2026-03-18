---
name: theme-transition
description: 为任意前端项目添加主题切换圆形过渡动效（View Transition API + clip-path 水波纹扩散）。适用于 React/Vanilla/Tauri 等技术栈，含完整 CSS、JS 代码与降级方案。触发词："主题过渡"、"皮肤切换动效"、"theme transition"、"ripple theme"、"/theme-transition"。
---

# Theme Transition — 主题切换圆形过渡动效

为项目添加从按钮位置向外扩散的圆形 clip-path 主题切换动画，基于 View Transition API，自动降级到瞬时切换。

## 效果

点击主题切换按钮 → 新主题从按钮位置以圆形向外扩散覆盖整个页面，旧主题自然消退。全程无白屏/黑屏闪烁，内容始终可见。

## 核心原理

```
用户点击 → 计算按钮中心坐标 (x, y) → 计算覆盖全屏所需最大半径
→ 设置 CSS 自定义属性 (--ripple-x, --ripple-y, --ripple-radius)
→ document.startViewTransition() 捕获旧画面快照
→ 回调中执行主题切换（DOM 变更）
→ 浏览器自动对比新旧快照，通过 ::view-transition-new(root) 的 clip-path 动画展示新主题
```

**关键点**：View Transition API 自动将旧画面截图为 `::view-transition-old(root)`，新画面为 `::view-transition-new(root)`。我们只需控制 `::view-transition-new` 的 clip-path 从 `circle(0)` 到 `circle(maxRadius)` 即可。

## 实现步骤

### Step 1: 添加 CSS

将以下 CSS 添加到项目的全局样式文件中：

```css
/* ══ Theme Transition — View Transition API Ripple ══ */

::view-transition-old(root),
::view-transition-new(root) {
  animation: none;
  mix-blend-mode: normal;
}

::view-transition-new(root) {
  clip-path: circle(0% at var(--ripple-x, 50%) var(--ripple-y, 0));
  animation: theme-ripple-in 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

::view-transition-old(root) {
  z-index: -1;
}

@keyframes theme-ripple-in {
  to {
    clip-path: circle(var(--ripple-radius, 150%) at var(--ripple-x, 50%) var(--ripple-y, 0));
  }
}
```

### Step 2: 添加 JS 切换函数

根据项目技术栈选择对应实现。

#### Vanilla JS（CDS / 纯 HTML）

```js
function toggleTheme(event) {
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  // 1. 计算按钮中心坐标
  let x, y;
  if (event) {
    const btn = event.currentTarget || event.target;
    const rect = btn.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  } else {
    x = window.innerWidth / 2;
    y = 0;
  }

  // 2. 计算覆盖全屏所需的最大半径
  const maxRadius = Math.ceil(Math.sqrt(
    Math.max(x, window.innerWidth - x) ** 2 +
    Math.max(y, window.innerHeight - y) ** 2
  ));

  // 3. 设置 CSS 自定义属性
  document.documentElement.style.setProperty('--ripple-x', `${x}px`);
  document.documentElement.style.setProperty('--ripple-y', `${y}px`);
  document.documentElement.style.setProperty('--ripple-radius', `${maxRadius}px`);

  // 4. 使用 View Transition API（自动降级）
  if (document.startViewTransition) {
    document.startViewTransition(() => applyTheme(newTheme));
  } else {
    applyTheme(newTheme);
  }
}
```

#### React（prd-admin / prd-desktop）

```tsx
import { useCallback, useRef } from 'react';

function useThemeTransition() {
  const triggerRef = useRef<HTMLButtonElement>(null);

  const toggleTheme = useCallback((newTheme: string) => {
    const btn = triggerRef.current;
    let x = window.innerWidth / 2, y = 0;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }

    const maxRadius = Math.ceil(Math.sqrt(
      Math.max(x, window.innerWidth - x) ** 2 +
      Math.max(y, window.innerHeight - y) ** 2
    ));

    document.documentElement.style.setProperty('--ripple-x', `${x}px`);
    document.documentElement.style.setProperty('--ripple-y', `${y}px`);
    document.documentElement.style.setProperty('--ripple-radius', `${maxRadius}px`);

    const apply = () => {
      // 替换为项目实际的主题切换逻辑
      document.documentElement.dataset.theme = newTheme;
    };

    if (document.startViewTransition) {
      document.startViewTransition(apply);
    } else {
      apply();
    }
  }, []);

  return { triggerRef, toggleTheme };
}

// 使用
function ThemeToggle() {
  const { triggerRef, toggleTheme } = useThemeTransition();
  return <button ref={triggerRef} onClick={() => toggleTheme('light')}>切换</button>;
}
```

#### Tauri Desktop（Rust + WebView）

Tauri 的 WebView 基于 Chromium，**完整支持 View Transition API**，无需额外处理。将 CSS 和 JS 按上述方式添加到前端代码即可。

如果 Desktop 使用 `window.__TAURI__` 通信切换主题：

```ts
// 在 applyTheme 回调中同时通知 Rust 侧
const apply = () => {
  document.documentElement.dataset.theme = newTheme;
  invoke('set_theme', { theme: newTheme }); // Tauri command
};

if (document.startViewTransition) {
  document.startViewTransition(apply);
} else {
  apply();
}
```

### Step 3: 主题切换按钮绑定

确保按钮的 `onclick` 传递了 `event` 对象，这是计算动画原点的关键：

```html
<!-- Vanilla -->
<button onclick="toggleTheme(event)">🌙</button>

<!-- React -->
<button ref={triggerRef} onClick={(e) => toggleTheme('light')}>🌙</button>
```

## 适配清单

| 技术栈 | CSS 文件 | JS/TS 文件 | 注意事项 |
|--------|---------|-----------|---------|
| **CDS** (Vanilla) | `cds/web/style.css` | `cds/web/app.js` | 已实现 (参考实现) |
| **prd-admin** (React) | `src/styles/globals.css` | 新建 `useThemeTransition` hook | 与 Zustand theme store 集成 |
| **prd-desktop** (Tauri+React) | `src/styles/globals.css` | 同 React 方案 | WebView 原生支持 |
| **prd-video** (Remotion) | 不适用 | 不适用 | 视频无主题切换需求 |

## 反模式

### 不要使用纯色遮罩覆盖

```js
// ❌ 创建纯色 div 覆盖全屏 → 白屏/黑屏闪烁
const overlay = document.createElement('div');
overlay.style.background = '#FFFFFF';
overlay.style.clipPath = `circle(0px at ${x}px ${y}px)`;
// 动画展开 → setTimeout 切换主题 → 移除 overlay
// 问题：遮罩展开时用户看到的是纯色，而非新主题内容
```

### 不要在 setTimeout 中切换主题

```js
// ❌ 延迟切换 → 新旧主题视觉断层
setTimeout(() => setTheme(newTheme), 300);
// 正确：在 startViewTransition 回调中同步切换
```

### 不要跳过 maxRadius 计算

```js
// ❌ 硬编码半径 → 角落点击时圆形无法覆盖对角
document.documentElement.style.setProperty('--ripple-radius', '100vmax');
// 正确：根据点击位置动态计算到最远角的距离
```

## 浏览器兼容性

| 浏览器 | View Transition API | 降级行为 |
|--------|-------------------|---------|
| Chrome 111+ | 支持 | — |
| Edge 111+ | 支持 | — |
| Safari 18+ | 支持 | — |
| Firefox 126+ (Nightly) | 部分支持 | 瞬时切换 |
| 旧版浏览器 | 不支持 | 瞬时切换（无动画） |
| Tauri WebView (Chromium) | 支持 | — |

降级策略：`if (document.startViewTransition)` 检测后直接调用 `applyTheme()`，用户感知为瞬时切换，功能不受影响。

## 参考实现

CDS 项目中的完整实现：
- CSS: `cds/web/style.css` — 搜索 "View Transition"
- JS: `cds/web/app.js` — 搜索 `toggleTheme`

## 可调参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 动画时长 | `0.5s` | `@keyframes theme-ripple-in` 的 duration |
| 缓动函数 | `cubic-bezier(0.4, 0, 0.2, 1)` | Material Design 标准减速曲线 |
| 降级行为 | 瞬时切换 | `else { applyTheme(newTheme) }` |
