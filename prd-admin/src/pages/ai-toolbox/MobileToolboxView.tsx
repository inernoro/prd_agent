import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus } from 'lucide-react';
import { useToolboxStore, BUILTIN_TOOLS, type ToolboxCategory } from '@/stores/toolboxStore';
import type { ToolboxItem } from '@/services';
import { AS_COLOR, AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { accentFor, iconFor } from '@/lib/agentAccent';
import { resolveMobileCompat } from '@/lib/mobileCompatibility';
import { MobileSegmented } from '@/components/mobile/MobileSegmented';
import { MobileFab } from '@/components/mobile/MobileFab';
import { AppStoreSection, AppStoreRankedList } from '@/components/mobile/appStore';

/**
 * 移动端「发现」（AI 百宝箱）—— 原生手机浏览体验。
 *
 * 为什么单独做：桌面版 AiToolboxPage 首屏要等 loadItems() 才出内容，
 * 在手机端慢网/接口异常时会长期卡「加载中」启动动画（调研实测两次复现）。
 * 这里首屏直接用静态 BUILTIN_TOOLS 立即出内容（与 MobileHomePage 同款数据源），
 * 接口返回的自建/公开工具到位后再并入，永不空白等待（CLAUDE.md §6）。
 *
 * 布局遵循 mobile-first-density：一条段控 + 一行横滚 chip + FAB，
 * 内容卡片 edge-to-edge 铺满，杜绝「中间操作区缩成小盒子」。
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
      className="h-full min-h-0 overflow-auto"
      style={{ background: AS_COLOR.bg, fontFamily: AS_FONT_FAMILY }}
    >
      <div style={{ paddingBottom: 120 }}>
        {/* 大标题 */}
        <div style={{ padding: '6px 16px 0', fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1 }}>
          发现
        </div>

        {/* 搜索 */}
        <div
          className="flex items-center gap-2"
          style={{ margin: '12px 16px', background: 'rgba(118,118,128,0.24)', borderRadius: 12, padding: '10px 12px' }}
        >
          <Search size={18} style={{ color: AS_COLOR.labelTertiary }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索智能体、工具"
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: 16, color: AS_COLOR.label }}
          />
        </div>

        {/* 段控：类型维度（一条，替代桌面的两排 tab） */}
        <MobileSegmented
          items={KIND_SEG}
          activeKey={funcKindFilter}
          onChange={(k) => setFuncKindFilter(k as 'all' | 'agent' | 'tool')}
          style={{ margin: '4px 16px 6px' }}
        />

        {/* chip 行：权属维度（单行横滚，永不堆叠） */}
        <div className="flex gap-2 overflow-x-auto" style={{ padding: '4px 16px 2px', scrollbarWidth: 'none' }}>
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
                  border: `1px solid ${on ? '#fff' : AS_COLOR.hairline}`,
                  background: on ? '#fff' : AS_COLOR.surface,
                  color: on ? '#000' : AS_COLOR.labelSecondary,
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
                border: `1px solid ${AS_COLOR.blue}`,
                background: 'rgba(10,132,255,0.16)',
                color: AS_COLOR.blue,
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
                <div className="grid grid-cols-2 gap-3" style={{ padding: '0 16px' }}>
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

/* ─────────── 智能体大卡（2 列，渐变铺满） ─────────── */

function AgentCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = accentFor(item.agentKey);
  const Icon = iconFor(item.icon);
  const pcOnly = item.routePath ? resolveMobileCompat(item.routePath)?.level === 'pc-only' : false;

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left active:scale-[0.97] transition-transform relative overflow-hidden flex flex-col justify-between"
      style={{
        height: 150,
        borderRadius: 18,
        padding: 16,
        color: '#fff',
        background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
        boxShadow: '0 8px 22px -10px rgba(0,0,0,0.6)',
      }}
    >
      {pcOnly && (
        <span
          className="absolute"
          style={{
            top: 12,
            right: 12,
            fontSize: 10,
            fontWeight: 700,
            background: 'rgba(0,0,0,0.3)',
            padding: '3px 7px',
            borderRadius: 7,
          }}
        >
          建议 PC
        </span>
      )}
      <span
        className="flex items-center justify-center"
        style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.22)' }}
      >
        <Icon size={24} strokeWidth={2} />
      </span>
      <span>
        <b style={{ fontSize: 17, fontWeight: 700, display: 'block', lineHeight: 1.2 }}>{item.name}</b>
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
      </span>
    </button>
  );
}

/* ─────────── 空状态 ─────────── */

function EmptyState({ hasFilter, onCreate }: { hasFilter: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center" style={{ padding: '70px 32px' }}>
      <div
        className="flex items-center justify-center"
        style={{ width: 64, height: 64, borderRadius: 18, background: AS_COLOR.surface, marginBottom: 16 }}
      >
        <Plus size={28} style={{ color: AS_COLOR.labelSecondary }} />
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, color: AS_COLOR.label, marginBottom: 6 }}>
        {hasFilter ? '没有匹配的工具' : '还没有工具'}
      </div>
      <div style={{ fontSize: 14, color: AS_COLOR.labelTertiary, lineHeight: 1.5, marginBottom: 18 }}>
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
