/**
 * 产品管理智能体 — 全局设置（表单模板 + 流程模板可视化编辑器，P2）。
 *
 * 全局默认（ProductId 留空）+ 允许选某产品覆盖。复用后端 form-templates / workflow-definitions CRUD。
 * 作用对象类型：需求 / 功能 / 缺陷 / 版本 / 客户 / 升级申请。
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Save, GripVertical } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listProducts,
  listFormTemplates,
  upsertFormTemplate,
  listWorkflowDefinitions,
  upsertWorkflowDefinition,
} from '@/services/real/productAgent';
import type { Product, FormField, FormFieldType, WorkflowState, WorkflowTransition, ProductEntityType } from './types';

const ENTITY_TYPES: { value: ProductEntityType; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'feature', label: '功能' },
  { value: 'version', label: '版本' },
  { value: 'customer', label: '客户' },
  { value: 'upgrade-request', label: '升级申请' },
];

const FIELD_TYPES: { value: FormFieldType; label: string }[] = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'richtext', label: '富文本（排版+截图）' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '单选下拉' },
  { value: 'multiselect', label: '多选' },
  { value: 'radio', label: '单选按钮' },
  { value: 'checkbox', label: '勾选' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '日期时间' },
  { value: 'user', label: '用户选择' },
  { value: 'relation', label: '关联对象' },
  { value: 'file', label: '附件上传' },
];
const HAS_OPTIONS = new Set(['select', 'multiselect', 'radio']);
const RELATION_TARGETS: { value: string; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'feature', label: '功能' },
  { value: 'version', label: '版本' },
  { value: 'customer', label: '客户' },
];

// 各对象类型的系统预置字段（由页面原生渲染，不可在表单里增删改；这里仅展示让配置者知晓）
const PRESET_FIELDS: Record<ProductEntityType, { label: string; type: string }[]> = {
  requirement: [
    { label: '标题', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '分级', type: 'P0-P3' },
    { label: '状态', type: '流程驱动' },
    { label: '所属客户', type: '关联客户' },
    { label: '归属版本', type: '关联版本' },
    { label: '追溯缺陷', type: '关联缺陷' },
  ],
  feature: [
    { label: '名称', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '分级', type: 'P0-P3' },
    { label: '状态', type: '流程驱动' },
    { label: '实现需求', type: '关联需求' },
    { label: '纳入版本', type: '功能版本化' },
    { label: '追溯缺陷', type: '关联缺陷' },
  ],
  version: [
    { label: '版本名', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '生命周期', type: '流程驱动' },
    { label: '关联需求', type: '关联需求' },
    { label: '纳入功能', type: '功能版本化' },
  ],
  customer: [
    { label: '名称', type: '单行文本' },
    { label: '公司', type: '单行文本' },
    { label: '联系方式', type: '单行文本' },
    { label: '描述', type: '多行文本' },
  ],
  'upgrade-request': [
    { label: '标题', type: '单行文本' },
    { label: '理由', type: '多行文本' },
    { label: '关联需求', type: '关联需求' },
    { label: '关联功能', type: '关联功能' },
    { label: '状态', type: '流程驱动' },
  ],
  product: [
    { label: '名称', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '分级', type: '核心/重要/普通/实验' },
  ],
};

export function SettingsSection() {
  const [mode, setMode] = useState<'form' | 'workflow'>('form');
  const [entityType, setEntityType] = useState<ProductEntityType>('requirement');
  const [productScope, setProductScope] = useState(''); // '' = 全局
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void (async () => {
      const res = await listProducts({ pageSize: 200 });
      if (res.success) setProducts(res.data.items);
    })();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* 模式 + 对象类型 + 作用范围 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          <button onClick={() => setMode('form')} className={`px-3 py-1.5 text-sm ${mode === 'form' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>表单模板</button>
          <button onClick={() => setMode('workflow')} className={`px-3 py-1.5 text-sm ${mode === 'workflow' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>流程模板</button>
        </div>
        <div className="w-px h-6 bg-white/10" />
        {ENTITY_TYPES.map((e) => (
          <button
            key={e.value}
            onClick={() => setEntityType(e.value)}
            className={`px-2.5 py-1 rounded-md text-xs border ${entityType === e.value ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
          >
            {e.label}
          </button>
        ))}
        <div className="w-px h-6 bg-white/10" />
        <select
          value={productScope}
          onChange={(e) => setProductScope(e.target.value)}
          className="px-2 py-1.5 rounded-md text-xs bg-white/5 border border-white/10 text-white/70 outline-none"
        >
          <option value="">全局默认（所有产品共用）</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>覆盖：{p.name}</option>
          ))}
        </select>
      </div>

      {mode === 'form' ? (
        <FormTemplateEditor key={`f-${entityType}-${productScope}`} entityType={entityType} productId={productScope || null} />
      ) : (
        <WorkflowEditor key={`w-${entityType}-${productScope}`} entityType={entityType} productId={productScope || null} />
      )}
    </div>
  );
}

// ════════════════════════ 表单模板编辑器 ════════════════════════
function FormTemplateEditor({ entityType, productId }: { entityType: ProductEntityType; productId: string | null }) {
  const [id, setId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listFormTemplates({ entityType, productId: productId ?? undefined });
    if (res.success) {
      const match = res.data.items.find((t) => (t.productId ?? null) === productId && t.isDefault) ?? res.data.items.find((t) => (t.productId ?? null) === productId);
      if (match) {
        setId(match.id);
        setName(match.name);
        setFields([...match.fields].sort((a, b) => a.sortOrder - b.sortOrder));
      } else {
        setId(undefined);
        setName(`${ENTITY_TYPES.find((e) => e.value === entityType)?.label}默认表单`);
        setFields([]);
      }
    }
    setLoading(false);
  }, [entityType, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addField = () => setFields((f) => [...f, { key: `field_${f.length + 1}`, label: '', type: 'text', required: false, sortOrder: f.length }]);
  const updateField = (i: number, patch: Partial<FormField>) => setFields((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeField = (i: number) => setFields((f) => f.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => setFields((f) => {
    const j = i + dir;
    if (j < 0 || j >= f.length) return f;
    const next = [...f];
    [next[i], next[j]] = [next[j], next[i]];
    return next.map((x, idx) => ({ ...x, sortOrder: idx }));
  });

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await upsertFormTemplate({
      id,
      name: name.trim() || '默认表单',
      entityType,
      fields: fields.map((f, idx) => ({ ...f, sortOrder: idx })),
      isDefault: true,
      productId,
    });
    setSaving(false);
    if (res.success) {
      setMsg('已保存');
      await load();
    } else {
      setMsg(res.error?.message ?? '保存失败');
    }
  };

  if (loading) return <MapSectionLoader text="正在加载模板…" />;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="模板名称" className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50">
          {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
        </button>
        {msg && <span className="text-xs text-white/50">{msg}</span>}
      </div>

      {/* 系统预置字段：页面原生渲染，锁定不可改 */}
      <div className="rounded-lg border border-white/10 bg-white/[0.015] p-3">
        <div className="text-xs font-medium text-white/50 mb-2">系统预置字段（页面原生渲染，不可修改）</div>
        <div className="flex flex-wrap gap-1.5">
          {(PRESET_FIELDS[entityType] ?? []).map((p, i) => (
            <span key={i} className="text-[11px] px-2 py-1 rounded bg-white/5 border border-white/10 text-white/55">
              {p.label}
              <span className="text-white/30"> · {p.type}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="text-xs font-medium text-white/50">额外自定义字段（存入 FormData，按需补充，勿与上方预置重复）</div>
      <div className="flex flex-col gap-2">
        {fields.length === 0 && <div className="text-xs text-white/35 py-3 text-center">还没有额外字段，点下方「添加字段」补充预置之外的信息。</div>}
        {fields.map((f, i) => (
          <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button onClick={() => move(i, -1)} className="text-white/30 hover:text-white text-[10px] leading-none">▲</button>
                <button onClick={() => move(i, 1)} className="text-white/30 hover:text-white text-[10px] leading-none">▼</button>
              </div>
              <GripVertical size={14} className="text-white/20" />
              <input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="字段标签（如：需求背景）" className="flex-1 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
              <input value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} placeholder="key" className="w-28 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none" />
              <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value as FormFieldType })} className="px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none">
                {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="flex items-center gap-1 text-xs text-white/50">
                <input type="checkbox" checked={f.required} onChange={(e) => updateField(i, { required: e.target.checked })} className="accent-cyan-500" /> 必填
              </label>
              <button onClick={() => removeField(i)} className="text-white/30 hover:text-red-300"><Trash2 size={14} /></button>
            </div>
            {HAS_OPTIONS.has(f.type) && (
              <textarea
                value={(f.options ?? []).map((o) => o.label).join('\n')}
                onChange={(e) => updateField(i, { options: e.target.value.split('\n').filter((l) => l.trim()).map((l) => ({ value: l.trim(), label: l.trim() })) })}
                rows={2}
                placeholder="每行一个选项"
                className="px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/80 outline-none resize-none"
              />
            )}
            {f.type === 'relation' && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-white/40">关联对象类型</span>
                <select
                  value={f.relationEntityType ?? ''}
                  onChange={(e) => updateField(i, { relationEntityType: e.target.value })}
                  className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none"
                >
                  <option value="">请选择</option>
                  {RELATION_TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ))}
      </div>
      <button onClick={addField} className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm">
        <Plus size={14} /> 添加字段
      </button>
    </div>
  );
}

// ════════════════════════ 流程模板编辑器 ════════════════════════
function WorkflowEditor({ entityType, productId }: { entityType: ProductEntityType; productId: string | null }) {
  const [id, setId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [transitions, setTransitions] = useState<WorkflowTransition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listWorkflowDefinitions({ entityType, productId: productId ?? undefined });
    if (res.success) {
      const match = res.data.items.find((w) => (w.productId ?? null) === productId && w.isDefault) ?? res.data.items.find((w) => (w.productId ?? null) === productId);
      if (match) {
        setId(match.id);
        setName(match.name);
        setStates([...match.states].sort((a, b) => a.sortOrder - b.sortOrder));
        setTransitions([...match.transitions]);
      } else {
        setId(undefined);
        setName(`${ENTITY_TYPES.find((e) => e.value === entityType)?.label}默认流程`);
        setStates([]);
        setTransitions([]);
      }
    }
    setLoading(false);
  }, [entityType, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addState = () => setStates((s) => [...s, { key: `state_${s.length + 1}`, label: '', color: '#60A5FA', isInitial: s.length === 0, isFinal: false, sortOrder: s.length }]);
  const updateState = (i: number, patch: Partial<WorkflowState>) => setStates((s) => s.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeState = (i: number) => setStates((s) => s.filter((_, idx) => idx !== i));

  const addTransition = () => setTransitions((t) => [...t, { key: `t_${t.length + 1}`, label: '', fromState: states[0]?.key ?? '', toState: states[1]?.key ?? states[0]?.key ?? '', requireComment: false }]);
  const updateTransition = (i: number, patch: Partial<WorkflowTransition>) => setTransitions((t) => t.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeTransition = (i: number) => setTransitions((t) => t.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await upsertWorkflowDefinition({
      id,
      name: name.trim() || '默认流程',
      entityType,
      states: states.map((s, idx) => ({ ...s, sortOrder: idx })),
      transitions,
      isDefault: true,
      productId,
    });
    setSaving(false);
    if (res.success) {
      setMsg('已保存');
      await load();
    } else {
      setMsg(res.error?.message ?? '保存失败');
    }
  };

  if (loading) return <MapSectionLoader text="正在加载流程…" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex items-center gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="流程名称" className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50">
          {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
        </button>
        {msg && <span className="text-xs text-white/50">{msg}</span>}
      </div>

      {/* 状态 */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-2">
        <div className="text-sm font-medium text-white/70">状态</div>
        {states.length === 0 && <div className="text-xs text-white/35 py-2 text-center">还没有状态，先添加状态再连流转。</div>}
        {states.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <input type="color" value={s.color ?? '#60A5FA'} onChange={(e) => updateState(i, { color: e.target.value })} className="w-7 h-7 rounded bg-transparent border border-white/10" />
            <input value={s.label} onChange={(e) => updateState(i, { label: e.target.value })} placeholder="状态名（如：待评审）" className="flex-1 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
            <input value={s.key} onChange={(e) => updateState(i, { key: e.target.value })} placeholder="key" className="w-28 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none" />
            <label className="flex items-center gap-1 text-xs text-white/50"><input type="checkbox" checked={s.isInitial} onChange={(e) => updateState(i, { isInitial: e.target.checked })} className="accent-cyan-500" /> 初始</label>
            <label className="flex items-center gap-1 text-xs text-white/50"><input type="checkbox" checked={s.isFinal} onChange={(e) => updateState(i, { isFinal: e.target.checked })} className="accent-cyan-500" /> 终态</label>
            <button onClick={() => removeState(i)} className="text-white/30 hover:text-red-300"><Trash2 size={14} /></button>
          </div>
        ))}
        <button onClick={addState} className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm">
          <Plus size={14} /> 添加状态
        </button>
      </div>

      {/* 流转 */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-2">
        <div className="text-sm font-medium text-white/70">流转（from → to）</div>
        {transitions.length === 0 && <div className="text-xs text-white/35 py-2 text-center">还没有流转动作。</div>}
        {transitions.map((t, i) => (
          <div key={i} className="flex items-center gap-2 flex-wrap">
            <input value={t.label} onChange={(e) => updateTransition(i, { label: e.target.value })} placeholder="动作名（如：提交评审）" className="flex-1 min-w-[140px] px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
            <input value={t.key} onChange={(e) => updateTransition(i, { key: e.target.value })} placeholder="key" className="w-24 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none" />
            <select value={t.fromState ?? ''} onChange={(e) => updateTransition(i, { fromState: e.target.value || null })} className="px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none">
              <option value="">任意状态</option>
              {states.map((s) => <option key={s.key} value={s.key}>{s.label || s.key}</option>)}
            </select>
            <span className="text-white/30 text-xs">→</span>
            <select value={t.toState} onChange={(e) => updateTransition(i, { toState: e.target.value })} className="px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none">
              {states.map((s) => <option key={s.key} value={s.key}>{s.label || s.key}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs text-white/50"><input type="checkbox" checked={t.requireComment} onChange={(e) => updateTransition(i, { requireComment: e.target.checked })} className="accent-cyan-500" /> 需备注</label>
            <button onClick={() => removeTransition(i)} className="text-white/30 hover:text-red-300"><Trash2 size={14} /></button>
          </div>
        ))}
        <button onClick={addTransition} disabled={states.length === 0} className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm disabled:opacity-40">
          <Plus size={14} /> 添加流转
        </button>
      </div>
    </div>
  );
}
