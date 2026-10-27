import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getProductAnnouncementSyncStatus, updateProductAnnouncements, type ProductAnnouncementSyncStatus } from '@/services/real/productAgent';
import { VersionAnnouncementRecords } from './VersionAnnouncementRecords';

export function VersionAnnouncementUpdate({ onUpdated }: { onUpdated: () => Promise<void> }) {
  const [state, setState] = useState<ProductAnnouncementSyncStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState('');
  const [recordsOpen, setRecordsOpen] = useState(false);
  const completed = useRef('');
  const active = useRef(true);
  const reload = useRef(onUpdated);
  useEffect(() => { reload.current = onUpdated; }, [onUpdated]);
  const observe = useCallback((value: ProductAnnouncementSyncStatus) => {
    if (!active.current) return;
    setState(value);
    if (value.status === 'succeeded' && value.runId && completed.current !== value.runId) {
      completed.current = value.runId;
      void reload.current();
    }
  }, []);
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const delay = 3000;
      try {
        const result = await getProductAnnouncementSyncStatus();
        if (!active.current) return;
        if (result.success) {
          setError('');
          observe(result.data);
        }
        else setError(result.error?.message ?? '公告更新状态读取失败，请稍后重试。');
      } catch { if (active.current) setError('公告更新状态读取失败，请稍后重试。'); }
      if (active.current) timer = setTimeout(() => { void poll(); }, delay);
    };
    void poll();
    return () => { active.current = false; clearTimeout(timer); };
  }, [observe]);
  const update = async () => {
    setRequesting(true);
    setError('');
    try {
      const result = await updateProductAnnouncements();
      if (!active.current) return;
      if (result.success) observe(result.data);
      else setError(result.error?.message ?? '公告更新未开始，请稍后重试。');
    } catch { if (active.current) setError('公告更新未开始，请稍后重试。'); }
    finally { if (active.current) setRequesting(false); }
  };
  const busy = requesting || state?.status === 'queued' || state?.status === 'running';
  return <div className="flex max-w-lg flex-col items-end gap-1">
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => { void update(); }} disabled={busy}
        title="更新所有应用的正式版本公告；每月首个中国法定工作日北京时间08:00自动执行，包含调休。"
        className="inline-flex items-center gap-1.5 rounded-full border border-token-subtle bg-token-nested px-3 py-1.5 text-xs text-token-secondary hover:bg-token-hover disabled:opacity-50">
        {busy ? <MapSpinner size={14} /> : <RefreshCw size={14} />}更新公告
      </button>
      <button type="button" onClick={() => setRecordsOpen(true)}
        className="rounded-full border border-token-subtle bg-token-nested px-3 py-1.5 text-xs text-token-secondary hover:bg-token-hover">抓取记录</button>
    </div>
    <span role={error || state?.status === 'failed' ? 'alert' : 'status'} aria-live="polite" className="max-w-full text-xs text-token-muted">
      {error || (state?.status !== 'idle' ? state?.message : '') || '每月首个法定工作日 08:00 自动更新'}
      {busy && state && `（已读取 ${state.pages} 页）`}
    </span>
    {state && state.status !== 'idle' && <span className="text-right text-xs text-token-secondary">
      已记录 {state.total} 条 · 本次发现 {state.discovered} 条 · 详情成功 {state.detailSucceeded} 条 · 已匹配 {state.matched} 条 · 冲突 {state.conflicts} 条
      {` · 待抓取 ${state.pending} 条 · 失败 ${state.failed} 条`}
    </span>}
    {state?.calendarError && <span role="alert" className="text-xs text-token-muted">{state.calendarError}</span>}
    {recordsOpen && <VersionAnnouncementRecords onClose={() => setRecordsOpen(false)} />}
  </div>;
}
