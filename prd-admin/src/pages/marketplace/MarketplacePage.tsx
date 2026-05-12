/**
 * 统一海鲜市场页面 — 排行榜列表风格
 *
 * 路由：
 *   /marketplace                    - 显示所有类型
 *   /marketplace?type=skill         - 只显示技能
 *   /marketplace?source=visual-agent - 标识来源应用
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Hash,
  Search,
  Store,
  TrendingUp,
  UploadCloud,
} from 'lucide-react';
import { MarketplaceListRow } from './MarketplaceListRow';
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

const LEADERBOARD_TITLES: Record<string, string> = {
  all: 'CATALOG',
  skill: 'SKILLS LEADERBOARD',
  prompt: 'PROMPTS LEADERBOARD',
  refImage: 'STYLE IMAGES',
  watermark: 'WATERMARKS',
};

export const MarketplacePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const typeFromUrl = searchParams.get('type') || 'all';
  const sourceApp = searchParams.get('source') || '';
  const currentUserId = useAuthStore((s) => s.user?.userId);

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
  const [cmdCopied, setCmdCopied] = useState(false);

  const handleCopyHeroCmd = async () => {
    try {
      await navigator.clipboard.writeText('npx findmapskills add <skill-name>');
      setCmdCopied(true);
      setTimeout(() => setCmdCopied(false), 2500);
    } catch { /* ignore */ }
  };

  const loadHomepageAssets = useHomepageAssetsStore((s) => s.load);
  const marketplaceBgUrl = useMarketplaceBgUrl('hero');

  useEffect(() => { void loadHomepageAssets(); }, [loadHomepageAssets]);

  const loadSkillTags = useCallback(async () => {
    try {
      const res = await getMarketplaceSkillTags();
      if (res.success && res.data?.tags) setSkillTags(res.data.tags);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadSkillTags(); }, [loadSkillTags]);

  useEffect(() => {
    if (typeFromUrl !== categoryFilter) setCategoryFilter(typeFromUrl);
  }, [typeFromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateTypeFilter = (type: string) => {
    setCategoryFilter(type);
    const newParams = new URLSearchParams(searchParams);
    if (type === 'all') newParams.delete('type');
    else newParams.set('type', type);
    setSearchParams(newParams);
  };

  const loadAllData = useCallback(async () => {
    setLoading(true);
    try {
      const results: Record<string, MarketplaceItemBase[]> = {};
      await Promise.all(
        Object.entries(CONFIG_TYPE_REGISTRY).map(async ([typeKey, typeDef]) => {
          try {
            const res = await typeDef.api.listMarketplace({ keyword: '', sort: sortBy });
            if (res.success && res.data?.items) results[typeKey] = res.data.items;
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

  useEffect(() => { loadAllData(); }, [loadAllData]);

  const handleFork = async (typeKey: string, id: string, customName?: string) => {
    const typeDef = CONFIG_TYPE_REGISTRY[typeKey];
    if (!typeDef) return;
    setForkingId(id);
    try {
      const res = await typeDef.api.fork({ id, name: customName });
      if (res.success) {
        toast.success(typeKey === 'skill' ? '已开始下载技能包' : '已添加到我的配置');
        await loadAllData();
      } else {
        toast.error('下载失败', res.error?.message || '未知错误');
      }
    } finally {
      setForkingId(null);
    }
  };

  const merged = mergeMarketplaceData(dataByType, categoryFilter);
  const sorted = sortMarketplaceItems(merged, sortBy);
  const searchFiltered = filterMarketplaceItems(sorted, searchKeyword);

  const filtered = useMemo(() => {
    if (!tagFilter) return searchFiltered;
    return searchFiltered.filter((item) => {
      if (item.type !== 'skill') return true;
      const tags = (item.data as unknown as { tags?: string[] }).tags || [];
      return tags.some((t) => t === tagFilter);
    });
  }, [searchFiltered, tagFilter]);

  const showSkillControls = categoryFilter === 'skill' || categoryFilter === 'all';
  const filterOptions = getCategoryFilterOptions();
  const leaderboardTitle = LEADERBOARD_TITLES[categoryFilter] ?? 'CATALOG';

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
        {/* ── Toolbar ────────────────────────────────────────────────────── */}
        <div className="surface-nav-bar marketplace-toolbar">
          <div className="surface-nav-content marketplace-toolbar-content">
            <div className="marketplace-title-group">
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="marketplace-icon-button"
                title="返回"
              >
                <ArrowLeft size={17} />
              </button>
              <div className="marketplace-title-mark">
                <Store size={18} className="text-token-primary" />
                <h1 className="marketplace-page-title">海鲜市场</h1>
              </div>
              {sourceApp && (
                <span className="marketplace-source-badge">来自 {sourceApp}</span>
              )}
            </div>

            <div className="marketplace-toolbar-actions">
              <div className="marketplace-search">
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
                  <input
                    type="text"
                    placeholder="搜索配置名称..."
                    value={searchKeyword}
                    onChange={(e) => setSearchKeyword(e.target.value)}
                    className={SEARCH_FIELD_CLASS}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => setOpenApiOpen(true)}
                className="marketplace-nav-pill"
                title="生成 API Key，让 Claude Code / Cursor 等 AI 接入海鲜市场"
              >
                接入 AI
              </button>

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

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="mkt-hero">
        <div className="mkt-hero-try">
          <div className="mkt-hero-label">TRY IT NOW</div>
          <div className="mkt-hero-cmd-wrap">
            <span className="mkt-hero-cmd-dollar">$</span>
            <span className="mkt-hero-cmd-text">
              npx findmapskills add &lt;skill-name&gt;
            </span>
            <button
              type="button"
              className="mkt-hero-cmd-copy"
              onClick={handleCopyHeroCmd}
              title="复制命令"
            >
              {cmdCopied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        </div>
        <div className="mkt-hero-agents-section">
          <div className="mkt-hero-label">AVAILABLE FOR THESE AGENTS</div>
          <div className="mkt-hero-agents">
            <span className="mkt-hero-agent">Claude Code</span>
            <span className="mkt-hero-agent">Cursor</span>
            <span className="mkt-hero-agent">Windsurf</span>
          </div>
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="relative pb-6">

        {/* Filter bar: type tabs + skill tag chips */}
        <div className="surface-nav-bar marketplace-filter-bar">
          <div className="surface-nav-content marketplace-filter-content">
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

            {showSkillControls && skillTags.length > 0 && (
              <div className="marketplace-tags-row">
                <span className="marketplace-tags-label">
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
            )}
          </div>
        </div>

        {/* Leaderboard section */}
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
          <div className="mkt-lb-container">
            {/* Leaderboard header */}
            <div className="mkt-lb-header">
              <span className="mkt-lb-title">{leaderboardTitle}</span>
              <div className="mkt-lb-sort-tabs">
                <button
                  type="button"
                  onClick={() => setSortBy('hot')}
                  data-active={sortBy === 'hot'}
                  className="marketplace-nav-pill"
                >
                  <TrendingUp size={13} />
                  热门
                </button>
                <button
                  type="button"
                  onClick={() => setSortBy('new')}
                  data-active={sortBy === 'new'}
                  className="marketplace-nav-pill"
                >
                  <Clock size={13} />
                  最新
                </button>
              </div>
            </div>

            {/* Table head */}
            <div className="mkt-lb-table-head">
              <span className="mkt-lb-th mkt-lb-th-rank">#</span>
              <span className="mkt-lb-th mkt-lb-th-icon" />
              <span className="mkt-lb-th mkt-lb-th-skill">SKILL</span>
              <span className="mkt-lb-th mkt-lb-th-fork">FORK</span>
            </div>

            {/* Rows */}
            {filtered.map((item, idx) => (
              <MarketplaceListRow
                key={`${item.type}-${item.data.id}`}
                rank={idx + 1}
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
          onUploaded={() => { void loadAllData(); void loadSkillTags(); }}
        />
      )}

      {editingSkill && (
        <SkillUploadDialog
          editingSkill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onUploaded={() => { void loadAllData(); void loadSkillTags(); }}
        />
      )}

      {openApiOpen && <SkillOpenApiDialog onClose={() => setOpenApiOpen(false)} />}
    </div>
  );
};

export default MarketplacePage;
