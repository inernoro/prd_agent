import { useEffect, useMemo } from 'react';
import { TabBar } from '@/components/design/TabBar';
import { GlassCard } from '@/components/design/GlassCard';
import { useToolboxStore, type ToolboxCategory } from '@/stores/toolboxStore';
import { Package, Search, Plus, Loader2, Sparkles, Boxes, User } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { ToolCard } from './components/ToolCard';
import { ToolDetail } from './components/ToolDetail';
import { ToolEditor } from './components/ToolEditor';
import { ToolRunner } from './components/ToolRunner';

const CATEGORY_OPTIONS: { key: ToolboxCategory; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: '全部', icon: <Boxes size={14} /> },
  { key: 'builtin', label: '内置工具', icon: <Sparkles size={14} /> },
  { key: 'custom', label: '我创建的', icon: <User size={14} /> },
];

export default function AiToolboxPage() {
  const {
    view,
    category,
    searchQuery,
    items,
    itemsLoading,
    selectedItem,
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

  if (view === 'create' || view === 'edit') {
    return <ToolEditor />;
  }

  if (view === 'running' && selectedItem) {
    return <ToolRunner />;
  }

  // Grid view (default)
  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title="AI 百宝箱"
        icon={<Package size={16} />}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <Button variant="primary" size="sm" onClick={startCreate}>
            <Plus size={14} />
            创建智能体
          </Button>
        }
      />

      {/* Filters - Glass style */}
      <GlassCard variant="subtle" padding="sm" className="flex items-center gap-4">
        {/* Category tabs */}
        <div
          className="flex items-center gap-1 p-1 rounded-xl"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setCategory(opt.key)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-2"
              style={{
                background: category === opt.key
                  ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                  : 'transparent',
                color: category === opt.key ? 'white' : 'var(--text-muted)',
                boxShadow: category === opt.key
                  ? '0 4px 12px -2px rgba(var(--accent-primary-rgb, 99, 102, 241), 0.4)'
                  : 'none',
              }}
            >
              {opt.icon}
              {opt.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 max-w-md relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-muted)' }}
          />
          <input
            type="text"
            placeholder="搜索工具名称、描述或标签..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm outline-none transition-all duration-200 focus:ring-2 focus:ring-[var(--accent-primary)]/30"
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* Count badge */}
        <div
          className="px-3 py-1.5 rounded-full text-xs font-medium"
          style={{
            background: 'rgba(255, 255, 255, 0.05)',
            color: 'var(--text-muted)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          {filteredItems.length} 个工具
        </div>
      </GlassCard>

      {/* Tool Grid */}
      <div className="flex-1 min-h-0 overflow-auto">
        {itemsLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <Loader2
                size={32}
                className="animate-spin mx-auto mb-3"
                style={{ color: 'var(--accent-primary)' }}
              />
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                加载中...
              </div>
            </div>
          </div>
        ) : filteredItems.length === 0 ? (
          <GlassCard variant="subtle" className="flex flex-col items-center justify-center h-64 gap-4">
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center"
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
              <Package size={40} style={{ color: 'var(--text-muted)' }} />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                {searchQuery ? '没有找到匹配的工具' : '暂无工具'}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {searchQuery ? '尝试其他关键词' : '点击右上角创建你的第一个智能体'}
              </div>
            </div>
            {category === 'custom' && !searchQuery && (
              <Button variant="primary" size="sm" onClick={startCreate}>
                <Plus size={14} />
                创建智能体
              </Button>
            )}
          </GlassCard>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 pb-4">
            {filteredItems.map((item) => (
              <ToolCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
