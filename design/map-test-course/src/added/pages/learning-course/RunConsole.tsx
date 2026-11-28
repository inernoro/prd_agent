import { formatDuration } from './registry';
import type { AgentRun, Finding, RetestResult } from './types';

const TAG = { done: ['OK', 'ok'], running: ['RUN', 'run'], failed: ['FAIL', 'bad'], waiting: ['', ''] } as const;

/* Agent 运行：阶段像日志一样逐行出现，发现的问题即时插入；跑完后复测给出逐项结果。模型名来自运行记录（网关返回）。 */
export function RunConsole({ run, title, findings = [], retest }: { run: AgentRun; title: string; findings?: Finding[]; retest?: RetestResult }) {
  const live = run.status === 'queued' || run.status === 'running';
  const shown = run.stages.filter(s => s.status !== 'waiting');
  const pending = run.stages.length - shown.length;
  return (
    <div className="flex flex-col gap-3" data-lc="agent-run" data-run-status={run.status}>
      <div>
        <div className="t-strong">{title}</div>
        {run.model && <div className="t-meta t-mute lc-mono" data-lc="run-model">{run.model.model} · {run.model.platform}</div>}
      </div>
      {live && <div className="lc-meter"><span style={{ width: `${run.progress}%` }} /></div>}
      <div className="lc-log" aria-live="polite">
        {shown.map((s, i) => {
          const [tag, tone] = TAG[s.status];
          return (
            <div key={s.key} className="lc-log-line" data-stage={s.key} data-stage-status={s.status}>
              <span>{i + 1}/{run.stages.length}</span>
              <span className="lc-log-tag" data-tone={tone}>{tag}</span>
              <span style={{ color: 'var(--ink)' }}>{s.label}{s.detail ? <span className="t-mute"> · {s.detail}</span> : null}{s.status === 'running' && <span className="lc-caret" />}</span>
            </div>
          );
        })}
        {findings.map((f, i) => (
          <div key={f.id} className="lc-log-line"><span>#{i + 1}</span><span className="lc-log-tag" data-tone="find">{f.severity}</span><span style={{ color: 'var(--ink)' }}>{f.title}</span></div>
        ))}
        {pending > 0 && live && <div className="lc-log-line"><span>…</span><span /><span>还有 {pending} 步</span></div>}
      </div>
      {live && (
        <div className="t-meta t-mute">
          {run.status === 'queued' ? '排队中' : `已用 ${formatDuration(run.elapsedSec)}`}{run.remainSec != null ? ` · 预计还需约 ${formatDuration(run.remainSec)}` : ''}{findings.length ? ` · 已发现 ${findings.length} 处` : ''}
          <br />依据{run.estimateBasis}。可以先离开，回来会接着显示。
        </div>
      )}
      {retest && run.status === 'done' && (
        <div className="lc-checks" data-lc="retest-board">
          {retest.checks.map(c => (
            <div key={c.name}>
              <span className="lc-verdict" style={{ color: c.status === 'pass' ? 'var(--pass)' : 'var(--fail)' }}>{c.status === 'pass' ? 'PASS' : 'FAIL'}</span>
              <span>{c.name}{c.message && <span className="t-mute"> · {c.message}</span>}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
