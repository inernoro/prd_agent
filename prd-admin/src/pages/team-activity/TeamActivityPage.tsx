/**
 * 团队动态 — 团队脉搏 + 全员工作日志时间线（仅管理员，team-activity.read）。
 * 数据由后端 ActivityLogActionFilter 按白名单自动留痕，本页只读：
 * 顶部脉搏面板（总量/模块能量/时段热力/成员排行）+ 按天分组时间线（连续同类动作折叠）。
 * 隐私脱敏开关默认开启：标题与姓名打码，适合投屏/旁观场景。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Eye, EyeOff, Radar } from 'lucide-react';
import { GlassCard, Button } from '@/components/design';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { resolveAvatarUrl } from '@/lib/avatar';
import { getTeamActivityLogs, getTeamActivityModules, getTeamActivityStats } from '@/services';
import type { ActivityModuleOption, TeamActivityItem, TeamActivityStatsData } from '@/services/contracts/teamActivity';
import { CategoryStatsPanel, MemberStatsPanel } from './StatsPanels';
import { InsightsPanel } from './InsightsPanel';
import { TimeRangePicker, resolveRange, rangePreset, type RangeKey, type TeamRange } from './TimeRangePicker';
import { getModuleMeta } from './moduleMeta';
import { getActionIcon } from './actionIcons';
import { aggregateConsecutive, maskName, type AggregatedActivity } from './pulse';

const PAGE_SIZE = 30;

// 隐私脱敏为纯 UI 偏好（发版后旧值无害），按 no-localstorage.md 例外清单允许 localStorage 记忆
const PRIVACY_KEY = 'team-activity-privacy-mask';

/** 环比文案：脉搏的对照窗口与所选范围同长（昨天/上周/上月）；「全部」/自定义无环比 */
const COMPARE_LABELS: Record<RangeKey, string | null> = {
  all: null,
  today: '较昨日',
  week: '较上周',
  month: '较上月',
};

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

function readPrivacyPreference(): boolean {
  try {
    return (localStorage.getItem(PRIVACY_KEY) ?? '1') === '1';
  } catch {
    return true;
  }
}

export default function TeamActivityPage() {
  // 视图切换：insights（行为洞察/VOC，默认首屏）/ feed（动态流），深链 ?tab=feed 回到动态流
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('tab') === 'feed' ? 'feed' : 'insights';
  const switchView = useCallback(
    (next: 'feed' | 'insights') => {
      setSearchParams(next === 'feed' ? { tab: 'feed' } : {}, { replace: true });
    },
    [setSearchParams]
  );

  const [items, setItems] = useState<TeamActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modules, setModules] = useState<ActivityModuleOption[]>([]);
  const [stats, setStats] = useState<TeamActivityStatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [privacy, setPrivacy] = useState(readPrivacyPreference);

  const [filterUserId, setFilterUserId] = useState('');
  const [filterModule, setFilterModule] = useState('');
  // 默认「今天」：脉搏回答的是「团队此刻在干嘛」，历史全量是查询场景而非默认视图。
  // 时间范围扩展为「预设 | 自定义[from,to]」，由 TimeRangePicker 驱动。
  const [timeRange, setTimeRange] = useState<TeamRange>({ kind: 'preset', preset: 'today' });
  // 当前选中的预设 key（自定义时为 null），用于脉搏环比文案等仅预设场景
  const rangePresetKey = rangePreset(timeRange);
  // 解析成发给后端的 from/to（自定义时 to 为所选末日 23:59:59；预设 to=undefined 至今）
  const { from: rangeFromIso, to: rangeToIso } = resolveRange(timeRange);

  // 过期响应守卫：快速切换筛选 / 加载更多与刷新竞态时，丢弃晚到的旧请求结果
  const fetchIdRef = useRef(0);
  const statsFetchIdRef = useRef(0);

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
        from: rangeFromIso,
        to: rangeToIso,
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
    [filterUserId, filterModule, rangeFromIso, rangeToIso]
  );

  // 筛选条件变化时重置到第一页（仅动态流视图拉取；行为洞察视图不拉 feed，避免白白加重切换卡顿）
  useEffect(() => {
    if (view !== 'feed') return;
    void load(1, false);
  }, [load, view]);

  // 脉搏聚合统计随同一组筛选条件刷新（统计不分页；同样仅动态流视图拉取）
  useEffect(() => {
    if (view !== 'feed') return;
    const fetchId = ++statsFetchIdRef.current;
    setStatsLoading(true);
    void getTeamActivityStats({
      userId: filterUserId || undefined,
      module: filterModule || undefined,
      from: rangeFromIso,
      to: rangeToIso,
    }).then((res) => {
      if (statsFetchIdRef.current !== fetchId) return;
      if (res.success) setStats(res.data);
      setStatsLoading(false);
    });
  }, [filterUserId, filterModule, rangeFromIso, rangeToIso, view]);

  const togglePrivacy = useCallback(() => {
    setPrivacy((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PRIVACY_KEY, next ? '1' : '0');
      } catch {
        // 存储不可用时仅影响记忆，不影响本次切换
      }
      return next;
    });
  }, []);

  // 聚合即导航：脉搏面板里点模块/成员 = 切换对应筛选（再点一次取消）
  const pickModule = useCallback((key: string) => {
    setFilterModule((prev) => (prev === key ? '' : key));
  }, []);
  const pickActor = useCallback((actorId: string) => {
    setFilterUserId((prev) => (prev === actorId ? '' : actorId));
  }, []);

  const hasMore = items.length < total;

  const dayGroups = useMemo(() => {
    const groups: Array<{ key: string; items: TeamActivityItem[] }> = [];
    for (const item of items) {
      const key = dayKeyOf(item.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(item);
      else groups.push({ key, items: [item] });
    }
    // 连续同类动作折叠发生在天分组内部，不跨天合并
    return groups.map((g) => ({ key: g.key, total: g.items.length, rows: aggregateConsecutive(g.items) }));
  }, [items]);

  return (
    // 控制台三栏：左成员统计 / 中时间线 / 右分类统计。限一个上限宽避免巨幕下三栏间距失衡
    <div className="flex flex-col gap-4 h-full min-h-0 w-full mx-auto" style={{ maxWidth: 1840 }}>
      {/* 页头：视图切换走全项目统一的 SegmentedTabs（与「应用模型池管理」同款 pill + hover），
          时间范围筛选保留 TimeRangePicker（含悬浮密度预览/自定义刷选，比纯分段更强）放右侧。 */}
      <div className="flex items-center justify-between gap-3 flex-wrap shrink-0 px-0.5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[16px] font-semibold text-white/90 shrink-0">VOC</span>
          <SegmentedTabs
            ariaLabel="VOC 视图切换"
            value={view}
            onChange={(key) => switchView(key === 'insights' ? 'insights' : 'feed')}
            items={[
              { key: 'insights', label: '行为洞察', icon: <Radar size={14} /> },
              { key: 'feed', label: '动态流', icon: <Activity size={14} /> },
            ]}
          />
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* 下方筛选栏：仅动态流视图保留（成员 / 模块 / 隐私脱敏）。行为洞察视图时间已上移页头，无需此栏。 */}
      {view === 'feed' ? (
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
          <button
            type="button"
            onClick={togglePrivacy}
            title={privacy ? '匿名模式：隐藏成员姓名（文档标题保持明文），点击切换实名' : '实名模式：点击切换匿名（隐藏成员姓名）'}
            className={`ml-auto inline-flex items-center gap-1.5 px-2.5 h-[26px] rounded-md text-[12px] border transition-colors ${
              privacy
                ? 'bg-violet-500/15 text-violet-200 border-violet-500/35'
                : 'bg-white/[0.03] text-white/50 border-white/10 hover:text-white/75 hover:border-white/20'
            }`}
          >
            {privacy ? <EyeOff size={13} /> : <Eye size={13} />}
            {privacy ? '匿名' : '实名'}
          </button>
        </div>
      ) : null}

      {view === 'insights' ? (
        <InsightsPanel from={rangeFromIso} to={rangeToIso} />
      ) : (
      // 控制台三栏：两侧统计栏各自滚动，中间时间线吃满剩余宽度。
      // 窄屏单列纵向堆叠（手机三栏挤爆），lg 起恢复 264 / 1fr / 300 三栏。
      <div
        className="flex-1 grid gap-4 grid-cols-1 lg:[grid-template-columns:264px_minmax(0,1fr)_300px]"
        style={{ minHeight: 0 }}
      >
        {/* 左栏：成员统计（窄屏自然高度堆叠，lg 起独立滚动） */}
        <div
          className="flex flex-col gap-4 min-h-0 lg:overflow-y-auto"
          style={{ overscrollBehavior: 'contain' }}
        >
          <MemberStatsPanel
            stats={stats}
            loading={statsLoading}
            privacy={privacy}
            compareLabel={rangePresetKey ? COMPARE_LABELS[rangePresetKey] : null}
            activeActorId={filterUserId}
            onPickActor={pickActor}
          />
        </div>

        {/* 中栏：时间线主体 */}
        <GlassCard className="flex flex-col" style={{ minHeight: 0 }}>
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
            <div className="flex flex-col gap-4">
              {dayGroups.map((g) => (
                <div key={g.key} className="flex flex-col">
                  {/* 吸顶日期头：长流滚动时始终知道自己看到哪一天 */}
                  <div
                    className="sticky top-0 z-10 flex items-center gap-3 py-1.5 -mx-5 px-5 backdrop-blur-md"
                    style={{ background: 'rgba(16,17,19,0.72)' }}
                  >
                    <span className="text-[12px] font-semibold text-white/70">{dayLabelOf(g.key)}</span>
                    <span className="flex-1 h-px bg-white/5" />
                    <span className="text-[11px] text-white/30">{g.total} 条</span>
                  </div>
                  <div className="relative">
                    {/* 时间线 rail：把同一天的事件串成一条线（GitLab 式） */}
                    <span className="absolute left-4 top-3 bottom-3 w-px bg-white/[0.06]" aria-hidden />
                    {g.rows.map((row) => (
                      <ActivityRow key={row.id} group={row} privacy={privacy} />
                    ))}
                  </div>
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

        {/* 右栏：分类统计（窄屏自然高度堆叠，lg 起独立滚动） */}
        <div
          className="flex flex-col gap-4 min-h-0 lg:overflow-y-auto"
          style={{ overscrollBehavior: 'contain' }}
        >
          <CategoryStatsPanel
            stats={stats}
            loading={statsLoading}
            activeModule={filterModule}
            onPickModule={pickModule}
          />
        </div>
      </div>
      )}
    </div>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 h-[26px] rounded-md text-[12px] border transition-colors ${
        active
          ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/35'
          : 'bg-white/[0.03] text-white/50 border-white/10 hover:text-white/75 hover:border-white/20'
      }`}
    >
      {label}
    </button>
  );
}

function ActivityRow({ group, privacy }: { group: AggregatedActivity; privacy: boolean }) {
  const item = group.head;
  const meta = getModuleMeta(item.module);
  const ActionIcon = getActionIcon(item.action);
  const actorName = item.actorName || item.actorId;
  // 标题按业界惯例全文显示（GitHub/GitLab 的对象名都是明文链接），隐私脱敏只作用于人名
  const titles = group.titles;
  // 折叠条数超过去重标题数时补「等」，提示还有同类对象未列出
  const hasMoreTargets = group.count > titles.length && titles.length > 0;

  return (
    <div className="relative flex items-start gap-3 py-2 rounded-lg hover:bg-white/[0.03] transition-colors">
      {/* 头像 + 模块色动作图标徽章（GitLab 时间线式事件类型标识） */}
      <span className="relative z-10 shrink-0">
        <UserAvatar
          src={resolveAvatarUrl({ avatarFileName: item.actorAvatarFileName })}
          alt={actorName}
          className="w-8 h-8 rounded-full object-cover block"
        />
        <span
          className="absolute -bottom-0.5 -right-1 w-4 h-4 rounded-full flex items-center justify-center"
          style={{ background: '#16171a', border: `1px solid ${meta.border}` }}
        >
          <ActionIcon size={9} style={{ color: meta.accent }} />
        </span>
      </span>
      <div className="flex-1 min-w-0 text-[13px] leading-relaxed pt-1">
        <span className="text-white/90 font-semibold">{privacy ? maskName(actorName) : actorName}</span>
        <span className="text-white/50"> {item.actionLabel}</span>
        {titles.map((t, i) => (
          <span key={i} className="text-cyan-200/90">
            {' '}
            《{t}》
          </span>
        ))}
        {hasMoreTargets ? <span className="text-white/50"> 等</span> : null}
        {group.count > 1 ? (
          <span
            className="inline-block ml-2 px-1.5 py-px rounded text-[11px] font-semibold tabular-nums align-[1px]"
            style={{ background: meta.soft, color: meta.accent }}
          >
            ×{group.count}
          </span>
        ) : null}
      </div>
      {/* 右侧元信息：模块归属 + 时间戳（第三优先级，弱化） */}
      <div className="flex items-center gap-2.5 shrink-0 pt-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/35">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: meta.accent }} />
          {item.moduleLabel}
        </span>
        {/* 列表场景关闭逐行自刷新定时器（项目惯例，长列表 N 行 N 个 interval 会拖性能） */}
        <RelativeTime value={item.createdAt} refreshIntervalMs={0} className="text-[11px] text-white/35" />
      </div>
    </div>
  );
}
