import { useState, useEffect, useCallback } from 'react';
import { CheckSquare, Square, Trash2, RefreshCw, Flame, TrendingUp, Clock, Archive } from 'lucide-react';
import type { PaTask, PaSubTask } from '@/services/real/paAgentService';
import {
  getPaTasks,
  updatePaTask,
  deletePaTask,
  updatePaSubTask,
} from '@/services/real/paAgentService';

// ── Quadrant config ────────────────────────────────────────────────────────

interface QuadrantConfig {
  key: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  label: string;
  sub: string;
  emoji: string;
  icon: React.ReactNode;
  gradient: string;
  pill: string;
  pillText: string;
}

const QUADRANTS: QuadrantConfig[] = [
  {
    key: 'Q1',
    label: '救火区',
    sub: '紧急 · 重要',
    emoji: '🔥',
    icon: <Flame size={14} />,
    gradient: 'linear-gradient(135deg, #ef4444, #f97316)',
    pill: 'rgba(239,68,68,0.1)',
    pillText: '#ef4444',
  },
  {
    key: 'Q2',
    label: '投资区',
    sub: '重要 · 不紧急',
    emoji: '🎯',
    icon: <TrendingUp size={14} />,
    gradient: 'linear-gradient(135deg, #22c55e, #10b981)',
    pill: 'rgba(34,197,94,0.1)',
    pillText: '#22c55e',
  },
  {
    key: 'Q3',
    label: '干扰区',
    sub: '紧急 · 不重要',
    emoji: '⚡',
    icon: <Clock size={14} />,
    gradient: 'linear-gradient(135deg, #f59e0b, #eab308)',
    pill: 'rgba(245,158,11,0.1)',
    pillText: '#f59e0b',
  },
  {
    key: 'Q4',
    label: '垃圾区',
    sub: '不紧急 · 不重要',
    emoji: '🗑',
    icon: <Archive size={14} />,
    gradient: 'linear-gradient(135deg, #6b7280, #9ca3af)',
    pill: 'rgba(107,114,128,0.1)',
    pillText: '#9ca3af',
  },
];

// ── TaskCard ───────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: PaTask;
  qConfig: QuadrantConfig;
  onToggleSubTask: (taskId: string, index: number, done: boolean) => void;
  onMarkDone: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}

function TaskCard({ task, qConfig, onToggleSubTask, onMarkDone, onDelete }: TaskCardProps) {
  const doneCount = task.subTasks.filter(s => s.done).length;
  const progress = task.subTasks.length > 0 ? doneCount / task.subTasks.length : 0;
  const isDone = task.status === 'done';

  return (
    <div
      className="rounded-xl p-3 mb-2 group transition-all hover:shadow-sm"
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-default)',
        opacity: isDone ? 0.6 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span
            className="text-xs font-medium leading-snug block"
            style={{
              color: isDone ? 'var(--text-muted)' : 'var(--text-primary)',
              textDecoration: isDone ? 'line-through' : 'none',
            }}
          >
            {task.title}
          </span>
          {task.reasoning && (
            <p className="mt-0.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {task.reasoning}
            </p>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isDone && (
            <button
              onClick={() => onMarkDone(task.id)}
              title="完成"
              className="p-1 rounded-lg hover:bg-green-500/10 transition-colors"
              style={{ color: '#22c55e' }}
            >
              <CheckSquare size={13} />
            </button>
          )}
          <button
            onClick={() => onDelete(task.id)}
            title="归档"
            className="p-1 rounded-lg hover:bg-red-500/10 transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {task.subTasks.length > 0 && (
        <div className="mt-2">
          <div
            className="h-1 rounded-full overflow-hidden"
            style={{ background: 'var(--bg-elevated)' }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${progress * 100}%`,
                background: qConfig.gradient,
              }}
            />
          </div>
          <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {doneCount}/{task.subTasks.length} 完成
          </div>
        </div>
      )}

      {/* Sub-tasks */}
      {task.subTasks.length > 0 && (
        <ul className="mt-2 space-y-1">
          {task.subTasks.map((sub: PaSubTask, i: number) => (
            <li key={i} className="flex items-center gap-1.5">
              <button
                onClick={() => onToggleSubTask(task.id, i, !sub.done)}
                className="shrink-0 transition-colors"
                style={{ color: sub.done ? '#22c55e' : 'var(--text-muted)' }}
              >
                {sub.done ? <CheckSquare size={12} /> : <Square size={12} />}
              </button>
              <span
                className="text-[11px] leading-tight"
                style={{
                  color: sub.done ? 'var(--text-muted)' : 'var(--text-secondary)',
                  textDecoration: sub.done ? 'line-through' : 'none',
                }}
              >
                {sub.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── PaTaskBoard ────────────────────────────────────────────────────────────

export function PaTaskBoard() {
  const [tasks, setTasks] = useState<PaTask[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getPaTasks();
      if (res.success && Array.isArray(res.data)) {
        setTasks(res.data);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggleSubTask = useCallback(async (taskId: string, index: number, done: boolean) => {
    const res = await updatePaSubTask(taskId, index, done);
    if (res.success && res.data) {
      setTasks(prev => prev.map(t => t.id === taskId ? res.data! : t));
    }
  }, []);

  const handleMarkDone = useCallback(async (taskId: string) => {
    const res = await updatePaTask(taskId, { status: 'done' });
    if (res.success && res.data) {
      setTasks(prev => prev.map(t => t.id === taskId ? res.data! : t));
    }
  }, []);

  const handleDelete = useCallback(async (taskId: string) => {
    const res = await deletePaTask(taskId);
    if (res.success) {
      setTasks(prev => prev.filter(t => t.id !== taskId));
    }
  }, []);

  const tasksByQ = (q: string) =>
    tasks.filter(t => t.quadrant === q && t.status !== 'done');

  const totalPending = tasks.filter(t => t.status === 'pending').length;
  const totalDone = tasks.filter(t => t.status === 'done').length;

  return (
    <div className="h-full flex flex-col" style={{ color: 'var(--text-primary)' }}>
      {/* Stats bar */}
      <div
        className="shrink-0 flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--border-default)' }}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            {totalPending} 个待处理
          </span>
          {totalDone > 0 && (
            <span className="text-xs" style={{ color: '#22c55e' }}>
              {totalDone} 个已完成
            </span>
          )}
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--text-muted)', background: 'var(--bg-elevated)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      {/* Board */}
      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-2 gap-3 h-full" style={{ minHeight: 360 }}>
          {QUADRANTS.map(q => {
            const qTasks = tasksByQ(q.key);
            return (
              <div
                key={q.key}
                className="rounded-2xl flex flex-col overflow-hidden"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  minHeight: 180,
                }}
              >
                {/* Column header */}
                <div
                  className="px-3 py-2.5 flex items-center justify-between shrink-0"
                  style={{
                    background: q.pill,
                    borderBottom: '1px solid var(--border-default)',
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{q.emoji}</span>
                    <div>
                      <div className="text-xs font-semibold" style={{ color: q.pillText }}>
                        {q.label}
                      </div>
                      <div className="text-[10px]" style={{ color: q.pillText, opacity: 0.7 }}>
                        {q.sub}
                      </div>
                    </div>
                  </div>
                  {qTasks.length > 0 && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded-full font-medium tabular-nums"
                      style={{
                        background: 'rgba(255,255,255,0.2)',
                        color: q.pillText,
                      }}
                    >
                      {qTasks.length}
                    </span>
                  )}
                </div>

                {/* Tasks */}
                <div className="flex-1 overflow-auto p-2.5">
                  {loading ? (
                    <div className="text-xs text-center pt-6" style={{ color: 'var(--text-muted)' }}>
                      加载中...
                    </div>
                  ) : qTasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-6 gap-1">
                      <span className="text-2xl opacity-20">{q.emoji}</span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        暂无任务
                      </span>
                    </div>
                  ) : (
                    qTasks.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        qConfig={q}
                        onToggleSubTask={handleToggleSubTask}
                        onMarkDone={handleMarkDone}
                        onDelete={handleDelete}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
