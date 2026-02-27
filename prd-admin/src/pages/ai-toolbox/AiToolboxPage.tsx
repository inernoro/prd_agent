import { useEffect, useMemo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { useToolboxStore, type ToolboxCategory, type ToolboxPageTab } from '@/stores/toolboxStore';
import { Package, Search, Plus, Loader2, Sparkles, Boxes, User, Wrench } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { ToolCard } from './components/ToolCard';
import { ToolDetail } from './components/ToolDetail';
import { ToolEditor } from './components/ToolEditor';
import { ToolRunner } from './components/ToolRunner';
import { BasicCapabilities } from './components/BasicCapabilities';
import { QuickCreateWizard } from './components/QuickCreateWizard';

const PAGE_TABS: { key: ToolboxPageTab; label: string; icon: React.ReactNode }[] = [
  { key: 'toolbox', label: 'AI 百宝箱', icon: <Package size={14} /> },
  { key: 'capabilities', label: '基础能力', icon: <Wrench size={14} /> },
];

const CATEGORY_OPTIONS: { key: ToolboxCategory; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: '全部', icon: <Boxes size={12} /> },
  { key: 'builtin', label: '内置工具', icon: <Sparkles size={12} /> },
  { key: 'custom', label: '我创建的', icon: <User size={12} /> },
];

// 页面容器样式 - 不透明背景
const pageContainerStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  borderRadius: '16px',
  border: '1px solid rgba(255, 255, 255, 0.06)',
};

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
    setPageTab,
    setCategory,
    setSearchQuery,
    loadItems,
    startCreate,
  } = useToolboxStore();

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // Filter items based on category and search
  const filteredItems = useMemo(() => {
    let result = items;

    // Filter by category
    if (category === 'builtin') {
      result = result.filter((item) => item.type === 'builtin');
    } else if (category === 'custom') {
      result = result.filter((item) => item.type === 'custom');
    }

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
  }, [items, category, searchQuery]);

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
    <div className="h-full min-h-0 flex flex-col gap-3" style={pageContainerStyle}>
      {/* Header */}
      <div className="px-4 pt-3">
        <div className={`flex ${isMobile ? 'flex-col gap-2.5' : 'items-center justify-between'}`}>
          {/* Page Tab Switcher */}
          <div
            className="flex items-center gap-0.5 p-0.5 rounded-xl"
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            {PAGE_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setPageTab(tab.key)}
                className={`${isMobile ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} rounded-lg font-medium transition-all duration-200 flex items-center gap-1.5`}
                style={{
                  background: pageTab === tab.key
                    ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                    : 'transparent',
                  color: pageTab === tab.key ? 'white' : 'rgba(255, 255, 255, 0.6)',
                  boxShadow: pageTab === tab.key
                    ? '0 2px 10px -2px rgba(var(--accent-primary-rgb, 99, 102, 241), 0.4)'
                    : 'none',
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Actions */}
          <Button variant="primary" size="sm" onClick={startCreate} className={isMobile ? 'self-end' : ''}>
            <Plus size={13} />
            创建智能体
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="px-4">
        <div
          className={`${isMobile ? 'flex flex-col gap-2' : 'flex items-center gap-3'} px-3 py-2 rounded-xl`}
          style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid rgba(255, 255, 255, 0.05)',
          }}
        >
          {/* Category tabs + Count badge */}
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-0.5 p-0.5 rounded-lg"
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.04)',
              }}
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setCategory(opt.key)}
                  className={`${isMobile ? 'px-2 py-1' : 'px-3 py-1.5'} rounded-md text-xs font-medium transition-all duration-200 flex items-center gap-1.5 whitespace-nowrap`}
                  style={{
                    background: category === opt.key
                      ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                      : 'transparent',
                    color: category === opt.key ? 'white' : 'rgba(255, 255, 255, 0.6)',
                    boxShadow: category === opt.key
                      ? '0 2px 8px -2px rgba(var(--accent-primary-rgb, 99, 102, 241), 0.4)'
                      : 'none',
                  }}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>

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
          </div>

          {/* Search */}
          <div className={`${isMobile ? 'w-full' : 'flex-1 max-w-sm'} relative`}>
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'rgba(255, 255, 255, 0.4)' }}
            />
            <input
              type="text"
              placeholder={isMobile ? '搜索工具...' : '搜索工具名称、描述或标签...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none transition-all duration-200 focus:ring-1 focus:ring-[var(--accent-primary)]/30"
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                color: 'rgba(255, 255, 255, 0.9)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Tool Grid */}
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-3">
        {itemsLoading ? (
          <div className="flex items-center justify-center h-48">
            <div className="text-center">
              <Loader2
                size={28}
                className="animate-spin mx-auto mb-2"
                style={{ color: 'var(--accent-primary)' }}
              />
              <div className="text-xs" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                加载中...
              </div>
            </div>
          </div>
        ) : filteredItems.length === 0 ? (
          <GlassCard variant="subtle" className="flex flex-col items-center justify-center h-48 gap-3">
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
                {searchQuery ? '没有找到匹配的工具' : '暂无工具'}
              </div>
              <div className="text-xs" style={{ color: 'rgba(255, 255, 255, 0.45)' }}>
                {searchQuery ? '尝试其他关键词' : '点击右上角创建你的第一个智能体'}
              </div>
            </div>
            {category === 'custom' && !searchQuery && (
              <Button variant="primary" size="sm" onClick={startCreate}>
                <Plus size={13} />
                创建智能体
              </Button>
            )}
          </GlassCard>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
            {filteredItems.map((item) => (
              <ToolCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
