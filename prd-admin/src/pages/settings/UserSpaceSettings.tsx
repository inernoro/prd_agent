/**
 * 「我的空间」设置页
 *
 * 管理当前用户的私人启动数据，并提供公开主页与用户互动入口。
 * 数据源：useAgentSwitcherStore（sessionStorage 持久化，登出即清空）。
 */

import { useCallback, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import * as LucideIcons from 'lucide-react';
import {
  ArrowUpRight,
  Clock,
  Compass,
  Copy,
  ExternalLink,
  FileText,
  Globe2,
  Keyboard,
  MessageSquare,
  Pin,
  Share2,
  Sparkles,
  Store,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import {
  useAgentSwitcherStore,
  getRelativeTime,
} from '@/stores/agentSwitcherStore';
import { useAuthStore } from '@/stores/authStore';
import { getLauncherCatalog, type LauncherItem } from '@/lib/launcherCatalog';
import { MyFavoriteSkills } from './MyFavoriteSkills';

function getIcon(name: string, size = 16) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Icon = (LucideIcons as any)[name] ?? LucideIcons.Circle;
  return <Icon size={size} />;
}

function buildProfilePath(username?: string | null) {
  const value = (username ?? '').trim();
  return value ? `/u/${encodeURIComponent(value)}` : '';
}

/** 一行工具条目 */
function ToolRow({
  item,
  rightSlot,
  onClick,
  onRemove,
  removeLabel,
  compact = false,
}: {
  item: LauncherItem;
  rightSlot?: ReactNode;
  onClick?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  compact?: boolean;
}) {
  const accent = item.accentColor ?? '#818CF8';
  return (
    <div
      className={cn(
        'surface-row group flex cursor-pointer items-center gap-3 rounded-[10px] border border-token-nested transition-colors',
        compact ? 'px-3 py-2' : 'px-3 py-2.5',
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onClick) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]"
        style={{
          background: `${accent}18`,
          border: `1px solid ${accent}30`,
          color: accent,
        }}
      >
        {getIcon(item.icon, 14)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-token-primary">
          {item.name}
        </div>
        <div className="truncate text-[11px] text-token-muted">
          {item.route}
        </div>
      </div>
      {rightSlot}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="surface-action-danger flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-token-subtle bg-token-nested opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
          title={removeLabel ?? '移除'}
          aria-label={removeLabel ?? '移除'}
        >
          <Trash2 size={11} />
        </button>
      )}
      <ExternalLink
        size={12}
        className="shrink-0 text-token-muted opacity-0 transition-opacity group-hover:opacity-100"
      />
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <div className="surface-inset min-w-0 rounded-[12px] px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] text-token-muted">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-[22px] font-semibold leading-none text-token-primary">
        {value}
      </div>
      <div className="mt-1 truncate text-[10px] text-token-muted">{hint}</div>
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  subtitle,
  count,
  action,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="surface-action-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-bold text-token-primary">
            <span className="truncate">{title}</span>
            {typeof count === 'number' && (
              <span className="surface-inset rounded px-1.5 py-0.5 font-mono text-[10px] text-token-muted">
                {count}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-token-muted">
            {subtitle}
          </div>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function InteractionCard({
  icon,
  title,
  description,
  actionLabel,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="surface-row group flex w-full cursor-pointer items-start gap-3 rounded-[12px] border border-token-nested px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="surface-action-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-token-primary">{title}</div>
        <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-token-muted">
          {description}
        </div>
        <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-token-accent">
          {actionLabel}
          <ArrowUpRight size={12} />
        </div>
      </div>
    </button>
  );
}

export function UserSpaceSettings() {
  const navigate = useNavigate();
  const permissions = useAuthStore((s) => s.permissions ?? []);
  const isRoot = useAuthStore((s) => s.isRoot ?? false);
  const user = useAuthStore((s) => s.user);

  const {
    pinnedIds,
    recentVisits,
    usageCounts,
    togglePin,
    clearPins,
    clearRecentVisits,
    resetUsage,
    open: openSwitcher,
  } = useAgentSwitcherStore();

  const catalog = useMemo(
    () => getLauncherCatalog({ permissions, isRoot }),
    [permissions, isRoot],
  );

  const catalogById = useMemo(() => {
    const m = new Map<string, LauncherItem>();
    for (const it of catalog) m.set(it.id, it);
    return m;
  }, [catalog]);

  const pinnedItems = useMemo(
    () =>
      pinnedIds
        .map((id) => catalogById.get(id))
        .filter((x): x is LauncherItem => !!x),
    [pinnedIds, catalogById],
  );

  const recentItems = useMemo(
    () =>
      recentVisits
        .map((v) => ({ item: catalogById.get(v.id), visit: v }))
        .filter(
          (x): x is { item: LauncherItem; visit: typeof recentVisits[number] } =>
            !!x.item,
        )
        .slice(0, 8),
    [recentVisits, catalogById],
  );

  const frequentItems = useMemo(() => {
    const entries = Object.entries(usageCounts)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    return entries
      .map(([id, count]) => {
        const item = catalogById.get(id);
        return item ? { item, count } : null;
      })
      .filter((x): x is { item: LauncherItem; count: number } => !!x)
      .slice(0, 8);
  }, [usageCounts, catalogById]);

  const totalLaunches = useMemo(
    () => Object.values(usageCounts).reduce((sum, n) => sum + n, 0),
    [usageCounts],
  );

  const profilePath = buildProfilePath(user?.username);
  const publicProfileUrl = useMemo(() => {
    if (!profilePath) return '';
    if (typeof window === 'undefined') return profilePath;
    return `${window.location.origin}${profilePath}`;
  }, [profilePath]);

  const profileInitial =
    user?.displayName?.trim()?.[0]?.toUpperCase() ||
    user?.username?.trim()?.[0]?.toUpperCase() ||
    'U';

  const copyProfileUrl = useCallback(async () => {
    if (!publicProfileUrl) return;
    try {
      await navigator.clipboard.writeText(publicProfileUrl);
      toast.success('已复制主页链接');
    } catch {
      toast.error('复制失败', '请手动复制浏览器地址');
    }
  }, [publicProfileUrl]);

  const gotoProfile = useCallback(() => {
    if (profilePath) navigate(profilePath);
  }, [navigate, profilePath]);

  return (
    <div className="h-full min-h-0 overflow-y-auto pr-1">
      <div className="space-y-5 pb-8">
        <GlassCard animated glow accentHue={210} padding="lg" overflow="hidden">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-stretch">
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-5">
              <div className="flex flex-col gap-4 md:flex-row md:items-start">
                <div className="surface-action-accent flex h-16 w-16 shrink-0 items-center justify-center rounded-[18px] text-[24px] font-bold text-token-primary">
                  {profileInitial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-token-muted">
                    <span className="inline-flex items-center gap-1">
                      <Sparkles size={12} />
                      我的空间
                    </span>
                    {user?.username && (
                      <span className="surface-inset rounded-full px-2 py-0.5 font-mono">
                        @{user.username}
                      </span>
                    )}
                  </div>
                  <h2 className="mt-2 truncate text-[24px] font-semibold leading-tight text-token-primary">
                    {user?.displayName ?? '你的私人工作台'}
                  </h2>
                  <p className="mt-2 max-w-3xl text-[12px] leading-relaxed text-token-muted">
                    把常用入口、收藏技能和公开主页放在一个地方。私人启动数据只保留在当前浏览器会话；公开主页用于展示你主动发布的网页、技能、文档和工作流。
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={gotoProfile}
                  disabled={!profilePath}
                >
                  <Globe2 size={14} />
                  访问个人主页
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={copyProfileUrl}
                  disabled={!publicProfileUrl}
                  title={publicProfileUrl || '当前用户缺少用户名'}
                >
                  <Copy size={14} />
                  复制主页链接
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openSwitcher()}>
                  <Keyboard size={14} />
                  打开命令面板
                </Button>
              </div>
            </div>

            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3 xl:w-[420px] xl:grid-cols-1">
              <Metric
                icon={<Pin size={13} />}
                label="已置顶"
                value={pinnedItems.length}
                hint="命令面板星标入口"
              />
              <Metric
                icon={<Clock size={13} />}
                label="近期使用"
                value={recentItems.length}
                hint="最近访问记录"
              />
              <Metric
                icon={<TrendingUp size={13} />}
                label="总启动次数"
                value={totalLaunches}
                hint="由命令面板累计"
              />
            </div>
          </div>
        </GlassCard>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <GlassCard animated accentHue={225}>
              <SectionHeader
                icon={<Compass size={15} />}
                title="启动区"
                subtitle="优先展示你最可能马上要用的入口"
              />
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <button
                  type="button"
                  onClick={() => openSwitcher()}
                  className="surface-row flex min-h-[96px] cursor-pointer flex-col justify-between rounded-[12px] border border-token-nested px-4 py-3 text-left transition-colors"
                >
                  <div className="flex items-center gap-2 text-[12px] font-semibold text-token-primary">
                    <Keyboard size={15} />
                    命令面板
                  </div>
                  <div className="text-[11px] leading-relaxed text-token-muted">
                    搜索 Agent、工具和快捷操作
                  </div>
                  <div className="text-[11px] font-mono text-token-accent">
                    {navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'} + K
                  </div>
                </button>

                <QuickToolCard
                  title="首个置顶"
                  emptyTitle="还没有置顶"
                  emptyHint="在命令面板点击星标"
                  item={pinnedItems[0]}
                  onClick={(item) => navigate(item.route)}
                />
                <QuickToolCard
                  title="最常用"
                  emptyTitle="还没有统计"
                  emptyHint="多用几次后自动排序"
                  item={frequentItems[0]?.item}
                  meta={frequentItems[0] ? `启动 ${frequentItems[0].count} 次` : undefined}
                  onClick={(item) => navigate(item.route)}
                />
              </div>
            </GlassCard>

            <MyFavoriteSkills />

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <GlassCard animated accentHue={230} className="flex flex-col">
                <SectionHeader
                  icon={<Pin size={14} />}
                  title="置顶工具"
                  subtitle="固定高频入口，保持可预测"
                  count={pinnedItems.length}
                  action={
                    pinnedItems.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          if (confirm('确认清空所有置顶？此操作不可撤销。')) clearPins();
                        }}
                      >
                        <Trash2 size={12} />
                        清空
                      </Button>
                    ) : null
                  }
                />
                {pinnedItems.length === 0 ? (
                  <EmptyHint
                    title="还没有置顶工具"
                    hint="按 Cmd/Ctrl + K 打开命令面板，把常用入口点击星标置顶。"
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {pinnedItems.slice(0, 6).map((item) => (
                      <ToolRow
                        key={item.id}
                        item={item}
                        compact
                        onClick={() => navigate(item.route)}
                        onRemove={() => togglePin(item.id)}
                        removeLabel="取消置顶"
                      />
                    ))}
                  </div>
                )}
              </GlassCard>

              <GlassCard animated accentHue={180} className="flex flex-col">
                <SectionHeader
                  icon={<Clock size={14} />}
                  title="最近使用"
                  subtitle="快速回到刚才的上下文"
                  count={recentItems.length}
                  action={
                    recentItems.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          if (confirm('确认清空最近使用记录？')) clearRecentVisits();
                        }}
                      >
                        <Trash2 size={12} />
                        清空
                      </Button>
                    ) : null
                  }
                />
                {recentItems.length === 0 ? (
                  <EmptyHint
                    title="还没有使用记录"
                    hint="通过命令面板打开任意工具后，这里会显示最近访问列表。"
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {recentItems.map(({ item, visit }) => (
                      <ToolRow
                        key={`${item.id}-${visit.timestamp}`}
                        item={item}
                        compact
                        onClick={() => navigate(item.route)}
                        rightSlot={
                          <span className="surface-inset shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-token-muted">
                            {getRelativeTime(visit.timestamp)}
                          </span>
                        }
                      />
                    ))}
                  </div>
                )}
              </GlassCard>
            </div>

            <GlassCard animated accentHue={290} className="flex flex-col">
              <SectionHeader
                icon={<TrendingUp size={14} />}
                title="常用工具"
                subtitle="按累计启动次数自动排序"
                count={frequentItems.length}
                action={
                  frequentItems.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        if (confirm('确认重置使用统计？「常用工具」将清空。')) resetUsage();
                      }}
                    >
                      <Trash2 size={12} />
                      重置统计
                    </Button>
                  ) : null
                }
              />
              {frequentItems.length === 0 ? (
                <EmptyHint
                  title="还没有统计数据"
                  hint="每次通过命令面板打开工具时都会计数，积累几次之后这里会展示你的 Top 8。"
                />
              ) : (
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {frequentItems.map(({ item, count }) => (
                    <ToolRow
                      key={item.id}
                      item={item}
                      compact
                      onClick={() => navigate(item.route)}
                      rightSlot={
                        <span className="surface-action-accent shrink-0 rounded px-2 py-0.5 font-mono text-[10px]">
                          x {count}
                        </span>
                      }
                    />
                  ))}
                </div>
              )}
            </GlassCard>
          </div>

          <div className="space-y-5">
            <GlassCard animated accentHue={160}>
              <SectionHeader
                icon={<Share2 size={14} />}
                title="用户互动"
                subtitle="把个人主页变成作品与协作入口"
              />
              <div className="flex flex-col gap-2">
                <InteractionCard
                  icon={<Globe2 size={16} />}
                  title="访问我的公开主页"
                  description="查看别人能看到的公开资源，确认展示效果。"
                  actionLabel="打开主页"
                  onClick={gotoProfile}
                  disabled={!profilePath}
                />
                <InteractionCard
                  icon={<FileText size={16} />}
                  title="发布网页作品"
                  description="将网页设为公开后，会自动出现在个人主页。"
                  actionLabel="去网页托管"
                  onClick={() => navigate('/web-pages')}
                />
                <InteractionCard
                  icon={<Store size={16} />}
                  title="发现别人的技能"
                  description="收藏、下载或 Fork 市场里的公开技能包。"
                  actionLabel="去海鲜市场"
                  onClick={() => navigate('/marketplace?type=skill')}
                />
                <InteractionCard
                  icon={<Users size={16} />}
                  title="查看团队成员"
                  description="通过用户卡片了解成员活跃度、作品和常用能力。"
                  actionLabel="去用户列表"
                  onClick={() => navigate('/users')}
                />
              </div>
            </GlassCard>

            <GlassCard animated accentHue={35}>
              <SectionHeader
                icon={<MessageSquare size={14} />}
                title="还能增强的互动"
                subtitle="后续可以继续产品化的用户关系"
              />
              <div className="space-y-3 text-[12px] leading-relaxed text-token-muted">
                <InteractionIdea title="关注用户" text="关注后在首页看到对方新公开的网页、技能、文档和工作流。" />
                <InteractionIdea title="主页留言" text="对公开资源留下反馈，资源作者可回复或置顶精选评论。" />
                <InteractionIdea title="协作邀请" text="从公开主页直接邀请对方一起维护工作流、知识库或网页项目。" />
                <InteractionIdea title="作品动态" text="把收藏、Fork、撤回、发布形成轻量动态流，增强发现效率。" />
              </div>
            </GlassCard>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickToolCard({
  title,
  emptyTitle,
  emptyHint,
  item,
  meta,
  onClick,
}: {
  title: string;
  emptyTitle: string;
  emptyHint: string;
  item?: LauncherItem;
  meta?: string;
  onClick: (item: LauncherItem) => void;
}) {
  if (!item) {
    return (
      <div className="surface-inset flex min-h-[96px] flex-col justify-between rounded-[12px] px-4 py-3">
        <div className="text-[12px] font-semibold text-token-primary">{emptyTitle}</div>
        <div className="text-[11px] leading-relaxed text-token-muted">{emptyHint}</div>
      </div>
    );
  }

  const accent = item.accentColor ?? '#818CF8';
  return (
    <button
      type="button"
      onClick={() => onClick(item)}
      className="surface-row flex min-h-[96px] cursor-pointer flex-col justify-between rounded-[12px] border border-token-nested px-4 py-3 text-left transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold text-token-muted">{title}</div>
        <ArrowUpRight size={14} className="text-token-muted" />
      </div>
      <div className="flex items-center gap-2">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px]"
          style={{ background: `${accent}18`, border: `1px solid ${accent}30`, color: accent }}
        >
          {getIcon(item.icon, 14)}
        </span>
        <span className="min-w-0 truncate text-[13px] font-semibold text-token-primary">
          {item.name}
        </span>
      </div>
      <div className="truncate text-[11px] text-token-muted">{meta ?? item.route}</div>
    </button>
  );
}

function InteractionIdea({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex gap-2">
      <UserRound size={13} className="mt-0.5 shrink-0 text-token-accent" />
      <div className="min-w-0">
        <span className="font-semibold text-token-primary">{title}</span>
        <span className="text-token-muted">：{text}</span>
      </div>
    </div>
  );
}

function EmptyHint({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center gap-1.5 py-8 text-center text-token-muted">
      <div className="text-[13px] font-medium">{title}</div>
      <div className="max-w-[280px] text-[11px] leading-relaxed">{hint}</div>
    </div>
  );
}

export default UserSpaceSettings;
