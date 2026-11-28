import { Cpu } from 'lucide-react';
import { formatDuration } from './registry';
import type { AgentRun, Finding, RetestResult } from './types';

const TAG = { done: ['OK', 'ok'], running: ['RUN', 'run'], failed: ['FAIL', 'bad'], waiting: ['', ''] } as const;

/* Agent 控制台：阶段像日志一样一行行打出来，发现的问题即时插入；跑完后复测给出记分板。
 * 主视觉是产物本身（日志与问题），进度与预计时间做配角。模型名来自运行记录（网关返回）。 */
export function RunConsole({ run, title, findings = [], retest }: { run: AgentRun; title: string; findings?: Finding[]; retest?: RetestResult }) {
  const live = run.status === 'queued' || run.status === 'running';
  const shown = run.stages.filter(s => s.status !== 'waiting');
  const pending = run.stages.length - shown.length;
  return (
    <div className="flex flex-col" data-lc="agent-run" data-run-status={run.status}>
      <div className="flex items-center gap-2 flex-wrap pb-2">
        <span className="text-[13.5px] font-semibold">{title}</span>
        {run.model && <span className="inline-flex items-center gap-1.5 text-[11.5px] lc-ink3 lc-mono" data-lc="run-model"><Cpu size={12} />{run.model.model} · {run.model.platform}</span>}
      </div>
      <div className="lc-panel overflow-hidden" style={{ background: 'var(--lc-solid)' }}>
        {live && <div className="lc-meter"><span style={{ width: `${run.progress}%` }} /></div>}
        <div className="lc-log" aria-live="polite">
          {shown.map((s, i) => {
            const [tag, tone] = TAG[s.status];
            return (
              <div key={s.key} className="lc-log-line" data-stage={s.key} data-stage-status={s.status}>
                <span className="lc-t">{String(i + 1).padStart(2, '0')}/{String(run.stages.length).padStart(2, '0')}</span>
                <span className="lc-log-tag" data-tone={tone}>{tag}</span>
                <span style={{ color: 'var(--lc-ink)' }}>{s.label}{s.detail ? <span className="lc-ink3"> · {s.detail}</span> : null}{s.status === 'running' && <span className="lc-caret" />}</span>
              </div>
            );
          })}
          {findings.map((f, i) => (
            <div key={f.id} className="lc-log-line">
              <span className="lc-t">#{i + 1}</span>
              <span className="lc-log-tag" data-tone="find">{f.severity}</span>
              <span style={{ color: 'var(--lc-ink)' }}>{f.title}</span>
            </div>
          ))}
          {pending > 0 && live && <div className="lc-log-line lc-ink3"><span className="lc-t">…</span><span /><span>还有 {pending} 步</span></div>}
        </div>
      </div>
      {live && (
        <div className="flex flex-col gap-1 pt-2 text-[12px] lc-ink2">
          <div className="flex gap-4 flex-wrap">
            <span>{run.status === 'queued' ? '排队中' : <>已用 <b className="lc-mono">{formatDuration(run.elapsedSec)}</b></>}</span>
            {run.remainSec != null && <span>预计还需约 <b className="lc-mono">{formatDuration(run.remainSec)}</b></span>}
            {findings.length > 0 && <span style={{ color: 'var(--lc-warn)' }}>已发现 {findings.length} 处</span>}
          </div>
          <span className="text-[11.5px] lc-ink3">预计时间依据：{run.estimateBasis}。可以先离开，回来会接着显示。</span>
        </div>
      )}
      {retest && run.status === 'done' && (
        <div className="lc-board mt-3" data-lc="retest-board">
          {retest.checks.map(c => (
            <div key={c.name}>
              <span className="lc-verdict" style={{ color: c.status === 'pass' ? 'var(--lc-pass)' : 'var(--lc-fail)' }}>{c.status === 'pass' ? 'PASS' : 'FAIL'}</span>
              <span>{c.name}{c.message && <span className="lc-ink3"> · {c.message}</span>}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
