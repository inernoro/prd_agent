/**
 * 产品管理智能体 — 动态表单渲染 + 有效模板/流程解析（让全局设置真正驱动页面，debt 7 闭环）。
 *
 * FormFieldsRenderer：按表单模板 fields 渲染可编辑控件，值存 Record<string,string>（对齐后端 FormData）。
 * useEffectiveTemplate/useEffectiveWorkflow：解析某对象类型在某产品下生效的默认模板/流程（产品覆盖 > 全局）。
 */
import { useEffect, useState } from 'react';
import {
  listFormTemplates,
  listWorkflowDefinitions,
} from '@/services/real/productAgent';
import type { FormField, FormTemplate, WorkflowDefinition, ProductEntityType } from './types';

export function useEffectiveTemplate(entityType: ProductEntityType, productId: string | null) {
  const [template, setTemplate] = useState<FormTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const res = await listFormTemplates({ entityType, productId: productId ?? undefined });
      if (!alive) return;
      if (res.success) {
        const items = res.data.items;
        const pick =
          items.find((t) => (t.productId ?? null) === productId && t.isDefault) ??
          items.find((t) => !t.productId && t.isDefault) ??
          items.find((t) => !t.productId) ??
          null;
        setTemplate(pick);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [entityType, productId]);
  return { template, loading };
}

export function useEffectiveWorkflow(entityType: ProductEntityType, productId: string | null) {
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const res = await listWorkflowDefinitions({ entityType, productId: productId ?? undefined });
      if (!alive) return;
      if (res.success) {
        const items = res.data.items;
        const pick =
          items.find((w) => (w.productId ?? null) === productId && w.isDefault) ??
          items.find((w) => !w.productId && w.isDefault) ??
          items.find((w) => !w.productId) ??
          null;
        setWorkflow(pick);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [entityType, productId]);
  return { workflow, loading };
}

/** 按模板字段渲染可编辑表单。 */
export function FormFieldsRenderer({
  fields,
  values,
  onChange,
}: {
  fields: FormField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (fields.length === 0) return null;
  const sorted = [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="flex flex-col gap-3">
      {sorted.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <label className="text-xs text-white/55">
            {f.label || f.key}
            {f.required && <span className="text-red-300/70 ml-1">*</span>}
          </label>
          <FieldControl field={f} value={values[f.key] ?? f.defaultValue ?? ''} onChange={(v) => onChange(f.key, v)} />
          {f.helpText && <span className="text-[11px] text-white/30">{f.helpText}</span>}
        </div>
      ))}
    </div>
  );
}

function FieldControl({ field, value, onChange }: { field: FormField; value: string; onChange: (v: string) => void }) {
  const base = 'px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40';
  switch (field.type) {
    case 'textarea':
    case 'richtext':
      return <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={field.placeholder ?? ''} className={`${base} resize-none`} />;
    case 'number':
      return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? ''} className={base} />;
    case 'date':
      return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={base} />;
    case 'datetime':
      return <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} className={base} />;
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} className="accent-cyan-500" /> 是
        </label>
      );
    case 'select':
    case 'radio':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          <option value="">请选择</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case 'multiselect': {
      const selected = value ? value.split(',') : [];
      const toggle = (v: string) => {
        const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
        onChange(next.join(','));
      };
      return (
        <div className="flex flex-wrap gap-1.5">
          {(field.options ?? []).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              className={`px-2.5 py-1 rounded-md text-xs border ${selected.includes(o.value) ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      );
    }
    default:
      // text / user / relation / file 暂以文本输入兜底
      return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? ''} className={base} />;
  }
}
