/**
 * 「我的空间」设置页
 *
 * 展示并管理当前用户的私人使用数据：
 *  - 常用工具：按使用次数自动排序
 *  - 最近使用：按最近访问时间倒序
 *  - 已置顶：用户固定的快捷入口
 *
 * 数据源：useAgentSwitcherStore（sessionStorage 持久化，登出即清空）
 * 与命令面板（Cmd/Ctrl + K）共享同一份存储，两边看到的是同一份数据。
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import * as LucideIcons from 'lucide-react';
import {
  Pin,
  Clock,
  TrendingUp,
  Trash2,
  ExternalLink,
  Keyboard,
  Sparkles,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
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

/** 一行工具条目 */
function ToolRow({
  item,
  rightSlot,
  onClick,
  onRemove,
  removeLabel,
}: {
  item: LauncherItem;
  rightSlot?: React.ReactNode;
  onClick?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const accent = item.accentColor ?? '#818CF8';
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] transition-colors cursor-pointer group"
      style={{
        background: 'var(--nested-block-bg, rgba(255,255,255,0.025))',
        border: '1px solid var(--nested-block-border, rgba(255,255,255,0.06))',
      }}
      onClick={onClick}
    >
      <div
        className="shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center"
        style={{
          background: `${accent}18`,
          border: `1px solid ${accent}30`,
          color: accent,
        }}
      >
        {getIcon(item.icon, 14)}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[13px] font-medium truncate"
          style={{ color: 'var(--text-primary)' }}
        >
          {item.name}
        </div>
        <div
          className="text-[11px] truncate"
          style={{ color: 'var(--text-muted)' }}
        >
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
          className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            color: 'rgba(239, 68, 68, 0.85)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
          }}
          title={removeLabel ?? '移除'}
          aria-label={removeLabel ?? '移除'}
        >
          <Trash2 size={11} />
        </button>
      )}
      <ExternalLink
        size={12}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--text-muted)' }}
      />
    </div>
  );
}

/** 区块头 */
function SectionHeader({
  icon,
  title,
  subtitle,
  count,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3 shrink-0">
      <div className="flex items-center gap-2.5 min-w-0">
        <div
          className="shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center"
          style={{
            background: 'rgba(99, 102, 241, 0.12)',
            color: '#a5b4fc',
            border: '1px solid rgba(99, 102, 241, 0.24)',
          }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <div
            className="text-[13px] font-bold flex items-center gap-2"
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--bg-input, rgba(255,255,255,0.04))',
                color: 'var(--text-muted)',
              }}
            >
              {count}
            </span>
          </div>
          <div
            className="text-[11px] mt-0.5 truncate"
            style={{ color: 'var(--text-muted)' }}
          >
            {subtitle}
          </div>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
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
    [permissions, isRoot]
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
    [pinnedIds, catalogById]
  );

  const recentItems = useMemo(
    () =>
      recentVisits
        .map((v) => ({ item: catalogById.get(v.id), visit: v }))
        .filter(
          (x): x is { item: LauncherItem; visit: typeof recentVisits[number] } =>
            !!x.item
        )
        .slice(0, 10),
    [recentVisits, catalogById]
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
      .slice(0, 10);
  }, [usageCounts, catalogById]);

  const totalLaunches = useMemo(
    () => Object.values(usageCounts).reduce((sum, n) => sum + n, 0),
    [usageCounts]
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto pr-1">
      {/* 顶部引导卡 */}
      <GlassCard animated glow accentHue={250} className="mb-5">
        <div className="flex items-start gap-4">
          <div
            className="shrink-0 w-12 h-12 rounded-[12px] flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, rgba(99,102,241,0.2) 0%, rgba(139,92,246,0.2) 100%)',
              border: '1px solid rgba(139, 92, 246, 0.3)',
              color: '#c4b5fd',
            }}
          >
            <Sparkles size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-[14px] font-bold"
              style={{ color: 'var(--text-primary)' }}
            >
              {user?.displayName ?? '你'}的私人空间
            </div>
            <div
              className="text-[12px] mt-1"
              style={{ color: 'var(--text-muted)' }}
            >
              这里记录你常用的 Agent 与工具。数据仅存储在当前浏览器会话中（登出即清空），不会被其他用户看到。
            </div>
            <div className="flex items-center gap-4 mt-3 flex-wrap">
              <div
                className="flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Pin size={12} />
                <span>已置顶</span>
                <span className="font-bold" style={{ color: '#a5b4fc' }}>
                  {pinnedItems.length}
                </span>
              </div>
              <div
                className="flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Clock size={12} />
                <span>近期使用</span>
                <span className="font-bold" style={{ color: '#a5b4fc' }}>
                  {recentItems.length}
                </span>
              </div>
              <div
                className="flex items-center gap-1.5 text-[11px]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <TrendingUp size={12} />
                <span>总启动次数</span>
                <span className="font-bold" style={{ color: '#a5b4fc' }}>
                  {totalLaunches}
                </span>
              </div>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openSwitcher()}
            className="shrink-0"
          >
            <Keyboard size={14} />
            打开命令面板
          </Button>
        </div>
      </GlassCard>

      {/* 我收藏的技能（从海鲜市场心标的技能包） */}
      <MyFavoriteSkills />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* 置顶 */}
        <GlassCard animated accentHue={230} className="flex flex-col">
          <SectionHeader
            icon={<Pin size={14} />}
            title="置顶工具"
            subtitle="在命令面板点击星标加入"
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
              hint="按 Cmd/Ctrl + K 打开命令面板，把你最常用的 Agent 或工具点击星标置顶到这里"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {pinnedItems.map((item) => (
                <ToolRow
                  key={item.id}
                  item={item}
                  onClick={() => navigate(item.route)}
                  onRemove={() => togglePin(item.id)}
                  removeLabel="取消置顶"
                />
              ))}
            </div>
          )}
        </GlassCard>

        {/* 最近使用 */}
        <GlassCard animated accentHue={180} className="flex flex-col">
          <SectionHeader
            icon={<Clock size={14} />}
            title="最近使用"
            subtitle="最近从命令面板进入的工具"
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
              hint="通过命令面板打开任意工具，这里就会出现最近访问列表"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {recentItems.map(({ item, visit }) => (
                <ToolRow
                  key={`${item.id}-${visit.timestamp}`}
                  item={item}
                  onClick={() => navigate(item.route)}
                  rightSlot={
                    <span
                      className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        background: 'var(--bg-input, rgba(255,255,255,0.04))',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {getRelativeTime(visit.timestamp)}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </GlassCard>

        {/* 常用工具 */}
        <GlassCard animated accentHue={290} className="flex flex-col lg:col-span-2">
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
              hint="每次通过命令面板打开工具时都会计数，积累几次之后这里会展示你的使用 Top 10"
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {frequentItems.map(({ item, count }) => (
                <ToolRow
                  key={item.id}
                  item={item}
                  onClick={() => navigate(item.route)}
                  rightSlot={
                    <span
                      className="shrink-0 text-[10px] font-mono px-2 py-0.5 rounded"
                      style={{
                        background: 'rgba(99, 102, 241, 0.15)',
                        color: '#a5b4fc',
                      }}
                    >
                      × {count}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}

function EmptyHint({ title, hint }: { title: string; hint: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1.5 py-8 text-center"
      style={{ color: 'var(--text-muted)' }}
    >
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[11px] max-w-[280px] leading-relaxed">{hint}</div>
    </div>
  );
}

export default UserSpaceSettings;
