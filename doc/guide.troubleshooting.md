# 疑难杂症排查手册

> **版本**：v1.0 | **日期**：2026-03-11 | **状态**：已落地
>
> **目标读者**：前端/全栈开发者、AI 辅助开发

## 适用场景

- 遇到「看起来调用了但没反应」的诡异问题
- 框架层面的调度/渲染异常，非业务逻辑 bug
- 需要快速定位"断在哪一层"的排查思路

---

## 案例索引

| # | 关键词 | 一句话 | 影响范围 |
|---|--------|--------|----------|
| 1 | ReactFlow + React Router | ReactFlow 阻塞 React Router 导航 | 所有包含 ReactFlow 的页面离开导航 |

---

## 案例 1：ReactFlow 页面 navigate() 调用成功但路由不切换

### 症状

- 点击返回按钮后，浏览器地址栏 URL 已变化
- 页面 UI 不动，仍然停留在画布页
- 无报错、无警告

### 根因

ReactFlow（@xyflow/react）内部有 **53+ 个 zustand `useSyncExternalStore` 订阅**。在 React 18 并发模式下，大量同步 store 更新会占满 React 调度器的微任务队列，导致 React Router 的 `useLocation()` 订阅被跳过——`history.pushState` 在浏览器层面生效了，但 React 树没有 re-render。

### 排查过程

用分层日志逐层确认"断在哪里"：

| 层级 | 埋点位置 | 预期日志 | 实际结果 |
|------|----------|----------|----------|
| 1. 事件触发 | `onClick` 回调 | `navigate() called` | 正常触发 |
| 2. History API | `history.pushState` 拦截 | `pushState called: /new-path` | 正常调用 |
| 3. URL 变化 | `setTimeout` 检查 `window.location.href` | URL 已变为新路径 | 确认变化 |
| 4. React Router | `useLocation()` + `useEffect` 日志 | `location changed: /new-path` | **未触发** |

**结论**：第 1-3 层全部正常，第 4 层断了 —— React Router 的内部状态没有传播到组件树。

### 排查方法论（可复用）

当怀疑"调用了但没反应"时，按以下分层打日志：

```
用户操作 → 事件回调 → 框架 API → 浏览器 API → DOM/URL 变化 → 框架状态更新 → UI 渲染
```

哪一层日志断了，问题就在那一层和上一层之间。

### 解决方案

**核心思路**：在导航前先卸载 ReactFlow，释放 zustand 订阅，让 React 调度器恢复正常。

**实现**：在路由包装页（如 `WorkflowCanvasPage`）中：

1. 点击返回时，设 `unmounting = true`，渲染 loading 替代 ReactFlow（触发卸载）
2. `useEffect` 监听 `unmounting`，在下一个 `requestAnimationFrame` 执行 `navigate()`
3. 此时 ReactFlow 的 53+ 个订阅已清除，`navigate()` 能正常触发 React Router re-render

**关键代码模式**：

```typescript
const [unmounting, setUnmounting] = useState(false);
const pendingNav = useRef<string | null>(null);

const safeNavigate = useCallback((path: string) => {
  pendingNav.current = path;
  setUnmounting(true);  // 先卸载重组件
}, []);

useEffect(() => {
  if (!unmounting || !pendingNav.current) return;
  const target = pendingNav.current;
  const raf = requestAnimationFrame(() => {
    navigate(target);  // ReactFlow 已卸载，调度器空闲
  });
  return () => cancelAnimationFrame(raf);
}, [unmounting, navigate]);

// 渲染时：unmounting 为 true 则不渲染 ReactFlow
if (unmounting) return <Loading text="返回中..." />;
return <WorkflowCanvas onBack={() => safeNavigate('/target')} />;
```

### 适用范围

此方案适用于所有"重订阅组件 + React Router 导航"的场景：

| 库 | 订阅数量级 | 是否可能触发 |
|----|-----------|-------------|
| ReactFlow / @xyflow/react | 53+ zustand stores | 高风险 |
| 大型 Redux 应用 | 取决于 `useSelector` 数量 | 中风险 |
| 多个 zustand store 组合 | 取决于 store 数量 | 低风险（通常 < 10） |

### 教训

1. **`navigate()` 成功 ≠ 路由切换成功** —— `history.pushState` 是浏览器 API，React Router 的响应依赖 React 调度器
2. **重订阅库是隐性风险** —— ReactFlow 看起来只是画布组件，实际上深度介入了 React 调度
3. **分层日志是最高效的排查手段** —— 不要猜，从底层到顶层逐层确认

---

## 新增案例模板

```markdown
## 案例 N：{一句话标题}

### 症状
{用户视角的表现}

### 根因
{技术层面的解释}

### 排查过程
{分层日志或关键排查步骤}

### 解决方案
{修复方案 + 关键代码模式}

### 适用范围
{哪些类似场景也会遇到}

### 教训
{可迁移的经验}
```

---

## 相关文档

- `design.workflow-engine.md` — 工作流引擎设计
- CLAUDE.md「Codebase Skill」节 — ReactFlow 相关说明
