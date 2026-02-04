import { useEffect, useMemo } from 'react';
import { TabBar } from '@/components/design/TabBar';
import { useToolboxStore, type ToolboxCategory } from '@/stores/toolboxStore';
import { Package, Search, Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { ToolCard } from './components/ToolCard';
import { ToolDetail } from './components/ToolDetail';
import { ToolEditor } from './components/ToolEditor';
import { ToolRunner } from './components/ToolRunner';

const CATEGORY_OPTIONS: { key: ToolboxCategory; label: string }[] = [
  { key: 'all', label: '全部工具' },
  { key: 'builtin', label: '内置工具' },
  { key: 'custom', label: '我创建的' },
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

      {/* Filters */}
      <div className="flex items-center gap-4">
        {/* Category tabs */}
        <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
          {CATEGORY_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setCategory(opt.key)}
              className="px-3 py-1.5 rounded-md text-sm transition-all"
              style={{
                background: category === opt.key ? 'var(--accent-primary)' : 'transparent',
                color: category === opt.key ? 'white' : 'var(--text-secondary)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 max-w-md relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-muted)' }}
          />
          <input
            type="text"
            placeholder="搜索工具名称、描述或标签..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg border text-sm outline-none transition-colors"
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-default)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* Count */}
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {filteredItems.length} 个工具
        </span>
      </div>

      {/* Tool Grid */}
      <div className="flex-1 min-h-0 overflow-auto">
        {itemsLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-2">
            <Package size={48} style={{ color: 'var(--text-muted)' }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {searchQuery ? '没有找到匹配的工具' : '暂无工具'}
            </div>
            {category === 'custom' && !searchQuery && (
              <Button variant="secondary" size="sm" onClick={startCreate}>
                <Plus size={14} />
                创建第一个智能体
              </Button>
            )}
          </div>
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
