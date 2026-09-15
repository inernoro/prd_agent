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
import { dayKey, endOfDay, isSameDay } from './dueTime';

export interface DuePickerProps {
  /** 已选的时间，ISO 字符串；null 表示没设 */
  value: string | null;
  onChange: (next: string | null) => void;
}

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return endOfDay(d).toISOString();
}

/** 本周末 = 最近的周六；今天已是周六或周日就取下一个周六 */
function weekendISO(): string {
  const d = new Date();
  return shift((6 - d.getDay() + 7) % 7 || 7);
}

function sameDay(iso: string | null, other: string): boolean {
  if (!iso) return false;
  return dayKey(new Date(iso)) === dayKey(new Date(other));
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

/** 某个月要画几格：从当月 1 号所在那一周的周一起，补满整周 */
function gridOf(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7; // 周一为一周之首
  const start = new Date(first);
  start.setDate(1 - lead);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
    // 已经画完当月且走完整周就收手，不必固定六行
    if (i >= 27 && d.getDay() === 0 && d.getMonth() !== anchor.getMonth()) break;
  }
  return cells;
}

function MonthGrid({ value, onPick }: { value: string | null; onPick: (d: Date) => void }) {
  const today = new Date();
  const [anchor, setAnchor] = useState(() => (value ? new Date(value) : today));
  const cells = gridOf(anchor);

  return (
    <div className="atb-cal">
      <div className="atb-cal__head">
        <button
          type="button"
          className="atb-cal__nav"
          aria-label="上个月"
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="atb-cal__month">{anchor.getFullYear()} 年 {anchor.getMonth() + 1} 月</span>
        <button
          type="button"
          className="atb-cal__nav"
          aria-label="下个月"
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="atb-cal__grid" role="grid">
        {WEEK.map((w) => <span className="atb-cal__wd" key={w}>{w}</span>)}
        {cells.map((d) => {
          const outside = d.getMonth() !== anchor.getMonth();
          const on = !!value && isSameDay(d, new Date(value));
          return (
            <button
              type="button"
              key={dayKey(d)}
              className={`atb-cal__day${outside ? ' atb-cal__day--out' : ''}${on ? ' atb-cal__day--on' : ''}${isSameDay(d, today) ? ' atb-cal__day--today' : ''}`}
              aria-pressed={on}
              aria-label={`${d.getMonth() + 1}月${d.getDate()}日`}
              onClick={() => onPick(d)}
            >
              {d.getDate()}
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
