/**
 * 产品管理智能体 — 应用配置（状态 + 流转边可视化编辑）。
 *
 * 主页左侧一级「应用」入口，页标题为「应用配置」。全局默认 + 可按产品覆盖。
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { listProducts, listWorkflowDefinitions, upsertWorkflowDefinition } from '@/services/real/productAgent';
import type { Product, WorkflowState, WorkflowTransition, ProductEntityType } from './types';
import {
  WORKFLOW_TRANSITION_FIELD_KEYS,
  WORKFLOW_TRANSITION_FIELD_LABELS,
  WORKFLOW_TRANSITION_ROLE_LABELS,
  WORKFLOW_TRANSITION_ROLES,
  type WorkflowTransitionFieldKey,
  type WorkflowTransitionRole,
} from './workflowTransitionGuard';

const WORKFLOW_ROLE_OPTIONS = Object.values(WORKFLOW_TRANSITION_ROLES);
const WORKFLOW_FIELD_OPTIONS = Object.values(WORKFLOW_TRANSITION_FIELD_KEYS);

const ENTITY_TYPES: { value: ProductEntityType; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'feature', label: '功能' },
  { value: 'version', label: '版本' },
];

function toggleWorkflowListItem(list: string[] | null | undefined, item: string): string[] {
  const base = list ?? [];
  return base.includes(item) ? base.filter((x) => x !== item) : [...base, item];
}

export function WorkflowTemplateSection() {
  const [entityType, setEntityType] = useState<ProductEntityType>('requirement');
  const [productScope, setProductScope] = useState('');
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void listProducts({ pageSize: 200 }).then((res) => {
      if (res.success) setProducts(res.data.items);
    });
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        {ENTITY_TYPES.map((e) => (
          <button
            key={e.value}
            type="button"
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
      <WorkflowEditor key={`${entityType}-${productScope}`} entityType={entityType} productId={productScope || null} />
    </div>
  );
}

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
      const match = res.data.items.find((w) => (w.productId ?? null) === productId && w.isDefault)
        ?? res.data.items.find((w) => (w.productId ?? null) === productId);
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
      {entityType === 'requirement' && (
        <div className="text-xs text-white/40 px-1">
          首次初始化写入 MAP 内置「米多需求收集工作流」（7 状态 + 流转矩阵）。保存后视为自定义配置，系统不再用内置种子覆盖；流转全程在 MAP 内执行。
        </div>
      )}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex items-center gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="流程名称" className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
        <button type="button" onClick={() => void save()} disabled={saving} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50">
          {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
        </button>
        {msg && <span className="text-xs text-white/50">{msg}</span>}
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-2">
        <div className="text-sm font-medium text-white/70">状态</div>
        {states.length === 0 && <div className="text-xs text-white/35 py-2 text-center">还没有状态，先添加状态再连流转。</div>}
        {states.map((s, i) => (
          <div key={i} className="flex items-center gap-2 flex-wrap">
            <input type="color" value={s.color ?? '#60A5FA'} onChange={(e) => updateState(i, { color: e.target.value })} className="w-7 h-7 rounded bg-transparent border border-white/10" />
            <input value={s.label} onChange={(e) => updateState(i, { label: e.target.value })} placeholder="状态名（如：待评审）" className="flex-1 min-w-[120px] px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
            <input value={s.key} onChange={(e) => updateState(i, { key: e.target.value })} placeholder="key" className="w-28 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none" />
            <label className="flex items-center gap-1 text-xs text-white/50"><input type="checkbox" checked={s.isInitial} onChange={(e) => updateState(i, { isInitial: e.target.checked })} className="accent-cyan-500" /> 初始</label>
            <label className="flex items-center gap-1 text-xs text-white/50"><input type="checkbox" checked={s.isFinal} onChange={(e) => updateState(i, { isFinal: e.target.checked })} className="accent-cyan-500" /> 终态</label>
            <input type="number" min={0} value={s.slaHours ?? ''} onChange={(e) => updateState(i, { slaHours: e.target.value ? Number(e.target.value) : null })} placeholder="SLA小时" title="停留超过此小时数视为超时（空=不限）" className="w-20 px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none" />
            <input type="number" min={0} value={s.wipLimit ?? ''} onChange={(e) => updateState(i, { wipLimit: e.target.value ? Number(e.target.value) : null })} placeholder="WIP" title="看板该列在制上限（空=不限）" className="w-16 px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none" />
            <button type="button" onClick={() => removeState(i)} className="text-white/30 hover:text-red-300"><Trash2 size={14} /></button>
          </div>
        ))}
        <button type="button" onClick={addState} className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm">
          <Plus size={14} /> 添加状态
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-2">
        <div className="text-sm font-medium text-white/70">流转（from → to）</div>
        {transitions.length === 0 && <div className="text-xs text-white/35 py-2 text-center">还没有流转动作。</div>}
        {transitions.map((t, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-white/8 bg-black/15 p-3">
            <div className="flex items-center gap-2 flex-wrap">
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
              <label className="flex items-center gap-1 text-xs text-white/50" title="触发该流转时自动把处理人指派给操作人本人"><input type="checkbox" checked={t.autoAssignToActor ?? false} onChange={(e) => updateTransition(i, { autoAssignToActor: e.target.checked })} className="accent-cyan-500" /> 自动认领</label>
              <button type="button" onClick={() => removeTransition(i)} className="text-white/30 hover:text-red-300"><Trash2 size={14} /></button>
            </div>
            <div className="flex flex-col gap-1.5 pl-0.5">
              <span className="text-[11px] text-white/40">允许角色（不选=不限）</span>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {WORKFLOW_ROLE_OPTIONS.map((role) => (
                  <label key={role} className="flex items-center gap-1 text-[11px] text-white/50">
                    <input type="checkbox" checked={(t.allowedRoles ?? []).includes(role)} onChange={() => updateTransition(i, { allowedRoles: toggleWorkflowListItem(t.allowedRoles, role) })} className="accent-cyan-500" />
                    {WORKFLOW_TRANSITION_ROLE_LABELS[role as WorkflowTransitionRole]}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 pl-0.5">
              <span className="text-[11px] text-white/40">流转前必填字段</span>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {WORKFLOW_FIELD_OPTIONS.map((fieldKey) => (
                  <label key={fieldKey} className="flex items-center gap-1 text-[11px] text-white/50">
                    <input type="checkbox" checked={(t.requiredFieldKeys ?? []).includes(fieldKey)} onChange={() => updateTransition(i, { requiredFieldKeys: toggleWorkflowListItem(t.requiredFieldKeys, fieldKey) })} className="accent-cyan-500" />
                    {WORKFLOW_TRANSITION_FIELD_LABELS[fieldKey as WorkflowTransitionFieldKey]}
                  </label>
                ))}
              </div>
            </div>
          </div>
        ))}
        <button type="button" onClick={addTransition} disabled={states.length === 0} className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm disabled:opacity-40">
          <Plus size={14} /> 添加流转
        </button>
      </div>
    </div>
  );
}
