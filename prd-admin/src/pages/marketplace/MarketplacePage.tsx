/**
 * 统一海鲜市场页面
 *
 * 路由：
 *   /marketplace                    - 显示技能（默认）
 *   /marketplace?type=prompt        - 只显示提示词
 *   /marketplace?source=visual-agent - 标识来源应用
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Clock, Hash, PanelTop, Rows3, Search, Store, TrendingUp, UploadCloud, Zap } from 'lucide-react';
import { MarketplaceCard } from '@/components/marketplace/MarketplaceCard';
import type { MixedMarketplaceItem } from '@/lib/marketplaceTypes';
import { QuickConnectPanel } from './QuickConnectPanel';
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
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';

type SortMode = 'hot' | 'new';
type CardDensity = 'classic' | 'short' | 'micro';
type CardDemoSkill = MarketplaceSkillDto & MarketplaceItemBase & {
  shareCount?: number;
};

const SEARCH_FIELD_CLASS = 'prd-field h-8 w-full rounded-lg pl-9 pr-3 text-xs focus:outline-none';
const CARD_DEMO_COVER =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 640 360%22%3E%3Cdefs%3E%3ClinearGradient id=%22g%22 x1=%220%22 x2=%221%22 y1=%220%22 y2=%221%22%3E%3Cstop stop-color=%22%2322c55e%22/%3E%3Cstop offset=%221%22 stop-color=%22%2365d647%22/%3E%3C/linearGradient%3E%3Cfilter id=%22b%22%3E%3CfeGaussianBlur stdDeviation=%2218%22/%3E%3C/filter%3E%3C/defs%3E%3Crect width=%22640%22 height=%22360%22 fill=%22url(%23g)%22/%3E%3Ccircle cx=%22108%22 cy=%22100%22 r=%22124%22 fill=%22%23058c45%22 opacity=%22.62%22 filter=%22url(%23b)%22/%3E%3Cpath d=%22M146 32h210c66 0 120 50 130 112h69l-70 40c-15 58-68 100-131 100H146c-76 0-138-56-138-126S70 32 146 32Z%22 fill=%22%23edf7ec%22 opacity=%22.86%22 filter=%22url(%23b)%22/%3E%3Ccircle cx=%22318%22 cy=%22386%22 r=%22192%22 fill=%22%23111827%22 opacity=%22.46%22 filter=%22url(%23b)%22/%3E%3C/svg%3E';

const CARD_DEMO_SKILLS: CardDemoSkill[] = [
  {
    id: 'demo-yuque',
    forkCount: 10,
    createdAt: '2026-07-01T10:20:00+08:00',
    updatedAt: '2026-07-01T10:20:00+08:00',
    ownerUserId: 'demo-user-1',
    ownerUserName: '蒋云峰',
    ownerUserAvatar: '',
    title: '语雀操作技能',
    version: '1.0.0',
    description: '能操作语雀获取资料和数据',
    iconEmoji: '',
    coverImageUrl: CARD_DEMO_COVER,
    previewUrl: null,
    previewSource: null,
    previewHostedSiteId: null,
    tags: ['创意', '技能'],
    zipUrl: '',
    zipSizeBytes: 0,
    originalFileName: 'yuque-skill.zip',
    hasSkillMd: true,
    downloadCount: 10,
    shareCount: 2,
    favoriteCount: 0,
    isFavoritedByCurrentUser: false,
  },
  {
    id: 'official-acceptance-checklist',
    forkCount: 8,
    createdAt: '2026-05-01T09:00:00+08:00',
    updatedAt: '2026-05-01T09:00:00+08:00',
    ownerUserId: 'official',
    ownerUserName: 'PrdAgent 官方',
    ownerUserAvatar: '',
    title: 'acceptance-checklist · 真人验收清单',
    version: '1.0.0',
    description: '生成真人逐步执行的验收清单，包含预期结果和失败排查手册。',
    iconEmoji: '',
    coverImageUrl: null,
    previewUrl: null,
    previewSource: null,
    previewHostedSiteId: null,
    tags: ['分析', '验收', '官方'],
    zipUrl: '',
    zipSizeBytes: 0,
    originalFileName: 'acceptance-checklist.zip',
    hasSkillMd: true,
    downloadCount: 8,
    shareCount: 4,
    favoriteCount: 0,
    isFavoritedByCurrentUser: false,
  },
  {
    id: 'demo-html-ppt',
    forkCount: 3,
    createdAt: '2026-06-10T09:00:00+08:00',
    updatedAt: '2026-06-10T09:00:00+08:00',
    ownerUserId: 'demo-user-2',
    ownerUserName: '魏喜胜',
    ownerUserAvatar: '',
    title: 'html-ppt-skill',
    version: '1.0.0',
    description: '基于内容做出一份 HTML 形式的 PPT，支持多主题和演讲稿模式。',
    iconEmoji: '',
    coverImageUrl: null,
    previewUrl: 'https://example.com',
    previewSource: 'external',
    previewHostedSiteId: null,
    tags: ['文档', '多风格'],
    zipUrl: '',
    zipSizeBytes: 0,
    originalFileName: 'html-ppt-skill.zip',
    hasSkillMd: true,
    downloadCount: 3,
    shareCount: 1,
    favoriteCount: 1,
    isFavoritedByCurrentUser: false,
  },
];

export const MarketplacePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const typeFromUrl = searchParams.get('type') || 'skill';
  const sourceApp = searchParams.get('source') || '';
  const cardDemoEnabled = searchParams.get('demo') === 'cards' || location.pathname === '/_dev/marketplace-card-demo';
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
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [quickConnectPos, setQuickConnectPos] = useState({ top: 0, right: 0 });
  const [cardDensity, setCardDensity] = useState<CardDensity>('short');
  const connectBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!quickConnectOpen) return;
    const close = () => setQuickConnectOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [quickConnectOpen]);

  const loadHomepageAssets = useHomepageAssetsStore((s) => s.load);
  const marketplaceBgUrl = useMarketplaceBgUrl('hero');

  useEffect(() => { void loadHomepageAssets(); }, [loadHomepageAssets]);

  const loadSkillTags = useCallback(async () => {
    if (cardDemoEnabled) {
      setSkillTags([
        { tag: '创意', count: 1 },
        { tag: '分析', count: 1 },
        { tag: '技能', count: 1 },
      ]);
      return;
    }
    try {
      const res = await getMarketplaceSkillTags();
      if (res.success && res.data?.tags) setSkillTags(res.data.tags);
    } catch { /* ignore */ }
  }, [cardDemoEnabled]);

  useEffect(() => { void loadSkillTags(); }, [loadSkillTags]);

  useEffect(() => {
    if (typeFromUrl !== categoryFilter) setCategoryFilter(typeFromUrl);
  }, [typeFromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateTypeFilter = (type: string) => {
    setCategoryFilter(type);
    setQuickConnectOpen(false);
    const newParams = new URLSearchParams(searchParams);
    if (type === 'skill') newParams.delete('type');
    else newParams.set('type', type);
    setSearchParams(newParams);
  };

  const loadAllData = useCallback(async () => {
    setLoading(true);
    if (cardDemoEnabled) {
      setDataByType({ skill: CARD_DEMO_SKILLS });
      setLoading(false);
      return;
    }
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
  }, [cardDemoEnabled, sortBy]);

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

  const showSkillControls = categoryFilter === 'skill';
  // 去掉"全部"，技能排第一
  const filterOptions = getCategoryFilterOptions().filter((o) => o.key !== 'all');

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
        {/* ── Toolbar ── */}
        <div className="surface-nav-bar marketplace-toolbar" style={{ marginBottom: 8 }}>
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
                <h1 data-tour-id="marketplace-page-title" className="marketplace-page-title">海鲜市场</h1>
              </div>
              {sourceApp && (
                <span className="marketplace-source-badge">来自 {sourceApp}</span>
              )}
            </div>

            <div className="marketplace-toolbar-actions">
              <TipsEntryButton compact />
              <div data-tour-id="marketplace-search" className="marketplace-search">
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

              <div data-tour-id="marketplace-sort" className="marketplace-sort-group">
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

              <div className="marketplace-density-group" aria-label="卡片密度">
                <button
                  type="button"
                  onClick={() => setCardDensity('classic')}
                  data-active={cardDensity === 'classic'}
                  className="marketplace-density-pill"
                  title="现版高度"
                >
                  <PanelTop size={13} />
                  现版
                </button>
                <button
                  type="button"
                  onClick={() => setCardDensity('short')}
                  data-active={cardDensity === 'short'}
                  className="marketplace-density-pill"
                  title="半高横向卡"
                >
                  <Rows3 size={13} />
                  半高
                </button>
                <button
                  type="button"
                  onClick={() => setCardDensity('micro')}
                  data-active={cardDensity === 'micro'}
                  className="marketplace-density-pill"
                  title="更矮横向卡"
                >
                  <Rows3 size={13} />
                  迷你
                </button>
              </div>

              {/* 接入AI — 技能 tab 下才显示 */}
              {categoryFilter === 'skill' && (
                <button
                  ref={connectBtnRef}
                  type="button"
                  onClick={() => {
                    if (!quickConnectOpen && connectBtnRef.current) {
                      const r = connectBtnRef.current.getBoundingClientRect();
                      setQuickConnectPos({ top: r.bottom + 8, right: window.innerWidth - r.right });
                    }
                    setQuickConnectOpen((v) => !v);
                  }}
                  className="marketplace-nav-pill"
                  data-active={quickConnectOpen ? 'true' : 'false'}
                  title="一键生成 API Key，让 Claude Code / Cursor 等 AI 接入海鲜市场"
                >
                  <Zap size={13} />
                  接入 AI
                </button>
              )}

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

        {/* ── Filter bar — 紧贴 toolbar ── */}
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
      </div>

      {/* ── 兼容 Agent 提示（findmapskills 协议适用于所有支持工具调用的 Agent） ── */}
      {categoryFilter === 'skill' && (
        <div className="marketplace-compat-banner">
          <span className="marketplace-compat-label">通过「接入 AI」一键安装到：</span>
          <span className="marketplace-compat-agent">Claude Code</span>
          <span className="marketplace-compat-dot">·</span>
          <span className="marketplace-compat-agent">Cursor</span>
          <span className="marketplace-compat-dot">·</span>
          <span className="marketplace-compat-agent">Gemini CLI</span>
          <span className="marketplace-compat-dot">·</span>
          <span className="marketplace-compat-agent">Codex</span>
          <span className="marketplace-compat-dot">·</span>
          <span className="marketplace-compat-agent-muted">任何支持 MCP / API Key 的 Agent</span>
        </div>
      )}

      {/* ── 卡片内容区 ── */}
      <div data-tour-id="marketplace-list" className="relative pt-4 pb-6 px-4">
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
          (() => {
            const renderCard = (item: MixedMarketplaceItem) => (
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
                density={cardDensity}
              />
            );
            // 官方与社区同列同序：按当前排序（热门/最新）混排，不再把官方置顶成独立「官方推荐」区。
            // 官方卡自身带「官方」徽章（MarketplaceCard.mkt-card-official）标识身份，无需单独成区。
            const gridStyle = {
              gridTemplateColumns:
                cardDensity === 'classic'
                  ? 'repeat(auto-fill, minmax(300px, 1fr))'
                  : 'repeat(auto-fill, minmax(280px, 1fr))',
              maxWidth: '1400px',
              margin: '0 auto',
            } as const;
            return (
              <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
                <div className="grid gap-4" style={gridStyle}>
                  {filtered.map(renderCard)}
                </div>
              </div>
            );
          })()
        )}
      </div>

      {quickConnectOpen && createPortal(
        <>
          {/* 点击遮罩关闭 */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
            onClick={() => setQuickConnectOpen(false)}
          />
          <div
            className="mkt-lb-qc-popover"
            style={{ position: 'fixed', top: quickConnectPos.top, right: quickConnectPos.right, left: 'auto', zIndex: 1001 }}
          >
            <QuickConnectPanel
              onClose={() => setQuickConnectOpen(false)}
              onOpenFullDialog={() => { setQuickConnectOpen(false); setOpenApiOpen(true); }}
            />
          </div>
        </>,
        document.body
      )}

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
