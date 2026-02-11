import { useEffect, useMemo, useState } from 'react';
import { Search, Sparkles, Loader2 } from 'lucide-react';
import { ToolCard } from '@/pages/ai-toolbox/components/ToolCard';
import { useToolboxStore } from '@/stores/toolboxStore';

export default function AgentLauncherPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const { items, itemsLoading, loadItems } = useToolboxStore();

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const query = searchQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  }, [items, searchQuery]);

  return (
    <div
      className="h-full min-h-0 flex flex-col"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="mx-auto w-full px-6 py-12" style={{ maxWidth: '900px' }}>
          {/* Greeting */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 mb-4">
              <Sparkles size={20} style={{ color: 'var(--accent-primary, #818CF8)' }} />
              <span
                className="text-sm font-medium"
                style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.5))' }}
              >
                AI 智能助手
              </span>
            </div>
            <h1
              className="text-2xl font-semibold tracking-tight"
              style={{ color: 'var(--text-primary, rgba(255, 255, 255, 0.95))' }}
            >
              你好，选择一个智能助手开始吧
            </h1>
          </div>

          {/* Search Input */}
          <div className="relative mb-10 mx-auto" style={{ maxWidth: '600px' }}>
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.4))' }}
            />
            <input
              type="text"
              placeholder="搜索工具或输入问题..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-12 pl-11 pr-4 rounded-xl text-sm outline-none transition-all duration-200"
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                color: 'var(--text-primary, rgba(255, 255, 255, 0.95))',
                boxShadow: '0 2px 12px -4px rgba(0, 0, 0, 0.3)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent-primary, #818CF8)';
                e.currentTarget.style.boxShadow =
                  '0 2px 12px -4px rgba(0, 0, 0, 0.3), 0 0 0 3px rgba(129, 140, 248, 0.1)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.boxShadow = '0 2px 12px -4px rgba(0, 0, 0, 0.3)';
              }}
            />
          </div>

          {/* Tool Grid */}
          {itemsLoading ? (
            <div className="flex items-center justify-center h-48">
              <div className="text-center">
                <Loader2
                  size={28}
                  className="animate-spin mx-auto mb-2"
                  style={{ color: 'var(--accent-primary)' }}
                />
                <div
                  className="text-xs"
                  style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.5))' }}
                >
                  加载中...
                </div>
              </div>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3">
              <Search size={28} style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.3))' }} />
              <div className="text-center">
                <div
                  className="text-sm font-medium mb-0.5"
                  style={{ color: 'var(--text-primary, rgba(255, 255, 255, 0.8))' }}
                >
                  没有找到匹配的工具
                </div>
                <div
                  className="text-xs"
                  style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.45))' }}
                >
                  尝试其他关键词
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {filteredItems.map((item) => (
                <ToolCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
