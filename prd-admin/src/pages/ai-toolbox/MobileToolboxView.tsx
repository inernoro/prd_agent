import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus } from 'lucide-react';
import { useToolboxStore, BUILTIN_TOOLS, type ToolboxCategory } from '@/stores/toolboxStore';
import type { ToolboxItem } from '@/services';
import { AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';
import { useDataTheme } from '@/hooks/useDataTheme';
import { accentFor, iconFor } from '@/lib/agentAccent';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { MobileSegmented } from '@/components/mobile/MobileSegmented';
import { MobileFab } from '@/components/mobile/MobileFab';
import { AppStoreSection, AppStoreRankedList } from '@/components/mobile/appStore';
import { AgentCardArtwork, AgentCardTask, hasAgentCardArtwork } from '@/components/agent-shell/AgentCardArtwork';

/**
 * 移动端「发现」（AI 百宝箱）—— 原生手机浏览体验。
 *
 * 为什么单独做：桌面版 AiToolboxPage 首屏要等 loadItems() 才出内容，
 * 在手机端慢网/接口异常时会长期卡「加载中」启动动画（调研实测两次复现）。
 * 这里首屏直接用静态 BUILTIN_TOOLS 立即出内容（与 MobileHomePage 同款数据源），
 * 接口返回的自建/公开工具到位后再并入，永不空白等待（CLAUDE.md §6）。
 *
 * 布局遵循 mobile-first-density：搜索框 + 一条横滚控制条（段控与权属 chip 同行）+ FAB，
 * 进内容前控制条不超过 2 条且不换行；内容卡片 edge-to-edge 铺满，杜绝「中间操作区缩成小盒子」。
 */

const KIND_SEG = [
  { key: 'all', label: '全部' },
  { key: 'agent', label: '智能体' },
  { key: 'tool', label: '工具' },
];

const OWNERSHIP_CHIPS: { key: ToolboxCategory; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我的' },
  { key: 'others', label: '别人的' },
  { key: 'favorite', label: '收藏' },
];

export function MobileToolboxView() {
  const navigate = useNavigate();
  const C = useAppStoreColors();
  const light = useDataTheme() === 'light';
  const {
    items,
    category,
    searchQuery,
    funcKindFilter,
    favoriteIds,
    activeTagFilter,
    setCategory,
    setSearchQuery,
    setFuncKindFilter,
    setActiveTagFilter,
    selectItem,
    startCreate,
    trackRecentlyUsed,
  } = useToolboxStore();

  // 首屏即时数据：接口未返回前用内置工具，返回后用合并结果（含内置 + 自建 + 公开）
  const source = items.length > 0 ? items : BUILTIN_TOOLS;

  const filtered = useMemo(() => {
    let result = source;
    if (category === 'mine') result = result.filter((it) => it.ownership === 'mine');
    else if (category === 'others') result = result.filter((it) => it.ownership === 'others');
    else if (category === 'favorite') result = result.filter((it) => favoriteIds.has(it.id));

    if (funcKindFilter !== 'all') result = result.filter((it) => (it.kind ?? 'agent') === funcKindFilter);

    if (activeTagFilter) {
      const lt = activeTagFilter.toLowerCase();
      result = result.filter((it) => it.tags.some((t) => t.toLowerCase() === lt));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.description.toLowerCase().includes(q) ||
          it.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [source, category, searchQuery, funcKindFilter, favoriteIds, activeTagFilter]);

  const agents = useMemo(() => filtered.filter((it) => (it.kind ?? 'agent') === 'agent'), [filtered]);
  const tools = useMemo(() => filtered.filter((it) => it.kind === 'tool'), [filtered]);

  const open = (item: ToolboxItem) => {
    trackRecentlyUsed(item.id);
    if (item.routePath) {
      if (item.agentKey === 'cds-agent') {
        window.location.assign(item.routePath);
        return;
      }
      navigate(item.routePath);
    } else {
      selectItem(item);
    }
  };

  const hasFilter = !!searchQuery.trim() || !!activeTagFilter || category !== 'all' || funcKindFilter !== 'all';

  return (
    <div
      className="h-full min-h-0 overflow-auto no-scrollbar"
      style={{ background: C.bg, fontFamily: AS_FONT_FAMILY }}
    >
      <div style={{ paddingBottom: 120 }}>
        {/* 大标题（紧凑：28px + 收紧上下间距，让卡片更早进首屏） */}
        <div style={{ padding: '4px 16px 0', fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1, color: C.label }}>
          发现
        </div>

        {/* 搜索 */}
        <div
          className="flex items-center gap-2"
          style={{ margin: '8px 16px', background: light ? 'rgba(120,120,128,0.12)' : 'rgba(118,118,128,0.24)', borderRadius: 12, padding: '10px 12px' }}
        >
          <Search size={18} style={{ color: C.labelTertiary }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索智能体、工具"
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: 16, color: C.label }}
          />
        </div>

        {/* 控制条：类型段控 + 权属 chip 合并为一条横滚（mobile-first-density §二.3：进内容前控制条 ≤2 且不换行） */}
        <div className="flex items-center gap-2 overflow-x-auto" style={{ padding: '4px 16px 2px', scrollbarWidth: 'none' }}>
          <MobileSegmented
            items={KIND_SEG}
            activeKey={funcKindFilter}
            onChange={(k) => setFuncKindFilter(k as 'all' | 'agent' | 'tool')}
            className="shrink-0"
            style={{ width: 216 }}
          />
          <span aria-hidden className="shrink-0" style={{ width: 1, height: 20, background: C.hairline }} />
          {OWNERSHIP_CHIPS.map((c) => {
            const on = category === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                className="shrink-0 whitespace-nowrap"
                style={{
                  padding: '7px 15px',
                  borderRadius: 18,
                  fontSize: 13,
                  fontWeight: 600,
                  border: `1px solid ${on ? C.label : C.hairline}`,
                  background: on ? C.label : C.surface,
                  color: on ? C.bg : C.labelSecondary,
                }}
              >
                {c.label}
              </button>
            );
          })}
          {activeTagFilter && (
            <button
              type="button"
              onClick={() => setActiveTagFilter(null)}
              className="shrink-0 whitespace-nowrap flex items-center gap-1"
              style={{
                padding: '7px 13px',
                borderRadius: 18,
                fontSize: 13,
                fontWeight: 600,
                border: `1px solid ${C.blue}`,
                background: light ? 'rgba(0,122,255,0.10)' : 'rgba(10,132,255,0.16)',
                color: C.blue,
              }}
            >
              #{activeTagFilter} ×
            </button>
          )}
        </div>

        {/* 内容 */}
        {filtered.length === 0 ? (
          <EmptyState hasFilter={hasFilter} onCreate={startCreate} />
        ) : (
          <>
            {agents.length > 0 && (
              <AppStoreSection title="智能体" caption={`${agents.length} 个`}>
                <div className="grid grid-cols-1 gap-3" style={{ padding: '0 16px' }}>
                  {agents.map((a) => (
                    <AgentCard key={a.id} item={a} onClick={() => open(a)} />
                  ))}
                </div>
              </AppStoreSection>
            )}

            {tools.length > 0 && (
              <AppStoreSection title="工具" caption={`${tools.length} 个`}>
                <AppStoreRankedList
                  numbered={false}
                  items={tools.map((t) => ({
                    key: t.id,
                    Icon: iconFor(t.icon),
                    accent: accentFor(t.agentKey),
                    title: t.name,
                    subtitle: t.description,
                    pillLabel: '打开',
                    onClick: () => open(t),
                  }))}
                />
              </AppStoreSection>
            )}
          </>
        )}
      </div>

      <MobileFab onClick={startCreate} icon={Plus} />
    </div>
  );
}

/* ─────────── 智能体大卡（单列大图） ─────────── */

function AgentCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = accentFor(item.agentKey);
  const Icon = iconFor(item.icon);
  const hasArtwork = hasAgentCardArtwork(item.agentKey);
  const pcOnly = item.routePath ? resolveMobileCompat(item.routePath)?.level === 'pc-only' : false;

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left active:scale-[0.97] transition-transform relative overflow-hidden flex flex-col justify-between"
      style={{
        height: hasArtwork ? 216 : 150,
        borderRadius: 18,
        padding: 16,
        color: hasArtwork ? 'var(--text-on-media)' : '#fff',
        background: hasArtwork ? 'var(--media-card-base)' : `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
        boxShadow: 'var(--media-card-shadow)',
      }}
    >
      <AgentCardArtwork agentKey={item.agentKey} compact tint={accent.from} />
      {pcOnly && (
        <span
          className="absolute z-10"
          style={{
            top: hasArtwork ? 58 : 12,
            right: 12,
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--media-card-tag-text)',
            background: 'var(--media-card-tag-bg)',
            border: '1px solid var(--media-card-tag-border)',
            padding: '3px 7px',
            borderRadius: 7,
          }}
        >
          建议 PC
        </span>
      )}
      {hasArtwork ? (
        <span className="relative z-10 flex items-start justify-between gap-2">
          <b style={{ maxWidth: '62%', fontSize: 20, fontWeight: 700, display: 'block', lineHeight: 1.2 }}>
            {item.name}
          </b>
          <AgentCardTask agentKey={item.agentKey} compact />
        </span>
      ) : (
        <span
          className="relative z-10 flex items-center justify-center"
          style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${accent.from}, ${accent.to})` }}
        >
          <Icon size={24} strokeWidth={2} />
        </span>
      )}
      <span
        className="relative z-10"
        style={hasArtwork ? {
          margin: 'auto -16px -16px',
          padding: '14px 16px 16px',
          background: 'var(--media-card-panel-translucent)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        } : undefined}
      >
        {!hasArtwork && (
          <b style={{ fontSize: 17, fontWeight: 700, display: 'block', lineHeight: 1.2 }}>{item.name}</b>
        )}
        {hasArtwork ? (
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="shrink-0 rounded-full border px-2.5 py-1 font-medium leading-none"
                style={{
                  fontSize: 12,
                  color: 'var(--media-card-tag-text)',
                  background: 'var(--media-card-tag-bg)',
                  borderColor: 'var(--media-card-tag-border)',
                }}
              >
                {tag}
              </span>
            ))}
          </span>
        ) : (
          <span
            className="block"
            style={{
              fontSize: 12,
              opacity: 0.85,
              lineHeight: 1.3,
              marginTop: 3,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {item.description}
          </span>
        )}
      </span>
    </button>
  );
}

/* ─────────── 空状态 ─────────── */

function EmptyState({ hasFilter, onCreate }: { hasFilter: boolean; onCreate: () => void }) {
  const C = useAppStoreColors();
  return (
    <div className="flex flex-col items-center justify-center text-center" style={{ padding: '70px 32px' }}>
      <div
        className="flex items-center justify-center"
        style={{ width: 64, height: 64, borderRadius: 18, background: C.surface, marginBottom: 16 }}
      >
        <Plus size={28} style={{ color: C.labelSecondary }} />
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, color: C.label, marginBottom: 6 }}>
        {hasFilter ? '没有匹配的工具' : '还没有工具'}
      </div>
      <div style={{ fontSize: 14, color: C.labelTertiary, lineHeight: 1.5, marginBottom: 18 }}>
        {hasFilter ? '换个筛选条件或关键词试试' : '点下方按钮创建你的第一个智能体'}
      </div>
      {!hasFilter && (
        <button
          type="button"
          onClick={onCreate}
          style={{
            padding: '10px 20px',
            borderRadius: 16,
            border: 'none',
            background: 'linear-gradient(135deg, #5E5CE6, #0A84FF)',
            color: '#fff',
            fontSize: 15,
            fontWeight: 700,
          }}
        >
          创建智能体
        </button>
      )}
    </div>
  );
}
