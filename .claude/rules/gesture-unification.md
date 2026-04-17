# 画布手势统一原则（Gesture Unification）

> 所有可平移/缩放的 2D 画布（视觉创作、涌现探索器、工作流画布、图像编辑、任何未来的 2D 编辑器）必须遵守同一套手势约定。禁止每个模块各搞各的。

---

## 一、统一手势语义（Apple 触控板优先）

| 手势 | 行为 | 实现要点 |
|------|------|---------|
| **两指拖动**（trackpad two-finger drag） | **平移**画布 | 吞掉原生 wheel 事件，用 `deltaX/deltaY` 直接调整 camera |
| **双指捏合**（pinch） | **缩放**画布 | macOS Chrome/Edge 上 pinch = `wheel` 事件 + `ctrlKey = true`（浏览器合成行为，非真实按键） |
| **⌘ / Ctrl + 滚轮** | **缩放**画布 | 用 `ctrlKey \|\| metaKey` 统一判定 |
| **单指点击空白 + 拖动** | **平移**画布（hand tool 行为） | pointer events + `setPointerCapture` |
| **Space + 拖动** | 临时进入 hand tool 平移 | 键盘按下切状态 |
| **单指点击节点/元素** | 选中 / 激活 | 正常 click 事件 |
| **双击空白** | 不触发缩放 | 显式禁用 `zoomOnDoubleClick`，避免"不小心双击就放大" |

**禁止**：把两指拖动映射为"滚动页面"或"缩放"，也禁止用单指拖动画布元素的同时不支持平移。

---

## 二、参考实现（两套标准）

### 标准 A：自定义 DOM 画布

**参考**：`prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx`（视觉创作）

```ts
el.addEventListener('wheel', (ev) => {
  if (ev.ctrlKey || ev.metaKey) {
    // pinch / ⌘+滚轮 = 缩放
    ev.preventDefault();
    zoomAt(ev.clientX, ev.clientY, clampZoom(zoomRef.current * zoomFactorFromDeltaY(ev.deltaY)));
    return;
  }
  // 两指拖动 = 平移
  ev.preventDefault();
  const cam = cameraRef.current;
  setViewport(zoomRef.current, { x: cam.x - ev.deltaX, y: cam.y - ev.deltaY });
}, { passive: false });
```

关键点：
- `{ passive: false }` 让 `preventDefault()` 生效，阻止默认浏览器滚动
- 缩放曲线：`exp(-deltaY * 0.003)`（macOS trackpad 柔和的缩放感）
- 高频交互走 ref + 直接 DOM transform，不 setState（否则"不跟手"）

### 标准 B：ReactFlow 画布

**参考**：`prd-admin/src/pages/emergence/EmergenceCanvas.tsx`（涌现探索器）

```tsx
<ReactFlow
  panOnScroll                                 // 两指拖动 / 滚轮 = 平移
  panOnScrollSpeed={0.8}
  panOnDrag                                   // 单指拖动空白 = 平移
  zoomOnScroll={false}                        // 禁止无修饰键滚轮缩放
  zoomOnPinch                                 // 双指捏合 = 缩放
  zoomOnDoubleClick={false}                   // 禁止双击缩放
  zoomActivationKeyCode={['Meta', 'Control']} // ⌘/Ctrl+滚轮 = 缩放
  panActivationKeyCode="Space"                // Space + 拖动 = 平移
  selectionOnDrag={false}                     // 单指拖动不走框选
/>
```

---

## 三、强制规则（新画布必须过这个 checklist）

新增任何 2D 画布时，逐条核对：

- [ ] 两指拖动可以平移画布（不应触发页面滚动）
- [ ] 双指捏合可以缩放画布
- [ ] ⌘ / Ctrl + 滚轮可以缩放画布
- [ ] 双击空白**不**触发缩放
- [ ] 单指点击空白 + 拖动可以平移（hand tool 等价）
- [ ] Space + 拖动临时进入平移
- [ ] 有 mini-map / 缩放控件时，按钮 zoom-in/zoom-out 与手势一致（不要一个用乘法一个用加法）
- [ ] 缩放范围 `[0.05, 3]` 与其他画布一致，缩放动画曲线走同一个函数
- [ ] 代码注释引用 `.claude/rules/gesture-unification.md`，方便后来人对齐

---

## 四、为什么必须统一

1. **用户是同一个人**：用户在视觉创作学会了两指拖动 = 平移，进到涌现探索器时默认尝试同样手势。如果涌现里变成缩放或滚动页面，体验立刻割裂。
2. **Apple 用户占比高**：团队和客户大量使用 MacBook 触控板。trackpad 的两指拖动是肌肉记忆级别的交互，默认就应该是平移画布。
3. **减少文档负担**：一套手势文档覆盖所有画布，不用在每个页面再教用户一遍怎么操作。

---

## 五、反面案例

| 错误做法 | 问题 |
|---------|------|
| ReactFlow 默认配置（单指拖动节点 + 滚轮缩放） | 两指拖动变成滚动页面，用户以为画布"卡住不动" |
| 自定义画布：两指拖动映射为滚动容器 | 画布只能通过按钮平移，苹果用户骂街 |
| 不同画布有不同的缩放范围/曲线 | 用户在 A 画布缩到头，到 B 画布发现还能继续缩，产生困惑 |
| 双击空白触发缩放 | 用户想取消选中却意外放大 |
| 只支持滚轮缩放，不支持 ⌘ + 滚轮 | Windows 用户习惯 ⌘ 映射到 Ctrl，需要双支持 |

---

## 六、与其他原则的关系

- `frontend-architecture.md`：SSOT + 组件复用 —— 手势逻辑也是一种 SSOT，应提取到共享 hook（如未来的 `useCanvasGesture`）
- `zero-friction-input.md`：用户不应为了"学怎么用画布"发呆——统一手势意味着学一次用一辈子
- `guided-exploration.md`：陌生页面 3 秒内知道做什么 —— 统一手势让用户不需要在每个新画布重新试错

---

## 七、未来扩展

当团队新建 3+ 画布后，考虑抽取：

- `hooks/useCanvasGesture.ts`：把 wheel/pointer/key 监听封装为 React hook
- `components/canvas/CanvasControls.tsx`：统一的缩放控件/mini-map 样式
- 任何新画布直接引用这两个组件，不再重复造轮子

在抽取前，新画布必须引用本规则并复制标准 A 或标准 B 的配置。
