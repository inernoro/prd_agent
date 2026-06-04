/**
 * 产品管理智能体 — 看板视图（按工作流状态分列，拖拽卡片即流转，P3）。
 *
 * 列 = 工作流状态(按 sortOrder)；卡片 = 该状态下的需求/功能。拖卡片到目标列 →
 * 解析「目标状态可达的流转动作」→ 调 /transition 落库。卡片显示 SLA 停留时长，超时高亮。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, AlertTriangle, User } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getUsers } from '@/services';
import type { AdminUser } from '@/types/admin';
import { listRequirements, listFeatures, transition } from '@/services/real/productAgent';
import { useEffectiveWorkflow } from './DynamicForm';
import { ITEM_GRADE_LABEL } from './types';
import type { Requirement, Feature } from './types';
import { slaInfo } from './sla';

type Item = (Requirement | Feature) & { title: string; currentState?: string | null; grade: string; assigneeId?: string | null; stateEnteredAt?: string | null };

export function KanbanBoard({ productId, entityType }: { productId: string; entityType: 'requirement' | 'feature' }) {
  const navigate = useNavigate();
  const { workflow } = useEffectiveWorkflow(entityType, productId);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = entityType === 'requirement' ? await listRequirements(productId) : await listFeatures(productId);
    if (res.success) setItems(res.data.items as Item[]);
    setLoading(false);
  }, [productId, entityType]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void getUsers({ page: 1, pageSize: 200 }).then((res) => {
      if (res.success) setUsers(res.data.items);
    });
  }, []);

  const nameOf = useMemo(() => {
    const map = new Map(users.map((u) => [u.userId, u.displayName || u.username]));
    return (id?: string | null) => (id ? map.get(id) ?? id : '');
  }, [users]);

  const states = useMemo(() => [...(workflow?.states ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [workflow]);
  const slaOf = (key?: string | null) => states.find((s) => s.key === key)?.slaHours ?? null;
  const initialKey = states.find((s) => s.isInitial)?.key ?? states[0]?.key;

  const byState = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const s of states) map.set(s.key, []);
    for (const it of items) {
      const key = states.some((s) => s.key === it.currentState) ? it.currentState! : initialKey;
      if (key && map.has(key)) map.get(key)!.push(it);
    }
    return map;
  }, [items, states, initialKey]);

  const drop = async (targetKey: string) => {
    const item = items.find((i) => i.id === dragId);
    setDragId(null);
    if (!item || item.currentState === targetKey) return;
    const tr = (workflow?.transitions ?? []).find(
      (t) => t.toState === targetKey && (!t.fromState || t.fromState === (item.currentState ?? initialKey)),
    );
    if (!tr) {
      setHint(`不能直接从「${stateLabel(item.currentState)}」拖到「${stateLabel(targetKey)}」：没有定义对应的流转`);
      setTimeout(() => setHint(null), 3500);
      return;
    }
    if (tr.requireComment) {
      const c = window.prompt(`「${tr.label}」需要填写备注`);
      if (c == null) return;
      const res = await transition({ entityType, entityId: item.id, transitionKey: tr.key, comment: c });
      if (res.success) await reload();
      return;
    }
    const res = await transition({ entityType, entityId: item.id, transitionKey: tr.key });
    if (res.success) await reload();
    else setHint(res.error?.message ?? '流转失败');
  };

  const stateLabel = (key?: string | null) => states.find((s) => s.key === key)?.label ?? key ?? '未设置';

  if (!workflow) return <div className="text-sm text-white/40 py-10 text-center">该对象类型还没有可用的工作流，去「设置 → 流程模板」配置。</div>;
  if (loading) return <MapSectionLoader text="正在加载看板…" />;

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      {hint && <div className="shrink-0 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-1.5">{hint}</div>}
      <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto pb-2" style={{ overscrollBehavior: 'contain' }}>
        {states.map((s) => {
          const colItems = byState.get(s.key) ?? [];
          return (
            <div
              key={s.key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(s.key)}
              className="shrink-0 w-72 flex flex-col rounded-xl border border-white/10 bg-white/[0.02]"
            >
              <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-white/8">
                <span className="w-2 h-2 rounded-full" style={{ background: s.color ?? '#9ca3af' }} />
                <span className="text-sm text-white/80">{s.label}</span>
                <span className="text-[11px] text-white/40">{colItems.length}</span>
                {s.slaHours ? <span className="ml-auto text-[10px] text-white/30">SLA {s.slaHours}h</span> : null}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2" style={{ overscrollBehavior: 'contain' }}>
                {colItems.length === 0 ? (
                  <div className="text-[11px] text-white/25 text-center py-6">空</div>
                ) : (
                  colItems.map((it) => {
                    const sla = slaInfo(it.stateEnteredAt, slaOf(it.currentState));
                    return (
                      <div
                        key={it.id}
                        draggable
                        onDragStart={() => setDragId(it.id)}
                        onClick={() => navigate(`/product-agent/p/${productId}/${entityType}/${it.id}`)}
                        className="cursor-grab active:cursor-grabbing rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] p-2.5 flex flex-col gap-1.5"
                      >
                        <div className="text-sm text-white/90 line-clamp-2">{it.title}</div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">{ITEM_GRADE_LABEL[it.grade as keyof typeof ITEM_GRADE_LABEL] ?? it.grade}</span>
                          {it.assigneeId && (
                            <span className="text-[10px] text-white/50 inline-flex items-center gap-0.5"><User size={10} /> {nameOf(it.assigneeId)}</span>
                          )}
                          {sla && (
                            <span className={`ml-auto text-[10px] inline-flex items-center gap-0.5 ${sla.overdue ? 'text-red-300' : 'text-white/35'}`}>
                              {sla.overdue ? <AlertTriangle size={10} /> : <Clock size={10} />} {sla.label}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
