/**
 * 成片时长：开工前就让人知道「大概多长」，也能自己定。
 * - 自动：服务端按内容估算（稿件全文照念多长、取多少讲重点），选项上直接写出估算值，不写空泛的「自动」；
 * - 指定：约 1 / 3 / 5 / 10 分钟。服务端按目标决定幕数与旁白字数，并校验脚本总时长落在目标的 ±15%。
 * 估算值来自 POST /api/quick-creation/estimate，前端只显示。
 * 选项放在「时长 · 风格」按钮的面板顶部：时长、风格都是「怎么做这一支」，收在同一个按钮里，输入框不再多一个按钮。
 */
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { DurationChoice, QcEstimate } from './types';

const OPTIONS: { value: DurationChoice; label: string; hint: string }[] = [
  { value: 'auto', label: '自动', hint: '按内容估算' },
  { value: 60, label: '约 1 分钟', hint: '讲重点' },
  { value: 180, label: '约 3 分钟', hint: '讲清楚' },
  { value: 300, label: '约 5 分钟', hint: '一步步教' },
  { value: 600, label: '约 10 分钟', hint: '完整课程' },
];

export const minutesLabel = (sec: number) => (sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`);
/** 按钮上的短写：自动时直接写估算值 */
export function durationShort(value: DurationChoice, estimate?: QcEstimate | null) {
  const sec = value === 'auto' ? estimate?.autoSec : value;
  return sec ? `约 ${minutesLabel(sec)}` : '时长';
}

/** 时长选项：桌面在时长按钮的面板里，手机在「视频 · 风格」面板顶部 */
export function DurationOptions({ value, estimate, onChange, compact }: { value: DurationChoice; estimate?: QcEstimate | null; onChange: (v: DurationChoice) => void; compact?: boolean }) {
  return (
    <div>
      <div role="radiogroup" aria-label="成片时长" className={cn(compact ? 'flex gap-1.5 overflow-x-auto pb-0.5' : 'flex flex-col gap-0.5')} style={compact ? { scrollbarWidth: 'none' } : undefined}>
        {OPTIONS.map(o => {
          const on = o.value === value;
          const label = o.value === 'auto' && estimate ? `自动 · 约 ${minutesLabel(estimate.autoSec)}` : o.label;
          return compact ? (
            <button key={String(o.value)} type="button" role="radio" aria-checked={on} data-qc="duration-option" data-value={String(o.value)} onClick={() => onChange(o.value)}
              className={cn('qc-face qc-face-chip relative inline-flex shrink-0 items-center px-3 text-[12.5px]', on ? 'font-medium text-[color:var(--accent-primary)]' : 'text-token-primary')}>
              {label}
            </button>
          ) : (
            <button key={String(o.value)} type="button" role="radio" aria-checked={on} data-qc="duration-option" data-value={String(o.value)} onClick={() => onChange(o.value)}
              className={cn('flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover-bg-soft', on && 'bg-[var(--selection-bg)]')}>
              <span className="min-w-0 flex-1 text-token-primary">{label}</span>
              <span className="shrink-0 text-[12px] text-token-muted">{o.hint}</span>
              <Check size={14} className={cn('shrink-0 text-[color:var(--accent-primary)]', !on && 'invisible')} aria-hidden />
            </button>
          );
        })}
      </div>
      {estimate && (
        <p className="m-0 mt-2 text-[12px] leading-[18px] text-token-secondary" data-qc="duration-basis">
          {estimate.basis}。分成约 {estimate.scenes} 幕，生成约 {estimate.generateMin[0]}–{estimate.generateMin[1]} 分钟。
        </p>
      )}
    </div>
  );
}
