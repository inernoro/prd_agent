import { useState, useEffect, useMemo, useCallback } from 'react';
import { Trophy, Medal, BarChart3, AlertCircle } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getLeaderboard } from '@/services/real/reviewAgent';
import type { LeaderboardItem, LeaderboardSummary } from '@/services/real/reviewAgent';

type SortKey = 'totalCount' | 'passRate' | 'firstTimePassRate';
type GroupBy = 'submitter' | 'document';

interface Props {
  groupBy: GroupBy;
}

function thisYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ymOffset(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function thisYearStartYM(): string {
  return `${new Date().getFullYear()}-01`;
}

function formatPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500/60 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-white/70 tabular-nums w-12 text-right">{pct.toFixed(1)}%</span>
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <Trophy className="w-4 h-4 text-yellow-400" />;
  if (rank === 2) return <Medal className="w-4 h-4 text-slate-300" />;
  if (rank === 3) return <Medal className="w-4 h-4 text-amber-600" />;
  return <span className="text-xs text-white/40 tabular-nums">{rank}</span>;
}

function SortHeader({
  active,
  direction,
  onClick,
  children,
}: {
  active: boolean;
  direction: 'asc' | 'desc';
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 text-xs font-medium transition-colors ${
        active ? 'text-indigo-300' : 'text-white/50 hover:text-white/80'
      }`}
    >
      {children}
      {active && <span className="text-[10px]">{direction === 'desc' ? '↓' : '↑'}</span>}
    </button>
  );
}

function StatCard({
  label,
  value,
  hint,
  progress,
}: {
  label: string;
  value: string;
  hint?: string;
  progress?: number | null;
}) {
  return (
    <div className="bg-white/3 border border-white/8 rounded-lg p-4 flex flex-col gap-2">
      <div className="text-xs text-white/40">{label}</div>
      <div className="text-2xl font-semibold text-white tabular-nums">{value}</div>
      {progress != null && (
        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500/60" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      )}
      {hint && <div className="text-[11px] text-white/30">{hint}</div>}
    </div>
  );
}

export function ReviewLeaderboardView({ groupBy }: Props) {
  const [startMonth, setStartMonth] = useState(thisYM());
  const [endMonth, setEndMonth] = useState(thisYM());
  const [items, setItems] = useState<LeaderboardItem[]>([]);
  const [summary, setSummary] = useState<LeaderboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('totalCount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getLeaderboard({ startMonth, endMonth, groupBy });
    if (res.success && res.data) {
      setItems(res.data.items);
      setSummary(res.data.summary);
    } else {
      setError(res.error?.message || '加载失败');
      setItems([]);
      setSummary(null);
    }
    setLoading(false);
  }, [startMonth, endMonth, groupBy]);

  useEffect(() => { load(); }, [load]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedItems = useMemo(() => {
    const sign = sortDir === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
      // null 一律排到最后
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * sign;
    });
  }, [items, sortKey, sortDir]);

  const applyShortcut = (kind: 'thisMonth' | 'last3' | 'last6' | 'thisYear') => {
    if (kind === 'thisMonth') {
      setStartMonth(thisYM());
      setEndMonth(thisYM());
    } else if (kind === 'last3') {
      setStartMonth(ymOffset(-2));
      setEndMonth(thisYM());
    } else if (kind === 'last6') {
      setStartMonth(ymOffset(-5));
      setEndMonth(thisYM());
    } else {
      setStartMonth(thisYearStartYM());
      setEndMonth(thisYM());
    }
  };

  // 根据当前月份范围反推命中的快捷项；用户手动改了月份则无项命中
  const activeShortcut: 'thisMonth' | 'last3' | 'last6' | 'thisYear' | null = (() => {
    const now = thisYM();
    if (startMonth === now && endMonth === now) return 'thisMonth';
    if (startMonth === ymOffset(-2) && endMonth === now) return 'last3';
    if (startMonth === ymOffset(-5) && endMonth === now) return 'last6';
    if (startMonth === thisYearStartYM() && endMonth === now) return 'thisYear';
    return null;
  })();

  return (
    <div className="flex flex-col gap-4">
      {/* 月份范围 + 快捷按钮 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={startMonth}
            onChange={e => setStartMonth(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500/50"
          />
          <span className="text-xs text-white/40">至</span>
          <input
            type="month"
            value={endMonth}
            onChange={e => setEndMonth(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500/50"
          />
        </div>
        <div className="flex gap-1.5">
          {[
            { key: 'thisMonth', label: '本月' },
            { key: 'last3', label: '近 3 个月' },
            { key: 'last6', label: '近 6 个月' },
            { key: 'thisYear', label: '今年' },
          ].map(s => {
            const active = activeShortcut === s.key;
            return (
              <button
                key={s.key}
                onClick={() => applyShortcut(s.key as 'thisMonth' | 'last3' | 'last6' | 'thisYear')}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                    : 'border-white/10 text-white/60 hover:text-white hover:border-white/30'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 总览卡片 */}
      {summary && !loading && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="总评审数" value={String(summary.totalCount)} />
          <StatCard
            label="评审通过率"
            value={formatPct(summary.totalPassRate)}
            progress={summary.totalPassRate}
            hint={
              summary.totalAppealApprovedCount && summary.totalAppealApprovedCount > 0
                ? `${summary.totalPassedCount} 通过 / ${summary.totalCount} 总评审（${summary.totalAppealApprovedCount} 条申诉成功不参与统计）`
                : `${summary.totalPassedCount} / ${summary.totalCount} 通过`
            }
          />
          <StatCard
            label="一次性通过率"
            value={formatPct(summary.totalFirstTimePassRate)}
            progress={summary.totalFirstTimePassRate ?? 0}
            hint="通过的方案中，从未重审的占比"
          />
        </div>
      )}

      {/* 排行表格 */}
      {loading ? (
        <MapSectionLoader text="加载排行榜数据..." />
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-red-400/80 py-8 justify-center">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      ) : sortedItems.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-white/40">
          <BarChart3 className="w-10 h-10 text-white/20" />
          <div className="text-sm">所选时段内暂无评审完成的数据</div>
          <div className="text-xs text-white/30">尝试扩大时间范围或换个维度查看</div>
        </div>
      ) : (
        <div className="border border-white/8 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/3 border-b border-white/8">
                <tr>
                  <th className="px-4 py-2.5 text-left w-12 text-xs font-medium text-white/50">排名</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-white/50">
                    {groupBy === 'submitter' ? '提交人' : '方案'}
                  </th>
                  <th className="px-4 py-2.5 text-right w-24">
                    <SortHeader active={sortKey === 'totalCount'} direction={sortDir} onClick={() => toggleSort('totalCount')}>
                      评审数
                    </SortHeader>
                  </th>
                  <th className="px-4 py-2.5 text-right w-44">
                    <SortHeader active={sortKey === 'passRate'} direction={sortDir} onClick={() => toggleSort('passRate')}>
                      通过率
                    </SortHeader>
                  </th>
                  <th className="px-4 py-2.5 text-right w-44">
                    <SortHeader active={sortKey === 'firstTimePassRate'} direction={sortDir} onClick={() => toggleSort('firstTimePassRate')}>
                      一次性通过率
                    </SortHeader>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item, idx) => (
                  <tr key={item.key} className="border-b border-white/5 last:border-b-0 hover:bg-white/3 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center w-6">
                        <RankBadge rank={idx + 1} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-white truncate max-w-md" title={item.name}>{item.name}</div>
                      {groupBy === 'document' && (
                        <div className="text-[11px] text-white/40 mt-0.5">{item.submitterName}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-white/80">{item.totalCount}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <ProgressBar value={item.passRate} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {item.firstTimePassRate == null ? (
                        <div className="text-right text-xs text-white/30">— 无通过</div>
                      ) : (
                        <div className="flex justify-end">
                          <ProgressBar value={item.firstTimePassRate} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 历史数据近似值提示 */}
      <p className="text-[11px] text-white/30 leading-relaxed">
        说明：「一次性通过率」= 通过的方案中从未触发「重新评审」的占比；2026-05-13 之前的历史数据未追踪 rerun 次数，统计为近似值。
      </p>
    </div>
  );
}
