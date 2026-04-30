import { useEffect, useMemo } from 'react';
import { Surface } from '@/components/design/Surface';
import { useToolboxStore, type ToolboxCategory } from '@/stores/toolboxStore';
import { Package, Search, Plus, Boxes, User, Star, Globe2 } from 'lucide-react';
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

// 三张筛选卡片（+ 收藏），按"权属"维度组织：
//   全部   = BUILTIN + 我的 + 别人公开的
//   我的   = 我自己创建/Fork 的（不含 BUILTIN，BUILTIN 永远可用于所有人）
//   别人的 = 别人创建并公开的
// 这样"公开发布"就是让自己的条目出现在其他用户的「全部/别人的」里。
const CATEGORY_TABS: ToolboxSegmentedItem[] = [
  { key: 'all', label: '全部', icon: <Boxes size={14} /> },
  { key: 'mine', label: '我的', icon: <User size={14} /> },
  { key: 'others', label: '别人的', icon: <Globe2 size={14} /> },
  { key: 'favorite', label: '收藏', icon: <Star size={14} /> },
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
          <ToolboxSegmentedControl
            items={CATEGORY_TABS}
            activeKey={category}
            label="工具分类"
            compact
            onChange={(key) => setCategory(key as ToolboxCategory)}
          />

          <div className="toolbox-search-cluster">
            <div className="toolbox-count-pill">
              {filteredItems.length} 个工具
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
              {searchQuery
                ? '没有找到匹配的工具'
                : isOthersCategory
                ? '还没有其他人公开发布智能体'
                : category === 'mine'
                ? '你还没有创建过智能体'
                : '暂无工具'}
            </div>
            <div className="text-xs text-token-muted-faint">
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
        </Surface>
      ) : (
        <div className="grid grid-auto-tool-cards gap-4">
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
    </ToolboxPageShell>
  );
}
