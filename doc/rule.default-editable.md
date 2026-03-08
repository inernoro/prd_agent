# 默认可编辑原则

> 创建日期：2026-03-04

## 核心原则

**系统开发初期，减少约束。除非业务明确禁止或具有破坏性，所有字段默认可编辑。**

## 规则说明

1. **默认可编辑**
   - 表单字段在创建和编辑模式下默认都可修改
   - 不主动给字段加 `disabled`、`readOnly` 限制

2. **仅在以下情况禁用编辑**
   - **业务明确禁止**：如已发布的合同编号、已结算的订单金额
   - **破坏性较重**：如修改后会导致大量关联数据不一致且无法自动修复
   - **安全要求**：如用户 ID、审计日志等不可篡改字段

3. **不属于禁用理由的场景**
   - "编辑时可能不太合适" → 不禁用
   - "一般不会改" → 不禁用
   - "改了需要同步其他地方" → 不禁用（由后端处理级联更新）
   - "以前就是禁用的" → 不是理由

## 示例

```typescript
// ✅ 正确：默认可编辑
<ModelTypePicker value={form.modelType} onChange={v => setForm({...form, modelType: v})} />
<input value={form.code} onChange={e => setForm({...form, code: e.target.value})} />

// ❌ 错误：无业务理由的禁用
<ModelTypePicker value={form.modelType} onChange={...} disabled={!!editing} />
<input value={form.code} disabled={!!editing} style={{ opacity: 0.6 }} />
```
