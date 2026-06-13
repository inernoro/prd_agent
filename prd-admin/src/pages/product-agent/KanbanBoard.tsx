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
import { searchDirectoryUsers } from '@/services';
import type { AdminUser } from '@/types/admin';
import { getProduct, listRequirements, listFeatures, transition } from '@/services/real/productAgent';
import { useAuthStore } from '@/stores/authStore';
import { useEffectiveWorkflow } from './DynamicForm';
import { ITEM_GRADE_LABEL } from './types';
import type { Requirement, Feature, Product, WorkflowTransition } from './types';
import { slaInfo } from './sla';
import { normalizeRequirementStateKey, resolveRequirementStateLabel } from './requirementWorkflowUtils';
import {
  canExecuteWorkflowTransition,
  isGlobalProductAdmin,
  transitionNeedsDialog,
  type ProductWorkflowContext,
} from './workflowTransitionGuard';
import { WorkflowTransitionDialog } from './WorkflowTransitionDialog';
import './product-cards.css';

type Item = (Requirement | Feature) & { title: string; currentState?: string | null; grade: string; assigneeId?: string | null; stateEnteredAt?: string | null };

export function KanbanBoard({ productId, entityType }: { productId: string; entityType: 'requirement' | 'feature' }) {
  const navigate = useNavigate();
  const { workflow } = useEffectiveWorkflow(entityType, productId);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [swimlane, setSwimlane] = useState<'none' | 'assignee' | 'grade'>('none');
  const showGrade = entityType === 'requirement';
  useEffect(() => {
    if (!showGrade) setSwimlane((s) => (s === 'grade' ? 'none' : s));
  }, [showGrade]);
  const [product, setProduct] = useState<ProductWorkflowContext | null>(null);
  const [pendingTransition, setPendingTransition] = useState<{ item: Item; transition: WorkflowTransition } | null>(null);

  const currentUserId = useAuthStore((s) => s.user?.userId ?? '');
  const permissions = useAuthStore((s) => s.permissions);
  const isGlobalAdmin = isGlobalProductAdmin(permissions);

  useEffect(() => {
    void getProduct(productId).then((res) => {
      if (res.success) {
        setProduct({
          ownerId: res.data.ownerId,
          ownerIds: res.data.ownerIds,
          adminIds: res.data.adminIds,
          memberIds: res.data.memberIds,
        });
      }
    });
  }, [productId]);

  const reload = useCallback(async () => {
    const res = entityType === 'requirement' ? await listRequirements(productId) : await listFeatures(productId);
    if (res.success) setItems(res.data.items as Item[]);
    setLoading(false);
  }, [productId, entityType]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // 处理人姓名走 /api/teams/search-users（仅需登录），普通产品成员也能拿到，不用管理员专用的 /api/users。
  useEffect(() => {
    void searchDirectoryUsers('', 200).then((res) => {
      if (res.success) {
        setUsers(res.data.items.map((u) => ({
          userId: u.userId,
          username: u.username,
          displayName: u.displayName,
          avatarFileName: u.avatarFileName,
          role: '' as AdminUser['role'],
          status: 'Active' as AdminUser['status'],
          createdAt: '',
        })));
      }
    });
  }, []);

  const nameOf = useMemo(() => {
    const map = new Map(users.map((u) => [u.userId, u.displayName || u.username]));
    return (id?: string | null) => (id ? map.get(id) ?? id : '');
  }, [users]);

  const states = useMemo(() => [...(workflow?.states ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [workflow]);
  const slaOf = (key?: string | null) => states.find((s) => s.key === key)?.slaHours ?? null;
  const initialKey = states.find((s) => s.isInitial)?.key ?? states[0]?.key;

  const drop = async (targetKey: string) => {
    const item = items.find((i) => i.id === dragId);
    setDragId(null);
    if (!item) return;
    const fromKey = entityType === 'requirement'
      ? normalizeRequirementStateKey(item.currentState ?? initialKey, workflow)
      : (item.currentState ?? initialKey);
    if (fromKey === targetKey) return;
    const tr = (workflow?.transitions ?? []).find(
      (t) => t.toState === targetKey && (!t.fromState || t.fromState === fromKey),
    );
    if (!tr) {
      setHint(`不能直接从「${stateLabel(item.currentState)}」拖到「${stateLabel(targetKey)}」：没有定义对应的流转`);
      setTimeout(() => setHint(null), 3500);
      return;
    }
    const entity = {
      ownerId: 'ownerId' in item ? item.ownerId : undefined,
      assigneeId: item.assigneeId,
      title: item.title,
      grade: item.grade,
      versionIds: 'versionIds' in item ? item.versionIds : [],
    };
    if (product && currentUserId && !canExecuteWorkflowTransition(currentUserId, tr, product, isGlobalAdmin, entity)) {
      setHint('当前账号无权执行该流转');
      setTimeout(() => setHint(null), 3500);
      return;
    }
    if (transitionNeedsDialog(tr, entity)) {
      setPendingTransition({ item, transition: tr });
      return;
    }
    const res = await transition({ entityType, entityId: item.id, transitionKey: tr.key });
    if (res.success) await reload();
    else {
      setHint(res.error?.message ?? '流转失败');
      setTimeout(() => setHint(null), 3500);
    }
  };

  const stateLabel = (key?: string | null) => {
    if (entityType === 'requirement') return resolveRequirementStateLabel(key, workflow);
    return states.find((s) => s.key === key)?.label ?? key ?? '未设置';
  };
  const colKeyOf = (it: Item) => {
    const raw = it.currentState ?? initialKey;
    const key = entityType === 'requirement' ? normalizeRequirementStateKey(raw, workflow) : raw;
    return states.some((s) => s.key === key) ? key : initialKey;
  };

  // 泳道分组
  const lanes = useMemo<{ key: string; label: string; items: Item[] }[]>(() => {
    if (swimlane === 'none') return [{ key: 'all', label: '', items }];
    if (showGrade && swimlane === 'grade') {
      return ['p0', 'p1', 'p2', 'p3']
        .map((g) => ({ key: g, label: ITEM_GRADE_LABEL[g as keyof typeof ITEM_GRADE_LABEL] ?? g, items: items.filter((i) => i.grade === g) }))
        .filter((l) => l.items.length > 0);
    }
    // by assignee
    const groups = new Map<string, Item[]>();
    for (const it of items) {
      const k = it.assigneeId || '__none__';
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(it);
    }
    return [...groups.entries()].map(([k, its]) => ({ key: k, label: k === '__none__' ? '未指派' : nameOf(k), items: its }));
  }, [swimlane, items, nameOf, showGrade]);

  const totalOf = (stateKey: string) => items.filter((it) => colKeyOf(it) === stateKey).length;

  if (!workflow) return <div className="text-sm text-white/40 py-10 text-center">该对象类型还没有可用的工作流，去「应用 → 应用配置」配置。</div>;
  if (loading) return <MapSectionLoader text="正在加载看板…" />;

  const showLane = swimlane !== 'none';

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2">
        <span className="text-[11px] text-white/40">泳道</span>
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {(['none', 'assignee', ...(showGrade ? (['grade'] as const) : [])] as const).map((m) => (
            <button key={m} onClick={() => setSwimlane(m)} className={`px-2.5 py-1 text-xs ${swimlane === m ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>
              {m === 'none' ? '无' : m === 'assignee' ? '按处理人' : '按分级'}
            </button>
          ))}
        </div>
        {hint && <span className="text-xs text-amber-300/90 ml-2">{hint}</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-auto pb-2" style={{ overscrollBehavior: 'contain' }}>
        <div className="inline-block min-w-full">
          {/* 列头（含 WIP） */}
          <div className="flex gap-3 sticky top-0 z-10 bg-[#0f1014] pb-2">
            {showLane && <div className="w-24 shrink-0" />}
            {states.map((s) => {
              const total = totalOf(s.key);
              const over = s.wipLimit != null && s.wipLimit > 0 && total > s.wipLimit;
              return (
                <div key={s.key} className="shrink-0 w-72 flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.03]">
                  <span className="w-2 h-2 rounded-full" style={{ background: s.color ?? '#9ca3af' }} />
                  <span className="text-sm text-white/80">{s.label}</span>
                  <span className={`text-[11px] ${over ? 'text-red-300 font-semibold' : 'text-white/40'}`}>
                    {total}{s.wipLimit ? ` / ${s.wipLimit}` : ''}
                  </span>
                  {over && <AlertTriangle size={12} className="text-red-300" />}
                  {s.slaHours ? <span className="ml-auto text-[10px] text-white/30">SLA {s.slaHours}h</span> : null}
                </div>
              );
            })}
          </div>

          {/* 泳道 + 列 */}
          {lanes.map((lane) => (
            <div key={lane.key} className="flex gap-3 mb-2">
              {showLane && (
                <div className="w-24 shrink-0 pt-2 pr-1 text-right">
                  <div className="text-xs text-white/70 truncate" title={lane.label}>{lane.label}</div>
                  <div className="text-[10px] text-white/35">{lane.items.length}</div>
                </div>
              )}
              {states.map((s) => {
                const colItems = lane.items.filter((it) => colKeyOf(it) === s.key);
                return (
                  <div
                    key={s.key}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => drop(s.key)}
                    className="shrink-0 w-72 min-h-[80px] rounded-xl border border-white/8 bg-white/[0.01] p-2 flex flex-col gap-2"
                  >
                    {colItems.length === 0 ? (
                      <div className="text-[11px] text-white/20 text-center py-4">—</div>
                    ) : (
                      colItems.map((it) => {
                        const sla = slaInfo(it.stateEnteredAt, slaOf(it.currentState));
                        return (
                          <div
                            key={it.id}
                            draggable
                            onDragStart={() => setDragId(it.id)}
                            onClick={() => navigate(`/product-agent/p/${productId}/${entityType}/${it.id}`)}
                            className="pa-row cursor-grab active:cursor-grabbing rounded-lg border border-white/10 bg-white/[0.03] p-2.5 flex flex-col gap-1.5"
                          >
                            <div className="text-sm text-white/90 line-clamp-2">{it.title}</div>
                            <div className="flex items-center gap-2 flex-wrap">
                              {showGrade && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">{ITEM_GRADE_LABEL[it.grade as keyof typeof ITEM_GRADE_LABEL] ?? it.grade}</span>
                              )}
                              {it.assigneeId && swimlane !== 'assignee' && (
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
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {pendingTransition && (
        <WorkflowTransitionDialog
          open
          productId={productId}
          workflow={workflow}
          entityType={entityType}
          entityId={pendingTransition.item.id}
          transition={pendingTransition.transition}
          entity={{
            ownerId: 'ownerId' in pendingTransition.item ? pendingTransition.item.ownerId : undefined,
            assigneeId: pendingTransition.item.assigneeId,
            title: pendingTransition.item.title,
            grade: pendingTransition.item.grade,
            versionIds: 'versionIds' in pendingTransition.item ? pendingTransition.item.versionIds : [],
          }}
          onClose={() => setPendingTransition(null)}
          onDone={() => void reload()}
        />
      )}
    </div>
  );
}
