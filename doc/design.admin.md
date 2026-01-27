# PRD Admin 设计系统规范

**文档版本**：v1.0  
**创建日期**：2025年1月8日  
**适用版本**：prd-admin v1.0+  
**目标读者**：前端开发工程师、UI/UX 设计师

---

## 目录

1. [设计理念](#1-设计理念)
2. [设计原则](#2-设计原则)
3. [视觉风格](#3-视觉风格)
4. [组件规范](#4-组件规范)
5. [布局系统](#5-布局系统)
6. [动效规范](#6-动效规范)
7. [实施指南](#7-实施指南)

---

## 1. 设计理念

### 1.1 核心理念

PRD Admin 的设计系统追求**专业、精致、高效**的视觉体验，通过精心打磨的细节和流畅的交互，营造高级设计师的作品感。

**关键词**：
- **层次感**：通过阴影、渐变、间距营造清晰的视觉层次
- **呼吸感**：充足的留白和间距，避免拥挤
- **精致感**：细腻的圆角、阴影、边框处理
- **流畅感**：平滑的过渡动画和交互反馈

### 1.2 设计目标

- **提升可读性**：优化排版层次，让信息更易理解
- **增强专业感**：精致的视觉细节，体现产品品质
- **改善交互体验**：流畅的动效反馈，提升操作愉悦度
- **保持一致性**：统一的设计语言，降低学习成本

---

## 2. 设计原则

### 2.1 层次优先

通过视觉层次引导用户注意力：

1. **主要操作**：金色渐变按钮 + 强阴影
2. **次要操作**：半透明按钮 + 微阴影
3. **辅助信息**：低对比度文本
4. **背景元素**：深色渐变 + 内凹效果

### 2.2 细节打磨

每个元素都经过精心设计：

- **圆角**：20px（卡片）、16px（列表项）、14px（输入框）、12px（按钮）
- **阴影**：多层叠加（外阴影 + 内高光）
- **边框**：半透明 + color-mix 实现微妙效果
- **渐变**：对角线渐变（135deg）增加动感

### 2.3 交互反馈

所有交互都有明确的视觉反馈：

- **hover**：亮度提升 + 阴影增强
- **active**：scale(0.98) 按下效果
- **focus**：金色外发光
- **disabled**：50% 透明度

---

## 3. 视觉风格

### 3.1 色彩系统

#### 主色调（金色）

```css
/* 金色渐变 */
--gold-gradient: linear-gradient(135deg, #f6d365 0%, #fda085 100%);

/* 金色强调色 */
--accent-gold: rgba(250, 204, 21, 1);

/* 金色阴影 */
box-shadow: 0 4px 16px -2px rgba(214, 178, 106, 0.3);
```

**使用场景**：
- 主要操作按钮
- 激活状态标识
- 重要信息高亮

#### 背景色系

```css
/* 页面背景 */
--bg-base: rgba(0, 0, 0, 0.95);

/* 卡片背景（带渐变） */
background: var(--bg-elevated);
background-image: linear-gradient(
  135deg, 
  color-mix(in srgb, var(--bg-elevated) 96%, white) 0%, 
  color-mix(in srgb, var(--bg-elevated) 92%, black) 100%
);

/* 输入框背景 */
background: linear-gradient(
  135deg, 
  var(--bg-input) 0%, 
  color-mix(in srgb, var(--bg-input) 98%, black) 100%
);
```

#### 文本色系

```css
/* 主要文本 */
--text-primary: rgba(255, 255, 255, 0.95);

/* 次要文本 */
--text-secondary: rgba(255, 255, 255, 0.70);

/* 辅助文本 */
--text-muted: rgba(255, 255, 255, 0.50);
```

#### 边框色系

```css
/* 默认边框 */
--border-subtle: rgba(255, 255, 255, 0.10);

/* 强调边框 */
--border-default: rgba(255, 255, 255, 0.15);

/* 半透明边框（推荐） */
border-color: color-mix(in srgb, var(--border-subtle) 60%, transparent);
```

### 3.2 阴影系统

#### 卡片阴影

```css
/* 标准卡片 */
box-shadow: 
  0 4px 24px -4px rgba(0, 0, 0, 0.3),           /* 外阴影 */
  0 0 0 1px rgba(255, 255, 255, 0.02) inset;    /* 内高光 */

/* 金色卡片 */
box-shadow: 
  0 8px 32px -8px rgba(0, 0, 0, 0.4),
  0 0 0 1px rgba(255, 255, 255, 0.03) inset,
  0 2px 8px rgba(214, 178, 106, 0.08);          /* 金色光晕 */
```

#### 按钮阴影

```css
/* 主要按钮 */
box-shadow: 
  0 4px 16px -2px rgba(214, 178, 106, 0.3),
  0 0 0 1px rgba(255, 255, 255, 0.1) inset;

/* 次要按钮 */
box-shadow: 
  0 2px 8px -2px rgba(0, 0, 0, 0.2),
  0 0 0 1px rgba(255, 255, 255, 0.02) inset;
```

#### 输入框阴影

```css
/* 默认状态 */
box-shadow: 
  0 2px 8px -2px rgba(0, 0, 0, 0.2) inset,
  0 0 0 1px rgba(255, 255, 255, 0.02) inset;

/* focus 状态 */
box-shadow: 
  0 2px 8px -2px rgba(0, 0, 0, 0.2) inset,
  0 0 0 1px rgba(214, 178, 106, 0.2) inset,
  0 0 0 2px rgba(214, 178, 106, 0.1);           /* 外发光 */
```

### 3.3 圆角系统

```css
/* 大卡片 */
border-radius: 20px;

/* 中等卡片/列表项 */
border-radius: 16px;

/* 输入框 */
border-radius: 14px;

/* 按钮 */
border-radius: 12px;  /* md */
border-radius: 11px;  /* xs/sm */

/* 小元素 */
border-radius: 10px;
```

### 3.4 间距系统

```css
/* 页面级间距 */
gap: 24px;  /* gap-6 */

/* 卡片内边距 */
padding: 24px;  /* p-6 */
padding: 20px;  /* p-5 */

/* 组件间距 */
gap: 16px;  /* gap-4 */
gap: 12px;  /* gap-3 */

/* 元素内边距 */
padding: 16px;  /* px-4 py-4 */
padding: 12px;  /* px-3 py-3 */
```

---

## 4. 组件规范

### 4.1 Card 组件

#### 基础样式

```tsx
// src/components/design/Card.tsx
<Card className="p-6" variant="default">
  {children}
</Card>
```

**样式规范**：

```css
/* 结构 */
.card {
  border-radius: 20px;
  padding: 24px;
  transition: all 0.2s;
}

/* 背景 */
background-color: var(--bg-elevated);
background-image: linear-gradient(
  135deg, 
  color-mix(in srgb, var(--bg-elevated) 96%, white) 0%, 
  color-mix(in srgb, var(--bg-elevated) 92%, black) 100%
);

/* 边框 */
border: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);

/* 阴影 */
box-shadow: 
  0 4px 24px -4px rgba(0, 0, 0, 0.3),
  0 0 0 1px rgba(255, 255, 255, 0.02) inset;
```

#### Gold 变体

```css
/* 金色卡片（用于强调区域） */
background-image: 
  linear-gradient(
    135deg, 
    color-mix(in srgb, var(--bg-elevated) 94%, black) 0%, 
    color-mix(in srgb, var(--bg-elevated) 88%, black) 100%
  ),
  radial-gradient(
    600px 400px at 50% 0%, 
    rgba(214, 178, 106, 0.15) 0%, 
    transparent 65%
  );

box-shadow: 
  0 8px 32px -8px rgba(0, 0, 0, 0.4),
  0 0 0 1px rgba(255, 255, 255, 0.03) inset,
  0 2px 8px rgba(214, 178, 106, 0.08);
```

### 4.2 Button 组件

#### 尺寸规范

```tsx
// xs: 小按钮
<Button size="xs">按钮</Button>
// height: 32px, padding: 0 14px, font-size: 12px, border-radius: 11px

// sm: 中按钮
<Button size="sm">按钮</Button>
// height: 36px, padding: 0 16px, font-size: 13px, border-radius: 12px

// md: 大按钮（默认）
<Button size="md">按钮</Button>
// height: 44px, padding: 0 20px, font-size: 14px, border-radius: 14px
```

#### 变体规范

**Primary（主要按钮）**：

```css
background: var(--gold-gradient);
color: #1a1206;
box-shadow: 
  0 4px 16px -2px rgba(214, 178, 106, 0.3),
  0 0 0 1px rgba(255, 255, 255, 0.1) inset;

/* hover */
filter: brightness(1.05);
box-shadow: 
  0 6px 20px -2px rgba(214, 178, 106, 0.4),
  0 0 0 1px rgba(255, 255, 255, 0.1) inset;

/* active */
transform: scale(0.98);
```

**Secondary（次要按钮）**：

```css
background: rgba(255, 255, 255, 0.05);
border: 1px solid rgba(255, 255, 255, 0.10);
color: var(--text-primary);
box-shadow: 
  0 2px 8px -2px rgba(0, 0, 0, 0.2),
  0 0 0 1px rgba(255, 255, 255, 0.02) inset;

/* hover */
background: rgba(255, 255, 255, 0.10);
border-color: rgba(255, 255, 255, 0.20);

/* active */
transform: scale(0.98);
```

**Danger（危险按钮）**：

```css
background: rgba(239, 68, 68, 0.10);
border: 1px solid rgba(239, 68, 68, 0.25);
color: rgba(239, 68, 68, 0.95);
box-shadow: 0 2px 8px -2px rgba(239, 68, 68, 0.2);

/* hover */
background: rgba(239, 68, 68, 0.15);

/* active */
transform: scale(0.98);
```

### 4.3 SegmentedTabs 组件

#### 结构

```tsx
<SegmentedTabs
  items={[
    { key: 'tab1', label: '标签1' },
    { key: 'tab2', label: '标签2' },
  ]}
  value={activeTab}
  onChange={setActiveTab}
/>
```

#### 样式规范

```css
/* 容器 */
.segmented-tabs {
  display: inline-flex;
  padding: 4px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.20);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 2px 8px -2px rgba(0, 0, 0, 0.3) inset;
}

/* 按钮 */
.segmented-tabs button {
  height: 32px;
  padding: 0 16px;
  border-radius: 11px;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.2s;
}

/* 激活状态 */
.segmented-tabs button[aria-pressed="true"] {
  background: var(--gold-gradient);
  color: #1a1206;
  box-shadow: 
    0 2px 8px -2px rgba(214, 178, 106, 0.4),
    0 0 0 1px rgba(255, 255, 255, 0.1) inset;
  transform: scale(1);
}

/* 非激活状态 */
.segmented-tabs button[aria-pressed="false"] {
  background: transparent;
  color: var(--text-secondary);
  transform: scale(0.98);
}
```

### 4.4 输入框组件

#### Textarea 样式

```css
/* 基础样式 */
.textarea {
  border-radius: 14px;
  padding: 12px;
  font-size: 13px;
  line-height: 1.6;
  border: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);
  background: linear-gradient(
    135deg, 
    var(--bg-input) 0%, 
    color-mix(in srgb, var(--bg-input) 98%, black) 100%
  );
  color: var(--text-primary);
  box-shadow: 
    0 2px 8px -2px rgba(0, 0, 0, 0.2) inset,
    0 0 0 1px rgba(255, 255, 255, 0.02) inset;
  transition: all 0.2s;
}

/* focus 状态 */
.textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--accent-gold) 40%, transparent);
  box-shadow: 
    0 2px 8px -2px rgba(0, 0, 0, 0.2) inset,
    0 0 0 1px rgba(214, 178, 106, 0.2) inset,
    0 0 0 2px rgba(214, 178, 106, 0.1);
}
```

### 4.5 列表项组件

#### 可点击列表项

```css
/* 基础样式 */
.list-item {
  border-radius: 16px;
  padding: 14px 16px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);
  background: var(--bg-input);
  box-shadow: 0 2px 8px -2px rgba(0, 0, 0, 0.2);
}

/* hover */
.list-item:hover {
  transform: scale(1.01);
}

/* 激活状态 */
.list-item[aria-pressed="true"] {
  background: linear-gradient(
    135deg, 
    color-mix(in srgb, var(--accent-gold) 12%, var(--bg-input)) 0%, 
    color-mix(in srgb, var(--accent-gold) 8%, var(--bg-input)) 100%
  );
  border-color: color-mix(in srgb, var(--accent-gold) 40%, transparent);
  box-shadow: 
    0 4px 16px -4px rgba(214, 178, 106, 0.2),
    0 0 0 1px rgba(255, 255, 255, 0.03) inset;
}
```

---

## 5. 布局系统

### 5.1 页面布局

#### 标准页面结构

```tsx
<div className="h-full min-h-0 flex flex-col gap-6 overflow-x-hidden">
  {/* 顶部卡片（标题 + 操作） */}
  <Card className="p-5" variant="gold">
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <div className="text-3xl font-bold tracking-tight">
          页面标题
        </div>
        <div className="mt-2 text-[14px] text-muted">
          页面描述
        </div>
      </div>
      <div className="flex items-center gap-3">
        {/* 操作按钮 */}
      </div>
    </div>
  </Card>

  {/* 主内容区 */}
  <div className="grid gap-6 flex-1 min-h-0">
    {/* 内容 */}
  </div>
</div>
```

### 5.2 两栏布局

```tsx
<div className="grid gap-6 flex-1 min-h-0" 
     style={{ gridTemplateColumns: '360px minmax(0, 1fr)' }}>
  {/* 左侧栏 */}
  <Card className="p-5 h-full">
    {/* 左侧内容 */}
  </Card>

  {/* 右侧栏 */}
  <Card className="p-5 h-full">
    {/* 右侧内容 */}
  </Card>
</div>
```

### 5.3 间距规范

```css
/* 页面级 */
gap: 24px;           /* gap-6 */
padding: 20px;       /* px-5 py-5 */

/* 卡片级 */
padding: 24px;       /* p-6 */
padding: 20px;       /* p-5 */
gap: 16px;           /* gap-4 */

/* 组件级 */
gap: 12px;           /* gap-3 */
margin-top: 16px;    /* mt-4 */
margin-top: 12px;    /* mt-3 */
```

---

## 6. 动效规范

### 6.1 过渡时长

```css
/* 标准过渡 */
transition: all 0.2s;

/* 快速过渡 */
transition: all 0.15s;

/* 缓慢过渡 */
transition: all 0.3s;
```

### 6.2 缓动函数

```css
/* 默认 */
transition-timing-function: ease;

/* 进入 */
transition-timing-function: ease-out;

/* 退出 */
transition-timing-function: ease-in;

/* 弹性 */
transition-timing-function: cubic-bezier(0.22, 0.9, 0.28, 1);
```

### 6.3 常用动效

#### hover 效果

```css
/* 亮度提升 */
.element:hover {
  filter: brightness(1.05);
}

/* 缩放 */
.element:hover {
  transform: scale(1.01);
}

/* 阴影增强 */
.element:hover {
  box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.4);
}
```

#### active 效果

```css
/* 按下缩放 */
.element:active {
  transform: scale(0.98);
}
```

#### focus 效果

```css
/* 外发光 */
.element:focus {
  outline: none;
  box-shadow: 0 0 0 2px rgba(214, 178, 106, 0.1);
}
```

---

## 7. 实施指南

### 7.1 组件文件位置

```
prd-admin/src/components/design/
├── Card.tsx           # 卡片组件
├── Button.tsx         # 按钮组件
└── Badge.tsx          # 徽章组件
```

### 7.2 使用示例

#### 标准页面

```tsx
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';

export default function MyPage() {
  return (
    <div className="h-full min-h-0 flex flex-col gap-6 overflow-x-hidden">
      <Card className="p-5" variant="gold">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="text-3xl font-bold tracking-tight" 
                 style={{ letterSpacing: '-0.03em' }}>
              我的页面
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm">
              刷新
            </Button>
            <Button variant="primary" size="sm">
              保存
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-6 flex-1 min-h-0">
        {/* 主内容 */}
      </Card>
    </div>
  );
}
```

### 7.3 样式工具

#### Tailwind 常用类

```css
/* 布局 */
.flex .flex-col .gap-6
.grid .gap-6
.min-h-0 .flex-1

/* 间距 */
.p-6 .px-5 .py-5
.mt-4 .mb-3 .gap-3

/* 圆角 */
.rounded-[20px]
.rounded-[16px]
.rounded-[14px]

/* 文本 */
.text-3xl .font-bold
.text-[14px] .font-semibold
.tracking-tight
```

#### CSS 变量

```css
/* 色彩 */
var(--text-primary)
var(--text-secondary)
var(--text-muted)
var(--bg-elevated)
var(--bg-input)
var(--border-subtle)
var(--accent-gold)
var(--gold-gradient)

/* 阴影 */
var(--shadow-card)
var(--shadow-gold)
```

### 7.4 开发检查清单

设计新组件时，确保：

- [ ] 圆角符合规范（20/16/14/12px）
- [ ] 阴影使用多层叠加（外阴影 + 内高光）
- [ ] 边框使用半透明 color-mix
- [ ] 渐变使用对角线方向（135deg）
- [ ] hover 有明确反馈（亮度/缩放/阴影）
- [ ] active 有按下效果（scale 0.98）
- [ ] focus 有外发光效果
- [ ] 过渡动画流畅（0.2s）
- [ ] 间距符合规范（6/5/4/3）
- [ ] 文本层次清晰（3xl/xl/lg/base/sm）

---

## 附录

### A. 快速参考

#### 常用尺寸

| 元素 | 圆角 | 高度 | 内边距 |
|------|------|------|--------|
| 大卡片 | 20px | auto | 24px |
| 中卡片 | 16px | auto | 20px |
| 列表项 | 16px | auto | 14px 16px |
| 输入框 | 14px | auto | 12px |
| 按钮 md | 14px | 44px | 0 20px |
| 按钮 sm | 12px | 36px | 0 16px |
| 按钮 xs | 11px | 32px | 0 14px |

#### 常用间距

| 场景 | Tailwind | 像素值 |
|------|----------|--------|
| 页面级 | gap-6 | 24px |
| 卡片级 | gap-4 | 16px |
| 组件级 | gap-3 | 12px |
| 元素级 | gap-2 | 8px |

### B. 相关资源

- **设计工具**：Figma（推荐）
- **色彩工具**：CSS color-mix()
- **动效参考**：Framer Motion 文档
- **Tailwind 文档**：https://tailwindcss.com

---

**文档维护**：本文档应随设计系统演进持续更新，确保与代码实现保持一致。
