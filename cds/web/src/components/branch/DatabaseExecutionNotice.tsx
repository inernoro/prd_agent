import type { DatabaseFailure } from '@/lib/databaseFailure';

export function DatabaseExecutionNotice({ failure, batchWrite = false, showDiagnostics = false }: {
  failure: DatabaseFailure;
  batchWrite?: boolean;
  showDiagnostics?: boolean;
}): JSX.Element {
  return (
    <div role="alert" aria-label="数据库操作失败" className="max-h-48 shrink-0 overflow-y-auto break-words border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
      <p className="font-semibold">{failure.summary}</p>
      <p>{failure.recovery}</p>
      {batchWrite ? <p>执行已停止；此前已提交的修改可能仍然生效。请先查询核对，勿直接重复整批执行。</p> : null}
      {showDiagnostics && failure.diagnostic ? (
        <details className="mt-1">
          <summary className="cursor-pointer">诊断信息</summary>
          <div className="font-mono">{failure.diagnostic.requestId ? `诊断编号：${failure.diagnostic.requestId}` : '未返回诊断编号'}{failure.diagnostic.status ? ` · 状态码：${failure.diagnostic.status}` : ''}</div>
        </details>
      ) : null}
    </div>
  );
}
