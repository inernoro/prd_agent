/**
 * 对话里助手一侧的过程卡：排队、生成进度、失败恢复、完成。
 * 写法对齐网页生成工作台的 RunProgressCard：标题行说「此刻在做什么」，右上角是走动的计时，
 * 下方是任务清单；进行中的那一步高亮、带流动的进度条，其余步骤一行一项。
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, Circle, CircleCheck, Clock3, Globe, RotateCcw, Video } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/design/Button';
import type { OutputKind, QcFailure, QcRun } from './types';
import { formatDuration, formatRemain } from './format';

/** 计时：不到 1 小时写 mm:ss，超过写 h:mm:ss（出片常要 30–60 分钟，超时上限 2 小时） */
function clock(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}

/** 排队看板里的分钟数：只写到分钟，不足 1 分钟写「1 分钟内」 */
function mins(sec: number) {
  const m = Math.round(sec / 60);
  return m < 1 ? '1 分钟内' : m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}

function Initial({ name, me }: { name: string; me?: boolean }) {
  return (
    <span className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
      me ? 'bg-[color:var(--accent-primary)] text-[color:var(--accent-on-primary)]' : 'bg-[var(--bg-tertiary)] text-token-secondary')} aria-hidden>
      {me ? '你' : name.slice(-1)}
    </span>
  );
}

function KindMark({ kind }: { kind: OutputKind }) {
  return kind === 'video' ? <Video size={12} className="shrink-0 text-token-muted" aria-label="视频" /> : <Globe size={12} className="shrink-0 text-token-muted" aria-label="网页" />;
}

/**
 * 排队：大字说第几位、多久后开始；一句话说原因（团队同时生成的上限满了，与稿件无关）；
 * 排在你前面的人直接列出（谁、做什么、预计何时开始），正在生成的几位收在「正在生成」里，需要时展开。
 * 不套卡片：靠字号与留白分层，不靠边框。
 */
export function QueueCard({ run }: { run: QcRun }) {
  const q = run.queue;
  const [showRunning, setShowRunning] = useState(false);
  if (!q) return null;
  const runningItems = q.runningItems ?? [];
  const aheadItems = q.aheadItems ?? [];
  return (
    <section className="qc-rise" data-qc="queue-card" data-position={q.position}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[20px] font-semibold tracking-tight text-token-primary">排队中 · 第 {q.position} 位</div>
        <div className="shrink-0 text-[13px] tabular-nums text-token-secondary">约 {mins(q.startInSec)}后开始</div>
      </div>
      <p className="m-0 mt-1.5 text-[13px] leading-5 text-token-secondary" data-qc="queue-reason">
        团队同时最多生成 {q.capacity} 个，现在都在用，所以要等一等；这和你的稿件无关，轮到你会自动开始。
      </p>
      <ol className="m-0 mt-4 list-none p-0" aria-label="排队顺序">
        {aheadItems.map((a, i) => (
          <li key={a.ownerName + a.title} className="flex items-center gap-2.5 py-1.5 text-[13px]" data-queue-ahead={i + 1}>
            <Initial name={a.ownerName} />
            <span className="shrink-0 font-medium text-token-primary">{a.ownerName}</span>
            <span className="min-w-0 flex-1 truncate text-token-muted">{a.title}</span>
            <span className="shrink-0 tabular-nums text-token-muted">{mins(a.startInSec ?? 0)}后</span>
          </li>
        ))}
        <li className="flex items-center gap-2.5 py-1.5 text-[13px]" data-queue-me>
          <Initial name="你" me />
          <span className="shrink-0 font-semibold text-token-primary">你</span>
          <span className="min-w-0 flex-1 truncate text-token-secondary">{run.title}</span>
          <span className="shrink-0 font-medium tabular-nums text-[color:var(--accent-primary)]">{mins(q.startInSec)}后</span>
        </li>
      </ol>
      <button type="button" aria-expanded={showRunning} onClick={() => setShowRunning(v => !v)} data-qc="queue-running-toggle"
        className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-md text-[12.5px] text-token-muted hover:text-token-primary max-md:min-h-11">
        正在生成的 {q.running} 个<ChevronDown size={13} className={cn('transition-transform', showRunning && 'rotate-180')} aria-hidden />
      </button>
      {showRunning && (
        <ul className="m-0 list-none p-0" aria-label="正在生成的任务">
          {runningItems.map(r => (
            <li key={r.ownerName + r.title} className="flex items-center gap-2.5 py-1.5 text-[12.5px]" data-queue-running={r.ownerName}>
              <Initial name={r.ownerName} />
              <span className="shrink-0 text-token-primary">{r.ownerName}</span>
              <KindMark kind={r.kind} />
              <span className="min-w-0 flex-1 truncate text-token-muted">{r.title}</span>
              <span className="shrink-0 tabular-nums text-token-muted">还需约 {mins(r.remainSec ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
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
          <div className="mt-1 text-[12.5px] leading-5 text-token-secondary">已保存：{failure.saved.join('、')}。不需要改稿件，重试只会重做没完成的部分。</div>
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

  const title = finished ? '全部完成' : failed ? `停在${current?.label ?? ''}` : current?.status === 'running' ? `正在${current.label}` : '正在准备';
  /* 总进度：已完成的阶段 + 当前阶段的进度（「已生成」不算一段） */
  const work = steps.filter(s => s.key !== 'done');
  const overall = Math.round(((work.filter(s => s.status === 'done').length + ((current?.status === 'running' ? current.progress ?? 30 : 0) / 100)) / Math.max(1, work.length)) * 100);
  return (
    <section className="qc-rise" data-qc="run-progress">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[20px] font-semibold tracking-tight text-token-primary">
          {failed && <AlertTriangle size={18} className="shrink-0" style={{ color: 'var(--accent-fg-error)' }} aria-hidden />}
          <span className="truncate">{title}</span>
        </div>
        <div className="shrink-0 text-[13px] tabular-nums text-token-secondary">
          {failed ? `运行 ${formatDuration(run.elapsedSec)}后停下` : run.remainSec != null ? `还需${formatRemain(run.remainSec)}` : `已用 ${clock(run.elapsedSec)}`}
        </div>
      </div>
      {current?.detail && !failed && <div className="mt-1 truncate text-[13px] text-token-secondary">{current.detail}</div>}
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]" role="progressbar" aria-valuenow={overall} aria-valuemin={0} aria-valuemax={100} aria-label="总进度">
        <div className={cn('h-full rounded-full transition-[width] duration-700', failed ? '' : 'qc-bar-live')} style={{ width: `${Math.max(4, overall)}%`, ...(failed ? { background: 'var(--accent-fg-error)' } : {}) }} />
      </div>
      <button type="button" aria-expanded={showSteps} onClick={() => setShowSteps(v => !v)} data-qc="process-toggle"
        className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-md text-[12.5px] text-token-muted hover:text-token-primary max-md:min-h-11">
        过程 · {doneCount} / {steps.length}<ChevronDown size={13} className={cn('transition-transform', showSteps && 'rotate-180')} aria-hidden />
      </button>
      {/* 步骤列表默认收起；data-stage 一直在，供程序判断 */}
      <ol aria-label="生成步骤" className={cn('m-0 list-none p-0', !showSteps && 'hidden')}>
        {steps.map(s => {
          const live = s.status === 'running';
          return (
            <li key={s.key} data-stage={s.key} data-stage-status={s.status} aria-current={live ? 'step' : undefined}
              className="flex min-h-8 items-center gap-2.5 text-[13px]">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: s.status === 'done' ? 'var(--accent-fg-success)' : live ? 'var(--accent-primary)' : s.status === 'failed' ? 'var(--accent-fg-error)' : 'var(--text-muted)' }}>
                {s.status === 'done' ? <CircleCheck size={14} /> : live ? <Clock3 size={14} /> : s.status === 'failed' ? <AlertTriangle size={13} /> : <Circle size={14} />}
              </span>
              <span className={cn('min-w-0 flex-1 truncate', s.status === 'pending' ? 'text-token-muted' : 'text-token-primary')}>
                {s.label}{s.status === 'done' && s.detail && <span className="text-token-muted"> · {s.detail}</span>}
              </span>
              {live && <span className="shrink-0 text-[12px] tabular-nums text-[color:var(--accent-primary)]">{s.progress != null ? `${s.progress}%` : '进行中'}</span>}
              {s.status === 'failed' && <span className="shrink-0 text-[12px]" style={{ color: 'var(--accent-fg-error)' }}>未完成</span>}
            </li>
          );
        })}
      </ol>
      {showSteps && run.estimateBasis && !finished && !failed && <div className="pt-1 text-[12px] text-token-muted">预计依据：{run.estimateBasis}</div>}
    </section>
  );
}
