import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, ArrowRight, CircleUser } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  listPmDecisions, createPmDecision, updatePmDecision, deletePmDecision,
} from '@/services';
import type { PmDecision, PmDecisionType } from '@/services/contracts/pmAgent';
import { DECISION_TYPE_REGISTRY, DECISION_COLUMNS } from './pmConstants';

interface Props {
  projectId: string;
}

function fmtTime(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 一个状态列里的下一个流转目标（用于「移到下一态」快捷按钮） */
const NEXT_TYPE: Record<PmDecisionType, PmDecisionType | null> = {
  pending: 'decided',
  decided: 'memo',
  memo: null,
};

/**
 * 项目决策事项 — 三态分栏（待决策 / 已决策 / 备忘）。
 * 支持新建、内联编辑、状态流转（转入已决策落定案人/时间）、删除。
 */
export function DecisionsPanel({ projectId }: Props) {
  const [items, setItems] = useState<PmDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 编辑态：existing decision id，或 `new:{type}` 表示在某列新建
  const [editing, setEditing] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');

  const load = useCallback(async () => {
    const res = await listPmDecisions(projectId);
    if (res.success) setItems(res.data.items);
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const m: Record<PmDecisionType, PmDecision[]> = { pending: [], decided: [], memo: [] };
    for (const d of items) (m[d.type] ?? m.pending).push(d);
    return m;
  }, [items]);

  const startCreate = (type: PmDecisionType) => { setEditing(`new:${type}`); setDraftTitle(''); setDraftContent(''); };
  const startEdit = (d: PmDecision) => { setEditing(d.id); setDraftTitle(d.title); setDraftContent(d.content || ''); };
  const cancelEdit = () => { setEditing(null); setDraftTitle(''); setDraftContent(''); };

  const saveDraft = async () => {
    if (!draftTitle.trim()) { toast.error('请填写决策标题', ''); return; }
    if (!editing) return;
    setBusyId(editing);
    if (editing.startsWith('new:')) {
      const type = editing.slice(4) as PmDecisionType;
      const res = await createPmDecision(projectId, { title: draftTitle.trim(), content: draftContent.trim() || undefined, type });
      if (res.success) { toast.success('已新增', ''); cancelEdit(); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    } else {
      const res = await updatePmDecision(editing, { title: draftTitle.trim(), content: draftContent.trim() });
      if (res.success) { toast.success('已保存', ''); cancelEdit(); await load(); }
      else toast.error('保存失败', res.error?.message || '');
    }
    setBusyId(null);
  };

  const moveTo = async (d: PmDecision, type: PmDecisionType) => {
    setBusyId(d.id);
    const res = await updatePmDecision(d.id, { type });
    if (res.success) await load();
    else toast.error('操作失败', res.error?.message || '');
    setBusyId(null);
  };

  const handleDelete = async (d: PmDecision) => {
    if (!window.confirm(`确定删除决策「${d.title}」？`)) return;
    setBusyId(d.id);
    const res = await deletePmDecision(d.id);
    if (res.success) { setItems((prev) => prev.filter((x) => x.id !== d.id)); }
    else toast.error('删除失败', res.error?.message || '');
    setBusyId(null);
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载决策事项…" /></div>;

  const renderEditor = (key: string) => (
    <div className="rounded-lg border p-2.5 flex flex-col gap-2" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}>
      <input autoFocus value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="决策标题"
        className="w-full text-[13px] rounded-md px-2 py-1.5 outline-none border"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
      <textarea value={draftContent} onChange={(e) => setDraftContent(e.target.value)} placeholder="背景 / 决策内容 / 影响（可选）" rows={3}
        className="w-full text-[12px] rounded-md px-2 py-1.5 outline-none border resize-y"
        style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={cancelEdit}><X size={13} />取消</Button>
        <Button variant="primary" size="sm" onClick={saveDraft} disabled={busyId === key}>
          {busyId === key ? <MapSpinner size={13} /> : <Check size={13} />}保存
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>决策事项</div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>记录项目推进中的关键决策与待办判断（待决策 / 已决策 / 备忘）</span>
      </div>

      <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {DECISION_COLUMNS.map((type) => {
          const cfg = DECISION_TYPE_REGISTRY[type];
          const list = grouped[type];
          const creatingHere = editing === `new:${type}`;
          return (
            <div key={type} className="flex flex-col min-h-0 rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
              <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="w-2 h-2 rounded-full" style={{ background: cfg.color }} />
                <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{cfg.label}</span>
                <span className="text-[11px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{list.length}</span>
                <button onClick={() => startCreate(type)} className="ml-auto p-1 rounded hover:opacity-80" title="新建" style={{ color: cfg.color }}><Plus size={15} /></button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2" style={{ overscrollBehavior: 'contain' }}>
                {creatingHere && renderEditor(`new:${type}`)}

                {list.length === 0 && !creatingHere ? (
                  <div className="text-[11px] text-center py-6 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                    {cfg.desc}
                  </div>
                ) : (
                  list.map((d) => (
                    editing === d.id ? (
                      <div key={d.id}>{renderEditor(d.id)}</div>
                    ) : (
                      <div key={d.id} className="group rounded-lg border p-2.5 flex flex-col gap-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0 text-[13px] font-medium break-words" style={{ color: 'var(--text-primary)' }}>{d.title}</div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                            <button onClick={() => startEdit(d)} className="p-1 rounded" title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>
                            <button onClick={() => handleDelete(d)} className="p-1 rounded" title="删除" style={{ color: 'var(--text-muted)' }} disabled={busyId === d.id}><Trash2 size={13} /></button>
                          </div>
                        </div>
                        {d.content && <div className="text-[11.5px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>{d.content}</div>}
                        {d.type === 'decided' && d.decidedByName && (
                          <div className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                            <CircleUser size={11} />定案：{d.decidedByName} · {fmtTime(d.decidedAt)}
                          </div>
                        )}
                        {NEXT_TYPE[type] && (
                          <button onClick={() => moveTo(d, NEXT_TYPE[type]!)} disabled={busyId === d.id}
                            className="self-start mt-0.5 text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
                            style={{ borderColor: 'var(--border-subtle)', color: DECISION_TYPE_REGISTRY[NEXT_TYPE[type]!].color }}>
                            {busyId === d.id ? <MapSpinner size={11} /> : <ArrowRight size={11} />}转「{DECISION_TYPE_REGISTRY[NEXT_TYPE[type]!].label}」
                          </button>
                        )}
                      </div>
                    )
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
