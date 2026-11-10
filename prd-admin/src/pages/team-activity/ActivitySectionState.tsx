import { useEffect, useState } from 'react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

/** Local progress and recovery never cover sections that have already loaded. */
export function ActivitySectionState({ title, loading, error, onRetry }: {
  title: string;
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!loading) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);
  return (
    <div className="h-full min-h-[160px] flex flex-col items-center justify-center gap-2 px-3 py-4 text-center" aria-busy={loading} aria-label={title}>
      {loading ? <MapSectionLoader variant="signal" text={title} /> : <p role="alert" className="text-sm text-token-secondary">{title}：{error}</p>}
      {loading ? (
        <>
          <p role="status" className="text-[11px] text-token-muted">{elapsed >= 20 ? '正在整理较多数据，其他模块可继续查看' : '正在聚合体验信号，请稍候'}</p>
          <span aria-hidden="true" className="text-[10px] text-token-muted font-mono tabular-nums opacity-60">已等待 {elapsed} 秒</span>
        </>
      ) : null}
      {!loading ? <button type="button" onClick={onRetry} className="text-[12px] text-semantic-cyan underline underline-offset-2">重试此模块</button> : null}
    </div>
  );
}
