import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  ArrowRight,
  FileText,
  Palette,
  PenTool,
  Bug,
  Video,
  Swords,
  FileBarChart,
  Code2,
  Languages,
  FileSearch,
  BarChart3,
  Bot,
  Store,
  Library,
  Sparkles,
  Sparkle,
  Workflow,
  Zap,
  Globe,
  ClipboardCheck,
  ScanSearch,
  Wand2,
  FlaskConical,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useAuthStore } from '@/stores/authStore';
import { useChangelogStore, selectUnreadCount } from '@/stores/changelogStore';
import { useHomepageAssetsStore, useAgentImageUrl, useAgentVideoUrl, useHeroBgUrl } from '@/stores/homepageAssetsStore';
import { buildDefaultCoverUrl, buildDefaultVideoUrl, buildDefaultHeroUrl } from '@/lib/homepageAssetSlots';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { ToolboxItem } from '@/services';
import { ShowcaseGallery } from '@/components/showcase/ShowcaseGallery';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { ReviewAgentCardArt } from '@/pages/ai-toolbox/components/ReviewAgentCardArt';
import { HomeAmbientBackdrop } from '@/components/effects/HomeAmbientBackdrop';
import { Reveal } from '@/pages/home/components/Reveal';

/**
 * 进场动效节奏 —— 与 /home LandingPage 同款 Reveal 组件，duration 减半（1000ms）让整体速度翻倍。
 *
 * 时序曲线：
 *   Hero 核心元素 (0-150ms) → Quick Links (200-350ms) → Agents (430ms + 35ms cascade)
 *   → Utilities (800ms + 25ms cascade) → Showcase (滚动到视口时触发)
 *
 * 首屏所有 Reveal 都在视口内，useInView 在 mount 时立即 fire；
 * Showcase 在 fold 下方，滚动到视口时才触发，不浪费动画预算。
 */
const REVEAL_DURATION = 1000; // /home 默认 2000 的一半
const REVEAL = {
  heroEyebrow: 0,
  heroTitle: 50,
  heroSubtitle: 100,
  heroSearch: 150,
  quickLinkBase: 200,
  quickLinkStep: 50,
  agentsHeader: 430,
  agentsCardBase: 470,
  agentsCardStep: 35,
  utilitiesHeader: 800,
  utilitiesCardBase: 840,
  utilitiesCardStep: 25,
  showcaseHeader: 970, // 仅当首屏即可见时生效；滚动触发走 IntersectionObserver
};

// ── Icon & Color mapping (self-contained, doesn't touch ToolCard) ──

const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Video, Swords, FileBarChart, Code2, Languages, FileSearch, BarChart3, Bot, Workflow, Zap, Globe, ClipboardCheck, ScanSearch, Wand2,
  // 迁移自用户菜单的管理工具
  FlaskConical, ScrollText, Sparkle, Sparkles, Library, Store,
};

// Agent 封面图/视频默认 CDN 路径由 `lib/homepageAssetSlots.ts` 统一维护
// （AGENT_COVER_DEFAULTS / AGENT_VIDEO_DEFAULTS），本文件通过 buildDefault*Url 间接消费。

/** 每个图标对应的主题色 */
const ACCENT: Record<string, { from: string; to: string }> = {
  FileText:  { from: '#3B82F6', to: '#60A5FA' },
  Palette:   { from: '#A855F7', to: '#C084FC' },
  PenTool:   { from: '#10B981', to: '#34D399' },
  Bug:       { from: '#F97316', to: '#FB923C' },
  Video:     { from: '#F43F5E', to: '#FB7185' },
  Swords:    { from: '#F59E0B', to: '#FBBF24' },
  Code2:     { from: '#10B981', to: '#6EE7B7' },
  Languages: { from: '#06B6D4', to: '#67E8F9' },
  FileSearch:{ from: '#EAB308', to: '#FDE68A' },
  BarChart3: { from: '#8B5CF6', to: '#C4B5FD' },
  Bot:       { from: '#6366F1', to: '#A5B4FC' },
  FileBarChart: { from: '#6366F1', to: '#818CF8' },
  Workflow:  { from: '#14B8A6', to: '#5EEAD4' },
  Zap:       { from: '#F59E0B', to: '#FCD34D' },
  Globe:     { from: '#0EA5E9', to: '#38BDF8' },
  ClipboardCheck: { from: '#6366F1', to: '#A5B4FC' },
  ScanSearch: { from: '#8B5CF6', to: '#C4B5FD' },
  Wand2:     { from: '#8B5CF6', to: '#C4B5FD' },
  FlaskConical: { from: '#0EA5E9', to: '#7DD3FC' },
  ScrollText: { from: '#64748B', to: '#94A3B8' },
  Sparkle:   { from: '#A855F7', to: '#D8B4FE' },
  Sparkles:  { from: '#FBBF24', to: '#FCD34D' },
  Library:   { from: '#3B82F6', to: '#60A5FA' },
  Store:     { from: '#F59E0B', to: '#FB923C' },
};

function getAccent(icon: string) {
  return ACCENT[icon] ?? { from: '#6366F1', to: '#A5B4FC' };
}

/** 默认 CDN 封面（非 hook 版本，FeaturedCard 内部用；cdnBase 从 authStore 快照取） */
function getDefaultCoverUrl(agentKey?: string): string | null {
  return buildDefaultCoverUrl(useAuthStore.getState().cdnBaseUrl ?? '', agentKey);
}

function getDefaultVideoUrl(agentKey?: string): string | null {
  return buildDefaultVideoUrl(useAuthStore.getState().cdnBaseUrl ?? '', agentKey);
}

// Hero banner 背景（上传后优先用上传的；否则回退 icon/title/home.png）
// 由 `useHeroBgUrl('home')` + `buildDefaultHeroUrl` 组合消费，不再需要此函数。

function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] || Bot;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

type HomeQuickLink = {
  /** 可选 id，配合页面内的徽章逻辑（如 updates 显示未读数） */
  id?: 'marketplace' | 'library' | 'showcase' | 'updates';
  icon: LucideIcon;
  label: string;
  desc: string;
  path: string;
  accent: string;
  gradient: string;
  /** 管理员上传的背景图 URL（优先级高于 gradient，渲染时作为背景图铺满卡片） */
  backgroundUrl?: string;
};

/**
 * 首页顶部四张快捷卡（MAP Primary Gateways）。
 *
 * 设计约束：
 * - 4 张卡同宽，响应式自适应
 * - 每张卡一个主色（accent）+ 渐变（gradient），源自 /home Hero 的
 *   retro-futurism 色谱（青/橙/蓝/紫/琥珀），保证既显眼又和页面整体和谐
 * - 「更新中心」带未读徽章，通过 `id==='updates'` 触发
 */
const QUICK_LINKS_BASE: HomeQuickLink[] = [
  { id: 'marketplace', icon: Store, label: '海鲜市场', desc: '发现和 Fork 优质提示词与配置', path: '/marketplace', accent: '#F59E0B', gradient: 'linear-gradient(135deg, #F59E0B, #F97316)' },
  { id: 'library', icon: Library, label: '智识殿堂', desc: '探索社区共享的知识库', path: '/library', accent: '#3B82F6', gradient: 'linear-gradient(135deg, #3B82F6, #6366F1)' },
  { id: 'showcase', icon: Sparkles, label: '作品广场', desc: '探索 AI 驱动的创意作品与灵感', path: '/showcase', accent: '#A855F7', gradient: 'linear-gradient(135deg, #A855F7, #6366F1)' },
  { id: 'updates', icon: Sparkles, label: '更新中心', desc: '代码级周报 · 本周仓库变更速览', path: '/changelog', accent: '#FBBF24', gradient: 'linear-gradient(135deg, #FBBF24, #F97316)' },
];

/** /home Hero 同款色谱（青 → 紫 → 玫红），用于首页顶部装饰与重点强调 */
const MAP_ACCENT_GRADIENT = 'linear-gradient(135deg, #00f0ff 0%, #7c3aed 50%, #f43f5e 100%)';

function dedupeToolboxItems(items: ToolboxItem[]): ToolboxItem[] {
  const seen = new Set<string>();
  const deduped: ToolboxItem[] = [];
  for (const item of items) {
    const identity =
      item.agentKey?.trim()
        ? `agent:${item.agentKey}`
        : item.routePath?.trim()
          ? `route:${item.routePath}`
          : `id:${item.id}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    deduped.push(item);
  }
  return deduped;
}

// ── Featured Agent Card (large, with cover image) ──

function FeaturedCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  // 订阅 store：上传后 store 刷新即触发重渲染；未上传时 fallback 到 CDN 默认路径
  const uploadedCover = useAgentImageUrl(item.agentKey);
  const uploadedVideo = useAgentVideoUrl(item.agentKey);
  const coverUrl = uploadedCover ?? getDefaultCoverUrl(item.agentKey);
  const videoUrl = uploadedVideo ?? getDefaultVideoUrl(item.agentKey);
  const [coverFailed, setCoverFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [hovering, setHovering] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const Icon = getIcon(item.icon);

  const handleMouseEnter = () => {
    setHovering(true);
    if (videoRef.current && videoReady) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setHovering(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group relative w-full text-left rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1"
      style={{
        background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid rgba(255,255,255,0.06)',
        height: 200,
      }}
    >
      {/* Cover visual: inline art / CDN image / gradient fallback */}
      {item.agentKey === 'review-agent' ? (
        <ReviewAgentCardArt />
      ) : coverUrl && !coverFailed ? (
        <>
          <img
            src={coverUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            draggable={false}
            onError={() => setCoverFailed(true)}
          />
          {videoUrl && (
            <video
              ref={videoRef}
              src={videoUrl}
              muted
              loop
              playsInline
              preload="metadata"
              onCanPlayThrough={() => setVideoReady(true)}
              className="absolute inset-0 w-full h-full object-cover transition-opacity duration-500"
              style={{ opacity: hovering && videoReady ? 1 : 0 }}
            />
          )}
        </>
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(ellipse at 70% 20%, ${accent.from}18 0%, transparent 60%),
              radial-gradient(ellipse at 20% 80%, ${accent.from}10 0%, transparent 50%)
            `,
          }}
        />
      )}

      {/* Subtle fade to blend image with glass panel */}
      <div
        className="absolute inset-0 pointer-events-none z-[2]"
        style={{
          background: 'linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.7) 100%)',
        }}
      />

      {/* Hover border glow */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none flex z-[20]"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.from}40, 0 0 20px ${accent.from}10` }}
      />

      {/* Content — Unified Glassmorphism Panel */}
      <div 
        className="absolute bottom-0 left-0 right-0 p-5 z-[10] transition-all duration-300 border-t"
        style={{ 
          borderColor: 'rgba(255,255,255,0.06)',
          background: 'var(--card-glass-bg, rgba(16,16,24,0.45))',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)'
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-105"
            style={{
              background: `linear-gradient(135deg, ${accent.from}40, ${accent.from}15)`,
              border: `1px solid ${accent.from}40`,
              boxShadow: `0 8px 24px -10px ${accent.from}60`
            }}
          >
            <Icon size={20} style={{ color: accent.to }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3
                className="text-[15px] font-semibold truncate transition-colors"
                style={{ color: '#fff', textShadow: '0 2px 4px rgba(0,0,0,0.4)' }}
              >
                {item.name}
              </h3>
              <ArrowRight
                size={14}
                className="shrink-0 opacity-0 group-hover:opacity-80 transition-all duration-200 group-hover:translate-x-0.5"
                style={{ color: accent.to }}
              />
            </div>
            <p
              className="text-[12px] leading-relaxed mt-1 line-clamp-2"
              style={{ color: 'rgba(255,255,255,0.7)', textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
            >
              {item.description}
            </p>
            {item.tags.length > 0 && (
              <div className="flex gap-1.5 mt-2.5">
                {item.tags.slice(0, 3).map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 rounded-[5px]"
                    style={{
                      background: 'rgba(255,255,255,0.08)',
                      color: 'rgba(255,255,255,0.7)',
                      border: '1px solid rgba(255,255,255,0.05)',
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// ── Compact Agent Card (smaller, for utility agents) ──

function CompactCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const Icon = getIcon(item.icon);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative w-full text-left rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5 flex items-center gap-3.5 px-4 py-3.5"
      style={{
        background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Hover glow */}
      <div
        className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.from}30` }}
      />

      <div
        className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
        style={{
          background: `linear-gradient(135deg, ${accent.from}20, ${accent.from}08)`,
          border: `1px solid ${accent.from}20`,
        }}
      >
        <Icon size={18} style={{ color: accent.to }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary, #fff)' }}>
          {item.name}
        </div>
        <div
          className="text-[11px] truncate mt-0.5"
          style={{ color: 'var(--text-muted, rgba(255,255,255,0.4))' }}
        >
          {item.description}
        </div>
      </div>
      <ArrowRight
        size={14}
        className="shrink-0 opacity-0 group-hover:opacity-60 transition-all duration-200 group-hover:translate-x-0.5"
        style={{ color: 'var(--text-muted)' }}
      />
    </button>
  );
}

// ── Section Header（/home 风格：eyebrow + title + subtitle + accent 渐变下划线） ──

interface SectionHeaderProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
  accent: string;
}

function SectionHeader({ eyebrow, title, subtitle, accent }: SectionHeaderProps) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <div
          className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] uppercase mb-1.5"
          style={{ color: accent, opacity: 0.85 }}
        >
          <span
            className="inline-block w-4 h-[2px] rounded-full"
            style={{
              background: `linear-gradient(90deg, ${accent}, transparent)`,
              boxShadow: `0 0 8px ${accent}80`,
            }}
          />
          {eyebrow}
        </div>
        <div className="flex items-baseline gap-3">
          <h2
            className="text-[18px] font-semibold tracking-tight"
            style={{ color: 'var(--text-primary, #fff)' }}
          >
            {title}
          </h2>
          {subtitle && (
            <span
              className="text-[11.5px] truncate"
              style={{ color: 'var(--text-muted, rgba(255,255,255,0.45))' }}
            >
              {subtitle}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Auto-fill grid style helper ──

const AUTO_GRID_FEATURED: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
};

const AUTO_GRID_COMPACT: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
};

// ── Main Page ──

export default function AgentLauncherPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const { items, itemsLoading, loadItems } = useToolboxStore();
  const { isMobile } = useBreakpoint();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions ?? []);

  const canUseReviewAgent = permissions.includes('review-agent.use');
  const canUsePrReview = permissions.includes('pr-review.use');
  // 管理工具类权限门（从用户菜单迁移到首页实用工具区后，按权限过滤）
  const canReadPrompts = permissions.includes('prompts.read') || permissions.includes('prompts.write');
  const canReadLab = permissions.includes('lab.read') || permissions.includes('lab.write');
  const canManageAutomations = permissions.includes('automations.manage');
  const canReadLogs = permissions.includes('logs.read');

  // 更新中心未读数（用于首页快捷卡的红点徽章）
  const changelogUnread = useChangelogStore(selectUnreadCount);
  const loadChangelogCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);

  // 首页资源（卡片背景 + Agent 封面）—— 上传后覆盖默认素材
  const homepageAssets = useHomepageAssetsStore((s) => s.assets);
  const loadHomepageAssets = useHomepageAssetsStore((s) => s.load);

  const quickLinks = useMemo<HomeQuickLink[]>(() => {
    return QUICK_LINKS_BASE.map((link) => {
      const uploaded = link.id ? homepageAssets[`card.${link.id}`]?.url : undefined;
      return uploaded ? { ...link, backgroundUrl: uploaded } : link;
    });
  }, [homepageAssets]);

  useEffect(() => {
    loadItems();
    void loadChangelogCurrentWeek();
    void loadHomepageAssets();
  }, [loadItems, loadChangelogCurrentWeek, loadHomepageAssets]);

  // 静态实用工具入口（不来自后端 toolbox）
  // 原用户菜单中的工具类条目（知识库/涌现/网页托管 + 提示词/实验室/自动化/请求日志）
  // 已全部迁移至此区，用户菜单只保留账户/系统通知/更新中心/数据分享/退出。
  const staticUtilities: ToolboxItem[] = useMemo(() => {
    const items: ToolboxItem[] = [
      {
        id: '__document-store__',
        name: '知识库',
        description: '文档存储与知识管理，支持文件夹、GitHub 同步',
        icon: 'Library',
        tags: ['文档', '知识', '知识库', 'docs'],
        routePath: '/document-store',
      } as ToolboxItem,
      {
        id: '__emergence__',
        name: '涌现探索',
        description: '从文档出发，AI 辅助发现功能创意与交叉价值',
        icon: 'Sparkle',
        tags: ['涌现', '探索', 'AI', '创意'],
        routePath: '/emergence',
      } as ToolboxItem,
      {
        id: '__web-pages__',
        name: '网页托管',
        description: '上传 HTML 或 ZIP，托管并分享你的网页',
        icon: 'Globe',
        tags: ['托管', '网页', 'hosting'],
        routePath: '/web-pages',
      } as ToolboxItem,
      {
        id: '__skill-agent__',
        name: '技能创建助手',
        description: 'AI 引导你逐步创建可复用的技能模板',
        icon: 'Wand2',
        tags: ['技能', 'skill', 'AI', '创建', '模板'],
        routePath: '/skill-agent',
      } as ToolboxItem,
    ];

    // 管理工具类（权限门控）
    if (canReadPrompts) {
      items.push({
        id: '__prompts__',
        name: '提示词管理',
        description: '管理系统与技能提示词',
        icon: 'FileText',
        tags: ['提示词', 'prompts', '管理'],
        routePath: '/prompts',
      } as ToolboxItem);
    }
    if (canReadLab) {
      items.push({
        id: '__lab__',
        name: '实验室',
        description: 'Model Lab / 桌面实验 / 工具箱',
        icon: 'FlaskConical',
        tags: ['实验室', 'lab', 'beta'],
        routePath: '/lab',
      } as ToolboxItem);
    }
    if (canManageAutomations) {
      items.push({
        id: '__automations__',
        name: '自动化规则',
        description: '创建和管理跨系统的自动化任务',
        icon: 'Zap',
        tags: ['自动化', 'automation', '规则'],
        routePath: '/automations',
      } as ToolboxItem);
    }
    if (canReadLogs) {
      items.push({
        id: '__logs__',
        name: '请求日志',
        description: 'LLM 调用与 API 请求日志审计',
        icon: 'ScrollText',
        tags: ['日志', 'logs', '审计'],
        routePath: '/logs',
      } as ToolboxItem);
    }

    return items;
  }, [canReadPrompts, canReadLab, canManageAutomations, canReadLogs]);

  // Split into featured (customized agents with routePath) and compact (utility agents)
  const { featured, utilities, filtered } = useMemo(() => {
    const filterByPerm = (list: ToolboxItem[]) =>
      list.filter((i) => {
        if (i.agentKey === 'review-agent' && !canUseReviewAgent) return false;
        if (i.agentKey === 'pr-review' && !canUsePrReview) return false;
        return true;
      });

    const allItems = dedupeToolboxItems(filterByPerm([...items, ...staticUtilities]));
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      const matched = allItems.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          item.tags.some((tag) => tag.toLowerCase().includes(query))
      );
      return { featured: [], utilities: [], filtered: matched };
    }
    const feat: ToolboxItem[] = [];
    const util: ToolboxItem[] = [];
    const dedupedItems = dedupeToolboxItems(items);
    for (const item of dedupedItems) {
      if (item.agentKey === 'review-agent' && !canUseReviewAgent) continue;
      if (item.agentKey === 'pr-review' && !canUsePrReview) continue;
      if (item.routePath) feat.push(item);
      else util.push(item);
    }
    util.push(...staticUtilities);
    return { featured: feat, utilities: util, filtered: [] };
  }, [items, staticUtilities, searchQuery, canUseReviewAgent, canUsePrReview]);

  const handleClick = (item: ToolboxItem) => {
    if (item.agentKey === 'prd-agent') {
      setDownloadDialogOpen(true);
      return;
    }
    if (item.routePath) {
      navigate(item.routePath);
    } else {
      useToolboxStore.getState().selectItem(item);
      navigate('/ai-toolbox');
    }
  };

  const greeting = getGreeting();
  const displayName = user?.displayName || '';

  // Hero banner：订阅 store；上传后自动重渲染并附缓存爆破参数
  const uploadedHero = useHeroBgUrl('home');
  const cdnBase = useAuthStore((s) => s.cdnBaseUrl ?? '');
  const heroBgUrl = useMemo(
    () => uploadedHero ?? buildDefaultHeroUrl(cdnBase, 'home') ?? '',
    [uploadedHero, cdnBase]
  );

  return (
    <div className="h-full min-h-0 flex flex-col relative" style={{ background: 'var(--bg-base)' }}>
      {/* 环境光背景层（blobs + film grain + top spotlight） —— 单独一层，不影响布局 */}
      <HomeAmbientBackdrop />

      <div className="flex-1 min-h-0 overflow-auto relative" style={{ zIndex: 1 }}>

          {/* ── Hero banner with background image — full width ── */}
          <div
            className="relative overflow-hidden"
            style={{
              marginBottom: 0,
            }}
          >
            {/* Background image — positioned right, like 文心 reference */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `url(${heroBgUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center top',
                backgroundRepeat: 'no-repeat',
                opacity: 0.85,
              }}
            />
            {/* Left fade overlay — text readability */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: isMobile
                  ? 'linear-gradient(180deg, var(--bg-base) 0%, rgba(20,20,24,0.85) 40%, rgba(20,20,24,0.5) 100%)'
                  : 'linear-gradient(90deg, var(--bg-base) 0%, var(--bg-base) 30%, rgba(20,20,24,0.7) 55%, rgba(20,20,24,0.15) 80%, transparent 100%)',
              }}
            />
            {/* Bottom fade — blend with page */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: 'linear-gradient(180deg, transparent 50%, var(--bg-base) 100%)',
              }}
            />

            {/* Hero 本地 aurora 光晕（/home 风格节选，只影响 Hero 自身）*/}
            <div
              className="absolute pointer-events-none"
              style={{
                top: '10%',
                left: isMobile ? '-20%' : '2%',
                width: isMobile ? '140%' : 520,
                height: isMobile ? 260 : 340,
                background:
                  'radial-gradient(ellipse at 30% 50%, rgba(124, 58, 237, 0.18) 0%, rgba(0, 240, 255, 0.08) 35%, transparent 65%)',
                filter: 'blur(40px)',
                opacity: 0.9,
              }}
            />

            {/* Hero content */}
            <div className={`relative z-10 ${isMobile ? 'px-5 pt-8 pb-6' : 'px-8 pt-10 pb-8'}`}>
              <div className={`flex ${isMobile ? 'flex-col gap-4' : 'items-start justify-between gap-8'}`}>
                <div className="shrink-0">
                  {/* 小型 eyebrow 标签：品牌定位 */}
                  <Reveal delay={REVEAL.heroEyebrow} duration={REVEAL_DURATION}>
                    <div
                      className="inline-flex items-center gap-1.5 mb-2 px-2.5 py-0.5 rounded-full text-[10px] font-medium tracking-[0.08em] uppercase"
                      style={{
                        background: 'rgba(124, 58, 237, 0.12)',
                        border: '1px solid rgba(124, 58, 237, 0.28)',
                        color: '#c4b5fd',
                        textShadow: 'none',
                      }}
                    >
                      <Sparkles size={10} />
                      MAP · 米多智能体生态平台
                    </div>
                  </Reveal>
                  <Reveal delay={REVEAL.heroTitle} duration={REVEAL_DURATION} offset={20}>
                    <h1
                      className={`font-semibold tracking-tight ${isMobile ? 'text-2xl' : 'text-[34px]'}`}
                      style={{
                        color: 'var(--text-primary, #fff)',
                        textShadow: '0 1px 12px rgba(0,0,0,0.35), 0 0 40px rgba(124, 58, 237, 0.15)',
                        lineHeight: 1.15,
                      }}
                    >
                      {greeting}
                      {displayName ? '，' : ''}
                      {displayName && (
                        <span
                          style={{
                            background: MAP_ACCENT_GRADIENT,
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text',
                          }}
                        >
                          {displayName}
                        </span>
                      )}
                    </h1>
                  </Reveal>
                  <Reveal delay={REVEAL.heroSubtitle} duration={REVEAL_DURATION}>
                    <p
                      className={`mt-2 ${isMobile ? 'text-sm' : 'text-[15px]'}`}
                      style={{
                        color: 'var(--text-muted, rgba(255,255,255,0.6))',
                        textShadow: '0 1px 4px rgba(0,0,0,0.2)',
                        maxWidth: 520,
                      }}
                    >
                      选一个智能助手开始创作，或在下方的实用工具里探索平台能力
                    </p>
                  </Reveal>
                </div>

                {/* Search (top-right) */}
                <Reveal delay={REVEAL.heroSearch} duration={REVEAL_DURATION}>
                  <div className="relative shrink-0" style={{ width: isMobile ? '100%' : 260 }}>
                    <Search
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                      style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}
                    />
                    <input
                      type="text"
                      placeholder="搜索 Agent..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full h-9 pl-9 pr-4 rounded-lg text-[13px] outline-none transition-colors duration-150"
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: 'var(--text-primary, #fff)',
                        backdropFilter: 'blur(12px)',
                        WebkitBackdropFilter: 'blur(12px)',
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = 'var(--accent-primary, #818CF8)';
                        e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                        e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                      }}
                    />
                  </div>
                </Reveal>
              </div>
            </div>
            {/* end hero content */}
          </div>
          {/* end hero banner */}

        <div className={isMobile ? 'px-4 pt-4 pb-8' : 'px-8 pt-5 pb-12'}>
          {/* ── Quick Links — 4 张独立卡片，同宽响应式（1/2/4 列） ── */}
          {!searchQuery.trim() && (
            <div
              className="grid"
              style={{
                marginBottom: isMobile ? 20 : 32,
                gap: isMobile ? 10 : 14,
                gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 160 : 220}px, 1fr))`,
              }}
            >
              {quickLinks.map((link, idx) => {
                const Icon = link.icon;
                const isUpdates = link.id === 'updates';
                const showUnread = isUpdates && changelogUnread > 0;
                return (
                  <Reveal
                    key={link.path}
                    delay={REVEAL.quickLinkBase + idx * REVEAL.quickLinkStep}
                    duration={REVEAL_DURATION}
                    offset={20}
                  >
                  <button
                    type="button"
                    onClick={() => navigate(link.path)}
                    className="group relative text-left rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-0.5 w-full"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 100%)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      padding: isMobile ? '14px 14px 16px' : '18px 18px 20px',
                      minHeight: isMobile ? 96 : 120,
                    }}
                  >
                    {/* 管理员上传的背景图（如有）：铺满卡片，底部渐变压暗保证文字可读 */}
                    {link.backgroundUrl && (
                      <>
                        <div
                          className="absolute inset-0 transition-transform duration-500 group-hover:scale-105 pointer-events-none"
                          style={{
                            backgroundImage: `url(${link.backgroundUrl})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                          }}
                        />
                        {/* Stronger unified gradient for text readability over bright images */}
                        <div
                          className="absolute inset-0 pointer-events-none"
                          style={{
                            background: 'linear-gradient(180deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.7) 50%, rgba(0,0,0,0.9) 100%)',
                          }}
                        />
                      </>
                    )}

                    {/* 背景光晕：从卡片右上角散出主色（仅无背景图时展示） */}
                    {!link.backgroundUrl && (
                    <div
                      className="absolute pointer-events-none transition-opacity duration-300"
                      style={{
                        top: -40,
                        right: -40,
                        width: 200,
                        height: 200,
                        background: `radial-gradient(circle at center, ${link.accent}26 0%, ${link.accent}0a 40%, transparent 70%)`,
                        opacity: 0.8,
                      }}
                    />
                    )}

                    {/* Hover 边框辉光 */}
                    <div
                      className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                      style={{
                        boxShadow: `inset 0 0 0 1px ${link.accent}60, 0 0 24px ${link.accent}18`,
                      }}
                    />

                    {/* 内容 */}
                    <div className="relative z-10 flex flex-col h-full">
                      <div className="flex items-center justify-between">
                        <div
                          className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-200 group-hover:scale-105"
                          style={{
                            background: `linear-gradient(135deg, ${link.accent}26, ${link.accent}08)`,
                            border: `1px solid ${link.accent}36`,
                            boxShadow: `0 4px 20px -8px ${link.accent}50`,
                          }}
                        >
                          <Icon size={18} style={{ color: link.accent }} />
                        </div>
                        {/* 未读徽章（仅更新中心） */}
                        {showUnread && (
                          <span
                            className="px-1.5 h-5 min-w-5 rounded-full inline-flex items-center justify-center text-[10px] font-bold shrink-0"
                            style={{
                              background: 'linear-gradient(135deg, #fbbf24, #f97316)',
                              color: '#1a1a1a',
                              boxShadow: '0 0 0 1.5px rgba(20, 20, 24, 0.92), 0 2px 8px rgba(251, 191, 36, 0.4)',
                            }}
                          >
                            {changelogUnread > 9 ? '9+' : changelogUnread}
                          </span>
                        )}
                      </div>

                      <div
                        className={`mt-3 font-semibold tracking-tight ${isMobile ? 'text-[14px]' : 'text-[15px]'}`}
                        style={{ color: 'var(--text-primary, #fff)', textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}
                      >
                        {link.label}
                      </div>
                      <div
                        className="text-[11px] mt-1 leading-relaxed line-clamp-2"
                        style={{ color: 'var(--text-muted, rgba(255,255,255,0.8))', textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}
                      >
                        {link.desc}
                      </div>

                      <div className="flex-1" />

                      <div
                        className="mt-3 flex items-center gap-1 text-[10px] font-medium opacity-50 group-hover:opacity-100 transition-opacity duration-200"
                        style={{ color: link.accent }}
                      >
                        <span>进入</span>
                        <ArrowRight size={11} className="group-hover:translate-x-0.5 transition-transform duration-200" />
                      </div>
                    </div>
                  </button>
                  </Reveal>
                );
              })}
            </div>
          )}

          {/* ── Loading ── */}
          {itemsLoading ? (
            <div className="flex items-center justify-center h-48">
              <MapSpinner size={24} color="var(--accent-primary)" />
            </div>
          ) : searchQuery.trim() ? (
            /* ── Search results ── */
            filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 gap-2">
                <Search size={24} style={{ color: 'var(--text-muted, rgba(255,255,255,0.2))' }} />
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  没有找到匹配的 Agent
                </span>
              </div>
            ) : (
              <div style={AUTO_GRID_FEATURED}>
                {filtered.map((item) =>
                  item.routePath ? (
                    <FeaturedCard key={item.id} item={item} onClick={() => handleClick(item)} />
                  ) : (
                    <CompactCard key={item.id} item={item} onClick={() => handleClick(item)} />
                  )
                )}
              </div>
            )
          ) : (
            /* ── Default layout: featured + utilities ── */
            <>
              {/* Featured Agents */}
              {featured.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.agentsHeader} duration={REVEAL_DURATION}>
                    <SectionHeader
                      eyebrow="AGENTS"
                      title="智能助手"
                      subtitle={`${featured.length} 个专属 Agent，覆盖 PRD / 视觉 / 文学 / 视频 / 缺陷 / 周报 / 审查`}
                      accent="#818CF8"
                    />
                  </Reveal>
                  <div style={AUTO_GRID_FEATURED}>
                    {featured.map((item, i) => (
                      <Reveal
                        key={item.id}
                        delay={REVEAL.agentsCardBase + i * REVEAL.agentsCardStep}
                        duration={REVEAL_DURATION}
                      >
                        <FeaturedCard item={item} onClick={() => handleClick(item)} />
                      </Reveal>
                    ))}
                  </div>
                </section>
              )}

              {/* Utility Agents */}
              {utilities.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.utilitiesHeader} duration={REVEAL_DURATION}>
                    <SectionHeader
                      eyebrow="UTILITIES"
                      title="实用工具"
                      subtitle="知识库 · 涌现探索 · 网页托管 · 管理工具 — 按需展开使用"
                      accent="#22D3EE"
                    />
                  </Reveal>
                  <div style={AUTO_GRID_COMPACT}>
                    {utilities.map((item, i) => (
                      <Reveal
                        key={item.id}
                        delay={REVEAL.utilitiesCardBase + i * REVEAL.utilitiesCardStep}
                        duration={REVEAL_DURATION}
                      >
                        <CompactCard item={item} onClick={() => handleClick(item)} />
                      </Reveal>
                    ))}
                  </div>
                </section>
              )}

              {/* Showcase Gallery — 作品广场（滚动到视口时由 IntersectionObserver 触发） */}
              <section>
                <Reveal delay={REVEAL.showcaseHeader} duration={REVEAL_DURATION}>
                  <SectionHeader
                    eyebrow="SHOWCASE"
                    title="作品广场"
                    subtitle="社区 AI 创意作品流"
                    accent="#F43F5E"
                  />
                </Reveal>
                <ShowcaseGallery />
              </section>
            </>
          )}
        </div>
      </div>

      <DesktopDownloadDialog open={downloadDialogOpen} onOpenChange={setDownloadDialogOpen} />
    </div>
  );
}
