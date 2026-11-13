import { useEffect, useState } from 'react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { ReportDeliveryEvidencePanel } from '@/components/report/ReportDeliveryEvidencePanel';
import type { ReportDeliverySnapshot } from '@/services/contracts/reportEvidence';
import { getMyDailyDeliveryEvidence } from '@/services';

type LoadState = { date: string; loading: boolean; evidence?: ReportDeliverySnapshot; error?: string };

/** The daily record path reads authoritative facts; it never invokes generation or submission. */
export function DailyDeliveryEvidencePanel({ date, refreshKey }: { date: string; refreshKey?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ date, loading: true });
  useEffect(() => {
    let alive = true;
    setState({ date, loading: true });
    void (async () => {
      try {
        const response = await getMyDailyDeliveryEvidence({ date });
        if (!alive) return;
        setState(response.success && response.data
          ? { date, loading: false, evidence: response.data }
          : { date, loading: false, error: response.error?.message || '暂时无法读取交付事实，请重试。' });
      } catch {
        if (alive) setState({ date, loading: false, error: '暂时无法读取交付事实，请重试。' });
      }
    })();
    return () => { alive = false; };
  }, [date, refreshKey, attempt]);

  if (state.loading || state.date !== date) {
    return <div role="status" className="flex items-center gap-2 rounded-xl p-4 text-[12px]" style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}><MapSpinner size={14} />正在核对本日交付事实与来源…</div>;
  }
  if (state.error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-xl p-4 text-[12px]" style={{ border: '1px solid var(--border-primary)', color: 'var(--text-secondary)' }}>
        <span>本日交付事实：{state.error}</span>
        <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
      </div>
    );
  }
  return <ReportDeliveryEvidencePanel evidence={state.evidence} title="本日交付事实" />;
}
