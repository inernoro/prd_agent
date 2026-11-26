import {
  ARTIFACT_VERIFICATION_STEPS,
  type ArtifactVerificationEventDetails, type ArtifactVerificationSignal, type ArtifactVerificationStep, type ArtifactWaitReason,
} from '../../../../src/shared/artifact-verification-metrics.js';

export const ARTIFACT_VERIFICATION_SAMPLE_LIMIT = 1000;
export const ARTIFACT_VERIFICATION_DAY_MS = 86_400_000;

const stepNames: Record<ArtifactVerificationStep, string> = {
  daemon: '读取执行器', reserve: '检查缓存与拉取名额', pull: '拉取镜像',
  receipt: '确认回执', inspect: '读取镜像', compare: '核对版本',
};

const signalNames: Record<ArtifactVerificationSignal, string> = {
  deadline: '本轮时间已用完', 'pull-slot-limit': '未结清拉取达到上限', 'image-budget': '镜像容量预算不足',
  'pull-never-started': '拉取未启动，名额已归还', 'pull-result-unknown': '拉取结果待确认',
  'receipt-unconfirmed': '拉取回执未确认',
};

const waitReasons: Record<ArtifactWaitReason, string> = {
  'target-unresolved': '目标提交待确认', 'image-unresolved': '镜像引用待确认', missing: '镜像尚未发布',
  'access-denied': '仓库拒绝拉取', 'verification-unavailable': '核验暂不可用',
  'revision-mismatch': '镜像版本不一致', 'platform-mismatch': '镜像平台不匹配', 'cache-budget': '镜像容量预算不足',
};

export interface ArtifactVerificationLog {
  ts: string;
  details?: ArtifactVerificationEventDetails;
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${(ms / 60_000).toFixed(1)} 分钟`;
}

export function summarizeArtifactVerification(events: readonly ArtifactVerificationLog[]) {
  const entries = events.flatMap(event => event.details?.runId ? [event.details] : []);
  const runs = new Set(entries.map(entry => entry.runId));
  const retried = new Set(entries.filter(entry => entry.retry).map(entry => entry.runId));
  const ready = new Map<string, number>();
  let measured = 0, pulls = 0, succeeded = 0, reused = 0;
  for (const entry of entries) {
    if (entry.outcome === 'ready') {
      ready.set(entry.runId, Math.min(ready.get(entry.runId) ?? Infinity, entry.elapsedSinceAcceptedMs));
    }
    if (entry.pullRequests === undefined) continue;
    measured++;
    pulls += entry.pullRequests;
    succeeded += entry.pullsSucceeded ?? 0;
    reused += entry.reusedImages ?? 0;
  }
  const durations = [...ready.values()].sort((a, b) => a - b);
  return {
    attempts: entries.length, runs: runs.size, retried: retried.size, ready: ready.size,
    waiting: entries.filter(entry => entry.outcome === 'waiting').length,
    p50: durations[Math.ceil(durations.length * 0.50) - 1],
    p95: durations[Math.ceil(durations.length * 0.95) - 1],
    measured, pulls, succeeded, reused,
  };
}

export function ArtifactVerificationMetrics({ events, now }: { events: readonly ArtifactVerificationLog[]; now: number }) {
  if (!events.length) return null;
  const dayAgo = now - ARTIFACT_VERIFICATION_DAY_MS;
  const samples = [
    { label: '最近 24 小时', entries: events.filter(event => Date.parse(event.ts) >= dayAgo) },
    { label: '前一段 24 小时', entries: events.filter(event => Date.parse(event.ts) < dayAgo) },
  ];
  return (
    <section className="space-y-2 rounded-md border border-border bg-background p-3" aria-label="镜像核验统计">
      <div className="grid gap-2 sm:grid-cols-2">
        {samples.map(({ label, entries }) => {
          const sample = summarizeArtifactVerification(entries);
          return (
            <div key={label} className="space-y-1 rounded-md border border-border p-3 text-xs">
              <h3 className="font-medium">{label}</h3>
              {sample.attempts ? (
                <>
                  <p>{sample.attempts} 次核验 · {sample.waiting} 次进入等待 · {sample.runs} 个部署 · {sample.retried} 个已重试</p>
                  <p>受理至核验通过 · P50 {duration(sample.p50)} · P95 {duration(sample.p95)} · {sample.ready} 个样本</p>
                  {sample.measured ? (
                    <p>拉取请求 {sample.pulls} · 拉取成功 {sample.succeeded} · 复用 {sample.reused} · 每轮平均请求 {(sample.pulls / sample.measured).toFixed(1)} · 有明细 {sample.measured}/{sample.attempts}</p>
                  ) : <p>执行器明细未收到</p>}
                </>
              ) : <p className="text-muted-foreground">暂无样本</p>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        部署按运行编号去重，耗时统计使用当期核验通过的部署。
        {events.length >= ARTIFACT_VERIFICATION_SAMPLE_LIMIT ? '达到采样上限，较早记录未纳入。' : ''}
      </p>
    </section>
  );
}

export function ArtifactVerificationLogDetails({ details }: { details: ArtifactVerificationEventDetails }) {
  const phases = ARTIFACT_VERIFICATION_STEPS.flatMap(step => {
    const elapsed = details.stepsMs?.[step];
    return elapsed === undefined ? [] : [`${stepNames[step]} ${duration(elapsed)}`];
  });
  const causes = details.signals?.map(signal => signalNames[signal]) ?? [];
  if (!causes.length && details.reason) causes.push(waitReasons[details.reason]);
  return (
    <div className="mt-1 space-y-1 break-words text-xs text-muted-foreground">
      <p>执行器 {details.executorId} · {details.retry ? '重试' : '开始核验'} · {details.requiredProfiles} 个必需服务 · 已等待 {duration(details.elapsedSinceAcceptedMs)}</p>
      {causes.length ? <p>{causes.join(' · ')}{details.lastStep ? ` · 最后阶段 ${stepNames[details.lastStep]}` : ''}</p> : null}
      {phases.length ? <p>{phases.join(' · ')}</p> : <p>执行器步骤未收到</p>}
      {details.pullRequests !== undefined ? <p>本轮拉取请求 {details.pullRequests} · 拉取成功 {details.pullsSucceeded} · 复用 {details.reusedImages}</p> : null}
    </div>
  );
}
