import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Surface } from '@/components/design/Surface';
import { useToolboxStore, type ToolboxCategory } from '@/stores/toolboxStore';
import type { ToolboxItem } from '@/services';
import { Package, Search, Plus, Boxes, User, Star, Globe2, Bot, Zap, X } from 'lucide-react';
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

// 权属维度（原有）
const CATEGORY_TABS: ToolboxSegmentedItem[] = [
  { key: 'all', label: '全部', icon: <Boxes size={14} /> },
  { key: 'mine', label: '我的', icon: <User size={14} /> },
  { key: 'others', label: '别人的', icon: <Globe2 size={14} /> },
  { key: 'favorite', label: '收藏', icon: <Star size={14} /> },
];

// 功能类型维度（新增）
const KIND_TABS: ToolboxSegmentedItem[] = [
  { key: 'all', label: '全部类型', icon: <Boxes size={14} /> },
  { key: 'agent', label: '智能体', icon: <Bot size={14} /> },
  { key: 'tool', label: '工具', icon: <Zap size={14} /> },
];

export default function AiToolboxPage() {
  const { isMobile } = useBreakpoint();
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
      result = result.filter((item) => item.kind === funcKindFilter);
    }

    if (activeTagFilter) {
      const lowerTag = activeTagFilter.toLowerCase();
      result = result.filter((item) =>
        item.tags.some((t) => t.toLowerCase().includes(lowerTag))
      );
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          item.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    return result;
  }, [items, category, searchQuery, favoriteIds, funcKindFilter, activeTagFilter]);

  const gridLoading = itemsLoading;
  const isOthersCategory = category === 'others';

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

  const hasActiveFilters = funcKindFilter !== 'all' || !!activeTagFilter;

  // Grid view (default)
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
        <>
          {/* 权属维度 */}
          <ToolboxSegmentedControl
            items={CATEGORY_TABS}
            activeKey={category}
            label="工具分类"
            compact
            onChange={(key) => setCategory(key as ToolboxCategory)}
          />

          {/* 功能类型维度 */}
          <ToolboxSegmentedControl
            items={KIND_TABS}
            activeKey={funcKindFilter}
            label="工具类型"
            compact
            onChange={(key) => setFuncKindFilter(key as 'all' | 'agent' | 'tool')}
          />

          <div className="toolbox-search-cluster">
            {/* 活跃 Tag 过滤芯片 */}
            {activeTagFilter && (
              <button
                className="toolbox-active-tag-chip"
                onClick={() => setActiveTagFilter(null)}
                title="清除标签过滤"
              >
                <span>{activeTagFilter}</span>
                <X size={11} />
              </button>
            )}

            <div className="toolbox-count-pill">
              {filteredItems.length} 个{hasActiveFilters ? '匹配' : '工具'}
            </div>

            <div className="relative">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-token-muted"
              />
              <input
                type="text"
                data-tour-id="toolbox-search"
                placeholder={isMobile ? '搜索...' : '搜索工具名称、描述或标签...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`prd-field ${isMobile ? 'w-32' : 'w-56'} pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none`}
              />
            </div>
          </div>
        </>
      }
    >
      {/* 最近使用横条 */}
      {!gridLoading && recentItems.length > 0 && (
        <div className="toolbox-recent-strip">
          <span className="toolbox-recent-label">最近使用</span>
          <div className="toolbox-recent-items">
            {recentItems.map((item) => (
              <RecentChip key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {gridLoading ? (
        <div className="flex items-center justify-center h-48">
          <MapSectionLoader text="加载中..." />
        </div>
      ) : filteredItems.length === 0 ? (
        <Surface variant="inset" className="flex flex-col items-center justify-center h-48 gap-3 rounded-xl">
          <div className="surface-inset w-14 h-14 rounded-xl flex items-center justify-center">
            <Package size={28} className="text-token-muted" />
          </div>
          <div className="text-center">
            <div className="text-sm font-medium mb-0.5 text-token-secondary">
              {activeTagFilter
                ? `没有含「${activeTagFilter}」标签的工具`
                : searchQuery
                ? '没有找到匹配的工具'
                : isOthersCategory
                ? '还没有其他人公开发布智能体'
                : category === 'mine'
                ? '你还没有创建过智能体'
                : '暂无工具'}
            </div>
            <div className="text-xs text-token-muted">
              {activeTagFilter
                ? '点击右侧 × 可清除标签过滤'
                : searchQuery
                ? '尝试其他关键词'
                : isOthersCategory
                ? '等待其他用户把工具发布到市场，公开后会带 NEW 徽章出现在这里'
                : '点击右上角创建你的第一个智能体'}
            </div>
          </div>
          {activeTagFilter && (
            <Button variant="ghost" size="sm" onClick={() => setActiveTagFilter(null)}>
              <X size={13} />
              清除标签过滤
            </Button>
          )}
          {category === 'mine' && !searchQuery && !activeTagFilter && (
            <Button variant="primary" size="sm" onClick={startCreate}>
              <Plus size={13} />
              创建智能体
            </Button>
          )}
        </Surface>
      ) : (
        <div className="grid grid-auto-tool-cards gap-4">
          {filteredItems.map((item) => (
            <ToolCard
              key={item.id}
              item={item}
              source={item.ownership === 'others' ? 'marketplace' : 'mine'}
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
