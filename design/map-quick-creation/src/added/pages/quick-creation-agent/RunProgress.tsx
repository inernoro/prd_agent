/**
 * 对话里助手一侧的过程卡：排队、生成进度、失败恢复、完成。
 * 写法对齐网页生成工作台的 RunProgressCard：标题行说「此刻在做什么」，右上角是走动的计时，
 * 下方是任务清单；进行中的那一步高亮、带流动的进度条，其余步骤一行一项。
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, Circle, CircleCheck, Clock3, RotateCcw, Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { QcFailure, QcRun } from './types';
import { formatDuration, formatRemain } from './format';

function clock(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function QueueCard({ run }: { run: QcRun }) {
  const q = run.queue;
  if (!q) return null;
  const slots = Array.from({ length: q.running + q.ahead + 1 }, (_, i) => (i < q.running ? 'run' : i < q.running + q.ahead ? 'wait' : 'me'));
  return (
    <section className="qc-card qc-rise p-4" data-qc="queue-card">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--selection-bg)] text-[color:var(--accent-primary)]"><Users size={17} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-token-primary">排队中 · 第 {q.position} 位</div>
          <div className="mt-0.5 text-[12.5px] text-token-secondary">前面还有 {q.ahead} 个，预计 {formatRemain(q.startInSec)}后开始</div>
        </div>
      </div>
      <div className="mt-3.5 rounded-[10px] bg-[var(--bg-secondary)] p-2.5">
        <div className="flex gap-1.5" aria-hidden>
          {slots.map((c, i) => (
            <span key={i} className={cn('flex h-7 flex-1 items-center justify-center rounded-md text-[11px] font-semibold',
              c === 'run' && 'qc-shimmer bg-[var(--semantic-success-soft)]',
              c === 'wait' && 'border border-dashed border-[var(--border-default)]',
              c === 'me' && 'bg-[color:var(--accent-primary)] text-[color:var(--accent-on-primary)]')}>
              {c === 'me' ? '你' : ''}
            </span>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-token-muted">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-[var(--semantic-success-soft)] ring-1 ring-[color:var(--accent-fg-success)]" />生成中 {q.running}</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm border border-dashed border-[var(--border-default)]" />排在前面 {q.ahead}</span>
          </span>
          <span>同时最多 {q.capacity} 个</span>
        </div>
      </div>
      <p className="mt-2.5 text-[12px] leading-5 text-token-secondary">排队不是失败，轮到会自动开始：先出分镜，再逐幕配音，最后合成成片。</p>
    </section>
  );
}

const ACTION_LABEL = (failure: QcFailure) => ({
  'retry-unit': `重试${failure.unitIndex ? `第 ${failure.unitIndex} ${failure.stageKey === 'voice' ? '幕' : '节'}` : '这一步'}`,
  'retry-step': '重试这一步',
  'skip-unit': '跳过这一幕的旁白，继续合成',
  requeue: '重新排队，从这里继续',
}) as const;

export function FailureCard({ failure, onAction }: { failure: QcFailure; onAction: (a: QcFailure['actions'][number]) => void }) {
  const label = ACTION_LABEL(failure);
  const [primary, ...others] = failure.actions;
  return (
    <section className="qc-rise rounded-[14px] border p-4" style={{ borderColor: 'var(--semantic-danger-border)', background: 'var(--semantic-danger-soft)' }} data-qc="failure-card" role="alert">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--bg-input)]" style={{ color: 'var(--accent-fg-error)' }}><AlertTriangle size={17} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-token-primary">{failure.message}</div>
          <div className="mt-1 text-[12.5px] leading-5 text-token-secondary">已保存：{failure.saved.join('、')}。重试只会重做没完成的部分。</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-12">
        {primary && <Button size="sm" variant="primary" className="max-md:min-h-11" data-qc="recover-primary" onClick={() => onAction(primary)}><RotateCcw size={13} />{label[primary]}</Button>}
        {others.map(a => <Button key={a} size="sm" variant="secondary" className="max-md:min-h-11" data-qc={`recover-${a}`} onClick={() => onAction(a)}>{label[a]}</Button>)}
      </div>
    </section>
  );
}

export function RunProgress({ run }: { run: QcRun }) {
  const finished = run.status === 'done';
  const failed = run.status === 'failed';
  const [showSteps, setShowSteps] = useState(false);
  const steps = run.stages;
  const doneCount = steps.filter(s => s.status === 'done').length;
  const current = steps.find(s => s.status === 'running') ?? steps.find(s => s.status === 'failed');

  /* 完成后过程收成一行，把注意力让给成品与发布；需要时展开回看 */
  if (finished && !showSteps) {
    return (
      <button type="button" onClick={() => setShowSteps(true)} data-qc="run-progress"
        className="flex w-full items-center gap-2 rounded-[10px] px-1 py-1.5 text-left text-[12.5px] hover-bg-soft max-md:min-h-11">
        <CircleCheck size={15} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />
        <span className="min-w-0 truncate text-token-secondary">{steps.slice(0, -1).map(s => s.label).join(' · ')} 全部完成，用时 {formatDuration(run.elapsedSec)}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-token-muted">过程<ChevronDown size={13} /></span>
      </button>
    );
  }

  const title = finished ? '全部完成' : failed ? `停在「${current?.label ?? ''}」` : current?.status === 'running' ? `正在${current.label}` : '正在准备';
  return (
    <section className="qc-card qc-rise overflow-hidden" data-qc="run-progress">
      <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-token-primary">
            {!finished && !failed && <MapSpinner size={14} />}
            {failed && <AlertTriangle size={15} style={{ color: 'var(--accent-fg-error)' }} aria-hidden />}
            {finished && <CircleCheck size={15} className="text-[color:var(--accent-fg-success)]" aria-hidden />}
            {title}
          </div>
          {current?.detail && !finished && !failed && <div className="mt-1 text-[12.5px] leading-5 text-token-secondary">{current.detail}</div>}
        </div>
        <div className="shrink-0 text-right">
          <div className="font-[var(--font-code)] text-[18px] font-semibold tabular-nums leading-6 text-token-primary">{clock(run.elapsedSec)}</div>
          <div className="text-[11px] text-token-muted">
            {finished ? '总用时' : failed ? '运行后停下' : run.remainSec != null ? `还需${formatRemain(run.remainSec)}` : '正在估算'}
          </div>
        </div>
      </div>
      {/* 分段总进度：每段一个阶段，进行中那段流动 */}
      <div className="flex gap-1 px-4" aria-hidden>
        {steps.map(s => (
          <span key={s.key} className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            {s.status === 'done' && <span className="block h-full w-full rounded-full bg-[color:var(--accent-fg-success)] opacity-70" />}
            {s.status === 'running' && <span className="qc-bar-live block h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(8, s.progress ?? 30)}%` }} />}
            {s.status === 'failed' && <span className="block h-full w-full rounded-full" style={{ background: 'var(--accent-fg-error)' }} />}
          </span>
        ))}
      </div>
      <div className="mx-4 mb-3 mt-3 rounded-[10px] bg-[var(--bg-secondary)] px-3 py-1.5">
        <div className="flex items-center justify-between border-b border-token-subtle pb-1.5 pt-0.5 text-[11.5px]">
          <span className="font-medium text-token-secondary">任务清单</span>
          <span className="flex items-center gap-2 tabular-nums text-token-muted">
            {doneCount} / {steps.length}
            {finished && <button type="button" onClick={() => setShowSteps(false)} className="rounded px-1 hover:text-token-primary">收起</button>}
          </span>
        </div>
        <ol aria-label="生成步骤">
          {steps.map(s => {
            const live = s.status === 'running';
            return (
              <li key={s.key} data-stage={s.key} data-stage-status={s.status} aria-current={live ? 'step' : undefined}
                className="flex min-h-8 items-center gap-2 text-[12.5px]">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: s.status === 'done' ? 'var(--accent-fg-success)' : live ? 'var(--accent-primary)' : s.status === 'failed' ? 'var(--accent-fg-error)' : 'var(--text-muted)' }}>
                  {s.status === 'done' ? <CircleCheck size={14} /> : live ? <Clock3 size={14} /> : s.status === 'failed' ? <AlertTriangle size={13} /> : <Circle size={14} />}
                </span>
                <span className={cn('min-w-0 flex-1 truncate', s.status === 'pending' ? 'text-token-muted' : 'text-token-primary', live && 'font-medium')}>
                  {s.label}
                  {s.status === 'done' && s.detail && <span className="text-token-muted"> · {s.detail}</span>}
                </span>
                {live && <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[color:var(--accent-primary)]">{s.progress != null ? `${s.progress}%` : '进行中'}</span>}
                {s.status === 'failed' && <span className="shrink-0 text-[11px] font-semibold" style={{ color: 'var(--accent-fg-error)' }}>未完成</span>}
              </li>
            );
          })}
        </ol>
      </div>
      {run.estimateBasis && !finished && !failed && <div className="px-4 pb-3 text-[11px] text-token-muted">预计依据：{run.estimateBasis}</div>}
    </section>
  );
}

