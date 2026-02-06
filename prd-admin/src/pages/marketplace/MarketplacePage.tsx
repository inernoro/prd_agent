/**
 * 统一海鲜市场页面
 *
 * 独立路由页面，支持所有配置类型的浏览和 Fork。
 * 可通过 URL 参数指定类型过滤和来源应用。
 *
 * 路由：
 *   /marketplace                    - 显示所有类型
 *   /marketplace?type=watermark     - 只显示水印
 *   /marketplace?source=visual-agent - 标识来源应用
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Search, TrendingUp, Clock, ArrowLeft, Store } from 'lucide-react';
import { MarketplaceCard } from '@/components/marketplace/MarketplaceCard';
import {
  CONFIG_TYPE_REGISTRY,
  getCategoryFilterOptions,
  mergeMarketplaceData,
  sortMarketplaceItems,
  filterMarketplaceItems,
  type MarketplaceItemBase,
} from '@/lib/marketplaceTypes';
import { toast } from '@/lib/toast';

type SortMode = 'hot' | 'new';

export const MarketplacePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // URL 参数
  const typeFromUrl = searchParams.get('type') || 'all';
  const sourceApp = searchParams.get('source') || '';

  // 状态
  const [categoryFilter, setCategoryFilter] = useState(typeFromUrl);
  const [sortBy, setSortBy] = useState<SortMode>('hot');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [dataByType, setDataByType] = useState<Record<string, MarketplaceItemBase[]>>({});
  const [forkingId, setForkingId] = useState<string | null>(null);

  // 同步 URL 参数到状态
  useEffect(() => {
    if (typeFromUrl !== categoryFilter) {
      setCategoryFilter(typeFromUrl);
    }
  }, [typeFromUrl]);

  // 更新 URL 参数
  const updateTypeFilter = (type: string) => {
    setCategoryFilter(type);
    const newParams = new URLSearchParams(searchParams);
    if (type === 'all') {
      newParams.delete('type');
    } else {
      newParams.set('type', type);
    }
    setSearchParams(newParams);
  };

  // 加载所有类型的数据
  const loadAllData = useCallback(async () => {
    setLoading(true);
    try {
      const results: Record<string, MarketplaceItemBase[]> = {};

      // 并行加载所有类型的数据
      await Promise.all(
        Object.entries(CONFIG_TYPE_REGISTRY).map(async ([typeKey, typeDef]) => {
          try {
            const res = await typeDef.api.listMarketplace({ keyword: '', sort: sortBy });
            if (res.success && res.data?.items) {
              results[typeKey] = res.data.items;
            }
          } catch (err) {
            console.error(`Failed to load ${typeKey}:`, err);
          }
        })
      );

      setDataByType(results);
    } finally {
      setLoading(false);
    }
  }, [sortBy]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // Fork 处理
  const handleFork = async (typeKey: string, id: string, customName?: string) => {
    const typeDef = CONFIG_TYPE_REGISTRY[typeKey];
    if (!typeDef) return;

    setForkingId(id);
    try {
      const res = await typeDef.api.fork({ id, name: customName });
      if (res.success) {
        toast.success('已添加到我的配置');
        // 重新加载数据以更新 forkCount
        await loadAllData();
      } else {
        toast.error('下载失败', res.error?.message || '未知错误');
      }
    } finally {
      setForkingId(null);
    }
  };

  // 处理数据
  const merged = mergeMarketplaceData(dataByType, categoryFilter);
  const sorted = sortMarketplaceItems(merged, sortBy);
  const filtered = filterMarketplaceItems(sorted, searchKeyword);

  // 类型筛选选项
  const filterOptions = getCategoryFilterOptions();

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* 顶部导航栏 */}
      <div
        className="sticky top-0 z-10 border-b backdrop-blur-xl"
        style={{
          background: 'rgba(var(--bg-primary-rgb), 0.8)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center gap-4">
            {/* 返回按钮 */}
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="p-2 rounded-lg hover:bg-white/5 transition-colors"
              style={{ color: 'var(--text-muted)' }}
              title="返回"
            >
              <ArrowLeft size={20} />
            </button>

            {/* 标题 */}
            <div className="flex items-center gap-2">
              <Store size={24} style={{ color: 'var(--text-primary)' }} />
              <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                海鲜市场
              </h1>
              {sourceApp && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(59, 130, 246, 0.15)', color: 'rgba(59, 130, 246, 0.9)' }}
                >
                  来自 {sourceApp}
                </span>
              )}
            </div>

            {/* 搜索框 */}
            <div className="flex-1 max-w-md ml-4">
              <div className="relative">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                />
                <input
                  type="text"
                  placeholder="搜索配置名称..."
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  className="w-full h-9 pl-10 pr-4 rounded-lg text-sm"
                  style={{
                    background: 'var(--input-bg)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            </div>

            {/* 排序按钮 */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSortBy('hot')}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  sortBy === 'hot' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5'
                }`}
                style={{ color: sortBy === 'hot' ? undefined : 'var(--text-muted)' }}
              >
                <TrendingUp size={14} />
                热门
              </button>
              <button
                type="button"
                onClick={() => setSortBy('new')}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  sortBy === 'new' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5'
                }`}
                style={{ color: sortBy === 'new' ? undefined : 'var(--text-muted)' }}
              >
                <Clock size={14} />
                最新
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* 类型筛选标签 */}
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          {filterOptions.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => updateTypeFilter(key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                categoryFilter === key
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'hover:bg-white/5 border border-transparent'
              }`}
              style={{ color: categoryFilter === key ? undefined : 'var(--text-muted)' }}
            >
              {Icon && <Icon size={14} />}
              {label}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Store size={48} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {searchKeyword ? '没有找到匹配的配置' : '暂无公开配置'}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((item) => (
              <MarketplaceCard
                key={`${item.type}-${item.data.id}`}
                item={item}
                onFork={handleFork}
                forking={forkingId === item.data.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default MarketplacePage;
