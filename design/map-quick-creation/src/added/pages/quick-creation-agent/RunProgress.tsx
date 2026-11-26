import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Clock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/design/Button';
import type { QcFailure, QcRun, QcStage } from './types';
import { formatDuration, formatRemain } from './format';

function StageDot({ stage, index }: { stage: QcStage; index: number }) {
  const base = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] text-[11px]';
  if (stage.status === 'done') return <span className={cn(base, 'border-[color:var(--accent-fg-success)]/60 bg-[color:var(--accent-fg-success)]/[0.12] text-[color:var(--accent-fg-success)]')}><Check size={12} strokeWidth={3} aria-label="已完成" /></span>;
  if (stage.status === 'failed') return <span className={cn(base, 'border-[color:var(--accent-fg-error)]/60 bg-[color:var(--accent-fg-error)]/[0.12] text-[color:var(--accent-fg-error)]')}><AlertTriangle size={12} aria-label="未完成" /></span>;
  if (stage.status === 'running') return <span className={cn(base, 'border-[color:var(--accent-primary)] text-[color:var(--accent-primary)]')}><span className="qc-pulse h-2 w-2 rounded-full bg-[color:var(--accent-primary)]" aria-label="进行中" /></span>;
  return <span className={cn(base, 'border-token-subtle text-token-muted')}>{index + 1}</span>;
}

export function QueueCard({ run }: { run: QcRun }) {
  const q = run.queue;
  if (!q) return null;
  const cells = Array.from({ length: q.running + q.ahead + 1 + 2 }, (_, i) => (i < q.running ? 'run' : i < q.running + q.ahead ? 'wait' : i === q.running + q.ahead ? 'me' : 'after'));
  return (
    <div className="rounded-[var(--radius-card)] border border-token-subtle bg-token-nested p-3.5" data-qc="queue-card">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-token-primary">排队中 · 第 {q.position} 位</span>
        <span className="text-[12px] text-token-muted">前面 {q.ahead} 个，{formatRemain(q.startInSec)}后开始</span>
      </div>
      <div className="mt-2.5 flex gap-1" aria-hidden>
        {cells.map((c, i) => (
          <span key={i} className={cn('h-1.5 flex-1 rounded-full',
            c === 'run' && 'bg-[color:var(--accent-fg-success)]/55',
            c === 'wait' && 'bg-[color:var(--accent-fg-info)]/40',
            c === 'me' && 'bg-[color:var(--accent-primary)]',
            c === 'after' && 'bg-token-nested border border-dashed border-token-subtle')} />
        ))}
      </div>
      <div className="mt-2 text-[12px] leading-5 text-token-secondary">
        团队同时最多 {q.capacity} 个在生成，现在 {q.running} 个在跑。排队不是失败，轮到会自动开始；可以离开，完成后会发通知。
      </div>
    </div>
  );
}

export function FailureCard({ failure, onAction }: { failure: QcFailure; onAction: (a: QcFailure['actions'][number]) => void }) {
  const label = {
    'retry-unit': `重试${failure.unitIndex ? `第 ${failure.unitIndex} ${failure.stageKey === 'voice' ? '幕' : '节'}` : '这一步'}`,
    'retry-step': '重试这一步',
    'skip-unit': '跳过这一幕的旁白，继续合成',
    requeue: '重新排队，从这里继续',
  } as const;
  const [primary, ...others] = failure.actions;
  return (
    <div className="rounded-[var(--radius-field)] border border-[color:var(--accent-fg-error)]/35 bg-[color:var(--accent-fg-error)]/[0.06] p-3" data-qc="failure-card" role="alert">
      <div className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--accent-fg-error)]"><AlertTriangle size={14} />{failure.message}</div>
      <div className="mt-1.5 text-[12px] leading-5 text-token-secondary">已保存：{failure.saved.join('、')}。重试只会重做没完成的部分。</div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {primary && <Button size="sm" variant="primary" className="max-md:min-h-11" data-qc="recover-primary" onClick={() => onAction(primary)}><RotateCcw size={13} />{label[primary]}</Button>}
        {others.map(a => <Button key={a} size="sm" variant="ghost" className="max-md:min-h-11" data-qc={`recover-${a}`} onClick={() => onAction(a)}>{label[a]}</Button>)}
      </div>
    </div>
  );
}

export function RunProgress({ run }: { run: QcRun }) {
  const finished = run.status === 'done';
  const [showSteps, setShowSteps] = useState(false);
  /* 完成后过程收成一行，把注意力让给成品与发布；需要时展开回看 */
  if (finished && !showSteps) {
    return (
      <button type="button" onClick={() => setShowSteps(true)} data-qc="run-progress"
        className="flex w-full items-center gap-2 rounded-[var(--radius-field)] border border-token-subtle bg-token-nested px-3 py-2 text-left text-[12.5px] hover-bg-soft max-md:min-h-11">
        <Check size={14} className="text-[color:var(--accent-fg-success)]" aria-hidden />
        <span className="text-token-primary">{run.stages.slice(0, -1).map(s => s.label).join(' → ')} 全部完成</span>
        <span className="text-token-muted">· 用时 {formatDuration(run.elapsedSec)}</span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-token-muted">查看过程<ChevronDown size={13} /></span>
      </button>
    );
  }
  return (
    <div className="rounded-[var(--radius-card)] border border-token-subtle bg-[var(--bg-card)] px-3.5 pb-1.5 pt-3" data-qc="run-progress">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[12px] font-medium text-token-secondary">生成进度</span>
        {finished && <button type="button" onClick={() => setShowSteps(false)} className="text-[11.5px] text-token-muted hover:text-token-primary">收起</button>}
        <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-token-muted">
          <Clock size={12} aria-hidden />
          {finished ? `用时 ${formatDuration(run.elapsedSec)}` : run.status === 'failed' ? `运行 ${formatDuration(run.elapsedSec)} 后停下` : (
            <>已用 {formatDuration(run.elapsedSec)}{run.remainSec != null ? ` · 预计还需 ${formatRemain(run.remainSec)}` : ' · 正在估算剩余时间'}</>
          )}
        </span>
      </div>
      <ol>
        {run.stages.map((s, i) => {
          const last = i === run.stages.length - 1;
          const active = s.status === 'running' || s.status === 'failed';
          return (
            <li key={s.key} className="flex gap-3" data-stage={s.key} data-stage-status={s.status}>
              <div className="flex flex-col items-center">
                <StageDot stage={s} index={i} />
                {!last && <span className={cn('min-h-3 w-[1.5px] flex-1', s.status === 'done' ? 'bg-[color:var(--accent-fg-success)]/45' : 'bg-[var(--border-subtle)]')} />}
              </div>
              <div className="min-w-0 flex-1 pb-3">
                <div className={cn('text-[13px]', s.status === 'pending' ? 'text-token-muted' : 'font-medium text-token-primary', s.status === 'failed' && 'text-[color:var(--accent-fg-error)]')}>{s.label}</div>
                {s.detail && (active || s.status === 'done') && <div className={cn('mt-0.5 text-[12px] leading-5', active ? 'text-token-secondary' : 'text-token-muted')}>{s.detail}</div>}
                {s.status === 'running' && s.progress != null && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
                    <div className="h-full rounded-full bg-[color:var(--accent-primary)] transition-[width] duration-700" style={{ width: `${s.progress}%` }} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {run.estimateBasis && !finished && run.status !== 'failed' && <div className="pb-2 text-[11px] text-token-muted">预计依据：{run.estimateBasis}</div>}
    </div>
  );
}
