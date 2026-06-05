import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, User, Users, ArrowLeft, ListTodo, Check } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listImportableWeeklyReports, importWeeklyReport, getPmProject } from '@/services';
import type { ImportableWeeklyReport, PmWeeklyReport, PmTask } from '@/services/contracts/pmAgent';
import { TASK_STATUS_REGISTRY } from './pmConstants';

interface Props {
  projectId: string;
  onClose: () => void;
  onImported: (report: PmWeeklyReport) => void;
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', submitted: '已提交', reviewed: '已审阅', viewed: '已查看', returned: '已退回', overdue: '逾期', vacation: '休假', 'not-started': '未开始',
};

/** 在 [start,end] 周窗内（含端点） */
function inWindow(s: string | null | undefined, start: number, end: number) {
  if (!s) return false;
  const x = new Date(s).getTime();
  return x >= start && x <= end;
}

/** 自动建议：负责人=作者、未取消、且时间落在该周窗（开始/截止/更新时间任一命中，或起止区间与周窗重叠）的任务 */
function suggestTaskIds(tasks: PmTask[], report: ImportableWeeklyReport): Set<string> {
  const start = new Date(report.periodStart).getTime();
  const end = new Date(report.periodEnd).getTime();
  const ids = tasks.filter((t) => {
    if (t.assigneeId !== report.userId || t.status === 'cancelled') return false;
    const startMs = t.startAt ? new Date(t.startAt).getTime() : null;
    const dueMs = t.dueAt ? new Date(t.dueAt).getTime() : null;
    const overlap = startMs != null && dueMs != null && startMs <= end && dueMs >= start;
    return inWindow(t.startAt, start, end) || inWindow(t.dueAt, start, end) || inWindow(t.updatedAt, start, end) || overlap;
  }).map((t) => t.id);
  return new Set(ids);
}

/**
 * 导入个人周报（report-agent）—— 两步：① 选一份可见范围内的个人周报；
 * ② 按「作者 + 本周窗口」自动建议关联任务（可调整）→ 确认导入为项目周报（快照+回溯）。
 */
export function ImportPersonalReportModal({ projectId, onClose, onImported }: Props) {
  const [items, setItems] = useState<ImportableWeeklyReport[]>([]);
  const [tasks, setTasks] = useState<PmTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<ImportableWeeklyReport | null>(null);
  const [selTaskIds, setSelTaskIds] = useState<Set<string>>(new Set());
  const [autoCount, setAutoCount] = useState(0);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ir, pr] = await Promise.all([listImportableWeeklyReports(), getPmProject(projectId)]);
      if (!alive) return;
      if (ir.success) setItems(ir.data.items);
      else toast.error('加载失败', ir.error?.message || '');
      if (pr.success) setTasks(pr.data.tasks);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (picked) setPicked(null); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, picked]);

  const pick = (it: ImportableWeeklyReport) => {
    const sug = suggestTaskIds(tasks, it);
    setSelTaskIds(sug);
    setAutoCount(sug.size);
    setPicked(it);
  };
  const toggleTask = (id: string) => setSelTaskIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const confirmImport = async () => {
    if (!picked) return;
    setImporting(true);
    const res = await importWeeklyReport(projectId, { sourceReportId: picked.id, relatedTaskIds: [...selTaskIds] });
    setImporting(false);
    if (res.success) { toast.success('已导入', `${picked.userName || '成员'} 的周报已转为项目周报`); onImported(res.data); }
    else toast.error('导入失败', res.error?.message || '');
  };

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => (selTaskIds.has(b.id) ? 1 : 0) - (selTaskIds.has(a.id) ? 1 : 0)),
    [tasks, selTaskIds],
  );

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 640, height: '80vh', maxHeight: '80vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          {picked && <button onClick={() => setPicked(null)} className="p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><ArrowLeft size={16} /></button>}
          <Download size={16} style={{ color: '#3B82F6' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{picked ? '确认导入 + 关联任务' : '导入个人周报'}</div>
          {!picked && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>仅显示你可见范围内的周报</span>}
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        {!picked ? (
          <div className="flex-1 px-3 py-3 flex flex-col gap-1.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {loading ? (
              <div className="flex-1 flex items-center justify-center"><MapSectionLoader text="正在加载可导入的周报…" /></div>
            ) : items.length === 0 ? (
              <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>暂无可导入的个人周报。去周报Agent 写一份，或确认你有可见权限。</div>
            ) : items.map((it) => (
              <button key={it.id} onClick={() => pick(it)} className="group flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                <span className="shrink-0" style={{ color: it.isMine ? '#3B82F6' : '#A855F7' }}>{it.isMine ? <User size={15} /> : <Users size={15} />}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{it.userName || '成员'} · {it.weekYear} 年第 {it.weekNumber} 周</div>
                  <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{it.teamName || '团队'} · {STATUS_LABEL[it.status] || it.status} · {it.sectionCount} 个章节</div>
                </div>
                <span className="text-[11px] shrink-0 opacity-0 group-hover:opacity-100" style={{ color: '#3B82F6' }}>选择 →</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="flex-1 px-4 py-3 flex flex-col gap-2.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>
                将导入 <b>{picked.userName || '成员'}</b> 的「{picked.weekYear} 年第 {picked.weekNumber} 周」周报为项目周报（快照，可回溯）。
              </div>
              <div className="flex items-center gap-1.5">
                <ListTodo size={13} style={{ color: '#F59E0B' }} />
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>关联任务</span>
                <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>已按「本周 + 负责人」自动勾选 {autoCount} 个，可调整</span>
                <span className="ml-auto text-[11px]" style={{ color: '#3B82F6' }}>已选 {selTaskIds.size}</span>
              </div>
              {tasks.length === 0 ? (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>本项目暂无任务</div>
              ) : sortedTasks.map((t) => {
                const st = TASK_STATUS_REGISTRY[t.status];
                const checked = selTaskIds.has(t.id);
                return (
                  <label key={t.id} className="flex items-center gap-2 text-[12.5px] cursor-pointer rounded-md px-2 py-1.5 border" style={{ borderColor: checked ? '#3B82F6' : 'var(--border-subtle)', background: checked ? 'rgba(59,130,246,0.08)' : 'var(--bg-card)', color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleTask(t.id)} />
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
                    <span className="truncate flex-1" title={t.title}>{t.title}</span>
                    {t.assigneeName && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.assigneeName}</span>}
                    <span className="text-[10px] shrink-0" style={{ color: st.color }}>{st.label}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <Button variant="ghost" onClick={() => setPicked(null)}>返回</Button>
              <Button variant="primary" onClick={confirmImport} disabled={importing}>{importing ? <MapSpinner size={14} /> : <Check size={14} />}确认导入</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
