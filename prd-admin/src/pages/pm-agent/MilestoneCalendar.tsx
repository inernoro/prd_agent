import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { PmMilestone } from '@/services/contracts/pmAgent';
import { MILESTONE_HEALTH_REGISTRY } from './pmConstants';

interface Props {
  milestones: PmMilestone[];
  onOpen: (m: PmMilestone) => void;
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
function ymd(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** 周一为一周起点的偏移（getDay: 0=周日） */
function mondayIndex(day: number) { return (day + 6) % 7; }

/**
 * 里程碑日历视图 —— 月历网格，里程碑落在其计划截止日（dueAt）格子，菱形健康色 + 名称，点开详情。
 */
export function MilestoneCalendar({ milestones, onOpen }: Props) {
  const [cursor, setCursor] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });

  const byDate = useMemo(() => {
    const m = new Map<string, PmMilestone[]>();
    for (const ms of milestones) {
      if (!ms.dueAt) continue;
      const key = ymd(new Date(ms.dueAt));
      (m.get(key) ?? m.set(key, []).get(key)!).push(ms);
    }
    return m;
  }, [milestones]);

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const lead = mondayIndex(first.getDay());
    const start = new Date(first); start.setDate(first.getDate() - lead);
    const arr: Date[] = [];
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); arr.push(d); }
    return arr;
  }, [cursor]);

  const todayKey = ymd(new Date());
  const monthLabel = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
  const undated = milestones.filter((m) => !m.dueAt).length;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><ChevronLeft size={14} /></Button>
        <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{monthLabel}</span>
        <Button variant="ghost" size="sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><ChevronRight size={14} /></Button>
        <Button variant="ghost" size="sm" onClick={() => { const n = new Date(); setCursor(new Date(n.getFullYear(), n.getMonth(), 1)); }}>今天</Button>
        {undated > 0 && <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>另有 {undated} 个未排期里程碑（无截止日，不在日历显示）</span>}
      </div>

      <div className="grid shrink-0" style={{ gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {WEEK.map((w) => <div key={w} className="text-[11px] text-center py-1" style={{ color: 'var(--text-muted)' }}>{w}</div>)}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(86px, auto)', gap: 4 }}>
          {cells.map((d, i) => {
            const key = ymd(d);
            const inMonth = d.getMonth() === cursor.getMonth();
            const isToday = key === todayKey;
            const items = byDate.get(key) ?? [];
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <div key={i} className="rounded-lg border p-1.5 flex flex-col gap-1"
                style={{ borderColor: isToday ? '#EF4444' : 'var(--border-subtle)', background: inMonth ? (weekend ? 'var(--bg-base)' : 'var(--bg-card)') : 'transparent', opacity: inMonth ? 1 : 0.4 }}>
                <div className="text-[10.5px] tabular-nums" style={{ color: isToday ? '#EF4444' : 'var(--text-muted)', fontWeight: isToday ? 700 : 400 }}>{d.getDate()}</div>
                {items.map((m) => {
                  const c = MILESTONE_HEALTH_REGISTRY[m.health].color;
                  return (
                    <button key={m.id} onClick={() => onOpen(m)} title={`${m.title}（${MILESTONE_HEALTH_REGISTRY[m.health].label} · ${m.progress}%）`}
                      className="text-left rounded px-1 py-0.5 flex items-center gap-1 hover:opacity-85"
                      style={{ background: `${c}1f` }}>
                      <span style={{ width: 7, height: 7, background: c, transform: 'rotate(45deg)', display: 'inline-block', borderRadius: 1, flexShrink: 0 }} />
                      <span className="text-[10px] truncate" style={{ color: 'var(--text-primary)' }}>{m.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
