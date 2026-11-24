import { useEffect, useState } from 'react';
import { getDesignArtifactRun, type DesignArtifactRunSummary } from '@/services/real/webPages';
import { completedRunDurationSeconds, formatCompletedRunDuration, resolveGeneratedSiteId } from '../siteGenerateProgress';
import { formatRevisionTime } from './useSiteEditSession';

/** 现有版本的只读来源记录，不恢复任务、不改变历史，也不创建模型请求。 */
export function RevisionRunRecord({ siteId, sourceRunId }: { siteId: string; sourceRunId?: string | null }) {
  const [record, setRecord] = useState<{ runId: string; run: DesignArtifactRunSummary | null } | null>(null);
  useEffect(() => {
    if (!sourceRunId) return;
    let active = true;
    void getDesignArtifactRun(sourceRunId).then((result) => {
      if (!active) return;
      const run = result.success && result.data.runId === sourceRunId
        && resolveGeneratedSiteId(result.data) === siteId ? result.data : null;
      setRecord({ runId: sourceRunId, run });
    }).catch(() => {
      if (active) setRecord({ runId: sourceRunId, run: null });
    });
    return () => { active = false; };
  }, [siteId, sourceRunId]);
  if (!sourceRunId) return null;
  const current = record?.runId === sourceRunId ? record : null;
  const run = current?.run;
  const duration = run?.status.toLowerCase() === 'done' ? completedRunDurationSeconds(run) : null;
  return (
    <details className="mt-1 text-[11px] text-token-muted">
      <summary className="cursor-pointer">生成记录 · 用时 {current ? formatCompletedRunDuration(duration) : '正在读取'}</summary>
      {run ? (
        <div className="mt-1 space-y-0.5">
          <p>开始：{formatRevisionTime(run.createdAt)}</p>
          <p>完成：{run.completedAt ? formatRevisionTime(run.completedAt) : '时间未知'}</p>
        </div>
      ) : current ? <p className="mt-1">来源记录暂时无法读取，网页和版本仍然保留。</p> : null}
    </details>
  );
}
