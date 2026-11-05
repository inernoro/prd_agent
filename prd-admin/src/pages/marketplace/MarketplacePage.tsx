/**
 * 统一海鲜市场页面
 *
 * 路由：
 *   /marketplace                    - 显示技能（默认）
 *   /marketplace?type=prompt        - 只显示提示词
 *   /marketplace?source=visual-agent - 标识来源应用
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useSmartBack } from '@/hooks/useSmartBack';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useSearchParams, useLocation } from 'react-router-dom';
import { ArrowLeft, Grid2X2, Search, Store, UploadCloud, Zap } from 'lucide-react';
import { MarketplaceCard } from '@/components/marketplace/MarketplaceCard';
import { QuickConnectPanel } from './QuickConnectPanel';
import { Button } from '@/components/design/Button';
import {
  CONFIG_TYPE_REGISTRY,
  mergeMarketplaceData,
  sortMarketplaceItems,
  filterMarketplaceItems,
  type MarketplaceItemBase,
} from '@/lib/marketplaceTypes';
import { toast } from '@/lib/toast';
import { getMarketplaceSkillTags, listMarketplaceSkills } from '@/services';
import { useHomepageAssetsStore } from '@/stores/homepageAssetsStore';
import { SkillUploadDialog } from './SkillUploadDialog';
import { SkillOpenApiDialog } from './SkillOpenApiDialog';
import { fetchOfficialSkillRoleLabels, type OfficialSkillRoleLabels } from './skillOpenApi/downloadOfficialSkill';
import { useAuthStore } from '@/stores/authStore';
import type { MarketplaceSkillDto, MarketplaceSkillScope } from '@/services/contracts/marketplaceSkills';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { ToolbarPopover } from '@/components/design/ToolbarPopover';
import { ListDisplayOptions } from '@/components/design/ListDisplayOptions';
import { useListDisplayPreferences } from '@/hooks/useListDisplayPreferences';
import { MarketplaceFilters } from './MarketplaceFilters';
import { MARKETPLACE_CARD_SIZES, MARKETPLACE_VIEWS, MARKETPLACE_SORT_OPTIONS, MARKETPLACE_CARD_SIZE_OPTIONS } from './marketplaceLayout';
import './marketplace.css';

type CardDemoSkill = MarketplaceSkillDto & MarketplaceItemBase & {
  shareCount?: number;
};

type MarketplaceSnapshot = {
  scope: MarketplaceSkillScope | null;
  viewerId: string | undefined;
  byType: Record<string, MarketplaceItemBase[]>;
};
const EMPTY_MARKETPLACE_DATA: Record<string, MarketplaceItemBase[]> = {};

function applyFavoritePatch(items: MarketplaceItemBase[], updated: MarketplaceSkillDto, scope: MarketplaceSkillScope | null) {
  // 收藏确认可能晚于范围切换；完整服务端 DTO 让刷新失败时也能保留刚确认的新成员。
  if (scope === 'favorites' && updated.isFavoritedByCurrentUser && !items.some(item => item.id === updated.id)) {
    return [...items, { ...updated, ownerUserAvatar: updated.ownerUserAvatar ?? undefined }];
  }
  return items.flatMap<MarketplaceItemBase>(item =>
    item.id !== updated.id ? [item] : scope === 'favorites' && !updated.isFavoritedByCurrentUser ? [] : [{
      ...item, favoriteCount: updated.favoriteCount, isFavoritedByCurrentUser: updated.isFavoritedByCurrentUser,
    }]);
}

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
  // 智能返回：弹栈回真正的上一页；深链直达无历史时兜底回首页
  const goBack = useSmartBack('/');
  const location = useLocation();

  const typeFromUrl = searchParams.get('type') || 'skill';
  const scopeParam = searchParams.get('scope');
  const scope: MarketplaceSkillScope = typeFromUrl === 'skill' && (scopeParam === 'favorites' || scopeParam === 'mine') ? scopeParam : 'all';
  const sourceApp = searchParams.get('source') || '';
  const cardDemoEnabled = searchParams.get('demo') === 'cards' || location.pathname === '/_dev/marketplace-card-demo';
  const currentUserId = useAuthStore((s) => s.user?.userId);

  const [categoryFilter, setCategoryFilter] = useState(typeFromUrl);
  const { sort: sortBy, setSort: setSortBy, cardSize, setCardSize } = useListDisplayPreferences({
    sortKey: 'marketplace.pref.sort', cardSizeKey: 'marketplace.pref.cardSize',
    sortOptions: MARKETPLACE_SORT_OPTIONS, cardSizeOptions: MARKETPLACE_CARD_SIZE_OPTIONS,
    defaultSort: 'hot', defaultCardSize: 'medium',
  });
  const [searchKeyword, setSearchKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const loadRequestRef = useRef(0);
  const latestLoadRef = useRef<{ viewerId: string | undefined; hasSkillSnapshot: boolean; load: (background?: boolean) => Promise<void> } | null>(null);
  const [snapshot, setSnapshot] = useState<MarketplaceSnapshot>({ scope: null, viewerId: currentUserId, byType: {} });
  const snapshotMatches = snapshot.scope === scope && snapshot.viewerId === currentUserId;
  const hasSkillSnapshot = snapshotMatches && Array.isArray(snapshot.byType.skill);
  // 网格、标签和角色共同读取匹配当前范围与账号的快照，切换时不暴露旧筛选数据。
  const dataByType = snapshotMatches ? snapshot.byType : EMPTY_MARKETPLACE_DATA;
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string>('');
  const [skillTags, setSkillTags] = useState<Array<{ tag: string; count: number }>>([]);
  // 角色入口：让「我是产品经理」的人一键筛出该角色的套装 + 技能，
  // 不用从二十张按功能分类的卡里自己猜哪几张跟自己有关
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [roleLabels, setRoleLabels] = useState<OfficialSkillRoleLabels>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<MarketplaceSkillDto | null>(null);
  const [openApiOpen, setOpenApiOpen] = useState(searchParams.get('dialog') === 'open-api');
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [toolbarPanel, setToolbarPanel] = useState<'display' | 'filters' | null>(null);
  const connectBtnRef = useRef<HTMLButtonElement>(null);
  // 手机端密度（.claude/rules/mobile-first-density.md）：
  // 搜索独占一行，筛选收进弹层，接入 AI / 上传保留紧凑入口。
  const isMobile = useIsMobile();

  useEffect(() => {
    if (searchParams.get('dialog') === 'open-api') setOpenApiOpen(true);
  }, [searchParams]);

  const closeOpenApi = useCallback(() => {
    setOpenApiOpen(false);
    if (searchParams.get('dialog') !== 'open-api') return;
    const next = new URLSearchParams(searchParams);
    next.delete('dialog');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const loadHomepageAssets = useHomepageAssetsStore((s) => s.load);

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
    let active = true;
    void fetchOfficialSkillRoleLabels().then(labels => { if (active) setRoleLabels(labels); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (typeFromUrl !== categoryFilter) setCategoryFilter(typeFromUrl);
  }, [typeFromUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateTypeFilter = (type: string) => {
    setCategoryFilter(type);
    setQuickConnectOpen(false);
    const newParams = new URLSearchParams(searchParams);
    if (type === 'skill') newParams.delete('type');
    else newParams.set('type', type);
    if (type !== 'skill') newParams.delete('scope');
    // 筛选切换用 replace：不堆 history，浏览器/手势返回直接回上一页而非上一个筛选态
    setSearchParams(newParams, { replace: true });
  };

  const updateScope = (view: MarketplaceSkillScope) => {
    const next = new URLSearchParams(searchParams);
    if (view === 'all') next.delete('scope');
    else { next.set('scope', view); next.delete('type'); setCategoryFilter('skill'); }
    setSearchKeyword(''); setTagFilter(''); setRoleFilter('');
    setToolbarPanel(null); setQuickConnectOpen(false);
    setSearchParams(next, { replace: true });
  };

  const loadAllData = useCallback(async (background = false) => {
    const requestId = ++loadRequestRef.current;
    if (!background) setLoading(true);
    setLoadError('');
    if (cardDemoEnabled) {
      setSnapshot({ scope, viewerId: currentUserId, byType: { skill: CARD_DEMO_SKILLS.filter(item => scope === 'all' || (scope === 'mine' ? item.ownerUserId === currentUserId : item.isFavoritedByCurrentUser)) } });
      setLoading(false);
      return;
    }
    try {
      const results: Record<string, MarketplaceItemBase[]> = {};
      let personalError = '';
      let requestFailed = false;
      await Promise.all(
        Object.entries(CONFIG_TYPE_REGISTRY).map(async ([typeKey, typeDef]) => {
          if ((scope !== 'all' || background) && typeKey !== 'skill') return;
          try {
            const res = scope === 'all'
              ? await typeDef.api.listMarketplace({ keyword: '', sort: sortBy })
              : await listMarketplaceSkills({ sort: sortBy, scope });
            if (res.success && res.data?.items) results[typeKey] = res.data.items;
            else {
              requestFailed = true;
              if (scope !== 'all') personalError = res.error?.message || '个人技能加载失败，请重试';
            }
          } catch (err) {
            requestFailed = true;
            console.error(`Failed to load ${typeKey}:`, err);
            if (scope !== 'all') personalError = '个人技能加载失败，请重试';
          }
        })
      );
      if (requestId === loadRequestRef.current) {
        setSnapshot(previous => ({
          scope, viewerId: currentUserId,
          byType: background && previous.scope === scope && previous.viewerId === currentUserId
            ? { ...previous.byType, ...results } : results,
        }));
        setLoadError(background ? '' : personalError);
        if (background && requestFailed) toast.error('列表刷新失败', '收藏已更新，已保留当前内容，请稍后刷新页面');
      }
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [cardDemoEnabled, sortBy, scope, currentUserId]);

  useLayoutEffect(() => {
    latestLoadRef.current = { viewerId: currentUserId, hasSkillSnapshot, load: loadAllData };
  }, [currentUserId, hasSkillSnapshot, loadAllData]);
  useEffect(() => { loadAllData(); }, [loadAllData]);

  const refreshCurrentList = (background = false) => {
    const latest = latestLoadRef.current;
    if (latest && latest.viewerId === currentUserId) return latest.load(background && latest.hasSkillSnapshot);
  };

  const handleFavoriteChange = (updated: MarketplaceSkillDto) => {
    // 依据当前快照的范围立即回写，再以确认后的当前查询淘汰所有更早的列表响应。
    setSnapshot(previous => previous.viewerId !== currentUserId ? previous : {
      ...previous, byType: { ...previous.byType, skill: applyFavoritePatch(previous.byType.skill || [], updated, previous.scope) },
    });
    void refreshCurrentList(true);
  };

  const viewLoading = loading || !snapshotMatches;

  const handleFork = async (typeKey: string, id: string, customName?: string) => {
    const typeDef = CONFIG_TYPE_REGISTRY[typeKey];
    if (!typeDef) return;
    setForkingId(id);
    try {
      const res = await typeDef.api.fork({ id, name: customName });
      if (res.success) {
        toast.success(typeKey === 'skill' ? '已开始下载技能包' : '已添加到我的配置');
        await refreshCurrentList();
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
    let list = searchFiltered;
    if (tagFilter) {
      list = list.filter((item) => {
        if (item.type !== 'skill') return true;
        const tags = (item.data as unknown as { tags?: string[] }).tags || [];
        return tags.some((t) => t === tagFilter);
      });
    }
    if (roleFilter) {
      // 只有官方条目带 roles；用户上传的技能没有角色归属，
      // 选了角色就不该混进来（否则「产品经理」筛出一堆无关技能，等于没筛）
      list = list.filter((item) => {
        if (item.type !== 'skill') return true;
        const roles = (item.data as unknown as { roles?: string[] }).roles || [];
        return roles.includes(roleFilter);
      });
    }
    return list;
  }, [searchFiltered, tagFilter, roleFilter]);

  const roleEntries = useMemo(() => Object.entries(roleLabels).filter(([key]) =>
    scope === 'all' || ((dataByType.skill || []) as MarketplaceSkillDto[]).some(item => item.roles?.includes(key))),
  [roleLabels, scope, dataByType.skill]);
  const categoryLabel = CONFIG_TYPE_REGISTRY[categoryFilter]?.label ?? '配置';
  const hasFilters = Boolean(searchKeyword || (categoryFilter === 'skill' && (tagFilter || roleFilter)));
  const filterCount = (categoryFilter === 'skill' ? Number(Boolean(tagFilter)) + Number(Boolean(roleFilter)) : 1);
  const viewTags = useMemo(() => {
    if (scope === 'all') return skillTags;
    const counts = new Map<string, number>();
    for (const item of (dataByType.skill || []) as MarketplaceSkillDto[]) {
      for (const tag of new Set(item.tags || [])) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [scope, skillTags, dataByType.skill]);
  const filters = (
    <MarketplaceFilters category={categoryFilter} onCategoryChange={updateTypeFilter}
      categoryTourAnchor={!isMobile}
      roles={roleEntries} role={roleFilter} onRoleChange={setRoleFilter}
      tags={viewTags} tag={tagFilter} onTagChange={setTagFilter} />
  );

  // 搜索框（桌面在工具条内、手机独占一行），只渲染其中一处，tour 锚点不重复
  const searchField = (
    <div className="relative">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
      <input
        type="text"
        placeholder="搜索名称、描述"
        value={searchKeyword}
        onChange={(e) => setSearchKeyword(e.target.value)}
        className={SEARCH_FIELD_CLASS}
      />
    </div>
  );

  return (
    <div className="marketplace-page marketplace-workspace h-full min-h-0 flex flex-col" data-card-size={cardSize}>
      <header className="marketplace-module-header">
        <div className="marketplace-title-group">
          <button type="button" onClick={goBack} className="marketplace-icon-button" aria-label="返回" title="返回">
            <ArrowLeft size={17} />
          </button>
          <div className="marketplace-title-mark">
            <Store size={18} />
            <h1 data-tour-id="marketplace-page-title" className="marketplace-page-title">海鲜市场</h1>
          </div>
          {sourceApp && <span className="marketplace-source-badge">来自 {sourceApp}</span>}
        </div>
        <TipsEntryButton compact />
      </header>
      <nav className="marketplace-scope-tabs" aria-label="市场范围">
        {(Object.keys(MARKETPLACE_VIEWS) as MarketplaceSkillScope[]).map(view => (
          <button key={view} type="button" aria-current={scope === view ? 'page' : undefined} data-active={scope === view}
            onClick={() => updateScope(view)}>{MARKETPLACE_VIEWS[view].label}</button>
        ))}
      </nav>
      <div className="marketplace-workspace-body">
        {!isMobile && <aside className="marketplace-filter-rail" aria-label="筛选技能与配置">{filters}</aside>}
        <section className="marketplace-results" aria-label="市场内容">
          <div className="marketplace-workspace-toolbar">
            <div data-tour-id="marketplace-search" className="marketplace-workspace-search">{searchField}</div>
            {!isMobile && <span className="marketplace-view-label"><Grid2X2 size={14} />平铺</span>}
            <ToolbarPopover label="显示" summary={`${sortBy === 'hot' ? '热门' : '最新'} · ${MARKETPLACE_CARD_SIZES[cardSize].label}`}
              open={toolbarPanel === 'display'} onOpenChange={open => { setToolbarPanel(open ? 'display' : null); setQuickConnectOpen(false); }}
              tourId="marketplace-sort">
              <ListDisplayOptions sortOptions={MARKETPLACE_SORT_OPTIONS} sort={sortBy} onSortChange={setSortBy}
                cardSizeOptions={MARKETPLACE_CARD_SIZE_OPTIONS} cardSize={cardSize} onCardSizeChange={setCardSize}
                rememberPreferences />
            </ToolbarPopover>
            {isMobile && (
              <div className="shrink-0" data-tour-id="marketplace-category-tabs">
                <ToolbarPopover label="筛选" count={filterCount} open={toolbarPanel === 'filters'}
                  onOpenChange={open => { setToolbarPanel(open ? 'filters' : null); setQuickConnectOpen(false); }}
                  tourId="marketplace-mobile-filters">
                  {filters}
                </ToolbarPopover>
              </div>
            )}
            <div className="marketplace-primary-actions">
              {categoryFilter === 'skill' && (
                <button ref={connectBtnRef} type="button" className="marketplace-nav-pill marketplace-connect-button"
                  data-active={quickConnectOpen} aria-expanded={quickConnectOpen} aria-label="接入 AI"
                  onClick={() => { setQuickConnectOpen(open => !open); setToolbarPanel(null); }}>
                  <Zap size={14} />{!isMobile && '接入 AI'}
                </button>
              )}
              <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}
                data-tour-id="marketplace-upload-skill-btn" aria-label="上传技能" title="上传技能">
                <UploadCloud size={14} />{!isMobile && '上传技能'}
              </Button>
            </div>
          </div>
          <div className="marketplace-results-scroll" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            <div className="marketplace-results-heading">
              <h2>{scope !== 'all' ? MARKETPLACE_VIEWS[scope].label : hasFilters ? `筛选${categoryLabel}` : `全部${categoryLabel}`}</h2>
              <span role="status">{viewLoading ? '正在加载…' : loadError ? '加载失败' : `${filtered.length} 项`}</span>
              {hasFilters && (
                <button type="button" className="marketplace-clear-filters" onClick={() => { setSearchKeyword(''); setTagFilter(''); setRoleFilter(''); }}>
                  清空筛选
                </button>
              )}
            </div>
            <div data-tour-id="marketplace-list">
              {viewLoading ? <MapSectionLoader /> : loadError ? (
                <div className="marketplace-empty" role="alert"><p>{loadError}</p><Button size="sm" onClick={() => void loadAllData()}>重试</Button></div>
              ) : filtered.length === 0 ? (
                <div className="marketplace-empty">
                  <Store size={40} strokeWidth={1.5} />
                  <p>{searchKeyword ? '没有找到匹配的配置' : categoryFilter === 'skill' && roleFilter ? `还没有面向「${roleLabels[roleFilter] ?? roleFilter}」的技能`
                    : categoryFilter === 'skill' && tagFilter ? `没有带 #${tagFilter} 的配置` : scope !== 'all' ? MARKETPLACE_VIEWS[scope].empty : categoryFilter === 'skill' ? '还没有人上传技能，第一个就是你' : '暂无公开配置'}</p>
                  {categoryFilter === 'skill' && scope !== 'favorites' && <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
                    <UploadCloud size={14} />上传第一个技能包
                  </Button>}
                </div>
              ) : (
                <div className="marketplace-tile-grid" style={{ ['--marketplace-card-min' as string]: `${MARKETPLACE_CARD_SIZES[cardSize].minWidth}px` }}>
                  {filtered.map(item => (
                    <MarketplaceCard key={`${item.type}-${item.data.id}`} item={item} onFork={handleFork}
                      onEdit={selected => { if (selected.type === 'skill') setEditingSkill(selected.data as MarketplaceSkillDto); }}
                      currentUserId={currentUserId} forking={forkingId === item.data.id} density="tile" onFavoriteChange={handleFavoriteChange} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
      <AnchoredMenu open={quickConnectOpen} onClose={() => setQuickConnectOpen(false)} anchorRef={connectBtnRef}
        minWidth={340} className="marketplace-quick-connect" style={{ padding: 0 }}>
        <QuickConnectPanel onClose={() => setQuickConnectOpen(false)}
          onOpenFullDialog={() => { setQuickConnectOpen(false); setOpenApiOpen(true); }} />
      </AnchoredMenu>

      {uploadOpen && (
        <SkillUploadDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => { void refreshCurrentList(); void loadSkillTags(); }}
        />
      )}

      {editingSkill && (
        <SkillUploadDialog
          editingSkill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onUploaded={() => { void refreshCurrentList(); void loadSkillTags(); }}
        />
      )}

      {openApiOpen && <SkillOpenApiDialog onClose={closeOpenApi} />}
    </div>
  );
};

export default MarketplacePage;
