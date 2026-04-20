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

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Clock, Hash, Search, Store, TrendingUp, UploadCloud } from 'lucide-react';
import { MarketplaceCard } from '@/components/marketplace/MarketplaceCard';
import { Button } from '@/components/design/Button';
import {
  CONFIG_TYPE_REGISTRY,
  getCategoryFilterOptions,
  mergeMarketplaceData,
  sortMarketplaceItems,
  filterMarketplaceItems,
  type MarketplaceItemBase,
} from '@/lib/marketplaceTypes';
import { toast } from '@/lib/toast';
import { getMarketplaceSkillTags } from '@/services';
import { useHomepageAssetsStore, useMarketplaceBgUrl } from '@/stores/homepageAssetsStore';
import { SkillUploadDialog } from './SkillUploadDialog';

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
  const [tagFilter, setTagFilter] = useState<string>('');
  const [skillTags, setSkillTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [uploadOpen, setUploadOpen] = useState(false);

  // 海报背景：资源管理里上传的 `marketplace.bg.hero`，未上传走内置深海蓝渐变
  const loadHomepageAssets = useHomepageAssetsStore((s) => s.load);
  const marketplaceBgUrl = useMarketplaceBgUrl('hero');

  useEffect(() => {
    void loadHomepageAssets();
  }, [loadHomepageAssets]);

  // 拉技能标签（技能 Tab 顶部的筛选芯片）
  const loadSkillTags = useCallback(async () => {
    try {
      const res = await getMarketplaceSkillTags();
      if (res.success && res.data?.tags) {
        setSkillTags(res.data.tags);
      }
    } catch {
      // 忽略，筛选栏空也不阻断
    }
  }, []);
  useEffect(() => {
    void loadSkillTags();
  }, [loadSkillTags]);

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
        // 技能走浏览器下载 zip（已在 forkMarketplaceSkillReal 里触发）
        toast.success(typeKey === 'skill' ? '已开始下载技能包' : '已添加到我的配置');
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
  const searchFiltered = filterMarketplaceItems(sorted, searchKeyword);

  // 标签筛选：仅在 "技能" Tab 或 "全部" 视图下对 skill 类型生效
  const filtered = useMemo(() => {
    if (!tagFilter) return searchFiltered;
    return searchFiltered.filter((item) => {
      if (item.type !== 'skill') return true;
      const tags = (item.data as unknown as { tags?: string[] }).tags || [];
      return tags.some((t) => t === tagFilter);
    });
  }, [searchFiltered, tagFilter]);

  const showSkillControls = categoryFilter === 'skill' || categoryFilter === 'all';

  // 类型筛选选项
  const filterOptions = getCategoryFilterOptions();

  return (
    <div
      className="relative min-h-screen"
      style={{
        // 未上传海报 → 保持原生 var(--bg-primary)；上传了 → 铺用户的图
        background: marketplaceBgUrl
          ? `url("${marketplaceBgUrl}") center / cover no-repeat fixed, var(--bg-primary)`
          : 'var(--bg-primary)',
      }}
    >
      {/* 顶部导航栏：恢复原生半透明 */}
      <div
        className="sticky top-0 z-10 border-b backdrop-blur-xl relative"
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

            {/* 上传技能按钮（常驻）：点亮 Skill Tab 场景最核心的 CTA */}
            <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
              <UploadCloud size={13} />
              上传技能
            </Button>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="relative max-w-7xl mx-auto px-4 py-6">
        {/* 类型筛选标签 */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
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

        {/* 技能标签筛选栏（仅在"技能"或"全部"时出现） */}
        {showSkillControls && skillTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mb-6">
            <span
              className="text-[11px] mr-1 inline-flex items-center gap-1"
              style={{ color: 'var(--text-muted)' }}
            >
              <Hash size={11} />
              技能标签
            </span>
            <button
              type="button"
              onClick={() => setTagFilter('')}
              className="px-2.5 py-1 rounded-full text-[11px] transition-all"
              style={{
                background: !tagFilter ? 'rgba(56, 189, 248, 0.18)' : 'rgba(255, 255, 255, 0.04)',
                border: `1px solid ${!tagFilter ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255, 255, 255, 0.1)'}`,
                color: !tagFilter ? 'rgba(186, 230, 253, 0.98)' : 'var(--text-muted)',
              }}
            >
              不限
            </button>
            {skillTags.slice(0, 20).map(({ tag, count }) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter((prev) => (prev === tag ? '' : tag))}
                className="px-2.5 py-1 rounded-full text-[11px] transition-all"
                style={{
                  background:
                    tagFilter === tag ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255, 255, 255, 0.04)',
                  border: `1px solid ${
                    tagFilter === tag ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255, 255, 255, 0.1)'
                  }`,
                  color:
                    tagFilter === tag ? 'rgba(186, 230, 253, 0.98)' : 'var(--text-secondary)',
                }}
              >
                #{tag}
                <span className="ml-1 opacity-60">{count}</span>
              </button>
            ))}
          </div>
        )}

        {/* 内容区 */}
        {loading ? (
          <MapSectionLoader />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Store size={48} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {searchKeyword
                ? '没有找到匹配的配置'
                : tagFilter
                  ? `没有带 #${tagFilter} 的配置`
                  : categoryFilter === 'skill'
                    ? '还没有人上传技能，第一个就是你'
                    : '暂无公开配置'}
            </div>
            {categoryFilter === 'skill' && (
              <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
                <UploadCloud size={13} />
                上传第一个技能包
              </Button>
            )}
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

      {uploadOpen && (
        <SkillUploadDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            void loadAllData();
            void loadSkillTags();
          }}
        />
      )}
    </div>
  );
};

export default MarketplacePage;
