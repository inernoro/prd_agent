import { useState } from 'react';
import { Trash2, GripVertical } from 'lucide-react';
import type { PmTask, PmTaskStatus } from '@/services/contracts/pmAgent';
import { BOARD_COLUMNS, TASK_STATUS_REGISTRY, PRIORITY_REGISTRY } from './pmConstants';

interface Props {
  tasks: PmTask[];
  onStatusChange: (taskId: string, status: PmTaskStatus) => void;
  onDelete: (taskId: string) => void;
}

/**
 * 任务看板 — 按状态分列，HTML5 拖拽改状态。
 * 滚动发生在每列内部（full-height-layout 规则：最近内容层滚动）。
 */
export function KanbanBoard({ tasks, onStatusChange, onDelete }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<PmTaskStatus | null>(null);

  const byStatus = (s: PmTaskStatus) => tasks.filter((t) => t.status === s);

  return (
    <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto pb-2" style={{ overscrollBehavior: 'contain' }}>
      {BOARD_COLUMNS.map((col) => {
        const meta = TASK_STATUS_REGISTRY[col];
        const colTasks = byStatus(col);
        const isOver = overCol === col;
        return (
          <div
            key={col}
            className="flex flex-col rounded-xl border shrink-0 w-[280px]"
            style={{
              background: isOver ? 'var(--bg-elevated)' : 'var(--bg-base)',
              borderColor: isOver ? meta.color : 'var(--border-subtle)',
              transition: 'background .15s, border-color .15s',
            }}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col); }}
            onDragLeave={() => setOverCol((c) => (c === col ? null : c))}
            onDrop={() => {
              if (dragId) onStatusChange(dragId, col);
              setDragId(null);
              setOverCol(null);
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
              <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{meta.label}</span>
              <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>{colTasks.length}</span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 flex flex-col gap-2" style={{ overscrollBehavior: 'contain' }}>
              {colTasks.length === 0 && (
                <div className="text-[11px] text-center py-6" style={{ color: 'var(--text-muted)' }}>拖拽任务到此</div>
              )}
              {colTasks.map((t) => {
                const p = PRIORITY_REGISTRY[t.priority];
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => { setDragId(null); setOverCol(null); }}
                    className="group rounded-lg border p-2.5 cursor-grab active:cursor-grabbing"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)', opacity: dragId === t.id ? 0.5 : 1 }}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>{t.title}</div>
                        {t.description && <div className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{t.description}</div>}
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                          {t.priority !== 'none' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${p.color}22`, color: p.color }}>{p.label}</span>
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
                        onClick={() => onDelete(t.id)}
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
