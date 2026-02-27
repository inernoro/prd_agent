---
name: fix-surface-styles
description: 扫描并修复 CSS 样式偏差，统一到 Surface System。当发现页面样式不一致（灰蒙蒙、不透明、hover 不统一）时一句话修复。触发词："修复样式"、"统一样式"、"fix styles"、"surface check"、"/fix-surface"。
---

# Fix Surface Styles — CSS 样式统一修复

自动扫描 `prd-admin/src` 下所有 `.tsx` 文件，检测不符合 Surface System 规范的样式反模式，并批量修复。

## 核心概念

项目使用 **Surface System**（定义在 `prd-admin/src/styles/globals.css`）作为卡片/面板样式的 Single Source of Truth：

| CSS 类名 | 用途 | 适用场景 |
|----------|------|---------|
| `.surface` | 主级卡片容器 | 页面最外层卡片，需要 backdrop-filter blur |
| `.surface-raised` | 突出展示卡片 | KPI 卡片、Hero 区域，更深阴影 |
| `.surface-inset` | 嵌套内面板 | card 内的二级分区、设置区块 |
| `.surface-row` | 列表/表格行 | 可 hover 高亮的行元素 |
| `.surface-interactive` | 可点击卡片 | hover 上浮 + 光晕效果 |

## 触发条件

- 用户说 "修复样式"、"统一样式"、"fix styles"、"surface check"
- 用户反馈页面"灰蒙蒙"、"不透明"、"hover 不统一"
- 新增页面后需要检查样式一致性
- 可指定单个文件、目录或全局扫描

## 反模式检测规则

### Rule 1: 内联 hover 背景（→ surface-row）

**检测**: `hover:bg-white/[0.0X]` 用于行/列表元素

```tsx
// 反模式
className="... hover:bg-white/[0.03] transition-colors ..."

// 修复为
className="surface-row ..."
// 移除 hover:bg-white/[0.0X] 和 transition-colors（surface-row 已包含 transition）
```

**排除条件**:
- Landing page 装饰性元素（`pages/home/sections/` 下的 bento grid、hero 等）
- 按钮的 hover 效果（`<button>` 元素上的小范围 hover）
- 已使用 surface-* 类的元素

### Rule 2: JavaScript hover 处理器（→ surface-row）

**检测**: `onMouseEnter` + `onMouseLeave` 用于改变背景色

```tsx
// 反模式
onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
onMouseLeave={(e) => e.currentTarget.style.background = ''}

// 修复为
className="surface-row ..."
// 删除 onMouseEnter 和 onMouseLeave 属性
```

**排除条件**:
- hover 处理器用于非背景效果（如 tooltip 显示、文字装饰变化）

### Rule 3: 硬编码 rgba 卡片背景（→ surface-inset）

**检测**: 内联 `background: 'rgba(255,255,255,0.0X)'` 用于容器级元素

```tsx
// 反模式
style={{
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: 16,
}}

// 修复为
className="surface-inset"
style={{ borderRadius: 12, padding: 16 }}
// 移除 background 和 border（surface-inset 已包含）
```

**排除条件**:
- 小型 UI 元素（badge、tag、dot、小按钮）
- 语义色背景（success/error/warning 状态色）

### Rule 4: var(--bg-elevated) 卡片背景（→ surface-inset）

**检测**: `background: var(--bg-elevated)` 用于面板级容器

```tsx
// 反模式
style={{ background: 'var(--bg-elevated)', borderRadius: 12, padding: 16 }}

// 修复为
className="surface-inset"
style={{ borderRadius: 12, padding: 16 }}
```

**排除条件**:
- 页面级背景（`min-height: 100vh` 的根容器）
- Sidebar/Navbar 背景

### Rule 5: 内联卡片三件套（→ surface-inset / surface）

**检测**: 同时包含 `background` + `borderRadius` + `border` + `padding` 的内联 style 对象，看起来像卡片容器

```tsx
// 反模式
style={{
  background: 'var(--bg-card)',
  borderRadius: 16,
  border: '1px solid var(--border-subtle)',
  padding: 20,
  boxShadow: '...',
}}

// 修复为
className="surface-inset rounded-[16px] p-5"
// 或 className="surface rounded-[16px] p-5" 如果需要 blur
```

## 执行流程

### Step 1: 确定扫描范围

```bash
# 用户指定了文件/目录？用指定的
# 否则全局扫描
grep -rn "hover:bg-white/\[0\.0" prd-admin/src/pages/ prd-admin/src/components/ --include="*.tsx"
grep -rn "onMouseEnter.*background" prd-admin/src/pages/ prd-admin/src/components/ --include="*.tsx"
grep -rn "bg-elevated" prd-admin/src/pages/ prd-admin/src/components/ --include="*.tsx"
```

### Step 2: 分类问题

将检测到的问题按反模式规则分类：
1. **Rule 1 命中** → 替换为 `surface-row`
2. **Rule 2 命中** → 删除 handler，添加 `surface-row`
3. **Rule 3/4/5 命中** → 替换为 `surface-inset` 或 `surface`

### Step 3: 批量修复

使用 Edit 工具逐文件修复，每个文件：
1. 读取文件，理解上下文
2. 应用修复（添加 surface class，移除冗余内联样式）
3. 验证修复不破坏语义色或特殊元素

### Step 4: 输出报告

```markdown
# Surface System 样式统一报告

## 扫描范围
- [扫描的目录/文件]

## 检测结果

| 文件 | 规则 | 行号 | 修复动作 |
|------|------|------|---------|
| OpenPlatformPage.tsx | Rule 1 | L125 | hover:bg-white → surface-row |
| SettingsPage.tsx | Rule 3 | L45 | rgba 背景 → surface-inset |
| ... | ... | ... | ... |

## 修复统计
- Rule 1 (hover 类): X 处
- Rule 2 (JS handler): X 处
- Rule 3 (rgba 背景): X 处
- Rule 4 (bg-elevated): X 处
- Rule 5 (卡片三件套): X 处
- **总计**: X 处修复

## 跳过（不修复）
- [文件:行号] 原因: Landing page 装饰性元素
- [文件:行号] 原因: 语义色状态背景

## 验证建议
在浏览器中检查以下页面:
- [受影响页面列表]
```

## 注意事项

1. **页面级容器禁止使用 surface 类**: 占满整个内容区域的页面根 `<div>` 不应有 `surface-inset`、`surface` 等类。页面容器应保持透明，让内部的 GlassCard / surface 子组件自己表达玻璃质感。如果页面根元素使用了 `surface-inset`，整个页面看起来会像一个灰蒙蒙的框，这是最常见的错误。
2. **不要修改 Landing Page 装饰元素**: `pages/home/sections/` 下的 FeatureBento、SectionHeader 等使用独立装饰性样式，不纳入 Surface System
3. **保留语义色**: `success/error/warning` 相关的状态背景色不要替换
4. **GlassCard 组件不需修复**: `components/design/GlassCard.tsx` 本身是 Surface System 的 React 封装，使用 `.glass-card-interactive` 类
5. **glassStyles.ts 预设暂保留**: `lib/glassStyles.ts` 中的预设对象目前仍被部分 Dialog/Drawer 使用，不在此 skill 范围内替换
6. **按钮 hover 不要替换**: `<button>` 上的 `hover:bg-white/10` 是正常的交互反馈，不是卡片样式问题
7. **用户可指定范围**: 如果用户说"修复 XXX 页面样式"，只扫描对应文件；如果说"全局修复"则扫描全部

### surface 类适用层级速查

| 层级 | 示例 | 是否使用 surface | 说明 |
|------|------|----------------|------|
| 页面根容器 | `<div className="h-full flex flex-col">` | **否** | 保持透明 |
| 页面内区块 | 设置面板、统计卡片 | `.surface-inset` | 嵌套面板 |
| 独立卡片 | ToolCard、项目卡片 | `GlassCard` 或 `.surface` | 自带 blur |
| 列表行 | 表格行、列表项 | `.surface-row` | hover 高亮 |
| 可点击卡片 | 快捷入口 | `.surface-interactive` | hover 上浮 |

## Surface System 参考

定义位置: `prd-admin/src/styles/globals.css` (搜索 "Surface System")

```css
/* 类名 → 作用 */
.surface          /* 主卡片: blur(40px) + 渐变 + 边框 + 阴影 */
.surface-raised   /* 突出卡片: 更强阴影 + 更亮内光 */
.surface-inset    /* 嵌套面板: var(--bg-card) + 内陷阴影 */
.surface-row      /* 行 hover: 0.2s transition + hover 背景+微影 */
.surface-interactive  /* 卡片 hover: translateY(-3px) + 光晕 */
```

CSS 变量自动适配性能模式: `html[data-perf-mode="performance"]` 时 `--glass-bg-start/end` 切换为实底值，全局 `backdrop-filter: none !important` 生效。
