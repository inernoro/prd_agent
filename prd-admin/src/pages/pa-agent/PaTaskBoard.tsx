import { useState, useEffect, useCallback } from 'react';
import { CheckSquare, Square, Trash2, RefreshCw, AlertCircle, Clock, TrendingUp, XCircle } from 'lucide-react';
import type { PaTask, PaSubTask } from '@/services/real/paAgentService';
import {
  getPaTasks,
  updatePaTask,
  deletePaTask,
  updatePaSubTask,
} from '@/services/real/paAgentService';

interface QuadrantConfig {
  key: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  label: string;
  sub: string;
  icon: React.ReactNode;
  color: string;
  borderColor: string;
}

const QUADRANTS: QuadrantConfig[] = [
  {
    key: 'Q1',
    label: '救火区',
    sub: '紧急 + 重要',
    icon: <AlertCircle size={16} />,
    color: 'var(--color-red-500, #ef4444)',
    borderColor: 'var(--color-red-500, #ef4444)',
  },
  {
    key: 'Q2',
    label: '投资区',
    sub: '重要 + 不紧急',
    icon: <TrendingUp size={16} />,
    color: 'var(--color-green-500, #22c55e)',
    borderColor: 'var(--color-green-500, #22c55e)',
  },
  {
    key: 'Q3',
    label: '干扰区',
    sub: '紧急 + 不重要',
    icon: <Clock size={16} />,
    color: 'var(--color-yellow-500, #eab308)',
    borderColor: 'var(--color-yellow-500, #eab308)',
  },
  {
    key: 'Q4',
    label: '垃圾区',
    sub: '不紧急 + 不重要',
    icon: <XCircle size={16} />,
    color: 'var(--text-muted)',
    borderColor: 'var(--border-default)',
  },
];

interface TaskCardProps {
  task: PaTask;
  onToggleSubTask: (taskId: string, index: number, done: boolean) => void;
  onMarkDone: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}

function TaskCard({ task, onToggleSubTask, onMarkDone, onDelete }: TaskCardProps) {
  return (
    <div
      className="rounded-lg p-3 mb-2 text-sm"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="font-medium leading-snug flex-1"
          style={{
            color: task.status === 'done' ? 'var(--text-muted)' : 'var(--text-primary)',
            textDecoration: task.status === 'done' ? 'line-through' : 'none',
          }}
        >
          {task.title}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {task.status !== 'done' && (
            <button
              onClick={() => onMarkDone(task.id)}
              title="标记完成"
              className="p-1 rounded hover:opacity-70 transition-opacity"
              style={{ color: 'var(--color-green-500, #22c55e)' }}
            >
              <CheckSquare size={14} />
            </button>
          )}
          <button
            onClick={() => onDelete(task.id)}
            title="归档"
            className="p-1 rounded hover:opacity-70 transition-opacity"
            style={{ color: 'var(--text-muted)' }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {task.reasoning && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {task.reasoning}
        </p>
      )}

      {task.subTasks.length > 0 && (
        <ul className="mt-2 space-y-1">
          {task.subTasks.map((sub: PaSubTask, i: number) => (
            <li key={i} className="flex items-center gap-1.5">
              <button
                onClick={() => onToggleSubTask(task.id, i, !sub.done)}
                className="shrink-0 hover:opacity-70 transition-opacity"
                style={{ color: sub.done ? 'var(--color-green-500, #22c55e)' : 'var(--text-muted)' }}
              >
                {sub.done ? <CheckSquare size={13} /> : <Square size={13} />}
              </button>
              <span
                className="text-xs"
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

export function PaTaskBoard() {
  const [tasks, setTasks] = useState<PaTask[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getPaTasks();
    if (res.success && res.data) {
      setTasks(res.data);
    }
    setLoading(false);
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

  const tasksByQuadrant = (q: string) =>
    tasks.filter(t => t.quadrant === q && t.status !== 'archived');

  return (
    <div className="h-full flex flex-col" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          四象限任务看板
        </span>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors"
          style={{ color: 'var(--text-muted)', background: 'var(--bg-elevated)' }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="flex-1 overflow-auto px-4 pb-4">
        <div className="grid grid-cols-2 gap-3 h-full" style={{ minHeight: 400 }}>
          {QUADRANTS.map(q => {
            const qTasks = tasksByQuadrant(q.key);
            return (
              <div
                key={q.key}
                className="rounded-xl p-3 flex flex-col"
                style={{
                  background: 'var(--bg-base)',
                  border: `1px solid var(--border-default)`,
                  borderTop: `3px solid ${q.borderColor}`,
                  minHeight: 180,
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span style={{ color: q.color }}>{q.icon}</span>
                  <div>
                    <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {q.key} {q.label}
                    </div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {q.sub}
                    </div>
                  </div>
                  <span
                    className="ml-auto text-xs px-1.5 py-0.5 rounded-full"
                    style={{
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {qTasks.length}
                  </span>
                </div>

                <div className="flex-1 overflow-auto">
                  {loading ? (
                    <div className="text-xs text-center pt-4" style={{ color: 'var(--text-muted)' }}>
                      加载中...
                    </div>
                  ) : qTasks.length === 0 ? (
                    <div className="text-xs text-center pt-4" style={{ color: 'var(--text-muted)' }}>
                      暂无任务
                    </div>
                  ) : (
                    qTasks.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
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
