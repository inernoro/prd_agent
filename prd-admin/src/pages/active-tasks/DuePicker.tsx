/**
 * 什么时候要 —— 照提醒事项那套：四个快捷胶囊，点「自定」才出月历。
 *
 * 为什么不一上来就给日期选择器：大多数任务根本不该有时间要求，
 * 而真有时间的那些，九成落在今天/明天/本周末这三个上（最小输入原则）。
 *
 * 「自定」展开的是自绘的月历网格，不是 <input type="date">：
 * 苹果从不把日期交给一个裸输入控件 —— macOS 提醒事项点日期出的是 popover 里的月历，
 * iOS 是 sheet 里的月历。裸 input 在 Mac 上是一个几像素宽的步进器，
 * 而且完全看不出「周五是几号」「本周还剩几天」。
 */
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, dayKey, dayOf, endOfDay, isSameDay, monthOf, teamDate, teamDay, weekdayOf, yearOf } from './dueTime';

export interface DuePickerProps {
  /** 已选的时间，ISO 字符串；null 表示没设 */
  value: string | null;
  onChange: (next: string | null) => void;
}

function shift(days: number): string {
  return endOfDay(addDays(teamDay(), days)).toISOString();
}

/**
 * 本周末 = 最近的周六。周六当天点它指的就是今天 —— 与 dueParse 同一口径。
 * 过了当天 18:00 的情况由 endOfDay 兜（退到 23:59），不需要在这里 +7。
 */
function weekendISO(): string {
  return shift((6 - weekdayOf(teamDay()) + 7) % 7);
}

/** 两个 ISO 瞬间是不是落在团队日历的同一天 */
function sameDay(iso: string | null, other: string): boolean {
  if (!iso) return false;
  return dayKey(teamDay(new Date(iso))) === dayKey(teamDay(new Date(other)));
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 某个月要画几格：从当月 1 号所在那一周的周一起，补满整周。
 * anchor 与返回的格子都是团队日历的坐标 Date（见 dueTime）。
 */
function gridOf(anchor: Date): Date[] {
  const first = teamDate(yearOf(anchor), monthOf(anchor), 1);
  const lead = (weekdayOf(first) + 6) % 7; // 周一为一周之首
  const start = addDays(first, -lead);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = addDays(start, i);
    cells.push(d);
    // 已经画完当月且走完整周就收手，不必固定六行
    if (i >= 27 && weekdayOf(d) === 0 && monthOf(d) !== monthOf(anchor)) break;
  }
  return cells;
}

function MonthGrid({ value, onPick }: { value: string | null; onPick: (d: Date) => void }) {
  const today = teamDay();
  const [anchor, setAnchor] = useState(() => (value ? teamDay(new Date(value)) : today));
  const cells = gridOf(anchor);

  return (
    <div className="atb-cal">
      <div className="atb-cal__head">
        <button
          type="button"
          className="atb-cal__nav"
          aria-label="上个月"
          onClick={() => setAnchor(teamDate(yearOf(anchor), monthOf(anchor) - 1, 1))}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="atb-cal__month">{yearOf(anchor)} 年 {monthOf(anchor) + 1} 月</span>
        <button
          type="button"
          className="atb-cal__nav"
          aria-label="下个月"
          onClick={() => setAnchor(teamDate(yearOf(anchor), monthOf(anchor) + 1, 1))}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="atb-cal__grid" role="grid">
        {WEEK.map((w) => <span className="atb-cal__wd" key={w}>{w}</span>)}
        {cells.map((d) => {
          const outside = monthOf(d) !== monthOf(anchor);
          const on = !!value && isSameDay(d, teamDay(new Date(value)));
          return (
            <button
              type="button"
              key={dayKey(d)}
              className={`atb-cal__day${outside ? ' atb-cal__day--out' : ''}${on ? ' atb-cal__day--on' : ''}${isSameDay(d, today) ? ' atb-cal__day--today' : ''}`}
              aria-pressed={on}
              aria-label={`${monthOf(d) + 1}月${dayOf(d)}日`}
              onClick={() => onPick(d)}
            >
              {dayOf(d)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DuePicker({ value, onChange }: DuePickerProps) {
  const options = [
    { label: '今天', iso: shift(0) },
    { label: '明天', iso: shift(1) },
    { label: '本周末', iso: weekendISO() },
  ];

  const isCustom = !!value && !options.some((o) => sameDay(value, o.iso));
  // 展开状态是真状态：上一版写成 (customOpen || isCustom)，选了自定之后按钮就再也收不起来
  const [customOpen, setCustomOpen] = useState(isCustom);

  return (
    <div className="atb-duepick">
      <div className="atb-chips">
        <button
          type="button"
          className={`atb-chip${!value ? ' atb-chip--on' : ''}`}
          aria-pressed={!value}
          onClick={() => { onChange(null); setCustomOpen(false); }}
        >
          不设时间
        </button>
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`atb-chip${sameDay(value, o.iso) ? ' atb-chip--on' : ''}`}
            aria-pressed={sameDay(value, o.iso)}
            onClick={() => { onChange(o.iso); setCustomOpen(false); }}
          >
            {o.label}
          </button>
        ))}
        <button
          type="button"
          className={`atb-chip${isCustom ? ' atb-chip--on' : ''}`}
          aria-pressed={isCustom}
          aria-expanded={customOpen}
          onClick={() => setCustomOpen((v) => !v)}
        >
          自定
        </button>
      </div>

      {customOpen && (
        <MonthGrid value={value} onPick={(d) => onChange(endOfDay(d).toISOString())} />
      )}
    </div>
  );
}

export default DuePicker;
