/**
 * 做成了什么 —— 历史，也是一个列表。
 *
 * 上一版这里有「他估得准吗」和「时间漏在哪」两块分析，都删了：那是考核，不是沟通。
 * 现在只剩一件事 —— 一条一条列出做成了什么样。放下的那些也留着，不粉饰。
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from '@/lib/toast';
import { getActiveTaskHistory } from '@/services/real/activeTasks';
import type { ActiveTaskDto, ActiveTaskHistory } from '@/services/contracts/activeTasks';
import './activeTasks.css';

const RANGES = [
  { days: 7, label: '本周' },
  { days: 30, label: '本月' },
  { days: 90, label: '本季' },
];

function dayLabel(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function ActiveTaskHistoryPage() {
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? undefined;
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ActiveTaskHistory | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getActiveTaskHistory(days, userId);
    if (res.success && res.data) setData(res.data);
    else toast.error(res.error?.message ?? '加载失败');
    setLoading(false);
  }, [days, userId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="atb-page"><div className="atb-col"><div className="atb-empty">正在翻历史</div></div></div>;
  }

  const items = (data?.items ?? []).filter((x: ActiveTaskDto) => x.state === 'done' || x.state === 'dropped');

  return (
    <div className="atb-page">
      <div className="atb-col">
        <div className="atb-head">
          <span className="atb-title">做成了什么</span>
          <div style={{ display: 'flex', gap: 14 }}>
            {RANGES.map((r) => (
              <button
                key={r.days}
                className="atb-link"
                style={days === r.days ? undefined : { color: 'var(--text-muted)' }}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {data?.summary?.headline && <span className="atb-group-label">{data.summary.headline}</span>}

        <div className="atb-list">
          {items.length === 0 && <div className="atb-empty">这段时间还没有结案的任务。</div>}

          {items.map((it) => {
            const dropped = it.state === 'dropped';
            return (
              <div className="atb-done-row" key={it.id}>
                <span className="atb-circle atb-circle--done" aria-hidden="true">
                  {dropped ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14 }}>
                    <span className="atb-done-row__title">{it.title}</span>
                    <span className="atb-when">{dropped ? '放下了' : dayLabel(it.doneAt)}</span>
                  </div>
                  {(it.closingNote || it.dropReason) && (
                    <span className="atb-done-row__note">{it.closingNote ?? it.dropReason}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default ActiveTaskHistoryPage;
