import { useState, useEffect, useCallback } from 'react';
import {
  CheckSquare, Square, Trash2, RefreshCw, Flame, TrendingUp, Clock, Archive,
  RotateCcw, CalendarDays, ListTree,
} from 'lucide-react';
import type { PaTask, PaSubTask } from '@/services/real/paAgentService';
import {
  getPaTasks,
  updatePaTask,
  deletePaTask,
  updatePaSubTask,
} from '@/services/real/paAgentService';
import dayjs from 'dayjs';

// ── Quadrant config（毒舌秘书：四象限 + 毒舌一句，零 emoji） ─────────────

interface QuadrantConfig {
  key: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  label: string;
  sub: string;
  savage: string;
  icon: React.ReactNode;
  gradient: string;
  pill: string;
  pillText: string;
}

const QUADRANTS: QuadrantConfig[] = [
  {
    key: 'Q1',
    label: '立刻干',
    sub: '紧急 · 重要',
    savage: '今天必须搞定，别想跑。',
    icon: <Flame size={14} />,
    gradient: 'linear-gradient(135deg, #ef4444, #f97316)',
    pill: 'rgba(239,68,68,0.1)',
    pillText: '#ef4444',
  },
  {
    key: 'Q2',
    label: '计划干',
    sub: '重要 · 不紧急',
    savage: '不紧急不等于不做，今天就排进日程。',
    icon: <TrendingUp size={14} />,
    gradient: 'linear-gradient(135deg, #22c55e, #10b981)',
    pill: 'rgba(34,197,94,0.1)',
    pillText: '#22c55e',
  },
  {
    key: 'Q3',
    label: '快速干',
    sub: '紧急 · 不重要',
    savage: '能授权就授权，别自己扛。',
    icon: <Clock size={14} />,
    gradient: 'linear-gradient(135deg, #f59e0b, #eab308)',
    pill: 'rgba(245,158,11,0.1)',
    pillText: '#f59e0b',
  },
  {
    key: 'Q4',
    label: '养着干',
    sub: '不紧急 · 不重要',
    savage: '养着可以，别忘了它存在。',
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

/** Deadline 显示：剩 X 天 / 已逾期 X 天 / null */
function formatDeadline(deadline?: string): { label: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  if (!deadline) return null;
  const d = dayjs(deadline);
  if (!d.isValid()) return null;
  const diff = d.diff(dayjs(), 'day');
  if (diff < 0) return { label: `逾期 ${-diff} 天`, tone: 'overdue' };
  if (diff === 0) return { label: '今天截止', tone: 'soon' };
  if (diff <= 3) return { label: `剩 ${diff} 天`, tone: 'soon' };
  return { label: `${d.format('M月D日')}`, tone: 'normal' };
}

function TaskCard({ task, qConfig, onToggleSubTask, onMarkDone, onDelete }: TaskCardProps) {
  const doneCount = task.subTasks.filter(s => s.done).length;
  const progress = task.subTasks.length > 0 ? doneCount / task.subTasks.length : 0;
  const isDone = task.status === 'done';
  const deadline = formatDeadline(task.deadline);

  return (
    <div
      className="pa-task-card group relative rounded-xl p-3 mb-2"
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-default)',
        opacity: isDone ? 0.62 : 1,
      }}
    >
      {/* 左侧象限色条 — 一眼能识别紧急度，遵循 Linear 优先级视觉权重 */}
      <span
        className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full"
        style={{ background: qConfig.gradient, opacity: isDone ? 0.35 : 0.85 }}
      />

      <div className="flex items-start justify-between gap-2 pl-1.5">
        <div className="flex-1 min-w-0">
          {/* 标题：14sb 主层 */}
          <div
            className="font-semibold leading-snug break-words"
            style={{
              fontSize: 13,
              color: isDone ? 'var(--text-muted)' : 'var(--text-primary)',
              textDecoration: isDone ? 'line-through' : 'none',
            }}
          >
            {task.title}
          </div>

          {/* Chip 行：象限 + 截止日期 + 子任务进度 — 信息层级第二档 */}
          {(deadline || task.subTasks.length > 0) && (
            <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
              {deadline && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums"
                  style={
                    deadline.tone === 'overdue'
                      ? { background: 'rgba(239,68,68,0.13)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.3)' }
                      : deadline.tone === 'soon'
                      ? { background: 'rgba(245,158,11,0.13)', color: '#fcd34d', border: '1px solid rgba(245,158,11,0.3)' }
                      : { background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.08)' }
                  }
                >
                  <CalendarDays size={9} />
                  {deadline.label}
                </span>
              )}
              {task.subTasks.length > 0 && (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] tabular-nums"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    color: 'var(--text-muted)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                  title={`${doneCount}/${task.subTasks.length} 子步骤已完成`}
                >
                  <ListTree size={9} />
                  {doneCount}/{task.subTasks.length}
                </span>
              )}
            </div>
          )}

          {/* Reasoning：12 muted 主辅层 */}
          {task.reasoning && (
            <p
              className="mt-1.5 leading-relaxed"
              style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: '17px' }}
            >
              {task.reasoning}
            </p>
          )}
        </div>

        {/* 操作浮条：hover 显示 */}
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isDone && (
            <button
              onClick={() => onMarkDone(task.id)}
              title="完成"
              className="p-1 rounded-lg pa-task-action transition-all"
              style={{ color: '#22c55e' }}
            >
              <CheckSquare size={13} />
            </button>
          )}
          <button
            onClick={() => onDelete(task.id)}
            title="归档"
            className="p-1 rounded-lg pa-task-action-danger transition-all"
            style={{ color: 'var(--text-muted)' }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Progress bar — 子步骤总进度 */}
      {task.subTasks.length > 0 && (
        <div className="mt-2.5 pl-1.5">
          <div
            className="h-1 rounded-full overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${progress * 100}%`,
                background: qConfig.gradient,
                boxShadow: progress > 0 ? `0 0 8px ${qConfig.pillText}66` : 'none',
              }}
            />
          </div>
        </div>
      )}

      {/* Sub-tasks 列表 */}
      {task.subTasks.length > 0 && (
        <ul className="mt-2 pl-1.5 space-y-1">
          {task.subTasks.map((sub: PaSubTask, i: number) => (
            <li key={i} className="flex items-center gap-1.5">
              <button
                onClick={() => onToggleSubTask(task.id, i, !sub.done)}
                className="shrink-0 pa-subtask-toggle"
                style={{ color: sub.done ? '#22c55e' : 'var(--text-muted)' }}
                aria-label={sub.done ? '取消完成' : '标记完成'}
              >
                {sub.done ? <CheckSquare size={12} /> : <Square size={12} />}
              </button>
              <span
                className="leading-tight pa-subtask-text"
                style={{
                  fontSize: 11,
                  color: sub.done ? 'var(--text-muted)' : 'var(--text-secondary)',
                  textDecoration: sub.done ? 'line-through' : 'none',
                  opacity: sub.done ? 0.6 : 1,
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

interface PaTaskBoardProps {
  /** 点击「复盘」按钮时由父组件打开 PaReviewDrawer */
  onOpenReview?: () => void;
}

export function PaTaskBoard({ onOpenReview }: PaTaskBoardProps = {}) {
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
      {/* Stats bar — 顶部毒舌引导 */}
      <div
        className="shrink-0 flex items-center justify-between px-4 py-2.5 gap-3"
        style={{ borderBottom: '1px solid var(--border-default)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
            {totalPending} 项待办
          </span>
          {totalDone > 0 && (
            <span className="text-xs whitespace-nowrap" style={{ color: '#22c55e' }}>
              {totalDone} 已完成
            </span>
          )}
          <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            先干 Q1，再排 Q2，扫掉 Q3，养着 Q4。
          </span>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {onOpenReview && (
            <button
              onClick={onOpenReview}
              className="pa-primary-button flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium"
              style={{
                color: '#fff',
                background: 'linear-gradient(135deg,#f59e0b,#ef4444)',
                boxShadow: '0 4px 12px -4px rgba(245,158,11,0.5)',
              }}
              title="毒舌秘书帮你复盘上周 / 自定义时段的任务进展"
            >
              <RotateCcw size={12} />
              复盘
            </button>
          )}
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
                {/* Column header — 图标 + 象限标题 + 毒舌副标题 */}
                <div
                  className="px-3 py-2.5 flex items-center justify-between shrink-0 gap-2"
                  style={{
                    background: q.pill,
                    borderBottom: '1px solid var(--border-default)',
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center"
                      style={{ background: q.gradient, color: '#fff' }}
                    >
                      {q.icon}
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold flex items-baseline gap-1.5" style={{ color: q.pillText }}>
                        <span>{q.key}</span>
                        <span>{q.label}</span>
                        <span className="text-[10px] font-normal opacity-70">{q.sub}</span>
                      </div>
                      <div className="text-[10px] mt-0.5 truncate" style={{ color: q.pillText, opacity: 0.7 }}>
                        {q.savage}
                      </div>
                    </div>
                  </div>
                  {qTasks.length > 0 && (
                    <span
                      className="shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium tabular-nums"
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
                    <div className="flex flex-col items-center justify-center h-full py-6 gap-2">
                      <span
                        className="w-9 h-9 rounded-xl flex items-center justify-center opacity-30"
                        style={{ background: q.gradient, color: '#fff' }}
                      >
                        {q.icon}
                      </span>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        这里空着，{q.label}的事还没来。
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
