import { githubWorkflowAttemptUrl } from '@/lib/github-urls';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}
function duration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未采集';
  return value < 1000 ? `${Number(value.toFixed(2))}ms` : `${Number((value / 1000).toFixed(2))}s`;
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function Stage({ label, value }: { label: string; value: unknown }): JSX.Element {
  const s = record(value);
  const known = s && (s.status === 'observed' || s.status === 'incomplete' || s.status === 'not-observed');
  const measured = known && s.status !== 'not-observed';
  const validCounts = s && ['intervals', 'completed', 'failed', 'cancelled', 'open', 'unknown'].every(key => count(s[key]));
  const validDurations = s && [s.completedWallMs, s.workMs].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const incomplete = measured && (s.status === 'incomplete' || !validCounts || !validDurations || Boolean(s.open) || Boolean(s.unknown));
  return <div className="grid grid-cols-1 gap-1 rounded border border-[hsl(var(--hairline))] px-3 py-2 text-xs sm:grid-cols-3">
    <span className="font-medium">{label}</span>
    <div className="text-muted-foreground">
      <p>已观测区间 {measured ? duration(s.completedWallMs) : '未采集'}</p>
      <p>工作时长 {measured ? duration(s.workMs) : '未采集'}</p>
    </div>
    <div className="text-muted-foreground">
      <p>{!measured ? '未采集' : incomplete ? '数据不完整' : '已观测'}</p>
      {measured && s ? ['completed', 'failed', 'cancelled', 'open', 'unknown'].map((key, i) => count(s[key]) && s[key] > 0
        ? <span key={key} className={`mr-2 inline-block ${key === 'failed' ? 'text-destructive' : key === 'cancelled' || key === 'unknown' ? 'text-warn' : ''}`}>
          {['完成', '失败', '取消', '未结束', '未知'][i]} {s[key] as number}
        </span> : null) : null}
    </div>
  </div>;
}

/** Read only the existing bounded list projection; no clocks, fetches or commands. */
export function DeploymentTimingSummary({ summary, commitSha, expectedRepository, expectedBranch }: {
  summary: unknown; commitSha?: string; expectedRepository?: string; expectedBranch?: string;
}): JSX.Element {
  const s = record(summary), stages = record(s?.stages);
  if (s?.version !== 1 || !stages) return <p className="mt-3 text-xs text-muted-foreground">阶段耗时尚未采集</p>;
  const ci = record(s.ci), p = record(ci?.provenance);
  const href = p ? githubWorkflowAttemptUrl(p.repository, p.runId, p.runAttempt) : null;
  const trusted = Boolean(href && ci?.version === 1 && ci.clock === 'github-provider'
    && ci.runnerMeaning === 'job-pre-start' && ci.buildMeaning === 'job-execution'
    && typeof commitSha === 'string' && /^[a-f0-9]{40}$/i.test(commitSha) && p?.headSha === commitSha
    && expectedRepository && p?.repository === expectedRepository && expectedBranch && p?.headBranch === expectedBranch
    && p?.workflowPath === '.github/workflows/branch-image.yml' && (p?.event === 'push' || p?.event === 'workflow_dispatch'));
  return <section className="mt-3 space-y-2" aria-label="部署阶段耗时">
    <p className="text-xs font-medium">阶段耗时</p>
    <p className="text-xs text-muted-foreground">CI 与 CDS 部署分别统计。已观测区间为闭合段并集，工作时长为并行累计，阶段区间不相加。</p>
    {s.incomplete !== false || ci?.incomplete !== false ? <p className="text-xs text-warn">数据不完整，尚有缺测或未结束的阶段。</p> : null}
    {s.truncated === true || ci?.truncated === true ? <p className="text-xs text-warn">记录已截断，已有值仅代表部分事实。</p> : null}
    <div className="space-y-1" aria-label="GitHub CI 时钟">
      <p className="text-xs text-muted-foreground">GitHub CI</p>
      {trusted && p ? <div className="break-all text-xs text-muted-foreground">
        <a href={href!} target="_blank" rel="noopener noreferrer" className="text-primary underline">查看 CI run {p.runId as number} / attempt {p.runAttempt as number}</a>
        <p>{p.repository as string} / {p.headBranch as string}</p>
        <p>{p.headSha as string}</p><p>{p.workflowPath as string}</p>
      </div> : <p className="text-xs text-warn">CI 来源待核对</p>}
      <Stage label="CI job 启动前等待" value={trusted ? ci?.runner : undefined} />
      <Stage label="CI job 执行" value={trusted ? ci?.build : undefined} />
      <p className="text-xs text-muted-foreground">job 执行包含准备、测试和发布；这些时间不证明制品已就绪。</p>
    </div>
    <div className="space-y-1" aria-label="CDS 本地时钟">
      <p className="text-xs text-muted-foreground">CDS 部署</p>
      <Stage label="制品等待" value={stages.artifact} />
      <Stage label="容量等待" value={stages.capacity} />
      <details className="text-xs">
        <summary className="cursor-pointer py-2 text-primary">其余部署阶段</summary>
        <div className="space-y-1">
          {([['pull', '拉代码'], ['startup', '启动'], ['readiness', '就绪'], ['switch', '切流'], ['cleanup', '清理']] as const)
            .map(([key, label]) => <Stage key={key} label={label} value={stages[key]} />)}
        </div>
      </details>
    </div>
  </section>;
}
