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
import { ArrowLeft, Clock, Hash, Search, Store, TrendingUp, UploadCloud, Zap } from 'lucide-react';
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
import { SkillOpenApiDialog } from './SkillOpenApiDialog';
import { useAuthStore } from '@/stores/authStore';
import type { MarketplaceSkillDto } from '@/services/contracts/marketplaceSkills';

type SortMode = 'hot' | 'new';

const SEARCH_FIELD_CLASS = 'prd-field h-8 w-full rounded-lg pl-9 pr-3 text-xs focus:outline-none';

export const MarketplacePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // URL 参数
  const typeFromUrl = searchParams.get('type') || 'all';
  const sourceApp = searchParams.get('source') || '';
  const currentUserId = useAuthStore((s) => s.user?.userId);

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
  const [editingSkill, setEditingSkill] = useState<MarketplaceSkillDto | null>(null);
  const [openApiOpen, setOpenApiOpen] = useState(false);

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
      className="marketplace-page relative min-h-screen overflow-auto"
      style={{
        background: marketplaceBgUrl
          ? `linear-gradient(rgba(8, 10, 16, 0.78), rgba(8, 10, 16, 0.90)), url("${marketplaceBgUrl}") center / cover no-repeat`
          : 'transparent',
      }}
    >
      <div className="relative z-10">
        <div className="surface-nav-bar marketplace-toolbar">
          <div className="surface-nav-content marketplace-toolbar-content">
            <div className="marketplace-title-group">
              {/* 返回按钮 */}
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="marketplace-icon-button"
                title="返回"
              >
                <ArrowLeft size={17} />
              </button>

              {/* 标题 */}
              <div className="marketplace-title-mark">
                <Store size={18} className="text-token-primary" />
                <h1 className="marketplace-page-title">
                  海鲜市场
                </h1>
              </div>
              {sourceApp && (
                <span className="marketplace-source-badge">
                  来自 {sourceApp}
                </span>
              )}
            </div>

            <div className="marketplace-toolbar-actions">
              {/* 搜索框 */}
              <div className="marketplace-search">
                <div className="relative">
                  <Search
                    size={15}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted"
                  />
                  <input
                    type="text"
                    placeholder="搜索配置名称..."
                    value={searchKeyword}
                    onChange={(e) => setSearchKeyword(e.target.value)}
                    className={SEARCH_FIELD_CLASS}
                  />
                </div>
              </div>

              {/* 排序按钮 */}
              <div className="marketplace-sort-group">
                <button
                  type="button"
                  onClick={() => setSortBy('hot')}
                  data-active={sortBy === 'hot'}
                  className="marketplace-nav-pill"
                >
                  <TrendingUp size={14} />
                  热门
                </button>
                <button
                  type="button"
                  onClick={() => setSortBy('new')}
                  data-active={sortBy === 'new'}
                  className="marketplace-nav-pill"
                >
                  <Clock size={14} />
                  最新
                </button>
              </div>

              {/* 接入 AI（开放接口凭据管理）：让外部 AI / Agent 可授权式调用海鲜市场 */}
              <button
                type="button"
                onClick={() => setOpenApiOpen(true)}
                className="marketplace-nav-pill"
                title="为 AI / Agent 生成长效 API Key，让它们可以浏览、下载、上传本市场的技能"
              >
                <Zap size={13} />
                接入 AI
              </button>

              {/* 上传技能按钮（常驻）：点亮 Skill Tab 场景最核心的 CTA */}
              <Button
                variant="primary"
                size="sm"
                onClick={() => setUploadOpen(true)}
                data-tour-id="marketplace-upload-skill-btn"
              >
                <UploadCloud size={13} />
                上传技能
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="relative pt-4 pb-6">
        {/* 筛选玻璃面板：类型筛选 + 技能标签筛选统一在一个液态玻璃卡里，不再悬空 */}
        <div className="surface-nav-bar marketplace-filter-bar mb-4">
          <div className="surface-nav-content marketplace-filter-content">
          {/* 类型筛选标签 */}
          <div data-tour-id="marketplace-category-tabs" className="marketplace-category-tabs">
            {filterOptions.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => updateTypeFilter(key)}
                data-active={categoryFilter === key}
                className="marketplace-nav-pill marketplace-filter-button"
              >
                {Icon && <Icon size={14} />}
                {label}
              </button>
            ))}
          </div>

          {/* 技能标签筛选栏（仅在"技能"或"全部"时出现） */}
          {showSkillControls && skillTags.length > 0 && (
            <>
              <div className="marketplace-tags-row">
                <span
                  className="marketplace-tags-label"
                >
                  <Hash size={11} />
                  技能标签
                </span>
                <button
                  type="button"
                  onClick={() => setTagFilter('')}
                  data-active={!tagFilter}
                  className="marketplace-tag-pill"
                >
                  不限
                </button>
                {skillTags.slice(0, 20).map(({ tag, count }) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTagFilter((prev) => (prev === tag ? '' : tag))}
                    data-active={tagFilter === tag}
                    className="marketplace-tag-pill"
                  >
                    #{tag}
                    <span className="ml-1 opacity-60">{count}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          </div>
        </div>

        {/* 内容区 */}
        {loading ? (
          <MapSectionLoader />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Store size={48} className="text-token-muted opacity-50" />
            <div className="text-sm text-token-muted">
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
                onEdit={(selected) => {
                  if (selected.type !== 'skill') return;
                  setEditingSkill(selected.data as MarketplaceSkillDto);
                }}
                currentUserId={currentUserId}
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

      {editingSkill && (
        <SkillUploadDialog
          editingSkill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onUploaded={() => {
            void loadAllData();
            void loadSkillTags();
          }}
        />
      )}

      {openApiOpen && <SkillOpenApiDialog onClose={() => setOpenApiOpen(false)} />}
    </div>
  );
};

export default MarketplacePage;
