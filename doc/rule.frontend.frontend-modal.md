# 前端浮层布局 · 规则

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 适用范围

Modal、Dialog、Drawer、Popover、菜单、Tooltip、全屏 Loading 和 Toast 均适用。模块级强制规则以 `.claude/rules/frontend-modal.md` 为执行事实源，本文提供跨模块可读版。

## 三条硬约束

### 1. 视觉边界使用 inline style

决定浮层边界的 `height`、`maxHeight`、`width`、`maxWidth`、`top` 和 `bottom` 使用 React inline style，不依赖 Tailwind arbitrary value。颜色、间距和一般布局仍使用主题 token 与公共类。

### 2. 逃离可能裁剪的父容器

全屏浮层和需要越过局部 stacking context 的弹层使用 `createPortal(..., document.body)`。只有明确受某个局部容器约束的轻量弹层可以留在原 DOM 层级。

### 3. Flex 滚动链完整

浮层外壳使用纵向 flex 且隐藏外溢；中间内容层必须 `min-height: 0` 并承担 `overflow-y: auto`。Header 和 footer 固定，滚动只发生在最近内容层。

## 补充要求

- 蒙版、弹层和局部 popover 使用项目 z-index 约定，不通过不断增加任意值解决层级冲突。
- Dialog 打开后管理初始焦点、Tab 循环、Escape 和关闭后的焦点归还。
- 移动端考虑 safe area、虚拟键盘和可见视口，不使用固定 `100vh` 假设。
- 关闭、取消和危险确认在窄屏下仍可见，不得被滚动内容挤出屏幕。
- 双主题使用语义 token，不在浮层内硬编码整套深色皮肤。

## 允许例外

- 原生浏览器 tooltip 或与目标元素同容器裁剪的轻量提示。
- 画布内必须跟随缩放和平移的局部菜单，但其边界和关闭行为仍需测试。
- 第三方组件内部 DOM 无法 portal 时，必须在适配层说明裁剪和焦点策略。

## 验收

1. 内容增加到两倍时仍能滚动到最后一个操作。
2. 在窄屏、低高度和虚拟键盘打开时主操作可见。
3. 父容器存在 `overflow:hidden`、transform 或高 z-index 时浮层仍正确显示。
4. 键盘可以打开、操作和关闭，焦点不会落到蒙版后页面。
5. 浅色和暗色均无背景、边框或文字泄漏。
