# 前端组件复用 · 规则

> 创建日期：2026-03-04

## 核心原则

**全局同属性元素，能复用则复用。** 当多个页面需要相同语义的 UI 元素（选择器、筛选栏、状态徽章等）时，必须抽取为共享组件，禁止在各页面各自硬编码。

## 规则说明

1. **同属性元素识别**
   - 如果两个以上页面出现"同一业务概念的选择/展示"，则视为同属性元素
   - 示例：模型类型选择、平台选择、状态徽章、权限标签

2. **共享组件注册表**
   - 共享组件统一放置在 `src/components/` 下按领域分目录
   - 数据源（如枚举定义、类型常量）统一维护在 `src/lib/` 下的单一文件中
   - 禁止在页面级文件中硬编码相同的选项列表

3. **新增页面时检查**
   - 新增或修改页面中如需选择某业务属性，先搜索现有共享组件
   - 已有则直接使用，没有则先创建共享组件再引用

## 已注册的共享组件

| 组件 | 路径 | 数据源 | 使用页面 |
|------|------|--------|----------|
| `ModelTypePicker` | `components/model/ModelTypePicker.tsx` | `lib/appCallerUtils.ts → MODEL_TYPE_DEFINITIONS` | ModelAppGroupPage, ModelPoolManagePage, ModelManagePage, SkillsPage |
| `ModelTypeFilterBar` | `components/model/ModelTypePicker.tsx` | 同上 | ModelAppGroupPage |

## 反模式（禁止）

```typescript
// ❌ 在页面中硬编码选项列表
const MODEL_TYPES = [
  { value: 'chat', label: '对话模型' },
  { value: 'vision', label: '视觉理解' },
];

// ❌ 多个页面各自写 <Select> + <option> 列表
<Select value={modelType} onChange={...}>
  <option value="chat">对话模型</option>
  <option value="vision">视觉理解</option>
</Select>

// ❌ 用纯文本 input 让用户手输枚举值
<input value={modelType} placeholder="chat" />
```

## 正确做法

```typescript
// ✅ 导入共享组件
import { ModelTypePicker } from '@/components/model/ModelTypePicker';

// ✅ 直接使用
<ModelTypePicker value={modelType} onChange={setModelType} />
```
