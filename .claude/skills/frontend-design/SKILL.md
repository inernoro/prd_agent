---
name: frontend-design
description: 前端设计实现技能。根据设计稿截图、文字描述或参考图，生成符合项目规范的前端页面/组件代码。自动适配液态玻璃主题、Radix UI 组件库、Tailwind CSS 样式体系。触发词："前端设计"、"页面设计"、"设计稿实现"、"写个页面"、"UI 实现"。
---

# Frontend Design - 前端设计实现

根据设计稿截图、文字描述或参考图片，生成符合项目技术栈和设计规范的前端页面/组件代码。

## 触发词

- "前端设计"
- "页面设计"
- "设计稿实现"
- "写个页面"
- "UI 实现"
- "照着这个做"
- "实现这个界面"

## 核心理念

1. **设计还原度优先**：忠实还原设计稿的视觉效果，不擅自"改进"设计
2. **组件化思维**：优先复用已有的 Design 组件（GlassCard、Button、Badge 等），避免重复造轮子
3. **主题一致性**：所有颜色必须通过 CSS 变量或设计组件 props 引用，禁止硬编码色值
4. **响应式设计**：使用 Tailwind 的响应式前缀适配不同屏幕尺寸
5. **最小实现**：只写满足设计要求的代码，不添加多余的功能或抽象

## 项目技术栈

### prd-admin（管理后台）

| 技术 | 版本 | 说明 |
|------|------|------|
| React | 18.3 | 函数式组件 + Hooks |
| TypeScript | 5.6 | 严格模式 |
| Vite | 6.0 | 构建工具 |
| Tailwind CSS | 4.1 | 样式（v4，无需 tailwind.config） |
| Zustand | 5.0 | 状态管理 |
| Radix UI | v1-2 | 无头 UI 组件（Dialog、Select、Tabs 等） |
| Lucide React | 0.468 | 图标库 |
| ECharts | 6.0 | 图表 |
| Lexical | 0.39 | 富文本编辑器 |
| Three.js | 0.175 | 3D 渲染（如需要） |

### prd-desktop（桌面客户端）

| 技术 | 版本 | 说明 |
|------|------|------|
| React | 18.3 | 函数式组件 + Hooks |
| TypeScript | 5.6 | 严格模式 |
| Tauri | 2.0 | 桌面运行时 |
| Tailwind CSS | 3.4 | 样式（v3，有 tailwind.config.js） |
| Zustand | 5.0 | 状态管理 |
| Radix UI | v1-2 | 无头 UI 组件 |
| Mermaid | 11.12 | 图表渲染 |

> **注意**：两个项目的 Tailwind 版本不同！prd-admin 用 v4，prd-desktop 用 v3。

## 设计系统参考

### 核心 CSS 变量（prd-admin）

在 `prd-admin/src/styles/tokens.css` 中定义：

```css
/* 背景 */
--bg-base: #0b0b0d;
--bg-elevated: #121216;
--bg-card: rgba(255, 255, 255, 0.03);
--bg-input: rgba(255, 255, 255, 0.04);

/* 玻璃效果 */
--glass-bg-start: rgba(255, 255, 255, 0.08);
--glass-bg-end: rgba(255, 255, 255, 0.03);
--glass-border: rgba(255, 255, 255, 0.14);

/* 边框 */
--border-faint: rgba(255, 255, 255, 0.05);
--border-subtle: rgba(255, 255, 255, 0.08);
--border-default: rgba(255, 255, 255, 0.12);
--border-hover: rgba(255, 255, 255, 0.18);
--border-focus: rgba(214, 178, 106, 0.55);  /* 金色聚焦 */

/* 文字 */
--text-primary: #f7f7fb;
--text-secondary: rgba(247, 247, 251, 0.72);
--text-muted: rgba(247, 247, 251, 0.48);

/* 强调色 */
--accent-green: #7cfc00;
--accent-gold: #d6b26a;
--accent-gold-2: #f2d59b;
--gold-gradient: linear-gradient(135deg, #f4e2b8 0%, #d6b26a 45%, #f2d59b 100%);

/* 圆角 */
--radius-sm: 8px;
--radius-md: 12px;
--radius-lg: 14px;
--radius-xl: 16px;

/* 阴影 */
--shadow-card: 0 8px 32px -4px rgba(0, 0, 0, 0.4);
--shadow-card-hover: 0 12px 48px -4px rgba(0, 0, 0, 0.5);
--shadow-gold: 0 0 20px rgba(214, 178, 106, 0.15);
```

### 核心 CSS 变量（prd-desktop）

在 `prd-desktop/src/styles/globals.css` 中定义，支持明暗主题：

```css
/* 亮色模式（:root） */
--color-primary: #0ea5e9;
--color-surface: #ffffff;
--color-background: #f8fafc;
--color-text: #1e293b;
--glass-bg: rgba(255, 255, 255, 0.72);
--glass-ring: rgba(15, 23, 42, 0.08);

/* 暗色模式（.dark） */
--color-surface: #1e293b;
--color-background: #0f172a;
--glass-bg: rgba(15, 23, 42, 0.55);
```

### 可用设计组件（prd-admin）

| 组件 | 导入路径 | 用途 |
|------|----------|------|
| `GlassCard` | `@/components/design` | 液态玻璃卡片，支持 variant（default/gold/frost/subtle）、accentHue、glow |
| `Card` | `@/components/design` | 磨砂玻璃卡片，支持 gold variant |
| `Button` | `@/components/design` | 按钮，variant: primary(金色)/secondary(半透明)/ghost/danger；size: xs/sm/md |
| `Badge` | `@/components/design` | 徽章：subtle/discount/new/featured/success/danger/warning |
| `KpiCard` | `@/components/design` | 数据指标卡片，accent: green/gold/blue/purple，含趋势指示 |
| `GlassSwitch` | `@/components/design` | 动画切换组，滑动指示器，支持自定义 accentHue |
| `TabBar` | `@/components/design` | 标签导航，平滑滑动指示器，支持 title 模式 |
| `PageHeader` | `@/components/design` | 页面标题容器，支持 tabs 和 actions |
| `Select` | `@/components/design` | 基于 Radix 的选择器 |
| `SearchableSelect` | `@/components/design` | 可搜索下拉选择 |
| `Switch` | `@/components/design` | 开关组件 |

### 可用 UI 组件（prd-admin）

| 组件 | 导入路径 | 用途 |
|------|----------|------|
| `Dialog` | `@/components/ui` | 对话框（基于 Radix） |
| `ConfirmTip` | `@/components/ui` | 确认提示 |
| `Tabs` | `@/components/ui` | 标签页 |
| `Tooltip` | `@/components/ui` | 工具提示 |
| `Toast` | `@/components/ui` | 提示消息 |
| `PrdLoader` | `@/components/ui` | 加载动画 |
| `ImagePreviewDialog` | `@/components/ui` | 图片预览 |

### 可用工具函数

```typescript
// 类名合并（clsx + tailwind-merge）
import { cn } from '@/lib/cn'

// 主题
import { useThemeStore } from '@/stores/themeStore'
import { getCSSVar } from '@/lib/themeComputed'

// 图标（按需导入）
import { LayoutDashboard, Settings, ChevronDown, Plus } from 'lucide-react'
```

## 执行流程

### Step 1: 确定目标项目

判断设计稿是要实现在哪个项目中：

| 线索 | 目标项目 |
|------|----------|
| 深色/液态玻璃风格、管理后台功能 | **prd-admin** |
| 明暗主题、桌面客户端、对话界面 | **prd-desktop** |
| 用户未指定 | 询问用户 |

### Step 2: 分析设计稿

从截图或描述中提取以下信息：

1. **布局结构**：整体页面布局（几栏、间距、对齐方式）
2. **组件识别**：识别已有组件可以直接复用的部分（卡片、按钮、徽章等）
3. **颜色方案**：使用的颜色是否在设计系统中已定义
4. **交互行为**：悬停效果、点击反馈、过渡动画
5. **数据结构**：页面需要什么数据，API 端点是否已存在

### Step 3: 规划组件结构

```
PageName/
├── PageName.tsx          # 页面主组件（如果是页面级）
├── components/           # 页面私有子组件（仅当复杂度需要时）
│   ├── SomeSection.tsx
│   └── SomeDialog.tsx
└── (或直接是单文件组件)
```

**命名约定**：
- 页面组件：`PascalCase` + `Page` 后缀 → `DataManagePage.tsx`
- 子组件：`PascalCase.tsx`
- 工具函数：`camelCase.ts`
- Store：`camelCase.ts` 在 `/stores/` 目录

### Step 4: 编写代码

#### 页面组件模板（prd-admin）

```tsx
import { useState, useEffect } from 'react'
import { GlassCard, Button, TabBar, PageHeader, KpiCard } from '@/components/design'
import { Plus, Settings } from 'lucide-react'
import { someService } from '@/services'

export default function ExamplePage() {
  // 1. Store hooks
  // const store = useSomeStore()

  // 2. Local state
  const [data, setData] = useState<SomeType[]>([])
  const [loading, setLoading] = useState(true)

  // 3. Data fetching
  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const res = await someService.list()
      setData(res.data?.items ?? [])
    } finally {
      setLoading(false)
    }
  }

  // 4. Render
  return (
    <div className="space-y-6">
      <PageHeader title="页面标题">
        <Button variant="primary" size="sm" onClick={() => {}}>
          <Plus className="w-4 h-4 mr-1" />
          新建
        </Button>
      </PageHeader>

      {/* KPI 区域 */}
      <div className="grid grid-cols-3 gap-4">
        <KpiCard title="指标A" value={123} accent="gold" />
        <KpiCard title="指标B" value={456} accent="green" />
        <KpiCard title="指标C" value={789} accent="blue" />
      </div>

      {/* 内容卡片 */}
      <GlassCard>
        <div className="p-6">
          {/* 内容 */}
        </div>
      </GlassCard>
    </div>
  )
}
```

#### 设计组件模板（prd-admin）

```tsx
import { cn } from '@/lib/cn'

export interface MyComponentProps {
  className?: string
  style?: React.CSSProperties
  variant?: 'default' | 'gold'
  children?: React.ReactNode
}

export function MyComponent({
  className,
  variant = 'default',
  children,
  ...props
}: MyComponentProps) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-md)] p-4 transition-all duration-200',
        variant === 'gold' && 'border-[var(--accent-gold)]',
        className
      )}
      style={{
        background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
        border: '1px solid var(--glass-border)',
        backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
      }}
      {...props}
    >
      {children}
    </div>
  )
}
```

#### 桌面端组件模板（prd-desktop）

```tsx
import { memo } from 'react'

interface Props {
  className?: string
}

const MyDesktopComponent = memo(({ className }: Props) => {
  return (
    <div className={`ui-glass-panel p-4 ${className ?? ''}`}>
      <h3 className="text-[var(--color-text)] font-medium">标题</h3>
      <p className="text-[var(--color-text-secondary)] text-sm mt-1">描述</p>
    </div>
  )
})

MyDesktopComponent.displayName = 'MyDesktopComponent'
export default MyDesktopComponent
```

### Step 5: 样式实现规则

#### 必须遵守

1. **颜色引用**：所有颜色使用 CSS 变量，禁止硬编码
   ```tsx
   // ✅ 正确
   className="text-[var(--text-primary)]"
   style={{ color: 'var(--accent-gold)' }}

   // ❌ 错误
   className="text-white"       // 硬编码
   style={{ color: '#d6b26a' }} // 硬编码
   ```

2. **玻璃效果**：优先使用 GlassCard 组件，自定义时需包含完整的 backdrop-filter
   ```tsx
   // ✅ 使用组件
   <GlassCard variant="subtle">内容</GlassCard>

   // ✅ 自定义玻璃效果（需完整声明）
   style={{
     background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
     border: '1px solid var(--glass-border)',
     backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
     WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
     transform: 'translateZ(0)',       // GPU 加速
     isolation: 'isolate',             // 防止渲染问题
   }}
   ```

3. **禁止 `color-mix()`**：Tauri WebView 不支持
   ```tsx
   // ❌ 禁止
   background: color-mix(in srgb, white 10%, transparent)

   // ✅ 替代
   background: rgba(255, 255, 255, 0.1)
   ```

4. **圆角统一**：使用 CSS 变量
   ```tsx
   className="rounded-[var(--radius-md)]"  // 12px
   className="rounded-[var(--radius-lg)]"  // 14px
   ```

5. **间距系统**：使用 Tailwind 标准间距
   ```tsx
   className="p-4 gap-4"     // 16px
   className="p-6 gap-6"     // 24px
   className="space-y-6"     // 垂直间距 24px
   ```

6. **阴影层次**：使用多层阴影实现深度
   ```tsx
   style={{
     boxShadow: `
       0 8px 32px -4px rgba(0, 0, 0, 0.4),
       0 0 0 1px rgba(255, 255, 255, 0.1) inset,
       0 1px 0 0 rgba(255, 255, 255, 0.15) inset,
       0 -1px 0 0 rgba(0, 0, 0, 0.1) inset
     `,
   }}
   ```

#### 响应式设计

```tsx
// 使用 Tailwind 断点
className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"

// 弹性布局
className="flex flex-col sm:flex-row items-start sm:items-center gap-4"
```

#### 交互状态

```tsx
// 悬停效果
className="hover:scale-[1.01] active:scale-[0.99] transition-transform duration-200"

// 禁用状态
className="disabled:opacity-50 disabled:cursor-not-allowed"

// 聚焦环
className="focus:outline-none focus:ring-2 focus:ring-[var(--border-focus)]"
```

#### 动画

```tsx
// 过渡
className="transition-all duration-200"
className="transition-colors duration-200"

// 尊重减少动画偏好（重要动画需要）
// globals.css 中已定义 @media (prefers-reduced-motion: reduce)
```

## 文件放置规则

### prd-admin

```
prd-admin/src/
├── pages/
│   └── NewFeaturePage.tsx          # 新页面（作为路由目标）
├── components/
│   ├── design/
│   │   └── NewDesignComp.tsx       # 可复用的设计组件
│   └── ui/
│       └── NewUiWidget.tsx         # 通用 UI 组件
├── stores/
│   └── newFeatureStore.ts          # 新功能的状态管理
├── services/
│   └── newFeatureService.ts        # API 调用
└── types/
    └── newFeature.ts               # 类型定义
```

### prd-desktop

```
prd-desktop/src/
├── components/
│   └── NewFeature/
│       ├── NewFeaturePage.tsx       # 页面组件
│       └── SubComponent.tsx         # 子组件
├── stores/
│   └── newFeatureStore.ts
└── types/
    └── index.ts                     # 集中定义（已有文件，追加即可）
```

## 特殊场景处理

### 图表页面

```tsx
import ReactECharts from 'echarts-for-react'

// ECharts 配置需要适配深色主题
const option = {
  backgroundColor: 'transparent',
  textStyle: { color: 'var(--text-secondary)' },
  // ...
}
```

### 对话框/弹窗

```tsx
import * as DialogPrimitive from '@radix-ui/react-dialog'

// 或使用已封装的 Dialog 组件
import { Dialog } from '@/components/ui'
```

### 表格

```tsx
// 管理后台使用自定义表格样式
<table className="w-full">
  <thead>
    <tr className="border-b border-[var(--border-subtle)]">
      <th className="text-left text-[var(--text-muted)] text-xs font-medium px-4 py-3">
        列名
      </th>
    </tr>
  </thead>
  <tbody>
    <tr className="border-b border-[var(--border-faint)] hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-3 text-[var(--text-primary)] text-sm">数据</td>
    </tr>
  </tbody>
</table>
```

### 表单

```tsx
// 输入框
<input
  className="w-full h-[36px] px-3 rounded-[var(--radius-sm)]
    bg-[var(--bg-input)] border border-[var(--border-default)]
    text-[var(--text-primary)] text-sm placeholder:text-[var(--text-muted)]
    focus:outline-none focus:border-[var(--border-focus)]
    transition-colors duration-200"
  placeholder="请输入..."
/>

// Textarea
<textarea
  className="w-full min-h-[100px] px-3 py-2 rounded-[var(--radius-sm)]
    bg-[var(--bg-input)] border border-[var(--border-default)]
    text-[var(--text-primary)] text-sm placeholder:text-[var(--text-muted)]
    focus:outline-none focus:border-[var(--border-focus)]
    resize-y transition-colors duration-200"
  placeholder="请输入..."
/>
```

## 检查清单

实现完成后，自查以下要点：

- [ ] 颜色全部使用 CSS 变量，无硬编码色值
- [ ] 使用了已有的设计组件（GlassCard、Button 等），而非自己重写
- [ ] 玻璃效果包含 `-webkit-backdrop-filter`（Webkit 兼容）
- [ ] 没有使用 `color-mix()`
- [ ] 包含 `transform: translateZ(0)` 和 `isolation: isolate`（如有自定义玻璃效果）
- [ ] 响应式适配（至少桌面宽度正常）
- [ ] 交互状态齐全（hover、active、disabled、focus）
- [ ] 文件放置在正确的目录
- [ ] 组件命名遵循 PascalCase
- [ ] 导入路径使用 `@/` 别名

## 注意事项

1. **先读后写**：实现前先阅读相关的已有页面/组件代码，理解当前的模式和风格
2. **不过度封装**：如果一个组件只在一个地方使用，直接写在页面中即可，不需要抽成独立组件
3. **数据与 UI 分离**：参照项目架构原则，数据映射（displayName 等）由后端提供，前端只做展示
4. **性能考虑**：大列表使用 `memo()`，Store 使用选择性订阅 `store((s) => s.field)`
5. **两个项目差异**：prd-admin 是深色液态玻璃风格，prd-desktop 支持明暗主题切换，样式写法不同
