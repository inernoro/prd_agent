import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Trash2, Plus, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { listPmTaskWorkLogs, createPmTaskWorkLog, updatePmTaskWorkLog, deletePmTaskWorkLog } from '@/services';
import type { PmTaskWorkLog } from '@/services/contracts/pmAgent';
import { WORK_LOG_CATEGORY_REGISTRY, WORK_LOG_CATEGORIES, progressColor } from './pmConstants';

interface Props {
  taskId: string;
  /** 日志带进度落库后回调（外层据此刷新任务进度） */
  onProgressLogged?: (percent: number) => void;
  /** 紧凑模式（抽屉内嵌用，减小留白） */
  compact?: boolean;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
const fmtDuration = (min?: number | null) => {
  if (!min) return '';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
};

/**
 * 任务工作日志面板 —— 处理人按天记录"做了什么、完成多少进度"，流水多条。
 * 详情页内嵌完整版，抽屉用 compact。数据走 pm_task_work_logs，带进度时联动任务进度。
 */
export function TaskWorkLogPanel({ taskId, onProgressLogged, compact = false }: Props) {
  const myId = useAuthStore((s) => s.user?.userId ?? '');
  const [logs, setLogs] = useState<PmTaskWorkLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  // 新增表单
  const [content, setContent] = useState('');
  const [date, setDate] = useState(todayStr());
  const [hours, setHours] = useState('');
  const [category, setCategory] = useState<string>('development');
  const [withProgress, setWithProgress] = useState(false);
  const [progress, setProgress] = useState(50);

  // 编辑中
  const [editId, setEditId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  const load = useCallback(async () => {
    const res = await listPmTaskWorkLogs(taskId);
    if (res.success) setLogs(res.data.items);
    setLoading(false);
  }, [taskId]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!content.trim()) { toast.warning('请填写工作内容', ''); return; }
    setAdding(true);
    const durationMinutes = hours.trim() === '' ? undefined : Math.round(Number(hours) * 60);
    const res = await createPmTaskWorkLog(taskId, {
      content: content.trim(),
      date: new Date(date + 'T00:00:00').toISOString(),
      durationMinutes,
      progressPercent: withProgress ? progress : undefined,
      category,
    });
    setAdding(false);
    if (res.success) {
      setContent(''); setHours('');
      setLogs((prev) => [res.data, ...prev]);
      if (withProgress) onProgressLogged?.(progress);
    } else toast.error('保存失败', res.error?.message || '');
  };

  const startEdit = (log: PmTaskWorkLog) => { setEditId(log.id); setEditContent(log.content); };
  const saveEdit = async (logId: string) => {
    if (!editContent.trim()) return;
    const res = await updatePmTaskWorkLog(logId, { content: editContent.trim() });
    if (res.success) {
      setLogs((prev) => prev.map((l) => (l.id === logId ? { ...l, content: editContent.trim() } : l)));
      setEditId(null);
    } else toast.error('保存失败', res.error?.message || '');
  };
  const remove = async (logId: string) => {
    if (!window.confirm('确定删除这条工作日志？')) return;
    const res = await deletePmTaskWorkLog(logId);
    if (res.success) setLogs((prev) => prev.filter((l) => l.id !== logId));
    else toast.error('删除失败', res.error?.message || '');
  };

  // 按日期分组
  const grouped = useMemo(() => {
    const map = new Map<string, PmTaskWorkLog[]>();
    for (const l of logs) {
      const key = l.date.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(l);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [logs]);

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };
  const gap = compact ? 'gap-2' : 'gap-3';

  return (
    <div className={`flex flex-col ${gap}`}>
      {/* 新增表单 */}
      <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
        <textarea
          className="w-full rounded-lg px-3 py-2 text-[13px] outline-none border"
          style={{ ...inputStyle, resize: 'vertical', minHeight: 56 }}
          value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="今天在这个任务上做了什么？"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" className="rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle}
            value={date} onChange={(e) => setDate(e.target.value)} />
          <input type="number" min={0} step={0.5} className="w-24 rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle}
            value={hours} onChange={(e) => setHours(e.target.value)} placeholder="工时(小时)" />
          <select className="rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle}
            value={category} onChange={(e) => setCategory(e.target.value)}>
            {WORK_LOG_CATEGORIES.map((c) => <option key={c} value={c}>{WORK_LOG_CATEGORY_REGISTRY[c].label}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={withProgress} onChange={(e) => setWithProgress(e.target.checked)} style={{ accentColor: '#3B82F6' }} />
            更新进度
          </label>
          {withProgress && (
            <div className="flex items-center gap-2 flex-1 min-w-[140px]">
              <input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => setProgress(Number(e.target.value))}
                className="flex-1" style={{ accentColor: progressColor(progress) }} />
              <span className="text-[12px] font-medium w-9 text-right" style={{ color: 'var(--text-primary)' }}>{progress}%</span>
            </div>
          )}
          <Button variant="primary" size="sm" onClick={submit} disabled={adding || !content.trim()} className="ml-auto">
            <Plus size={13} className="inline mr-0.5" />记录
          </Button>
        </div>
      </div>

      {/* 时间线 */}
      {loading ? (
        <div className="text-[12px] py-3 text-center" style={{ color: 'var(--text-muted)' }}>加载中…</div>
      ) : grouped.length === 0 ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>还没有工作日志，记录第一条吧</div>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map(([day, items]) => (
            <div key={day}>
              <div className="text-[12px] font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                <Clock size={12} /> {fmtDate(day)}
              </div>
              <div className="flex flex-col gap-1.5 pl-1">
                {items.map((l) => {
                  const cat = WORK_LOG_CATEGORY_REGISTRY[l.category] ?? WORK_LOG_CATEGORY_REGISTRY.other;
                  const mine = l.userId === myId;
                  return (
                    <div key={l.id} className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'var(--bg-input)' }}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${cat.color}22`, color: cat.color }}>{cat.label}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{l.userName || '成员'}</span>
                        {l.durationMinutes ? <span style={{ color: 'var(--text-muted)' }}>· {fmtDuration(l.durationMinutes)}</span> : null}
                        {l.progressPercent != null && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded ml-auto" style={{ background: `${progressColor(l.progressPercent)}22`, color: progressColor(l.progressPercent) }}>
                            进度 {l.progressPercent}%
                          </span>
                        )}
                        {mine && editId !== l.id && (
                          <div className={`flex items-center gap-1 ${l.progressPercent != null ? '' : 'ml-auto'}`}>
                            <button onClick={() => startEdit(l)} className="p-0.5 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><Pencil size={12} /></button>
                            <button onClick={() => remove(l.id)} className="p-0.5 rounded hover:opacity-70" style={{ color: '#EF4444' }}><Trash2 size={12} /></button>
                          </div>
                        )}
                      </div>
                      {editId === l.id ? (
                        <div className="flex items-center gap-1.5">
                          <input className="flex-1 rounded px-2 py-1 text-[12px] outline-none border" style={inputStyle}
                            value={editContent} onChange={(e) => setEditContent(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(l.id); if (e.key === 'Escape') setEditId(null); }} />
                          <button onClick={() => saveEdit(l.id)} className="p-1 rounded hover:opacity-70" style={{ color: '#10B981' }}><Check size={14} /></button>
                          <button onClick={() => setEditId(null)} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
                        </div>
                      ) : (
                        <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{l.content}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
