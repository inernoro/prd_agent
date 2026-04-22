import { useEffect, useMemo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar, type TabBarItem } from '@/components/design/TabBar';
import { useToolboxStore, type ToolboxCategory, type ToolboxPageTab } from '@/stores/toolboxStore';
import { Package, Search, Plus, Boxes, User, Wrench, Star, Globe2 } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ToolCard } from './components/ToolCard';
import { ToolDetail } from './components/ToolDetail';
import { ToolEditor } from './components/ToolEditor';
import { ToolRunner } from './components/ToolRunner';
import { BasicCapabilities } from './components/BasicCapabilities';
import { QuickCreateWizard } from './components/QuickCreateWizard';

const PAGE_TABS: TabBarItem[] = [
  { key: 'toolbox', label: 'AI 百宝箱', icon: <Package size={14} /> },
  { key: 'capabilities', label: '基础能力', icon: <Wrench size={14} /> },
];

// 三张筛选卡片（+ 收藏），按"权属"维度组织：
//   全部   = BUILTIN + 我的 + 别人公开的
//   我的   = 我自己创建/Fork 的（不含 BUILTIN，BUILTIN 永远可用于所有人）
//   别人的 = 别人创建并公开的
// 这样"公开发布"就是让自己的条目出现在其他用户的「全部/别人的」里。
const CATEGORY_TABS: TabBarItem[] = [
  { key: 'all', label: '全部', icon: <Boxes size={14} /> },
  { key: 'mine', label: '我的', icon: <User size={14} /> },
  { key: 'others', label: '别人的', icon: <Globe2 size={14} /> },
  { key: 'favorite', label: '收藏', icon: <Star size={14} /> },
];

// 页面容器样式 — 页面级不使用 surface 类，保持透明让卡片自身表达玻璃质感
const pageContainerClassName = '';
const pageContainerStyle: React.CSSProperties = {};

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
    setPageTab,
    setCategory,
    setSearchQuery,
    loadItems,
    startCreate,
  } = useToolboxStore();

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // Filter items based on ownership category + search
  // items 已经由 loadItems 预先合并成 BUILTIN + 我的(ownership='mine') + 别人公开的(ownership='others')
  const filteredItems = useMemo(() => {
    let result = items;

    if (category === 'mine') {
      result = result.filter((item) => item.ownership === 'mine');
    } else if (category === 'others') {
      result = result.filter((item) => item.ownership === 'others');
    } else if (category === 'favorite') {
      result = result.filter((item) => favoriteIds.has(item.id));
    }
    // category === 'all' 不过滤，展示 BUILTIN + 我的 + 别人公开的

    // Filter by search
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
  }, [items, category, searchQuery, favoriteIds]);

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

  // Grid view (default)
  return (
    <div className={`${pageContainerClassName} h-full min-h-0 flex flex-col gap-3`} style={pageContainerStyle}>
      {/* Header — 使用统一 TabBar */}
      <div className="px-4 pt-3">
        <TabBar
          items={PAGE_TABS}
          activeKey={pageTab}
          onChange={(key) => setPageTab(key as ToolboxPageTab)}
          actions={
            <Button variant="primary" size="sm" onClick={startCreate}>
              <Plus size={13} />
              创建智能体
            </Button>
          }
        />
      </div>

      {/* Filters — 使用统一 TabBar */}
      <div className="px-4">
        <TabBar
          items={CATEGORY_TABS}
          activeKey={category}
          onChange={(key) => setCategory(key as ToolboxCategory)}
          actions={
            <div className="flex items-center gap-2">
              {/* Count badge */}
              <div
                className="px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap shrink-0"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  color: 'rgba(255, 255, 255, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                }}
              >
                {filteredItems.length} 个工具
              </div>

              {/* Search */}
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: 'rgba(255, 255, 255, 0.4)' }}
                />
                <input
                  type="text"
                  data-tour-id="toolbox-search"
                  placeholder={isMobile ? '搜索...' : '搜索工具名称、描述或标签...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`${isMobile ? 'w-32' : 'w-56'} pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none transition-all duration-200 focus:ring-1 focus:ring-[var(--accent-primary)]/30`}
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    color: 'rgba(255, 255, 255, 0.9)',
                  }}
                />
              </div>
            </div>
          }
        />
      </div>

      {/* Tool Grid */}
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-3">
        {gridLoading ? (
          <div className="flex items-center justify-center h-48">
            <MapSectionLoader text="加载中..." />
          </div>
        ) : filteredItems.length === 0 ? (
          <GlassCard animated variant="subtle" className="flex flex-col items-center justify-center h-48 gap-3">
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center"
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.05)',
              }}
            >
              <Package size={28} style={{ color: 'rgba(255, 255, 255, 0.4)' }} />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium mb-0.5" style={{ color: 'rgba(255, 255, 255, 0.8)' }}>
                {searchQuery
                  ? '没有找到匹配的工具'
                  : isOthersCategory
                  ? '还没有其他人公开发布智能体'
                  : category === 'mine'
                  ? '你还没有创建过智能体'
                  : '暂无工具'}
              </div>
              <div className="text-xs" style={{ color: 'rgba(255, 255, 255, 0.45)' }}>
                {searchQuery
                  ? '尝试其他关键词'
                  : isOthersCategory
                  ? '等待其他用户把工具发布到市场，公开后会带 NEW 徽章出现在这里'
                  : '点击右上角创建你的第一个智能体'}
              </div>
            </div>
            {category === 'mine' && !searchQuery && (
              <Button variant="primary" size="sm" onClick={startCreate}>
                <Plus size={13} />
                创建智能体
              </Button>
            )}
          </GlassCard>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {filteredItems.map((item) => (
              // source 走 item.ownership：别人公开的 = 'marketplace' 分支（显示 Fork 数/NEW 徽章；点击打开详情抽屉而非直接 Fork）；
              // 自己或 BUILTIN = 'mine' 分支
              <ToolCard
                key={item.id}
                item={item}
                source={item.ownership === 'others' ? 'marketplace' : 'mine'}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
