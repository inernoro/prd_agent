/**
 * 快速创作的排队、阶段进度和失败恢复。展开过程可回看服务端的阶段详情。
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
        <div className="shrink-0 text-[13px] tabular-nums text-token-secondary">{q.startInSec == null ? '正在估算' : `约 ${mins(q.startInSec)}后开始`}</div>
      </div>
      <p className="m-0 mt-1.5 text-[13px] leading-5 text-token-secondary" data-qc="queue-reason">
        当前有 {q.running} 个任务执行中，同时最多运行 {q.capacity} 个。轮到你会自动开始。
      </p>
      {q.ahead > 0 && <p className="m-0 mt-3 text-[12px] text-token-muted">前面还有 {q.ahead} 个任务</p>}
      <ol className="m-0 mt-4 list-none p-0" aria-label="排队顺序">
        {aheadItems.map((a, i) => (
          <li key={a.ownerName + a.title} className="flex items-center gap-2.5 py-1.5 text-[13px]" data-queue-ahead={i + 1}>
            <Initial name={a.ownerName} />
            <span className="shrink-0 font-medium text-token-primary">{a.ownerName}</span>
            <span className="min-w-0 flex-1 truncate text-token-muted">{a.title}</span>
            <span className="shrink-0 tabular-nums text-token-muted">{a.startInSec == null ? '估算中' : `${mins(a.startInSec)}后`}</span>
          </li>
        ))}
        <li className="flex items-center gap-2.5 py-1.5 text-[13px]" data-queue-me>
          <Initial name="你" me />
          <span className="shrink-0 font-semibold text-token-primary">你</span>
          <span className="min-w-0 flex-1 truncate text-token-secondary">{run.title}</span>
          <span className="shrink-0 font-medium tabular-nums text-[color:var(--accent-primary)]">{q.startInSec == null ? '估算中' : `${mins(q.startInSec)}后`}</span>
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
              <span className="shrink-0 tabular-nums text-token-muted">{r.remainSec == null ? '估算中' : `还需约 ${mins(r.remainSec)}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ACTION_LABEL = (failure: QcFailure) => ({
  'retry-unit': `重试${failure.unitIndex ? `第 ${failure.unitIndex} ${failure.stageKey === 'voice' || failure.stageKey === 'scene' ? '幕' : '节'}` : '这一步'}`,
  'retry-step': '重试这一步',
  'skip-unit': '跳过这一幕的旁白，继续合成',
  resume: '重新排队，从这里继续',
  requeue: '用原稿重新排队',
}) as const;

export function FailureCard({ failure, onAction }: { failure: QcFailure; onAction: (a: QcFailure['actions'][number]) => void }) {
  const label = ACTION_LABEL(failure);
  const [primary, ...others] = failure.actions;
  return (
    <section className="qc-rise" data-qc="failure-card" role="alert">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ color: 'var(--accent-fg-error)' }}><AlertTriangle size={17} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-token-primary">{failure.message}</div>
          <div className="mt-1 text-[12.5px] leading-5 text-token-secondary">已保存：{failure.saved.join('、')}。</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-12">
        {primary && <Button size="sm" variant="primary" className="max-md:min-h-11" data-qc="recover-primary" onClick={() => onAction(primary)}><RotateCcw size={13} />{label[primary]}</Button>}
        {others.map(a => <Button key={a} size="sm" variant="ghost" className="max-md:min-h-11" data-qc={`recover-${a}`} onClick={() => onAction(a)}>{label[a]}</Button>)}
      </div>
    </section>
  );
}

const STAGE_NAMES: Record<string, string> = {
  queued: '排队', 'waiting-capacity': '排队', 'service-recovering': '恢复',
  'preparing-workspace': '准备', 'reading-sources': '读稿',
  outline: '大纲', layout: '版式', script: '分镜', scene: '绘制', voice: '配音', render: '合成', mux: '合成',
  'reviewing-page': '检查', 'repairing-quality': '修整', 'saving-result': '保存',
};

const STAGE_DETAILS: Record<string, string> = {
  'waiting-capacity': '轮到后会自动开始',
  'service-recovering': '服务正在恢复，稿件和要求已保存',
  'preparing-workspace': '正在准备稿件和所选风格',
  'reading-sources': '正在整理稿件里的内容',
  'reviewing-page': '正在检查产物是否可用',
  'collecting-artifact': '正在检查并整理生成的文件',
  'committing-artifact': '正在保存本次生成的结果',
};

export function stageName(kind: OutputKind, key?: string) {
  if (key === 'starting-design') return kind === 'video' ? '分镜' : '大纲';
  if (key === 'composing-page') return kind === 'video' ? '创作' : '生成页面';
  if (key === 'collecting-artifact' || key === 'committing-artifact') return kind === 'video' ? '合成' : '保存';
  return STAGE_NAMES[key ?? ''] ?? '准备';
}

export function RunProgress({ run }: { run: QcRun }) {
  const finished = run.status === 'done' || run.status === 'trial-ready';
  const completionLabel = run.status === 'trial-ready' ? '试看已完成' : '全部完成';
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
        <span className="min-w-0 truncate text-token-secondary">{completionLabel}，用时 {formatDuration(run.elapsedSec)}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-token-muted">过程<ChevronDown size={13} /></span>
      </button>
    );
  }

  const name = stageName(run.kind, current?.key);
  const title = finished ? completionLabel : failed ? (current ? `停在${name}` : '生成暂停') : `正在${name}`;
  const currentScene = run.scenes?.find(scene => scene.status === 'voicing' || scene.status === 'drawing');
  const detail = currentScene
    ? currentScene.status === 'voicing' ? `正在为第 ${currentScene.index} / ${run.scenes?.length} 幕配旁白` : `正在绘制第 ${currentScene.index} / ${run.scenes?.length} 幕`
    : STAGE_DETAILS[current?.key ?? ''] ?? (run.kind === 'video' ? '正在制作这段影片' : '正在制作网页');
  const work = steps.filter(s => s.key !== 'done');
  const progress = current?.progress;
  const overall = finished ? 100 : progress != null
    ? Math.max(0, Math.min(100, work.length <= 1 ? progress : Math.round((work.filter(s => s.status === 'done').length * 100 + progress) / work.length)))
    : undefined;
  return (
    <section className="qc-rise" data-qc="run-progress">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[20px] font-semibold tracking-tight text-token-primary">
          {failed && <AlertTriangle size={18} className="shrink-0" style={{ color: 'var(--accent-fg-error)' }} aria-hidden />}
          <span className="truncate" data-qc="stage-title">{title}</span>
        </div>
        <div className="shrink-0 text-[13px] tabular-nums text-token-secondary">
          {finished ? `用时 ${formatDuration(run.elapsedSec)}` : failed ? `运行 ${formatDuration(run.elapsedSec)}后停下` : run.remainSec != null ? `还需${formatRemain(run.remainSec)}` : `已用 ${clock(run.elapsedSec)}`}
        </div>
      </div>
      {!finished && !failed && <p className="m-0 mt-1 text-[13px] text-token-secondary" data-qc="stage-detail">{detail}</p>}
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]" role="progressbar" aria-valuenow={overall} aria-valuemin={0} aria-valuemax={100} aria-label="总进度">
        <div className={cn('h-full rounded-full transition-[width] duration-700', failed ? '' : 'qc-bar-live')} style={{ width: `${overall ?? 6}%`, ...(failed ? { background: 'var(--accent-fg-error)' } : {}) }} />
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
                {s.label}{s.detail && <span className="text-token-muted"> · {s.detail}</span>}
              </span>
              {live && <span className="shrink-0 text-[12px] tabular-nums text-[color:var(--accent-primary)]">{s.progress != null ? `${s.progress}%` : '进行中'}</span>}
              {s.status === 'failed' && <span className="shrink-0 text-[12px]" style={{ color: 'var(--accent-fg-error)' }}>未完成</span>}
            </li>
          );
        })}
      </ol>
      {showSteps && <div className="pt-1 text-[12px] text-token-muted">已用 {clock(run.elapsedSec)}{run.estimateBasis && ` · 预计依据：${run.estimateBasis}`}</div>}
    </section>
  );
}
