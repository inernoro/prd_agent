/**
 * 产品管理智能体 — 大版本升级申请 tab（P2）。
 *
 * 可配置申请表单：标题 + 理由 + 关联需求/功能（多选）。提交后走状态流转
 * （草稿→已提交→已批准/已驳回）。表单字段集合后续可由 ProductFormTemplate(upgrade-request) 扩展。
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, ArrowUpCircle } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import './product-cards.css';
import {
  listUpgradeRequests,
  createUpgradeRequest,
  updateUpgradeRequest,
  deleteUpgradeRequest,
  listRequirements,
  listFeatures,
  type UpgradeRequest,
} from '@/services/real/productAgent';
import type { Requirement, Feature } from './types';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  submitted: '已提交',
  approved: '已批准',
  rejected: '已驳回',
};
const STATUS_COLOR: Record<string, string> = {
  draft: 'rgba(255,255,255,0.4)',
  submitted: '#60A5FA',
  approved: '#4ADE80',
  rejected: '#F87171',
};
const NEXT_STATUS: Record<string, { key: string; label: string }[]> = {
  draft: [{ key: 'submitted', label: '提交' }],
  submitted: [
    { key: 'approved', label: '批准' },
    { key: 'rejected', label: '驳回' },
  ],
  approved: [],
  rejected: [{ key: 'submitted', label: '重新提交' }],
};

export function UpgradeRequestsTab({ productId }: { productId: string }) {
  const [items, setItems] = useState<UpgradeRequest[]>([]);
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [selReqs, setSelReqs] = useState<Set<string>>(new Set());
  const [selFeatures, setSelFeatures] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const [u, r, f] = await Promise.all([listUpgradeRequests(productId), listRequirements(productId), listFeatures(productId)]);
    if (u.success) setItems(u.data.items);
    if (r.success) setReqs(r.data.items);
    if (f.success) setFeatures(f.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const create = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const res = await createUpgradeRequest(productId, {
      title: title.trim(),
      reason: reason.trim() || undefined,
      requirementIds: Array.from(selReqs),
      featureIds: Array.from(selFeatures),
    });
    setSaving(false);
    if (res.success) {
      setTitle('');
      setReason('');
      setSelReqs(new Set());
      setSelFeatures(new Set());
      setCreating(false);
      await reload();
    }
  };

  const changeStatus = async (u: UpgradeRequest, status: string) => {
    await updateUpgradeRequest(u.id, { status });
    await reload();
  };

  if (loading) return <MapSectionLoader text="正在加载升级申请…" />;

  return (
    <div className="flex flex-col gap-3">
      {!creating ? (
        <button
          onClick={() => setCreating(true)}
          className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
        >
          <Plus size={15} /> 发起大版本升级申请
        </button>
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 flex flex-col gap-3">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="升级申请标题，如：v3.0 大版本升级"
            className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
          />
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="升级理由 / 背景"
            rows={2}
            className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 resize-none"
          />
          <PickList title={`关联需求（${selReqs.size}）`} items={reqs.map((r) => ({ id: r.id, label: r.title }))} selected={selReqs} toggle={(id) => toggle(selReqs, setSelReqs, id)} empty="无需求" />
          <PickList title={`关联功能（${selFeatures.size}）`} items={features.map((f) => ({ id: f.id, label: f.title }))} selected={selFeatures} toggle={(id) => toggle(selFeatures, setSelFeatures, id)} empty="无功能" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setCreating(false)} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">
              取消
            </button>
            <button
              onClick={create}
              disabled={!title.trim() || saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
            >
              {saving ? <MapSpinner size={14} /> : <ArrowUpCircle size={14} />} 创建
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-center text-white/40 text-xs py-10 px-6">
          还没有升级申请。大版本升级走可配置的申请表单，关联本次要交付的需求与功能，提交后走审批流转。
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((u) => (
            <div key={u.id} className="pa-row rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white/90 truncate">{u.title}</span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ color: STATUS_COLOR[u.status] ?? '#fff', background: 'rgba(255,255,255,0.06)' }}
                    >
                      {STATUS_LABEL[u.status] ?? u.status}
                    </span>
                  </div>
                  <div className="text-[11px] text-white/40 mt-0.5 truncate">
                    {u.upgradeNo} · 需求 {u.requirementIds.length} · 功能 {u.featureIds.length}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {(NEXT_STATUS[u.status] ?? []).map((n) => (
                    <button
                      key={n.key}
                      onClick={() => void changeStatus(u, n.key)}
                      className="px-2 py-0.5 rounded-md text-xs text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10"
                    >
                      {n.label}
                    </button>
                  ))}
                  <button
                    onClick={async () => {
                      await deleteUpgradeRequest(u.id);
                      await reload();
                    }}
                    className="text-white/30 hover:text-red-300"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {u.reason && <div className="text-[11px] text-white/50 mt-1.5 line-clamp-2">{u.reason}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PickList({
  title,
  items,
  selected,
  toggle,
  empty,
}: {
  title: string;
  items: { id: string; label: string }[];
  selected: Set<string>;
  toggle: (id: string) => void;
  empty: string;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-white/50 mb-1">{title}</div>
      {items.length === 0 ? (
        <div className="text-[11px] text-white/30 py-1">{empty}</div>
      ) : (
        <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
          {items.map((it) => (
            <label key={it.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 cursor-pointer">
              <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} className="accent-cyan-500" />
              <span className="text-sm text-white/80 truncate">{it.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
