import { CheckCircle2, Circle, CircleAlert, Cpu } from 'lucide-react';
import { formatDuration } from './registry';
import type { AgentRun, RunStageStatus } from './types';

const STAGE_ICON: Record<RunStageStatus, (props: { size: number }) => JSX.Element> = {
  waiting: ({ size }) => <Circle size={size} style={{ color: 'var(--text-muted)' }} />,
  running: () => <span className="lc-pulse" />,
  done: ({ size }) => <CheckCircle2 size={size} style={{ color: 'var(--accent-fg-success)' }} />,
  failed: ({ size }) => <CircleAlert size={size} style={{ color: 'var(--accent-fg-error)' }} />,
};

/* Agent 运行面板：当前阶段、进度、已用与预计剩余、所用模型（来自网关）。任务在服务端跑，离开页面不中断。 */
export function AgentRunPanel({ run, foundCount, title }: { run: AgentRun; foundCount?: number; title: string }) {
  const running = run.status === 'queued' || run.status === 'running';
  return (
    <div className="lc-nested p-3 flex flex-col gap-2.5" data-lc="agent-run" data-run-status={run.status}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13.5px] font-semibold">{title}</span>
        {run.model && (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] lc-muted lc-mono" data-lc="run-model"><Cpu size={12} />{run.model.model} · {run.model.platform}</span>
        )}
      </div>
      <div className="flex flex-col">
        {run.stages.map(s => {
          const Icon = STAGE_ICON[s.status];
          return (
            <div key={s.key} className="lc-stage-row" data-stage={s.key} data-stage-status={s.status}>
              <span className="lc-stage-icon"><Icon size={16} /></span>
              <span style={{ color: s.status === 'waiting' ? 'var(--text-muted)' : 'var(--text-primary)' }}>{s.label}</span>
              {s.detail && <span className="text-[12px] lc-muted truncate">{s.detail}</span>}
            </div>
          );
        })}
      </div>
      {running && (
        <>
          <div className="lc-progress-track"><div className="lc-progress-fill" style={{ width: `${run.progress}%` }} /></div>
          <div className="flex items-center gap-3 flex-wrap text-[12px] lc-secondary">
            <span>{run.status === 'queued' ? '排队中' : `已用 ${formatDuration(run.elapsedSec)}`}</span>
            {run.remainSec != null && <span>预计还需约 {formatDuration(run.remainSec)}</span>}
            {foundCount != null && foundCount > 0 && <span style={{ color: 'var(--text-primary)' }}>已发现 {foundCount} 处</span>}
          </div>
          <div className="text-[11.5px] lc-muted">预计时间依据：{run.estimateBasis}。可以先离开，回来会接着显示。</div>
        </>
      )}
    </div>
  );
}
