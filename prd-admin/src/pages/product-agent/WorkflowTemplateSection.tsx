/**
 * 产品管理智能体 — 应用配置（TAPD 风格流转矩阵 + 状态条）。
 *
 * 主页左侧一级「应用」入口。矩阵勾选启用流转，设置图标配置角色/必填字段。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Save, Settings2, Trash2 } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { systemDialog } from '@/lib/systemDialog';
import { listProducts, listWorkflowDefinitions, upsertWorkflowDefinition } from '@/services/real/productAgent';
import type { Product, WorkflowState, WorkflowTransition, ProductEntityType } from './types';
import {
  WorkflowTransitionRuleModal,
  createDefaultMatrixTransition,
  findMatrixTransition,
} from './WorkflowTransitionRuleModal';

const ENTITY_TYPES: { value: ProductEntityType; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'feature', label: '功能' },
  { value: 'version', label: '版本' },
];

function defaultWorkflowName(entityType: ProductEntityType): string {
  const label = ENTITY_TYPES.find((e) => e.value === entityType)?.label ?? '对象';
  return `${label}工作流`;
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
  /** 仅用于保存时回写 DB 已有名称，不在 UI 展示 */
  const [persistedName, setPersistedName] = useState('');
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [transitions, setTransitions] = useState<WorkflowTransition[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [statesOpen, setStatesOpen] = useState(true);
  const [ruleModal, setRuleModal] = useState<{
    transition: WorkflowTransition;
    from: WorkflowState;
    to: WorkflowState;
  } | null>(null);

  const sortedStates = useMemo(
    () => [...states].sort((a, b) => a.sortOrder - b.sortOrder),
    [states],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listWorkflowDefinitions({ entityType, productId: productId ?? undefined });
    if (res.success) {
      const match = res.data.items.find((w) => (w.productId ?? null) === productId && w.isDefault)
        ?? res.data.items.find((w) => (w.productId ?? null) === productId);
      if (match) {
        setId(match.id);
        setPersistedName(match.name);
        setStates([...match.states].sort((a, b) => a.sortOrder - b.sortOrder));
        setTransitions([...match.transitions]);
      } else {
        setId(undefined);
        setPersistedName('');
        setStates([]);
        setTransitions([]);
      }
    }
    setLoading(false);
  }, [entityType, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setMatrixTransition = (from: WorkflowState, to: WorkflowState, enabled: boolean) => {
    if (from.key === to.key) return;
    setTransitions((prev) => {
      const rest = prev.filter((t) => !(t.fromState === from.key && t.toState === to.key));
      if (!enabled) return rest;
      const existing = findMatrixTransition(prev, from.key, to.key);
      return [...rest, createDefaultMatrixTransition(from, to, existing)];
    });
  };

  const saveRule = (patch: WorkflowTransition) => {
    setTransitions((prev) => prev.map((t) => (t.key === patch.key ? patch : t)));
  };

  const addState = () => {
    setStates((s) => [
      ...s,
      {
        key: `state_${s.length + 1}`,
        label: '',
        description: '',
        color: '#60A5FA',
        isInitial: s.length === 0,
        isFinal: false,
        sortOrder: s.length,
      },
    ]);
  };

  const updateState = (i: number, patch: Partial<WorkflowState>) => {
    setStates((s) => s.map((x, idx) => {
      if (idx !== i) {
        if (patch.isInitial) return { ...x, isInitial: false };
        return x;
      }
      return { ...x, ...patch };
    }));
  };

  const confirmRemoveState = async (i: number) => {
    const target = states[i];
    if (!target) return;
    const refCount = transitions.filter((t) => t.fromState === target.key || t.toState === target.key).length;
    const ok = await systemDialog.confirm({
      title: '删除状态',
      message: refCount > 0
        ? `确定删除「${target.label || target.key}」？将同时移除 ${refCount} 条相关流转。`
        : `确定删除「${target.label || target.key}」？`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const removedKey = target.key;
    setStates((s) => s.filter((_, idx) => idx !== i));
    setTransitions((t) => t.filter((tr) => tr.fromState !== removedKey && tr.toState !== removedKey));
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await upsertWorkflowDefinition({
      id,
      name: persistedName.trim() || defaultWorkflowName(entityType),
      entityType,
      states: states.map((s, idx) => ({ ...s, sortOrder: idx })),
      transitions,
      isDefault: true,
      productId,
    });
    setSaving(false);
    if (res.success) {
      setMsg('已更新');
      await load();
    } else {
      setMsg(res.error?.message ?? '保存失败');
    }
  };

  if (loading) return <MapSectionLoader text="正在加载流程…" />;

  return (
    <div className="flex flex-col gap-4">
      {entityType === 'requirement' && (
        <p className="text-xs text-white/45 leading-relaxed">
          工作流流转设置用于配置各状态间的先后流转关系。在矩阵中勾选即可启用流转；点击
          <Settings2 size={12} className="inline mx-0.5 -mt-px" />
          可设置授权角色与必填字段。
        </p>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-medium text-white/85">流转设置</h3>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || sortedStates.length === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-cyan-500 text-slate-950 text-sm font-medium hover:bg-cyan-400 disabled:opacity-40"
        >
          {saving ? <MapSpinner size={14} /> : <Save size={14} />}
          更新
        </button>
        {msg && <span className="text-xs text-white/50">{msg}</span>}
      </div>

      {sortedStates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 py-10 text-center text-sm text-white/40">
          还没有状态，请先展开下方「状态定义」添加状态。
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.03]">
                <th className="sticky left-0 z-10 bg-[#16181d] px-3 py-2.5 text-left font-medium text-white/50 w-[148px] border-r border-white/10">
                  从 \ 到
                </th>
                {sortedStates.map((col) => (
                  <th
                    key={col.key}
                    className="px-2 py-2.5 text-center font-medium text-white/70 min-w-[88px]"
                    title={col.key}
                  >
                    <span className="inline-flex items-center gap-1.5 justify-center">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: col.color ?? '#60A5FA' }}
                      />
                      {col.label || col.key}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedStates.map((from) => (
                <tr key={from.key} className="border-b border-white/5 last:border-0">
                  <td className="sticky left-0 z-10 bg-[#14161b] px-3 py-2 text-white/55 border-r border-white/10 whitespace-nowrap">
                    从【{from.label || from.key}】可流转到
                  </td>
                  {sortedStates.map((to) => {
                    const isSelf = from.key === to.key;
                    const tr = findMatrixTransition(transitions, from.key, to.key);
                    const enabled = !!tr;
                    return (
                      <td key={to.key} className="px-2 py-2 text-center align-middle">
                        {isSelf ? (
                          <span className="inline-block w-4 h-4 rounded bg-white/[0.04]" title="不可自流转" />
                        ) : (
                          <div className="inline-flex items-center justify-center gap-1">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) => setMatrixTransition(from, to, e.target.checked)}
                              className="accent-cyan-500 w-4 h-4 cursor-pointer"
                              aria-label={`${from.label} 到 ${to.label}`}
                            />
                            {enabled && tr && (
                              <button
                                type="button"
                                onClick={() => setRuleModal({ transition: tr, from, to })}
                                className="p-0.5 rounded text-cyan-400/80 hover:text-cyan-300 hover:bg-cyan-500/10"
                                title="设置流转附加字段及授权用户"
                              >
                                <Settings2 size={14} />
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-white/35 flex items-center gap-1">
        注：点击
        <Settings2 size={12} className="text-cyan-400/70" />
        图标，可以设置流转的附加字段及授权用户。
      </p>

      <div className="rounded-lg border border-white/10 bg-white/[0.02]">
        <button
          type="button"
          onClick={() => setStatesOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-white/70 hover:bg-white/[0.03]"
        >
          {statesOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          状态定义
          <span className="text-xs text-white/35">（{sortedStates.length} 个状态）</span>
        </button>
        {statesOpen && (
          <div className="px-3 pb-3 pt-2 border-t border-white/5">
            {sortedStates.length === 0 ? (
              <p className="text-xs text-white/35 py-2 text-center">还没有状态，点击下方添加。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] table-fixed border-collapse text-xs">
                  <colgroup>
                    <col style={{ width: 40 }} />
                    <col style={{ width: 112 }} />
                    <col />
                    <col style={{ width: 72 }} />
                    <col style={{ width: 72 }} />
                    <col style={{ width: 44 }} />
                  </colgroup>
                  <thead>
                    <tr className="text-[11px] text-white/40 border-b border-white/8">
                      <th className="pb-2 font-medium text-left">颜色</th>
                      <th className="pb-2 font-medium text-left">状态名称</th>
                      <th className="pb-2 font-medium text-left">状态说明</th>
                      <th className="pb-2 font-medium text-center">起始状态</th>
                      <th className="pb-2 font-medium text-center">结束状态</th>
                      <th className="pb-2 font-medium text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStates.map((s, i) => {
                      const idx = states.findIndex((x) => x.key === s.key);
                      const row = idx >= 0 ? idx : i;
                      return (
                        <tr key={s.key} className="border-b border-white/5 last:border-0">
                          <td className="py-1.5 pr-2 align-middle">
                            <input
                              type="color"
                              value={s.color ?? '#60A5FA'}
                              onChange={(e) => updateState(row, { color: e.target.value })}
                              title="状态颜色"
                              className="w-8 h-8 rounded bg-transparent border border-white/10 cursor-pointer"
                            />
                          </td>
                          <td className="py-1.5 pr-2 align-middle">
                            <input
                              value={s.label}
                              onChange={(e) => updateState(row, { label: e.target.value })}
                              placeholder="如：待评审"
                              className="w-full min-w-0 px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
                            />
                          </td>
                          <td className="py-1.5 pr-2 align-middle">
                            <input
                              value={s.description ?? ''}
                              onChange={(e) => updateState(row, { description: e.target.value })}
                              placeholder="简要说明该状态含义"
                              className="w-full min-w-0 px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm text-white/80 outline-none focus:border-cyan-500/40"
                            />
                          </td>
                          <td className="py-1.5 align-middle text-center">
                            <input
                              type="checkbox"
                              checked={s.isInitial}
                              onChange={(e) => updateState(row, { isInitial: e.target.checked })}
                              title="新建时的默认状态（仅一个）"
                              className="accent-cyan-500"
                            />
                          </td>
                          <td className="py-1.5 align-middle text-center">
                            <input
                              type="checkbox"
                              checked={s.isFinal}
                              onChange={(e) => updateState(row, { isFinal: e.target.checked })}
                              title="流程结束状态"
                              className="accent-cyan-500"
                            />
                          </td>
                          <td className="py-1.5 align-middle text-center">
                            <button
                              type="button"
                              onClick={() => void confirmRemoveState(row)}
                              title="删除状态"
                              className="text-white/30 hover:text-red-300 p-1"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <button
              type="button"
              onClick={addState}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm"
            >
              <Plus size={14} /> 添加状态
            </button>
          </div>
        )}
      </div>

      {ruleModal && (
        <WorkflowTransitionRuleModal
          open
          transition={ruleModal.transition}
          fromState={ruleModal.from}
          toState={ruleModal.to}
          onClose={() => setRuleModal(null)}
          onSave={saveRule}
        />
      )}
    </div>
  );
}
