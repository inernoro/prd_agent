# Toast 通知系统实现

## 背景

用户反馈：需要点击"知道了"的模态对话框很烦人，希望使用自动消失的轻量级提示。

## 解决方案

实现了一个非阻塞的 Toast 通知系统，替代成功/失败场景下的模态对话框。

## 实现细节

### 1. Toast Store

**文件**：`prd-admin/src/lib/toast.tsx`

**功能**：
- 管理 Toast 队列
- 自动移除（基于 duration）
- 支持 4 种类型：success、error、info、warning

**API**：
```typescript
toast.success(title, message?, duration = 3000)
toast.error(title, message?, duration = 4000)
toast.info(title, message?, duration = 3000)
toast.warning(title, message?, duration = 3000)
```

**示例**：
```typescript
// 成功提示
toast.success('初始化成功', '删除 5 个旧应用，创建 13 个新应用');

// 错误提示
toast.error('初始化失败', '网络连接超时');

// 信息提示
toast.info('正在处理', '请稍候...');

// 警告提示
toast.warning('注意', '此操作不可撤销');
```

### 2. Toast 组件

**文件**：`prd-admin/src/components/ui/Toast.tsx`

**特性**：
- 固定在右上角（`fixed top-4 right-4`）
- 支持多个 Toast 同时显示（垂直堆叠）
- 平滑的进入/退出动画
- 可手动关闭（点击 X 按钮）
- 自动消失（基于 duration）
- 毛玻璃效果（`backdropFilter: blur(12px)`）

**视觉设计**：
| 类型 | 背景色 | 边框色 | 图标色 | 图标 |
|------|--------|--------|--------|------|
| success | `rgba(34, 197, 94, 0.1)` | `rgba(34, 197, 94, 0.3)` | `#22c55e` | CheckCircle2 |
| error | `rgba(239, 68, 68, 0.1)` | `rgba(239, 68, 68, 0.3)` | `#ef4444` | XCircle |
| info | `rgba(59, 130, 246, 0.1)` | `rgba(59, 130, 246, 0.3)` | `#3b82f6` | Info |
| warning | `rgba(251, 146, 60, 0.1)` | `rgba(251, 146, 60, 0.3)` | `#fb923c` | AlertTriangle |

**布局**：
```
┌─────────────────────────────────┐
│ [图标] 标题                  [X] │
│        消息内容（可选）          │
└─────────────────────────────────┘
```

**尺寸**：
- 最小宽度：320px
- 最大宽度：420px
- 圆角：16px
- 内边距：16px

### 3. Toast 容器

**文件**：`prd-admin/src/app/App.tsx`

**集成**：
```tsx
import { ToastContainer } from '@/components/ui/Toast';

export default function App() {
  return (
    <>
      <ToastContainer />
      <Routes>
        {/* ... */}
      </Routes>
    </>
  );
}
```

**层级**：`z-index: 9999`（确保在所有内容之上）

### 4. 使用场景更新

**文件**：`prd-admin/src/pages/ModelAppGroupPage.tsx`

**变更**：

**之前**（模态对话框）：
```typescript
systemDialog.success(
  '初始化成功',
  `删除 5 个旧应用，创建 13 个新应用`
);
// 用户必须点击"知道了"才能关闭
```

**之后**（Toast 提示）：
```typescript
toast.success(
  '初始化成功',
  '删除 5 个旧应用，创建 13 个新应用'
);
// 3 秒后自动消失，用户可以继续操作
```

## 使用规范

### 何时使用 Toast

✅ **适合使用 Toast 的场景**：
- 操作成功提示（如：保存成功、删除成功）
- 操作失败提示（如：网络错误、权限不足）
- 信息通知（如：正在处理、数据已更新）
- 轻量级警告（如：即将过期、建议操作）

❌ **不适合使用 Toast 的场景**：
- 需要用户确认的操作（如：删除确认、重要决策）
- 需要用户输入的场景（如：输入名称、填写表单）
- 复杂的错误信息（如：多步骤错误、需要详细说明）
- 重要的法律/安全提示（如：隐私政策、风险警告）

### Toast vs Dialog 对比

| 维度 | Toast | Dialog |
|------|-------|--------|
| **阻塞性** | 非阻塞，用户可继续操作 | 阻塞，必须关闭才能继续 |
| **消失方式** | 自动消失（3-4秒） | 手动关闭 |
| **适用场景** | 成功/失败提示、信息通知 | 确认操作、输入信息、复杂提示 |
| **用户体验** | 轻量、不打断 | 强制注意、需要响应 |
| **信息量** | 简短（标题+1-2行消息） | 可以很长（多段文字、表单） |

### 推荐的 Duration

| 类型 | 推荐时长 | 原因 |
|------|---------|------|
| success | 3000ms (3秒) | 用户只需快速确认成功 |
| error | 4000ms (4秒) | 用户需要多一点时间阅读错误信息 |
| info | 3000ms (3秒) | 信息性提示，快速阅读即可 |
| warning | 3000ms (3秒) | 警告信息，但不需要太长时间 |

**特殊情况**：
- 如果消息很长（超过 2 行），可以适当延长 duration
- 如果是非常重要的错误，考虑使用 Dialog 而非 Toast

## 动画效果

### 进入动画
```
opacity: 0 → 1
translateX: 32px → 0
duration: 300ms
```

### 退出动画
```
opacity: 1 → 0
translateX: 0 → 32px
duration: 300ms
```

### 时间轴
```
0ms                  2700ms              3000ms
│                    │                   │
├─────────────────────┼───────────────────┤
│   显示中            │  退出动画         │ 移除
│                    │                   │
└─────────────────────┴───────────────────┘
```

**说明**：
- Toast 在 2700ms 时开始退出动画（提前 300ms）
- 退出动画持续 300ms
- 3000ms 时从 DOM 中移除

## 多个 Toast 的处理

### 堆叠方式
```
┌─────────────────┐  ← 最新的 Toast（顶部）
│ Toast 3         │
└─────────────────┘
        ↓ gap: 8px
┌─────────────────┐
│ Toast 2         │
└─────────────────┘
        ↓ gap: 8px
┌─────────────────┐
│ Toast 1         │  ← 最早的 Toast（底部）
└─────────────────┘
```

### 最大数量
- 当前实现：无限制
- 建议：最多同时显示 3-5 个 Toast
- 超过时：自动移除最早的 Toast

**未来优化**：
```typescript
const MAX_TOASTS = 5;

addToast: (toast) => {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const newToast = { ...toast, id };
  
  set((state) => {
    const toasts = [...state.toasts, newToast];
    // 如果超过最大数量，移除最早的
    if (toasts.length > MAX_TOASTS) {
      return { toasts: toasts.slice(-MAX_TOASTS) };
    }
    return { toasts };
  });
  
  // ...
}
```

## 可访问性（Accessibility）

### 当前实现
- ✅ 可手动关闭（X 按钮）
- ✅ 自动消失（不会永久阻塞）
- ✅ 清晰的视觉反馈（颜色、图标）

### 未来改进
- [ ] 添加 `role="alert"` 或 `role="status"`
- [ ] 添加 `aria-live="polite"` 或 `aria-live="assertive"`
- [ ] 支持键盘操作（Escape 关闭）
- [ ] 支持屏幕阅读器

**示例**：
```tsx
<div
  role="alert"
  aria-live="polite"
  aria-atomic="true"
  className="..."
>
  {/* Toast 内容 */}
</div>
```

## 测试建议

### 功能测试
- [ ] 单个 Toast 显示和自动消失
- [ ] 多个 Toast 同时显示（堆叠）
- [ ] 手动关闭 Toast（点击 X）
- [ ] 不同类型的 Toast（success、error、info、warning）
- [ ] 长消息的 Toast（换行显示）

### 边界测试
- [ ] 快速连续触发多个 Toast
- [ ] Toast 显示期间刷新页面
- [ ] 窄屏幕下的 Toast 显示（响应式）

### 性能测试
- [ ] 大量 Toast（100+）的性能
- [ ] Toast 动画的流畅度

## 编译状态

✅ **前端编译成功**

## 总结

### 改进前
- ❌ 模态对话框阻塞用户操作
- ❌ 必须手动点击"知道了"关闭
- ❌ 打断用户工作流

### 改进后
- ✅ Toast 非阻塞，用户可继续操作
- ✅ 自动消失，无需手动关闭
- ✅ 轻量级，不打断工作流
- ✅ 支持多个 Toast 同时显示
- ✅ 平滑的动画效果
- ✅ 可手动关闭（如果需要）

### 用户体验提升
- 减少了不必要的点击
- 提高了操作流畅度
- 降低了用户的烦躁感
- 保持了必要的反馈（用户仍然知道操作结果）

现在用户在初始化应用后，会看到一个自动消失的 Toast 提示，而不是需要点击"知道了"的模态对话框！
