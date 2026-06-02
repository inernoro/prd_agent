import { useMemo, useState } from 'react';
import type { PmTask, PmMilestone } from '@/services/contracts/pmAgent';
import { TASK_STATUS_REGISTRY, PRIORITY_REGISTRY, MILESTONE_HEALTH_REGISTRY } from './pmConstants';

interface Props {
  tasks: PmTask[];
  /** 里程碑（在时间轴上以菱形 + 虚线呈现） */
  milestones?: PmMilestone[];
  /** 点击任务名或时间条 → 打开统一的任务详情抽屉 */
  onOpen?: (task: PmTask) => void;
  /** 拖拽里程碑菱形改期（仅 owner/leader 传入）。dueAtIso 为新计划截止日。 */
  onMilestoneMove?: (milestoneId: string, dueAtIso: string) => void;
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
export function GanttChart({ tasks, milestones, onOpen, onMilestoneMove }: Props) {
  const dated = useMemo(() => tasks.filter((t) => t.startAt && t.dueAt), [tasks]);
  const undatedCount = tasks.length - dated.length;
  const datedMilestones = useMemo(() => (milestones ?? []).filter((m) => m.dueAt), [milestones]);
  // 拖拽改期临时态
  const [drag, setDrag] = useState<{ id: string; startX: number; startOff: number; off: number } | null>(null);

  const range = useMemo(() => {
    if (dated.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (const t of dated) {
      const s = startOfDay(new Date(t.startAt!)).getTime();
      const e = startOfDay(new Date(t.dueAt!)).getTime();
      if (s < min) min = s;
      if (e > max) max = e;
    }
    // 把里程碑日期纳入范围，保证菱形不出界
    for (const m of datedMilestones) {
      const d = startOfDay(new Date(m.dueAt!)).getTime();
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const days = Math.max(1, Math.round((max - min) / DAY_MS) + 1);
    return { min, days };
  }, [dated, datedMilestones]);

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

          {/* 里程碑条（菱形 + 名称） */}
          {datedMilestones.length > 0 && (
            <div className="flex border-b" style={{ borderColor: 'var(--border-subtle)', height: 30, background: 'var(--bg-elevated)' }}>
              <div className="shrink-0 border-r px-3 flex items-center text-[11px]" style={{ width: LABEL_W, borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>里程碑</div>
              <div className="relative" style={{ width: days * COL_W, height: 30 }}>
                {datedMilestones.map((m) => {
                  const off = Math.round((startOfDay(new Date(m.dueAt!)).getTime() - min) / DAY_MS);
                  const liveOff = drag?.id === m.id ? drag.off : off;
                  const color = MILESTONE_HEALTH_REGISTRY[m.health].color;
                  const dragging = drag?.id === m.id;
                  const liveDate = new Date(min + liveOff * DAY_MS);
                  const canDrag = !!onMilestoneMove;
                  return (
                    <div key={m.id} className="absolute flex items-center gap-1" style={{ left: liveOff * COL_W + COL_W / 2 - 6, top: 7, zIndex: dragging ? 20 : undefined }}
                      title={`${m.title}｜${fmt(liveDate)}｜进度 ${m.progress}%（${MILESTONE_HEALTH_REGISTRY[m.health].label}）${canDrag ? '｜拖拽改期' : ''}`}
                      onPointerDown={canDrag ? (e) => { e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ id: m.id, startX: e.clientX, startOff: off, off }); } : undefined}
                      onPointerMove={canDrag ? (e) => { if (!drag || drag.id !== m.id) return; const dd = Math.round((e.clientX - drag.startX) / COL_W); const no = Math.min(days - 1, Math.max(0, drag.startOff + dd)); if (no !== drag.off) setDrag({ ...drag, off: no }); } : undefined}
                      onPointerUp={canDrag ? (e) => { if (!drag || drag.id !== m.id) return; const finalOff = drag.off; setDrag(null); (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); if (finalOff !== off) onMilestoneMove!(m.id, new Date(min + finalOff * DAY_MS).toISOString()); } : undefined}>
                      <span style={{ width: 11, height: 11, background: color, transform: 'rotate(45deg)', display: 'inline-block', borderRadius: 2, cursor: canDrag ? (dragging ? 'grabbing' : 'grab') : 'default', boxShadow: dragging ? `0 0 0 3px ${color}55` : undefined }} />
                      <span className="text-[10px] whitespace-nowrap" style={{ color: dragging ? color : 'var(--text-secondary)' }}>{m.title}{dragging ? ` · ${fmt(liveDate)}` : ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 任务行 */}
          <div className="relative">
            {/* 今日竖线 */}
            {todayOffset >= 0 && todayOffset < days && (
              <div className="absolute top-0 bottom-0" style={{ left: LABEL_W + todayOffset * COL_W + COL_W / 2, width: 1, background: '#EF4444', opacity: 0.5, zIndex: 5 }} />
            )}
            {/* 里程碑竖虚线 */}
            {datedMilestones.map((m) => {
              const off = Math.round((startOfDay(new Date(m.dueAt!)).getTime() - min) / DAY_MS);
              if (off < 0 || off >= days) return null;
              return <div key={m.id} className="absolute top-0 bottom-0" style={{ left: LABEL_W + off * COL_W + COL_W / 2, width: 0, borderLeft: `1px dashed ${MILESTONE_HEALTH_REGISTRY[m.health].color}`, opacity: 0.45, zIndex: 4 }} />;
            })}
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
                      title={`${t.title}｜${fmt(new Date(s))} - ${fmt(new Date(e))}${t.assigneeName ? `｜负责人 ${t.assigneeName}` : ''}${t.dependsOn.length ? `｜依赖 ${t.dependsOn.length} 项` : ''}`}
                      onClick={onOpen ? () => onOpen(t) : undefined}
                    >
                      <span className="text-[10px] truncate" style={{ color: '#fff' }}>
                        {t.dependsOn.length > 0 ? '↳ ' : ''}
                        {t.assigneeName || ''}
                        {t.assigneeName && t.estimateDays != null ? ' · ' : ''}
                        {t.estimateDays != null ? `${t.estimateDays}人天` : ''}
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
