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
import { TaskShell } from './TaskShell';
import { whenLabel } from './taskTime';
import './activeTasks.css';

/**
 * 档位是「往回数多少天」，标签就得这么写。
 *
 * 原来叫「本周 / 本月 / 本季」，而发出去的是滚动 7 / 30 / 90 天：9 月 16 号点「本月」
 * 会带出八月的记录，周一点「本周」带出的大半是上一周 —— 列表跟标签说的不是一回事。
 * 要么按自然周月季去查，要么把标签改成它真正在做的事。这里选后者：
 * 「最近 30 天」本身就是更有用的那个口径，而自然月在月初几乎是空的。
 */
const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
];

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

  // 时间范围是一组互斥选项，和 DuePicker 用同一种表达（胶囊），不另发明一套文字链接
  const ranges = (
    <div className="atb-chips">
      {RANGES.map((r) => (
        <button
          key={r.days}
          className={`atb-chip${days === r.days ? ' atb-chip--on' : ''}`}
          aria-pressed={days === r.days}
          onClick={() => setDays(r.days)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <TaskShell title="做成了什么" trailing={ranges}>
        <div className="atb-list" aria-busy="true" style={{ minHeight: 160 }} />
      </TaskShell>
    );
  }

  const items = (data?.items ?? []).filter((x: ActiveTaskDto) => x.state === 'done' || x.state === 'dropped');
  const serverNow = data?.serverNow;

  return (
    <TaskShell title="做成了什么" trailing={ranges} headline={data?.summary?.headline}>
      {items.length === 0 && <div className="atb-empty">这段时间没有结案</div>}

      {items.length > 0 && (
        <div className="atb-list" role="list">
          {items.map((it) => {
            const dropped = it.state === 'dropped';
            return (
              <div className="atb-done-row" role="listitem" key={it.id}>
                <span className="atb-circle atb-circle--done" aria-hidden="true">
                  {dropped ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </span>
                <div className="atb-done-row__body">
                  <div className="atb-done-row__line">
                    <span className="atb-done-row__title">
                      <span className="sr-only">{dropped ? '已放下：' : '已完成：'}</span>{it.title}
                    </span>
                    <span className="atb-when">{dropped ? '放下了' : whenLabel(it.doneAt, serverNow)}</span>
                  </div>
                  {(it.closingNote || it.dropReason) && (
                    <span className="atb-done-row__note">{it.closingNote ?? it.dropReason}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </TaskShell>
  );
}

export default ActiveTaskHistoryPage;
