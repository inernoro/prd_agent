import { useState } from 'react';
import { Trash2, GripVertical, CalendarClock, ListTree } from 'lucide-react';
import type { PmTask, PmTaskStatus } from '@/services/contracts/pmAgent';
import { BOARD_COLUMNS, TASK_STATUS_REGISTRY, PRIORITY_REGISTRY } from './pmConstants';

interface Props {
  tasks: PmTask[];
  /** 移动/排序：beforeId 为 null 表示放到该列末尾 */
  onMove: (taskId: string, status: PmTaskStatus, beforeId: string | null) => void;
  onDelete: (taskId: string) => void;
  onOpen: (task: PmTask) => void;
  /** WIP 限制（status → 上限），可选 */
  wipLimits?: Partial<Record<PmTaskStatus, number>>;
}

const isOverdue = (t: PmTask) => !!t.dueAt && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.dueAt) < new Date(new Date().toDateString());
const fmtDate = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };

/**
 * 任务看板 — 按状态分列；卡片点击打开详情，拖拽改状态 + 同列/跨列排序（落库 orderKey）。
 */
export function KanbanBoard({ tasks, onMove, onDelete, onOpen, wipLimits }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<PmTaskStatus | null>(null);

  const byStatus = (s: PmTaskStatus) => tasks.filter((t) => t.status === s).sort((a, b) => a.orderKey - b.orderKey);

  // 计算每个任务的子任务进度
  const childProgress = (parentId: string) => {
    const kids = tasks.filter((t) => t.parentTaskId === parentId);
    if (kids.length === 0) return null;
    return { done: kids.filter((k) => k.status === 'done').length, total: kids.length };
  };

  return (
    <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto pb-2" style={{ overscrollBehavior: 'contain' }}>
      {BOARD_COLUMNS.map((col) => {
        const meta = TASK_STATUS_REGISTRY[col];
        const colTasks = byStatus(col);
        const isOver = overCol === col;
        const wip = wipLimits?.[col];
        const overWip = wip != null && colTasks.length > wip;
        return (
          <div
            key={col}
            className="flex flex-col rounded-xl border shrink-0 w-[280px]"
            style={{
              background: isOver ? 'var(--bg-elevated)' : 'var(--bg-base)',
              borderColor: overWip ? '#EF4444' : isOver ? meta.color : 'var(--border-subtle)',
              transition: 'background .15s, border-color .15s',
            }}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col); }}
            onDragLeave={() => setOverCol((c) => (c === col ? null : c))}
            onDrop={() => { if (dragId) onMove(dragId, col, null); setDragId(null); setOverCol(null); }}
          >
            <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
              <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{meta.label}</span>
              <span className="text-[11px] ml-auto" style={{ color: overWip ? '#EF4444' : 'var(--text-muted)' }}>
                {colTasks.length}{wip != null ? ` / ${wip}` : ''}
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 flex flex-col gap-2" style={{ overscrollBehavior: 'contain' }}>
              {colTasks.length === 0 && (
                <div className="text-[11px] text-center py-6" style={{ color: 'var(--text-muted)' }}>拖拽任务到此</div>
              )}
              {colTasks.map((t) => {
                const p = PRIORITY_REGISTRY[t.priority];
                const overdue = isOverdue(t);
                const prog = childProgress(t.id);
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => { e.stopPropagation(); setDragId(t.id); }}
                    onDragEnd={() => { setDragId(null); setOverCol(null); }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOverCol(col); }}
                    onDrop={(e) => { e.stopPropagation(); if (dragId && dragId !== t.id) onMove(dragId, col, t.id); setDragId(null); setOverCol(null); }}
                    onClick={() => onOpen(t)}
                    className="group rounded-lg border p-2.5 cursor-pointer"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', opacity: dragId === t.id ? 0.5 : 1 }}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical size={13} className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing" style={{ color: 'var(--text-muted)' }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>{t.title}</div>
                        {t.description && <div className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{t.description}</div>}
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                          {t.priority !== 'none' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${p.color}22`, color: p.color }}>{p.label}</span>
                          )}
                          {overdue && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5" style={{ background: 'rgba(239,68,68,0.15)', color: '#EF4444' }}>
                              <CalendarClock size={10} />逾期 {fmtDate(t.dueAt!)}
                            </span>
                          )}
                          {prog && (
                            <span className="text-[10px] inline-flex items-center gap-0.5" style={{ color: prog.done === prog.total ? '#10B981' : 'var(--text-muted)' }}>
                              <ListTree size={10} />{prog.done}/{prog.total}
                            </span>
                          )}
                          {t.dependsOn.length > 0 && (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>依赖{t.dependsOn.length}</span>
                          )}
                          {t.estimateDays != null && (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{t.estimateDays}人天</span>
                          )}
                          {t.assigneeName && (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{t.assigneeName}</span>
                          )}
                          {t.source === 'ai_decompose' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(168,85,247,0.15)', color: '#A855F7' }}>AI</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded shrink-0"
                        style={{ color: 'var(--text-muted)' }}
                        title="删除任务"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
