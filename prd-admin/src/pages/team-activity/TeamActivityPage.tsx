/**
 * 团队动态 — 全员工作日志时间线（仅管理员，team-activity.read）。
 * 数据由后端 ActivityLogActionFilter 按白名单自动留痕，本页只读：
 * 按天分组的时间线流 + 按人/模块/时间筛选 + 加载更多分页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { PageHeader, GlassCard, Button } from '@/components/design';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { resolveAvatarUrl } from '@/lib/avatar';
import { getTeamActivityLogs, getTeamActivityModules } from '@/services';
import type { ActivityModuleOption, TeamActivityItem } from '@/services/contracts/teamActivity';

const PAGE_SIZE = 30;

type RangeKey = 'all' | 'today' | 'week' | 'month';

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
];

function rangeFrom(key: RangeKey): string | undefined {
  if (key === 'all') return undefined;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'week') {
    // 周一为一周起点
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day);
  } else if (key === 'month') {
    start.setDate(1);
  }
  return start.toISOString();
}

function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabelOf(key: string): string {
  const today = dayKeyOf(new Date().toISOString());
  const yesterday = dayKeyOf(new Date(Date.now() - 86_400_000).toISOString());
  if (key === today) return '今天';
  if (key === yesterday) return '昨天';
  const [y, m, d] = key.split('-');
  const sameYear = y === String(new Date().getFullYear());
  return sameYear ? `${Number(m)}月${Number(d)}日` : `${y}年${Number(m)}月${Number(d)}日`;
}

export default function TeamActivityPage() {
  const [items, setItems] = useState<TeamActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modules, setModules] = useState<ActivityModuleOption[]>([]);

  const [filterUserId, setFilterUserId] = useState('');
  const [filterModule, setFilterModule] = useState('');
  const [filterRange, setFilterRange] = useState<RangeKey>('all');

  // 过期响应守卫：快速切换筛选 / 加载更多与刷新竞态时，丢弃晚到的旧请求结果
  const fetchIdRef = useRef(0);

  useEffect(() => {
    void getTeamActivityModules().then((res) => {
      if (res.success) setModules(res.data.items);
    });
  }, []);

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      const fetchId = ++fetchIdRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      const res = await getTeamActivityLogs({
        page: nextPage,
        pageSize: PAGE_SIZE,
        userId: filterUserId || undefined,
        module: filterModule || undefined,
        from: rangeFrom(filterRange),
      });
      if (fetchIdRef.current !== fetchId) return;
      if (res.success) {
        setLoadError(null);
        setItems((prev) => (append ? [...prev, ...res.data.items] : res.data.items));
        setTotal(res.data.total);
        setPage(nextPage);
      } else if (!append) {
        // 刷新失败时清掉旧筛选的结果，避免筛选条件与列表内容错位
        setItems([]);
        setTotal(0);
        setPage(1);
        setLoadError(res.error?.message ?? '加载失败，请重试');
      } else {
        setLoadError(res.error?.message ?? '加载失败，请重试');
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [filterUserId, filterModule, filterRange]
  );

  // 筛选条件变化时重置到第一页
  useEffect(() => {
    void load(1, false);
  }, [load]);

  const hasMore = items.length < total;

  const dayGroups = useMemo(() => {
    const groups: Array<{ key: string; items: TeamActivityItem[] }> = [];
    for (const item of items) {
      const key = dayKeyOf(item.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(item);
      else groups.push({ key, items: [item] });
    }
    return groups;
  }, [items]);

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <PageHeader title="团队动态" description="全员工作动态时间线（按白名单动作自动留痕）" />

      {/* 筛选栏：人 / 模块 / 时间快捷段 */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <div className="w-52">
          <UserSearchSelect
            value={filterUserId}
            onChange={setFilterUserId}
            showAllOption
            allOptionLabel="全部成员"
            placeholder="按成员筛选"
            uiSize="sm"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <FilterChip active={filterModule === ''} label="全部模块" onClick={() => setFilterModule('')} />
          {modules.map((m) => (
            <FilterChip key={m.key} active={filterModule === m.key} label={m.label} onClick={() => setFilterModule(m.key)} />
          ))}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          {RANGE_OPTIONS.map((r) => (
            <FilterChip key={r.key} active={filterRange === r.key} label={r.label} onClick={() => setFilterRange(r.key)} />
          ))}
        </div>
      </div>

      {/* 时间线主体 */}
      <GlassCard className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
        <div
          className="flex-1 px-5 py-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <MapSectionLoader text="正在加载团队动态…" />
          ) : loadError && items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Activity size={36} className="text-white/15" />
              <div className="text-sm text-white/60">{loadError}</div>
              <Button variant="secondary" size="sm" onClick={() => void load(1, false)}>
                重试
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Activity size={36} className="text-white/15" />
              <div className="text-sm text-white/60">还没有符合条件的动态</div>
              <div className="text-[12px] text-white/35 max-w-md leading-relaxed">
                团队成员在知识库、缺陷管理、周报、视觉/文学创作、网页托管中的关键操作会自动出现在这里。
                试试切换成员、模块或时间范围。
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {dayGroups.map((g) => (
                <div key={g.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-3 pb-1">
                    <span className="text-[12px] font-semibold text-white/70">{dayLabelOf(g.key)}</span>
                    <span className="flex-1 h-px bg-white/5" />
                    <span className="text-[11px] text-white/30">{g.items.length} 条</span>
                  </div>
                  {g.items.map((item) => (
                    <ActivityRow key={item.id} item={item} />
                  ))}
                </div>
              ))}

              {hasMore && (
                <div className="flex flex-col items-center gap-1.5 pt-1 pb-2">
                  {loadError ? <span className="text-[11px] text-red-300/80">{loadError}</span> : null}
                  <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void load(page + 1, true)}>
                    {loadingMore ? <MapSpinner size={14} /> : null}
                    加载更多（已显示 {items.length} / {total} 条）
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </GlassCard>
    </div>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 h-[26px] rounded-full text-[12px] border transition-colors ${
        active
          ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
          : 'bg-white/[0.03] text-white/50 border-white/10 hover:text-white/75 hover:border-white/20'
      }`}
    >
      {label}
    </button>
  );
}

function ActivityRow({ item }: { item: TeamActivityItem }) {
  return (
    <div className="flex items-center gap-3 py-2 px-1 rounded-lg hover:bg-white/[0.03] transition-colors">
      <UserAvatar
        src={resolveAvatarUrl({ avatarFileName: item.actorAvatarFileName })}
        alt={item.actorName ?? ''}
        className="w-8 h-8 rounded-full shrink-0 object-cover"
      />
      <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
        <span className="text-white/85 font-medium">{item.actorName || item.actorId}</span>
        <span className="text-white/45"> 在 </span>
        <span className="text-white/70">{item.moduleLabel}</span>
        <span className="text-white/45"> {item.actionLabel}</span>
        {item.targetTitle ? <span className="text-cyan-200/90"> 《{item.targetTitle}》</span> : null}
      </div>
      {/* 列表场景关闭逐行自刷新定时器（项目惯例，长列表 N 行 N 个 interval 会拖性能） */}
      <RelativeTime value={item.createdAt} refreshIntervalMs={0} className="text-[11px] text-white/35 shrink-0" />
    </div>
  );
}
