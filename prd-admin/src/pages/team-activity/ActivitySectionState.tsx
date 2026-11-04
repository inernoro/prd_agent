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
    <div className="h-full min-h-[160px] flex flex-col items-center justify-center gap-2 px-3 py-4 text-center" role="status" aria-label={title}>
      {loading ? <MapSectionLoader text={`${title} · 已等待 ${elapsed} 秒`} /> : <p className="text-sm text-token-secondary">{title}：{error}</p>}
      {loading && elapsed >= 10 ? <p className="text-[11px] text-token-muted">此模块查询较慢，其他模块可继续查看</p> : null}
      {!loading ? <button type="button" onClick={onRetry} className="text-[12px] text-semantic-cyan underline underline-offset-2">重试此模块</button> : null}
    </div>
  );
}
