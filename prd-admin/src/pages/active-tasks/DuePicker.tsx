/**
 * 什么时候要 —— 照提醒事项那套：四个快捷胶囊，点「自定」才出日历。
 *
 * 为什么不一上来就给日期选择器：大多数任务根本不该有时间要求，
 * 而真有时间的那些，九成落在今天/明天/本周末这三个上（最小输入原则）。
 */
import { useState } from 'react';

export interface DuePickerProps {
  /** 已选的时间，ISO 字符串；null 表示没设 */
  value: string | null;
  onChange: (next: string | null) => void;
}

/** 取本地日期的当天 18:00（「今天要」指的是今天下班前，不是此刻） */
function atEndOfDay(d: Date): string {
  const x = new Date(d);
  x.setHours(18, 0, 0, 0);
  return x.toISOString();
}

function todayISO(): string { return atEndOfDay(new Date()); }

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return atEndOfDay(d);
}

/** 本周末 = 最近的周六；今天已是周六或周日就取下一个周六 */
function weekendISO(): string {
  const d = new Date();
  const delta = (6 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return atEndOfDay(d);
}

/** ISO → <input type="date"> 要的 yyyy-MM-dd（按本地时区，不是 UTC 切片） */
function toDateInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sameDay(iso: string | null, other: string): boolean {
  if (!iso) return false;
  return toDateInput(iso) === toDateInput(other);
}

export function DuePicker({ value, onChange }: DuePickerProps) {
  const [customOpen, setCustomOpen] = useState(false);

  const options = [
    { label: '今天', iso: todayISO() },
    { label: '明天', iso: tomorrowISO() },
    { label: '本周末', iso: weekendISO() },
  ];

  const isCustom = !!value && !options.some((o) => sameDay(value, o.iso));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`atb-chip${!value ? ' atb-chip--on' : ''}`}
          onClick={() => { onChange(null); setCustomOpen(false); }}
        >
          不设时间
        </button>
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`atb-chip${sameDay(value, o.iso) ? ' atb-chip--on' : ''}`}
            onClick={() => { onChange(o.iso); setCustomOpen(false); }}
          >
            {o.label}
          </button>
        ))}
        <button
          type="button"
          className={`atb-chip${isCustom || customOpen ? ' atb-chip--on' : ''}`}
          onClick={() => setCustomOpen((v) => !v)}
        >
          自定
        </button>
      </div>

      {(customOpen || isCustom) && (
        <input
          type="date"
          className="atb-input"
          value={value ? toDateInput(value) : ''}
          onChange={(e) => {
            if (!e.target.value) { onChange(null); return; }
            const [y, m, d] = e.target.value.split('-').map(Number);
            onChange(atEndOfDay(new Date(y, m - 1, d)));
          }}
        />
      )}
    </div>
  );
}

export default DuePicker;
