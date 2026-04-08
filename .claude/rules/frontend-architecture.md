---
globs: ["prd-admin/src/**/*.{ts,tsx}", "prd-desktop/src/**/*.{ts,tsx}"]
---

# 前端架构规则

## 核心原则

前端仅作为指令发送者与状态观察者。所有业务逻辑与状态流转在后端闭环，前端不维护中间态。

## 前端职责边界

- ✅ 发送原子化指令（API 调用）、展示后端返回的结果、UI 展示逻辑
- ❌ 维护业务数据映射、解析后端数据生成业务描述、持有业务中间状态

## 单一数据源原则

- 业务数据描述信息（displayName 等）必须在后端维护，前端直接显示
- 前端禁止维护业务数据映射表（如 AppCallerCode → 中文名的字典）

## 单一数据源渲染（SSOT）

- 一个 UI 列表只能由一个 Store 字段驱动
- mutation 后必须更新同一个 Store 字段
- Store 新增字段时必须在 `onRehydrateStorage` 中处理旧数据兼容

## 组件复用原则

- 两个以上页面出现同一业务概念 → 必须提取 `src/components/` 共享组件
- 数据源统一维护在 `src/lib/` 下

## 注册表模式（Registry Pattern）

**强制规则**：任何基于"类型 key → 图标/组件/配置/标签"的映射关系，必须采用注册表模式，**禁止在组件内硬编码 `switch` / `if-else`**。

### 判定标准

凡满足以下任一条件，必须用注册表而非 switch：

1. 有 3+ 分支的"类型→样式/图标/组件"映射（文件扩展名、枚举值、sourceType 等）
2. 同一映射关系可能在多个组件中被复用
3. 后续新增类型时，会需要改动多处代码

### 命名约定

| 后缀 | 含义 | 示例 |
|------|------|------|
| `*_REGISTRY` | 完整配置对象（含 icon + label + color + 组件等多字段） | `CONFIG_TYPE_REGISTRY`, `CAPSULE_TYPE_REGISTRY`, `FILE_TYPE_REGISTRY` |
| `*_DEFINITIONS` | 结构化数组定义 | `MODEL_TYPE_DEFINITIONS` |
| `*_MAP` | 简单键值映射（如 `Record<string, LucideIcon>`） | `ICON_MAP`, `ICON_HUE_MAP` |

### 标准位置

- 共享的注册表：`src/lib/xxxRegistry.ts` 或 `src/lib/xxxTypes.tsx`
- 单页面私有注册表：该页面目录下 `xxxRegistry.tsx`

### 标准结构

```typescript
// src/lib/fileTypeRegistry.ts
export interface FileTypeConfig {
  extensions: string[];
  icon: LucideIcon;
  color: string;
  label: string;
}

export const FILE_TYPE_REGISTRY: Record<string, FileTypeConfig> = {
  markdown: { extensions: ['.md'], icon: FileText, color: '...', label: 'Markdown' },
  pdf: { extensions: ['.pdf'], icon: FileText, color: '...', label: 'PDF' },
  // ...
};

export function getFileTypeConfig(filename: string, mimeType?: string): FileTypeConfig {
  // 查找逻辑...
}
```

### 参考范例

- `src/lib/marketplaceTypes.tsx` → `CONFIG_TYPE_REGISTRY`（海鲜市场配置类型）
- `src/pages/workflow-agent/capsuleRegistry.tsx` → `CAPSULE_TYPE_REGISTRY`（工作流胶囊）
- `src/lib/fileTypeRegistry.ts` → `FILE_TYPE_REGISTRY`（文件扩展名 → 图标）

### 反面案例（禁止）

```tsx
// ❌ 在组件中硬编码类型判断
function FileIcon({ mimeType }: Props) {
  if (mimeType === 'text/markdown') return <FileText />;
  if (mimeType === 'application/pdf') return <FileText color="red" />;
  if (mimeType.includes('presentation')) return <Presentation />;
  return <File />;
}
```

**问题**：新增类型要改这个组件 + 可能还有其他地方在做同样的判断。无法复用、无法统一维护。

## 统一加载组件（MAP Loader）

**强制规则**：所有加载状态必须使用 `@/components/ui/VideoLoader` 提供的统一组件，**禁止直接使用 `lucide-react` 的 `<Loader2 className="animate-spin" />`**。

### 三个层级（按场景选择）

| 组件 | 场景 | 尺寸 |
|------|------|------|
| `PageTransitionLoader` (`mode="fullscreen"` 或 `"inline"`) | Suspense fallback、路由过渡 | 全屏 / 内联 |
| `MapSectionLoader` | 区块居中加载（替代居中 Loader2） | 自适应父容器 |
| `MapSpinner` | 行内 / 按钮 loading 态 | 14-32px |

### 使用示例

```tsx
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';

// 区块加载
{loading ? <MapSectionLoader text="正在加载…" /> : <Content />}

// 按钮内加载
<Button disabled={saving}>
  {saving ? <MapSpinner size={14} /> : <Save size={14} />}
  保存
</Button>
```

### 反面案例（禁止）

```tsx
// ❌ 直接用 lucide-react 的 Loader2
import { Loader2 } from 'lucide-react';
{loading && <Loader2 className="animate-spin" />}
```

**理由**：MAP 加载组件统一了品牌色、动效语言（扫光条 + 字母淡入），避免各处样式不一致。

## 默认可编辑原则

除非业务明确禁止或具有破坏性，所有表单字段默认可编辑，不主动加 `disabled` / `readOnly`。
