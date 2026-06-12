/**
 * 项目管理智能体 — 首页右栏「便捷操作」卡片 + 配置弹窗。
 *
 * 操作目录来自 pmQuickActionRegistry（SSOT）；用户配置（id 有序列表）云端同步
 * （UserPreferences.PmAgentPreferences.QuickActionIds，用户级跨项目共用）。
 * 配置弹窗遵 frontend-modal 规则：createPortal、inline 尺寸、min-h-0 滚动、ESC/遮罩关闭。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Zap, Settings2, X, Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { getPmAgentPreferences, updatePmQuickActions } from '@/services';
import {
  PM_QUICK_ACTION_REGISTRY,
  PM_QUICK_ACTION_GROUP_LABEL,
  DEFAULT_PM_QUICK_ACTION_IDS,
  resolvePmQuickActions,
  type PmQuickActionContext,
  type PmQuickActionDef,
} from './pmQuickActionRegistry';

export function PmQuickActionsCard({ ctx }: { ctx: PmQuickActionContext }) {
  const [ids, setIds] = useState<string[]>(DEFAULT_PM_QUICK_ACTION_IDS);
  const [loading, setLoading] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);
  const permissions = useAuthStore((s) => (Array.isArray(s.permissions) ? s.permissions : []));
  const hasPerm = (p?: string) => !p || permissions.includes(p) || permissions.includes('super');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getPmAgentPreferences();
      if (!alive) return;
      // null = 从未配置走默认；空数组 = 用户主动清空，尊重之
      if (res.success && res.data.quickActionIds != null) setIds(res.data.quickActionIds);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const actions = useMemo(() => resolvePmQuickActions(ids).filter((a) => hasPerm(a.permission)), [ids, permissions]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // 与「我的待办」按 3:7 分高（flexGrow），网格内部滚动
    <div className="min-h-0 flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-4" style={{ flexGrow: 3, flexBasis: 0 }}>
      <div className="shrink-0 flex items-center gap-2 mb-3">
        <Zap size={15} className="text-amber-300" />
        <span className="text-sm font-semibold text-white/80">便捷操作</span>
        <button
          onClick={() => setConfigOpen(true)}
          className="ml-auto flex items-center gap-1 text-[11px] text-white/45 hover:text-white/85 px-1.5 py-1 rounded hover:bg-white/5"
          title="配置展示哪些便捷操作"
        >
          <Settings2 size={13} /> 配置
        </button>
      </div>
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><MapSpinner size={18} /></div>
      ) : actions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[12px] text-white/35 text-center px-4">还没有便捷操作，点右上角「配置」添加。</div>
      ) : (
        <div className="flex-1 grid grid-cols-2 gap-2 content-start" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {actions.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.id}
                onClick={() => a.run(ctx)}
                className="pa-row flex items-center gap-2 px-2.5 py-2 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-blue-500/10 hover:border-blue-500/30 text-left"
              >
                <Icon size={14} className={a.group === 'create' ? 'text-blue-300 shrink-0' : 'text-white/50 shrink-0'} />
                <span className="text-[12px] text-white/85 truncate">{a.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {configOpen && (
        <PmQuickActionsConfigDialog
          initial={ids}
          hasPerm={hasPerm}
          onClose={() => setConfigOpen(false)}
          onSaved={(next) => { setIds(next); setConfigOpen(false); }}
        />
      )}
    </div>
  );
}

/** 配置弹窗：上方"已选（可排序）"，下方按分组列出全部可添加操作。 */
function PmQuickActionsConfigDialog({
  initial,
  hasPerm,
  onClose,
  onSaved,
}: {
  initial: string[];
  hasPerm: (p?: string) => boolean;
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
    const res = await updatePmQuickActions(selected);
    setSaving(false);
    if (res.success) { toast.success('便捷操作已保存'); onSaved(res.data.quickActionIds ?? selected); }
    else toast.error('保存失败', res.error?.message);
  };

  const selectedDefs = resolvePmQuickActions(selected);
  const groups: PmQuickActionDef['group'][] = ['create', 'goto'];

  const dialog = (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#16181d] flex flex-col"
        style={{ width: 480, maxWidth: '92vw', maxHeight: '82vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-white">配置便捷操作</h2>
            <p className="text-[11px] text-white/40 mt-0.5">勾选要展示在首页的操作并排序（个人配置，云端同步）</p>
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

          {/* 可添加（按分组，无权限的不展示） */}
          {groups.map((g) => {
            const rest = PM_QUICK_ACTION_REGISTRY.filter((a) => a.group === g && !selected.includes(a.id) && hasPerm(a.permission));
            if (rest.length === 0) return null;
            return (
              <div key={g}>
                <div className="text-xs font-medium text-white/50 mb-2">{PM_QUICK_ACTION_GROUP_LABEL[g]}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {rest.map((a) => {
                    const Icon = a.icon;
                    return (
                      <button
                        key={a.id}
                        onClick={() => setSelected((p) => [...p, a.id])}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-blue-500/10 hover:border-blue-500/30 text-left"
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
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-500/20 text-blue-200 border border-blue-500/40 text-sm hover:bg-blue-500/30 disabled:opacity-40"
          >
            {saving ? <MapSpinner size={14} /> : null} 保存
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
