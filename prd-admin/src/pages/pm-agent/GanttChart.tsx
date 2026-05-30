import { useMemo } from 'react';
import type { PmTask } from '@/services/contracts/pmAgent';
import { TASK_STATUS_REGISTRY, PRIORITY_REGISTRY } from './pmConstants';

interface Props {
  tasks: PmTask[];
  /** 点击任务名或时间条 → 打开统一的任务详情抽屉 */
  onOpen?: (task: PmTask) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const COL_W = 36;       // 每天列宽 px
const ROW_H = 34;       // 每行高 px
const LABEL_W = 200;    // 左侧任务名列宽

function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function fmt(d: Date) { return `${d.getMonth() + 1}/${d.getDate()}`; }

/**
 * 甘特图 — 横向滚动时间线。
 * 仅渲染带 startAt + dueAt 的任务；缺日期的任务在底部提示补全。
 * 采用横向滚动而非 pan/zoom 画布，故不涉及 gesture-unification 规则。
 */
export function GanttChart({ tasks, onOpen }: Props) {
  const dated = useMemo(() => tasks.filter((t) => t.startAt && t.dueAt), [tasks]);
  const undatedCount = tasks.length - dated.length;

  const range = useMemo(() => {
    if (dated.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (const t of dated) {
      const s = startOfDay(new Date(t.startAt!)).getTime();
      const e = startOfDay(new Date(t.dueAt!)).getTime();
      if (s < min) min = s;
      if (e > max) max = e;
    }
    const days = Math.max(1, Math.round((max - min) / DAY_MS) + 1);
    return { min, days };
  }, [dated]);

  if (dated.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center">
        <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>暂无可排期的任务</div>
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>给任务设置「开始时间」与「截止时间」后即可在甘特图查看排期与依赖</div>
      </div>
    );
  }

  const { min, days } = range!;
  const todayOffset = Math.round((startOfDay(new Date()).getTime() - min) / DAY_MS);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto border rounded-xl" style={{ borderColor: 'var(--border-subtle)', overscrollBehavior: 'contain' }}>
        <div style={{ width: LABEL_W + days * COL_W, minWidth: '100%' }}>
          {/* 时间刻度表头 */}
          <div className="flex sticky top-0 z-10" style={{ background: 'var(--bg-base)' }}>
            <div className="shrink-0 border-r border-b px-3 py-2 text-[12px] font-semibold" style={{ width: LABEL_W, borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>任务</div>
            <div className="flex border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              {Array.from({ length: days }).map((_, i) => {
                const d = new Date(min + i * DAY_MS);
                const weekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <div key={i} className="shrink-0 text-center py-2 text-[10px]" style={{ width: COL_W, color: weekend ? 'var(--text-muted)' : 'var(--text-secondary)', background: weekend ? 'var(--bg-elevated)' : 'transparent' }}>
                    {fmt(d)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 任务行 */}
          <div className="relative">
            {/* 今日竖线 */}
            {todayOffset >= 0 && todayOffset < days && (
              <div className="absolute top-0 bottom-0" style={{ left: LABEL_W + todayOffset * COL_W + COL_W / 2, width: 1, background: '#EF4444', opacity: 0.5, zIndex: 5 }} />
            )}
            {dated.map((t) => {
              const s = startOfDay(new Date(t.startAt!)).getTime();
              const e = startOfDay(new Date(t.dueAt!)).getTime();
              const offset = Math.round((s - min) / DAY_MS);
              const span = Math.max(1, Math.round((e - s) / DAY_MS) + 1);
              const statusColor = TASK_STATUS_REGISTRY[t.status].color;
              const pColor = PRIORITY_REGISTRY[t.priority].color;
              return (
                <div key={t.id} className="flex border-b items-center" style={{ borderColor: 'var(--border-subtle)', height: ROW_H }}>
                  <div
                    className={`shrink-0 border-r px-3 text-[12px] truncate ${onOpen ? 'cursor-pointer hover:underline' : ''}`}
                    style={{ width: LABEL_W, borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    title={t.title}
                    onClick={onOpen ? () => onOpen(t) : undefined}
                  >
                    {t.priority !== 'none' && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5" style={{ background: pColor }} />}
                    {t.title}
                  </div>
                  <div className="relative" style={{ width: days * COL_W, height: ROW_H }}>
                    <div
                      className={`absolute rounded-md flex items-center px-2 ${onOpen ? 'cursor-pointer' : ''}`}
                      style={{
                        left: offset * COL_W + 2,
                        width: span * COL_W - 4,
                        top: 6,
                        height: ROW_H - 12,
                        background: `${statusColor}cc`,
                      }}
                      title={`${t.title}｜${fmt(new Date(s))} - ${fmt(new Date(e))}${t.dependsOn.length ? `｜依赖 ${t.dependsOn.length} 项` : ''}`}
                      onClick={onOpen ? () => onOpen(t) : undefined}
                    >
                      <span className="text-[10px] truncate" style={{ color: '#fff' }}>
                        {t.dependsOn.length > 0 ? '↳ ' : ''}{t.estimateDays != null ? `${t.estimateDays}人天` : ''}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {undatedCount > 0 && (
        <div className="text-[11px] mt-2 shrink-0" style={{ color: 'var(--text-muted)' }}>
          另有 {undatedCount} 个任务未设置排期时间，未在甘特图显示
        </div>
      )}
    </div>
  );
}
