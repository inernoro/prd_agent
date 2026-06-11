/**
 * 产品管理智能体 — 工作台右栏「快捷操作」卡片 + 配置弹窗。
 *
 * 操作目录来自 quickActionRegistry（SSOT）；用户配置（id 有序列表）云端同步
 * （UserPreferences.ProductAgentPreferences.QuickActionIds，用户级跨产品共用）。
 * 配置弹窗遵 frontend-modal 规则：createPortal、inline 尺寸、min-h-0 滚动、ESC/遮罩关闭。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Zap, Settings2, X, Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getProductAgentPreferences, updateProductAgentQuickActions } from '@/services/real/productAgent';
import {
  QUICK_ACTION_REGISTRY,
  QUICK_ACTION_GROUP_LABEL,
  DEFAULT_QUICK_ACTION_IDS,
  resolveQuickActions,
  type QuickActionDef,
} from './quickActionRegistry';

export function QuickActionsCard({ productId, gotoTab }: { productId: string; gotoTab: (tab: string) => void }) {
  const navigate = useNavigate();
  const [ids, setIds] = useState<string[]>(DEFAULT_QUICK_ACTION_IDS);
  const [loading, setLoading] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getProductAgentPreferences();
      if (!alive) return;
      // null = 从未配置走默认；空数组 = 用户主动清空，尊重之
      if (res.success && res.data.quickActionIds != null) setIds(res.data.quickActionIds);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const actions = useMemo(() => resolveQuickActions(ids), [ids]);
  const ctx = { productId, navigate, gotoTab };

  return (
    <div className="shrink-0 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Zap size={15} className="text-amber-300" />
        <span className="text-sm font-semibold text-white/80">快捷操作</span>
        <button
          onClick={() => setConfigOpen(true)}
          className="ml-auto flex items-center gap-1 text-[11px] text-white/45 hover:text-white/85 px-1.5 py-1 rounded hover:bg-white/5"
          title="配置展示哪些快捷操作"
        >
          <Settings2 size={13} /> 配置
        </button>
      </div>
      {loading ? (
        <div className="flex justify-center py-4"><MapSpinner size={18} /></div>
      ) : actions.length === 0 ? (
        <div className="text-[12px] text-white/35 py-3 text-center">还没有快捷操作，点右上角「配置」添加。</div>
      ) : (
        // 配置很多时卡片内部滚动，避免把右栏「我的待办」挤到零高
        <div className="grid grid-cols-2 gap-2" style={{ maxHeight: 280, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {actions.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.id}
                onClick={() => a.run(ctx)}
                className="pa-row flex items-center gap-2 px-2.5 py-2 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-cyan-500/10 hover:border-cyan-500/30 text-left"
              >
                <Icon size={14} className={a.group === 'create' ? 'text-cyan-300 shrink-0' : 'text-white/50 shrink-0'} />
                <span className="text-[12px] text-white/85 truncate">{a.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {configOpen && (
        <QuickActionsConfigDialog
          initial={ids}
          onClose={() => setConfigOpen(false)}
          onSaved={(next) => { setIds(next); setConfigOpen(false); }}
        />
      )}
    </div>
  );
}

/** 配置弹窗：上方"已选（可排序）"，下方按分组列出全部可添加操作。 */
function QuickActionsConfigDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: string[];
  onClose: () => void;
  onSaved: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const move = (i: number, dir: -1 | 1) => {
    setSelected((p) => {
      const n = [...p];
      const j = i + dir;
      if (j < 0 || j >= n.length) return p;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };

  const save = async () => {
    setSaving(true);
    const res = await updateProductAgentQuickActions(selected);
    setSaving(false);
    if (res.success) { toast.success('快捷操作已保存'); onSaved(res.data.quickActionIds ?? selected); }
    else toast.error('保存失败', res.error?.message);
  };

  const selectedDefs = resolveQuickActions(selected);
  const groups: QuickActionDef['group'][] = ['create', 'goto'];

  const dialog = (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#16181d] flex flex-col"
        style={{ width: 480, maxWidth: '92vw', maxHeight: '82vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-white">配置快捷操作</h2>
            <p className="text-[11px] text-white/40 mt-0.5">勾选要展示在工作台的操作并排序，所有产品共用这份配置</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={16} /></button>
        </div>

        <div className="flex-1 p-4 flex flex-col gap-4" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {/* 已选（可排序） */}
          <div>
            <div className="text-xs font-medium text-white/50 mb-2">已选（{selectedDefs.length}，按此顺序展示）</div>
            {selectedDefs.length === 0 ? (
              <div className="text-[12px] text-white/30 py-3 text-center rounded-lg border border-dashed border-white/10">从下方添加操作</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {selectedDefs.map((a, i) => {
                  const Icon = a.icon;
                  return (
                    <div key={a.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.03]">
                      <Icon size={14} className="text-white/55 shrink-0" />
                      <span className="text-[12px] text-white/85 flex-1 truncate">{a.label}</span>
                      <button onClick={() => move(i, -1)} disabled={i === 0} className="text-white/35 hover:text-white disabled:opacity-25" title="上移"><ArrowUp size={13} /></button>
                      <button onClick={() => move(i, 1)} disabled={i === selectedDefs.length - 1} className="text-white/35 hover:text-white disabled:opacity-25" title="下移"><ArrowDown size={13} /></button>
                      <button onClick={() => setSelected((p) => p.filter((x) => x !== a.id))} className="text-white/35 hover:text-red-300" title="移除"><Trash2 size={13} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 可添加（按分组） */}
          {groups.map((g) => {
            const rest = QUICK_ACTION_REGISTRY.filter((a) => a.group === g && !selected.includes(a.id));
            if (rest.length === 0) return null;
            return (
              <div key={g}>
                <div className="text-xs font-medium text-white/50 mb-2">{QUICK_ACTION_GROUP_LABEL[g]}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {rest.map((a) => {
                    const Icon = a.icon;
                    return (
                      <button
                        key={a.id}
                        onClick={() => setSelected((p) => [...p, a.id])}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-cyan-500/10 hover:border-cyan-500/30 text-left"
                      >
                        <Icon size={14} className="text-white/45 shrink-0" />
                        <span className="text-[12px] text-white/75 flex-1 truncate">{a.label}</span>
                        <Plus size={13} className="text-white/35 shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">取消</button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30 disabled:opacity-40"
          >
            {saving ? <MapSpinner size={14} /> : null} 保存
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
