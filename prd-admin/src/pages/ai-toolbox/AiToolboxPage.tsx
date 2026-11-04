import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHistoryBackedView } from '@/hooks/useHistoryBackedView';
import { Surface } from '@/components/design/Surface';
import { useToolboxStore, type ToolboxCategory } from '@/stores/toolboxStore';
import type { ToolboxItem } from '@/services';
import {
  Package,
  Search,
  Plus,
  Boxes,
  User,
  Star,
  Globe2,
  Bot,
  Zap,
  X,
  Grid3X3,
  LayoutGrid,
  Image,
  Clock3,
  ArrowUpRight,
} from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ToolCard } from './components/ToolCard';
import { ToolDetail } from './components/ToolDetail';
import { ToolEditor } from './components/ToolEditor';
import { ToolRunner } from './components/ToolRunner';
import { BasicCapabilities } from './components/BasicCapabilities';
import { QuickCreateWizard } from './components/QuickCreateWizard';
import { ToolboxPageShell, ToolboxSegmentedControl, type ToolboxSegmentedItem } from './components/ToolboxShell';
import { MobileToolboxView } from './MobileToolboxView';
import {
  readToolboxDisplayMode,
  writeToolboxDisplayMode,
  type ToolboxDisplayMode,
} from './toolboxDisplayMode';
import { searchToolboxItems } from './toolboxSearch';
import './toolbox-discovery.css';

// 权属维度（原有）
const CATEGORY_TABS: ToolboxSegmentedItem[] = [
  { key: 'all', label: '全部工具', icon: <Boxes size={14} /> },
  { key: 'mine', label: '我的创建', icon: <User size={14} /> },
  { key: 'others', label: '公开共享', icon: <Globe2 size={14} /> },
  { key: 'favorite', label: '收藏', icon: <Star size={14} /> },
];

// 功能类型维度（新增）
const KIND_TABS: ToolboxSegmentedItem[] = [
  { key: 'all', label: '全部类型', icon: <Boxes size={14} /> },
  { key: 'agent', label: '智能体', icon: <Bot size={14} /> },
  { key: 'tool', label: '工具', icon: <Zap size={14} /> },
];

const DISPLAY_MODES: Array<{
  key: ToolboxDisplayMode;
  label: string;
  description: string;
  icon: typeof Grid3X3;
}> = [
  { key: 'compact', label: '紧凑', description: '用图标和用途快速查找工具', icon: Grid3X3 },
  { key: 'standard', label: '标准', description: '平衡图片与信息密度', icon: LayoutGrid },
  { key: 'showcase', label: '大图', description: '突出智能体插画', icon: Image },
];

export default function AiToolboxPage() {
  const { isMobile } = useBreakpoint();
  const [displayMode, setDisplayMode] = useState<ToolboxDisplayMode>(() =>
    readToolboxDisplayMode(typeof window === 'undefined' ? undefined : window.localStorage)
  );
  const {
    view,
    pageTab,
    category,
    searchQuery,
    items,
    itemsLoading,
    selectedItem,
    favoriteIds,
    funcKindFilter,
    activeTagFilter,
    recentlyUsedIds,
    setPageTab,
    setCategory,
    setSearchQuery,
    setFuncKindFilter,
    setActiveTagFilter,
    loadItems,
    startCreate,
  } = useToolboxStore();

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // 网格 -> 详情/创建/编辑/运行 都是全屏级视图切换，必须进浏览器历史：
  // 右滑/浏览器返回 = 关当前视图回网格，而不是跳出整个百宝箱。
  // detail 带 item id（支持恢复）；create/edit/running/quick-create 只记视图名（刷新不恢复，回落网格）。
  useHistoryBackedView({
    param: 'panel',
    value:
      view === 'grid' ? null
      : (view === 'detail' || view === 'running') && selectedItem ? `${view}.${selectedItem.id}`
      : view,
    onExit: () => useToolboxStore.getState().backToGrid(),
    onRestore: (v) => {
      if (v.startsWith('detail.')) {
        const store = useToolboxStore.getState();
        const item = store.items.find((it) => it.id === v.slice('detail.'.length));
        if (!item) return false;
        store.selectItem(item);
        return;
      }
      return false;
    },
  });

  // 最近使用：从 items 里按 recentlyUsedIds 顺序取，过滤掉已从列表消失的 id
  const recentItems = useMemo(() => {
    if (!recentlyUsedIds.length || !items.length) return [];
    return recentlyUsedIds
      .map((id) => items.find((it) => it.id === id))
      .filter(Boolean) as typeof items;
  }, [recentlyUsedIds, items]);

  // 筛选：权属 + 类型 + Tag + 搜索
  const filteredItems = useMemo(() => {
    let result = items;

    if (category === 'mine') {
      result = result.filter((item) => item.ownership === 'mine');
    } else if (category === 'others') {
      result = result.filter((item) => item.ownership === 'others');
    } else if (category === 'favorite') {
      result = result.filter((item) => favoriteIds.has(item.id));
    }

    if (funcKindFilter !== 'all') {
      result = result.filter((item) => (item.kind ?? 'agent') === funcKindFilter);
    }

    if (activeTagFilter) {
      const lowerTag = activeTagFilter.toLowerCase();
      result = result.filter((item) =>
        item.tags.some((t) => t.toLowerCase() === lowerTag)
      );
    }

    return searchToolboxItems(result, searchQuery);
  }, [items, category, searchQuery, favoriteIds, funcKindFilter, activeTagFilter]);

  const gridLoading = itemsLoading;
  const favoriteItems = items.filter((item) => favoriteIds.has(item.id));

  // Render based on current view
  if (view === 'detail' && selectedItem) {
    return <ToolDetail />;
  }

  if (view === 'quick-create') {
    return <QuickCreateWizard />;
  }

  if (view === 'create' || view === 'edit') {
    return <ToolEditor />;
  }

  if (view === 'running' && selectedItem) {
    return <ToolRunner />;
  }

  // Render based on page tab
  if (pageTab === 'capabilities') {
    return <BasicCapabilities />;
  }

  const hasActiveFilters = funcKindFilter !== 'all' || !!activeTagFilter || !!searchQuery.trim();
  const resetFilters = () => {
    setCategory('all');
    setFuncKindFilter('all');
    setActiveTagFilter(null);
    setSearchQuery('');
  };
  const emptyStates = {
    all: { title: '暂无工具', description: '可用工具会显示在这里。' },
    mine: { title: '你还没有创建过智能体', description: '创建一个智能体，保存自己的提示词和配置。' },
    others: { title: '还没有公开共享的智能体', description: '其他用户公开发布后，你可以在这里直接使用。' },
    favorite: { title: '还没有收藏工具', description: '点击工具卡片上的星标，把常用工具留在这里。' },
  };
  const emptyState = hasActiveFilters
    ? { title: '没有找到匹配的工具', description: '试试更短的关键词，或清除筛选后查看全部工具。' }
    : emptyStates[category];

  const handleDisplayModeChange = (mode: ToolboxDisplayMode) => {
    setDisplayMode(mode);
    writeToolboxDisplayMode(
      typeof window === 'undefined' ? undefined : window.localStorage,
      mode,
    );
  };

  // 移动端「发现」：原生手机浏览体验（首屏即时出内容，不卡加载动画）
  if (isMobile) {
    return <MobileToolboxView />;
  }

  // Grid view (default, 桌面)
  return (
    <ToolboxPageShell
      pageTab={pageTab}
      onPageTabChange={setPageTab}
      contentClassName="overflow-auto"
      primaryAction={
        <Button variant="primary" size="sm" onClick={startCreate}>
          <Plus size={13} />
          创建智能体
        </Button>
      }
      controls={
        <div className="toolbox-discovery-controls">
          <div className="toolbox-discovery-search-row">
            <div className="toolbox-discovery-search">
              <Search size={19} aria-hidden />
              <input
                type="search"
                aria-label="搜索工具"
                data-tour-id="toolbox-search"
                placeholder="搜索名称、用途或标签，例如 Markdown PPT"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} aria-label="清空搜索">
                  <X size={15} />
                </button>
              )}
            </div>
            <span className="toolbox-discovery-total">{items.length} 个工具，随时开始</span>
          </div>
          <div className="toolbox-discovery-toolbar">
            <ToolboxSegmentedControl
              items={CATEGORY_TABS}
              activeKey={category}
              label="工具分类"
              compact
              onChange={(key) => setCategory(key as ToolboxCategory)}
            />
            <div className="toolbox-discovery-options">
              <ToolboxSegmentedControl
                items={KIND_TABS}
                activeKey={funcKindFilter}
                label="工具类型"
                compact
                onChange={(key) => setFuncKindFilter(key as 'all' | 'agent' | 'tool')}
              />
              <div className="toolbox-display-switch" role="group" aria-label="展示方式">
                {DISPLAY_MODES.map((mode) => {
                  const Icon = mode.icon;
                  return (
                    <button
                      key={mode.key}
                      type="button"
                      className="toolbox-display-option"
                      data-active={displayMode === mode.key}
                      aria-pressed={displayMode === mode.key}
                      title={mode.description}
                      onClick={() => handleDisplayModeChange(mode.key)}
                    >
                      <Icon size={13} aria-hidden />
                      <span>{mode.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      }
    >
      {!gridLoading && category === 'all' && !hasActiveFilters && (
        <div className="toolbox-quick-access">
          <div className="toolbox-quick-group">
            <span className="toolbox-quick-label"><Star size={13} />收藏</span>
            {favoriteItems.length ? (
              <div className="toolbox-quick-items">
                {favoriteItems.slice(0, 3).map((item) => <RecentChip key={item.id} item={item} />)}
                <button type="button" className="toolbox-quick-more" onClick={() => setCategory('favorite')}>
                  查看全部 <ArrowUpRight size={12} />
                </button>
              </div>
            ) : <span className="toolbox-quick-hint">点击卡片星标，收藏常用工具</span>}
          </div>
          <div className="toolbox-quick-group">
            <span className="toolbox-quick-label"><Clock3 size={13} />最近使用</span>
            {recentItems.length ? (
              <div className="toolbox-quick-items">
                {recentItems.slice(0, 4).map((item) => <RecentChip key={item.id} item={item} />)}
              </div>
            ) : <span className="toolbox-quick-hint">打开工具后，可以从这里快速返回</span>}
          </div>
        </div>
      )}

      <div className="toolbox-results-heading">
        <div className="toolbox-results-title">
          <h2>{searchQuery.trim() ? '搜索结果' : CATEGORY_TABS.find((tab) => tab.key === category)?.label}</h2>
          <span role="status" aria-live="polite">{filteredItems.length} 个工具</span>
          {activeTagFilter && (
            <button className="toolbox-active-tag-chip" onClick={() => setActiveTagFilter(null)} title="清除标签过滤">
              {activeTagFilter}<X size={11} />
            </button>
          )}
        </div>
        {hasActiveFilters && <button type="button" className="toolbox-quick-more" onClick={resetFilters}>清除筛选</button>}
      </div>

      {gridLoading ? (
        <div className="flex items-center justify-center h-48">
          <MapSectionLoader text="加载中..." />
        </div>
      ) : filteredItems.length === 0 ? (
        <Surface variant="inset" className="toolbox-discovery-empty flex flex-col items-center justify-center gap-4 rounded-xl">
          <div className="toolbox-empty-icon">
            {category === 'favorite' && !hasActiveFilters ? <Star size={25} /> : <Package size={25} />}
          </div>
          <div className="text-center">
            <div className="text-sm font-medium mb-2 text-token-secondary">{emptyState.title}</div>
            <div className="text-xs text-token-muted">{emptyState.description}</div>
          </div>
          {category === 'mine' && !hasActiveFilters ? (
            <Button variant="primary" size="sm" onClick={startCreate}><Plus size={13} />创建智能体</Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={resetFilters}>
              {hasActiveFilters ? '清除筛选' : '浏览全部工具'}
            </Button>
          )}
        </Surface>
      ) : (
        <div className="toolbox-card-grid" data-display-mode={displayMode}>
          {filteredItems.map((item) => (
            <ToolCard
              key={item.id}
              item={item}
              source={item.ownership === 'others' ? 'marketplace' : 'mine'}
              displayMode={displayMode}
            />
          ))}
        </div>
      )}
    </ToolboxPageShell>
  );
}

// 最近使用芯片 — 轻量组件，避免引入完整 ToolCard 的复杂逻辑
function RecentChip({ item }: { item: ToolboxItem }) {
  const { selectItem, trackRecentlyUsed } = useToolboxStore();
  const navigate = useNavigate();

  const handleClick = () => {
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

  return (
    <button className="toolbox-recent-chip" onClick={handleClick} title={item.description}>
      <span className="toolbox-recent-chip-name">{item.name}</span>
    </button>
  );
}
