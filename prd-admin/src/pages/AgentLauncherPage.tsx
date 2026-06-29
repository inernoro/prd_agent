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
  FolderHeart,
  Cpu,
  Users,
  Hammer,
  Radar,
  type LucideIcon,
} from 'lucide-react';
import { PaSecretary } from '@/lib/paSecretaryIconRegistry';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useAuthStore } from '@/stores/authStore';
import { deriveLauncherPerms, buildStaticAgents, buildStaticUtilities, buildStaticInfra } from '@/lib/homeLauncherItems';
import { useChangelogStore, selectUnreadCount } from '@/stores/changelogStore';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import { WeeklyPosterModal } from '@/components/weekly-poster/WeeklyPosterModal';
import { useHomepageAssetsStore, useAgentImageUrl, useAgentVideoUrl, useHeroBgUrl } from '@/stores/homepageAssetsStore';
import { buildDefaultCoverUrl, buildDefaultVideoUrl, buildDefaultHeroUrl } from '@/lib/homepageAssetSlots';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { ToolboxItem } from '@/services';
import { ShowcaseGallery } from '@/components/showcase/ShowcaseGallery';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { ReviewAgentCardArt } from '@/pages/ai-toolbox/components/ReviewAgentCardArt';
import { ProjectRouteAgentCardArt } from '@/pages/ai-toolbox/components/ProjectRouteAgentCardArt';
import { PaAgentCardArt } from '@/pages/ai-toolbox/components/PaAgentCardArt';
import { PmAgentCardArt } from '@/pages/ai-toolbox/components/PmAgentCardArt';
import { ProductAgentCardArt } from '@/pages/ai-toolbox/components/ProductAgentCardArt';
import { HomeAmbientBackdrop } from '@/components/effects/HomeAmbientBackdrop';
import { Reveal } from '@/pages/home/components/Reveal';
import { TipsRotator } from '@/components/daily-tips/TipsRotator';
import { UpdateCenterNewsTeaser } from '@/components/ai-news/UpdateCenterNewsTeaser';
import { LearningCenterTeaser } from '@/components/daily-tips/LearningCenterTeaser';

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
  heroTitle: 30,
  heroSubtitle: 60,
  heroSearch: 90,
  quickLinkBase: 120,
  quickLinkStep: 30,
  agentsHeader: 250,
  agentsCardBase: 280,
  agentsCardStep: 20,
  utilitiesHeader: 200,   // 首次出现延迟加速 2x(原 400)，让"实用工具"更快露出；step/duration 不变
  utilitiesCardBase: 210, // 同步减半(原 420)
  utilitiesCardStep: 15,
  infraHeader: 560,
  infraCardBase: 580,
  infraCardStep: 15,
  showcaseHeader: 720, // 仅当首屏即可见时生效；滚动触发走 IntersectionObserver
};

// ── Icon & Color mapping (self-contained, doesn't touch ToolCard) ──

const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Video, Swords, FileBarChart, Code2, Languages, FileSearch, BarChart3, Bot, Workflow, Zap, Globe, ClipboardCheck, ScanSearch, Wand2,
  // 迁移自用户菜单的管理工具
  FlaskConical, ScrollText, Sparkle, Sparkles, Library, Store,
  // 基础设施
  FolderHeart, Cpu, Users, Hammer,
  PaSecretary,
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
  ListTree:  { from: '#22C55E', to: '#86EFAC' },
  Sparkles:  { from: '#FBBF24', to: '#FCD34D' },
  Library:   { from: '#3B82F6', to: '#60A5FA' },
  Store:     { from: '#F59E0B', to: '#FB923C' },
  FolderHeart: { from: '#EC4899', to: '#F9A8D4' },
  Cpu:       { from: '#6366F1', to: '#A5B4FC' },
  Users:     { from: '#22D3EE', to: '#67E8F9' },
  Hammer:    { from: '#64748B', to: '#94A3B8' },
  // 毒舌秘书：科幻深蓝，与 PaAgentCardArt 内联插画呼应
  PaSecretary:{ from: '#1D4ED8', to: '#67E8F9' },
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
  const isPaAgent = item.agentKey === 'pa-agent';
  const cardDescription = isPaAgent
    ? '把模糊想法转成 MECE 执行清单的 MBB 级私人助理'
    : item.description;

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
      {/*
        毒舌秘书走「上传图优先 + inline 插画兜底」：与其他 agent 一致先看运维上传，
        没上传时不用渐变占位，而是渲染 PaAgentCardArt 内联插画（MBB + 四象限 + 琥珀/青色）。
        这是规则 #8「Agent 开发完成标准」要求的「看起来是个东西」。
      */}
      {item.agentKey === 'review-agent' ? (
        <ReviewAgentCardArt />
      ) : item.agentKey === 'pm-agent' && !uploadedCover ? (
        <PmAgentCardArt />
      ) : item.agentKey === 'product-agent' && !uploadedCover ? (
        <ProductAgentCardArt />
      ) : item.agentKey === 'project-route-agent' ? (
        <ProjectRouteAgentCardArt />
      ) : item.agentKey === 'pa-agent' && !uploadedCover ? (
        <>
          <PaAgentCardArt />
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
              style={{ opacity: hovering && videoReady ? 1 : 0, filter: 'saturate(0.86) brightness(0.92)' }}
            />
          )}
        </>
      ) : coverUrl && !coverFailed ? (
        <>
          <img
            src={coverUrl}
            alt=""
            // 卡片封面图体积较大（上传素材可达 1-2MB/张），网格里大量卡片在首屏外。
            // lazy + async 解码让屏外封面滚动到视口附近才下载，砍掉首屏的整片图片负载，
            // 不阻塞首屏渲染（治「预览页一次拉几十 MB」）。
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            draggable={false}
            onError={() => setCoverFailed(true)}
            style={{ filter: 'saturate(0.86) brightness(0.92)' }}
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
              style={{ opacity: hovering && videoReady ? 1 : 0, filter: 'saturate(0.86) brightness(0.92)' }}
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

      {/* 统一暗角蒙版：给所有封面图套同一层「玻璃」，让画风各异的图读起来像一家人（A2 核心） */}
      <div
        className="absolute inset-0 pointer-events-none z-[1]"
        style={{
          background: `linear-gradient(165deg, ${accent.from}12 0%, transparent 32%), linear-gradient(180deg, rgba(8,8,12,0.30) 0%, rgba(8,8,12,0.05) 38%, rgba(8,8,12,0.35) 100%)`,
        }}
      />

      {/* Strong dark fade at the bottom for text readability */}
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none z-[2] h-[65%]"
        style={{
          background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.4) 30%, rgba(0,0,0,0.85) 65%, rgba(0,0,0,0.98) 100%)',
        }}
      />

      {/* Hover border glow */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none flex z-[20]"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.from}40, 0 0 20px ${accent.from}10` }}
      />

      {/* Top Floating App Icon */}
      <div 
        className="absolute top-4 left-4 z-[10] shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
        style={{
          background: `linear-gradient(135deg, ${accent.from}50, ${accent.from}15)`,
          border: `1px solid ${accent.from}60`,
          boxShadow: `0 8px 24px -8px ${accent.from}90, inset 0 1px 0 rgba(255,255,255,0.25)`,
          backdropFilter: 'blur(8px)'
        }}
      >
        <Icon size={22} style={{ color: accent.to, filter: `drop-shadow(0 2px 4px ${accent.from}80)` }} />
      </div>

      {/* Top-Right Arrow Indicator */}
      <div className="absolute top-5 right-5 z-[10] shrink-0 opacity-0 -translate-x-3 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300">
        <ArrowRight size={18} style={{ color: accent.to, filter: `drop-shadow(0 2px 4px ${accent.from}80)` }} />
      </div>

      {/* Content — Clean Bottom Aligned */}
      <div className="absolute bottom-0 left-0 right-0 p-5 z-[10]">
        <h3
          className="text-[17px] font-semibold truncate transition-all duration-300 group-hover:translate-y-[-2px]"
          style={{ color: '#ffffff', textShadow: '0 1px 2px rgba(0,0,0,1), 0 2px 8px rgba(0,0,0,0.9), 0 4px 16px rgba(0,0,0,0.5)' }}
        >
          {item.name}
        </h3>
        <p
          className="text-[13px] leading-relaxed mt-1.5 line-clamp-1 transition-all duration-300 group-hover:translate-y-[-2px] group-hover:opacity-100 opacity-80"
          style={{ color: 'rgba(255,255,255,0.95)', textShadow: '0 1px 2px rgba(0,0,0,1), 0 2px 6px rgba(0,0,0,0.8)' }}
        >
          {cardDescription}
        </p>
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
  // 启动器静态入口的权限门（智能体/实用工具/基础设施），口径与移动端共用同一 SSOT
  const launcherPerms = useMemo(() => deriveLauncherPerms(permissions), [permissions]);

  // 更新中心未读数（用于首页快捷卡的红点徽章）
  const changelogUnread = useChangelogStore(selectUnreadCount);
  const loadChangelogCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);

  // 周报海报(主页弹窗)
  const loadWeeklyPoster = useWeeklyPosterStore((s) => s.loadCurrent);

  // 首页资源（卡片背景 + Agent 封面）—— 上传后覆盖默认素材
  const homepageAssets = useHomepageAssetsStore((s) => s.assets);
  const loadHomepageAssets = useHomepageAssetsStore((s) => s.load);

  const quickLinks = useMemo<HomeQuickLink[]>(() => {
    return QUICK_LINKS_BASE.map((link) => {
      // VOC 很重要：有 team-activity.read 权限者，首页顶部快捷卡用 VOC 替换「智识殿堂」（用户要求）
      if (link.id === 'library' && launcherPerms.canReadTeamActivity) {
        return {
          icon: Radar,
          label: 'VOC',
          desc: '用户原声闭环 · 行为洞察与 AI 根因诊断',
          path: '/team-activity',
          accent: '#6366F1',
          gradient: 'linear-gradient(135deg, #6366F1, #8B5CF6)',
        };
      }
      const uploaded = link.id ? homepageAssets[`card.${link.id}`]?.url : undefined;
      return uploaded ? { ...link, backgroundUrl: uploaded } : link;
    });
  }, [homepageAssets, launcherPerms]);

  useEffect(() => {
    loadItems();
    void loadChangelogCurrentWeek({ daysLimit: 8 });
    void loadHomepageAssets();
    void loadWeeklyPoster();
  }, [loadItems, loadChangelogCurrentWeek, loadHomepageAssets, loadWeeklyPoster]);

  // 静态入口（智能体 / 实用工具 / 基础设施）—— 数据源统一在 lib/homeLauncherItems（桌面+移动共用）
  const staticAgents: ToolboxItem[] = useMemo(() => buildStaticAgents(), []);
  const staticUtilities: ToolboxItem[] = useMemo(() => buildStaticUtilities(launcherPerms), [launcherPerms]);
  const staticInfra: ToolboxItem[] = useMemo(() => buildStaticInfra(launcherPerms), [launcherPerms]);

  // Split into featured (智能体) / utilities (工具) / infra (基础设施) three buckets
  const { featured, utilities, infra, filtered } = useMemo(() => {
    const filterByPerm = (list: ToolboxItem[]) =>
      list.filter((i) => {
        if (i.agentKey === 'review-agent' && !canUseReviewAgent) return false;
        if (i.agentKey === 'pr-review' && !canUsePrReview) return false;
        return true;
      });

    const allItems = dedupeToolboxItems(
      filterByPerm([...items, ...staticAgents, ...staticUtilities, ...staticInfra])
    );
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      const matched = allItems.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          item.tags.some((tag) => tag.toLowerCase().includes(query))
      );
      return { featured: [], utilities: [], infra: [], filtered: matched };
    }
    const feat: ToolboxItem[] = [];
    const util: ToolboxItem[] = [];
    const dedupedItems = dedupeToolboxItems(items);
    for (const item of dedupedItems) {
      if (item.agentKey === 'review-agent' && !canUseReviewAgent) continue;
      if (item.agentKey === 'pr-review' && !canUsePrReview) continue;
      // kind === 'agent' (或默认有 routePath 的内置条目) 进 featured
      // kind === 'tool' 进 util；不在此显示 infra（infra 不再经由 BUILTIN_TOOLS）
      if (item.kind === 'tool') {
        util.push(item);
      } else if (item.kind === 'agent' || item.routePath) {
        feat.push(item);
      } else {
        util.push(item);
      }
    }
    // 涌现探索属于智能体
    feat.push(...staticAgents);
    util.push(...staticUtilities);
    return { featured: feat, utilities: util, infra: staticInfra, filtered: [] };
  }, [items, staticAgents, staticUtilities, staticInfra, searchQuery, canUseReviewAgent, canUsePrReview]);

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
    <div
      className="h-full min-h-0 flex flex-col relative"
      style={{
        background: 'transparent',
      }}
    >
      {/* ── 页面背景大画幅层 (Page Hero Backing) ── */}
      <div
        className="absolute top-0 right-0 pointer-events-none"
        style={{
          left: isMobile ? 0 : -128,
          height: isMobile ? '70vh' : '90vh',
          zIndex: 0,
          // overflow:hidden 把缩放 1.04 的背景图裁回容器内，避免在 AppShell 滚动容器里撑出横向滚动条
          overflow: 'hidden',
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 100%)',
        }}
      >
        {/* Unified glass base: keeps the hero photo from reading as a pasted black rectangle. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(135deg, rgba(255, 255, 255, 0.16) 0%, rgba(30, 32, 40, 0.88) 34%, rgba(9, 10, 16, 0.98) 100%)',
          }}
        />
        {/* Background image —— 降级为「氛围层」：压暗 + 降饱和 + 轻模糊，从主角照片变墙上光影 */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `url(${heroBgUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center top',
            backgroundRepeat: 'no-repeat',
            opacity: 0.28,
            filter: 'saturate(0.68) brightness(0.64) blur(1.2px)',
            mixBlendMode: 'screen',
            maskImage:
              'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.18) 7%, rgba(0,0,0,0.78) 18%, #000 42%), linear-gradient(to bottom, #000 0%, #000 58%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.18) 7%, rgba(0,0,0,0.78) 18%, #000 42%), linear-gradient(to bottom, #000 0%, #000 58%, transparent 100%)',
            transform: 'scale(1.04)',
          }}
        />
        {/* Left fade overlay — text readability */}
        <div
          className="absolute inset-0"
          style={{
            background: isMobile
              ? 'linear-gradient(180deg, rgba(34,35,42,0.88) 0%, rgba(12,13,18,0.68) 46%, transparent 100%)'
              : 'linear-gradient(90deg, rgba(36,37,44,0.82) 0%, rgba(24,25,32,0.58) 18%, rgba(12,13,18,0.34) 48%, transparent 84%)',
          }}
        />
        {/* Bottom scrim —— 让背景图无缝熔进深空底色，卡片区域是干净深色，不再有照片噪点透出（A2 驯服核心） */}
        <div
          className="absolute inset-x-0 bottom-0"
          style={{
            height: '68%',
            background: 'linear-gradient(180deg, transparent 0%, rgba(11,12,22,0.58) 52%, var(--bg-base) 100%)',
          }}
        />
      </div>

      {/* 环境光背景层（blobs + film grain + top spotlight） —— 单独一层，不影响布局 */}
      <HomeAmbientBackdrop />
      <style>{`
        @keyframes gradientSlowFlow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .animate-gradient-flow {
          animation: gradientSlowFlow 8s ease-in-out infinite;
        }
      `}</style>
      
      <div className="flex-1 min-h-0 overflow-auto relative" style={{ zIndex: 1 }}>

        {/* Hero 本地 aurora 光晕 */}
        <div
          className="absolute pointer-events-none"
          style={{
            top: '5%',
            left: isMobile ? '-20%' : '2%',
            width: isMobile ? '140%' : 520,
            height: isMobile ? 260 : 340,
            background:
              'radial-gradient(ellipse at 30% 50%, rgba(255, 255, 255, 0.13) 0%, rgba(226, 232, 240, 0.055) 36%, transparent 66%)',
            filter: 'blur(40px)',
            opacity: 0.82,
            zIndex: 0,
          }}
        />

        {/* ── 页面主体内容（悬浮在背景图之上） ── */}
        <div className="relative z-10">

            {/* Hero content */}
            <div className={`relative ${isMobile ? 'px-5 pt-8 pb-6' : 'px-8 pt-10 pb-8'}`}>
              {/* flex-wrap：中等宽度(1024-1190px,非 mobile)下让右栏整体换行落到问候语下方，
                  避免「左列 + 搜索 280 + 教程 280」单行不换挤爆视口(Codex) */}
              <div className={`flex ${isMobile ? 'flex-col gap-4' : 'items-start justify-between gap-x-8 gap-y-6 flex-wrap'}`}>
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
                          className="animate-gradient-flow"
                          style={{
                            background: MAP_ACCENT_GRADIENT,
                            backgroundSize: '200% auto',
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
                    <div
                      data-tour-id="home-subtitle"
                      className={`mt-2 ${isMobile ? 'text-sm' : 'text-[15px]'}`}
                      style={{
                        color: 'var(--text-muted, rgba(255,255,255,0.6))',
                        textShadow: '0 1px 4px rgba(0,0,0,0.2)',
                        maxWidth: 520,
                      }}
                    >
                      <TipsRotator fallback="选一个智能体开始创作，或在下方的实用工具里探索平台能力" />
                    </div>
                  </Reveal>
                </div>

                {/* 右栏：搜索框 + 教程中心承接卡，搜索在左、教程在右，顶部对齐分列 */}
                <Reveal delay={REVEAL.heroSearch} duration={REVEAL_DURATION}>
                  {/* 非 mobile 右栏:去掉 shrink-0 + min-w-0,让 rail 能收缩到内容列实际宽度;
                      flex-wrap + 子项 maxWidth:100% 保证窄到 <576px(侧栏展开的平板)时搜索/教程竖向堆叠而非横向溢出(Codex P2) */}
                  <div className={isMobile ? 'flex flex-col gap-3 w-full' : 'flex flex-wrap items-start gap-4 min-w-0'}>
                    {/* 搜索框：移到顶部、教程左侧 */}
                    <div className="relative" style={{ width: isMobile ? '100%' : 280, maxWidth: '100%' }}>
                      <Search
                        size={15}
                        className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                        style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}
                      />
                      <input
                        data-tour-id="home-search"
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

                    {/* 教程中心承接卡（搜索态隐藏） */}
                    {!searchQuery.trim() && (
                      <div className="flex flex-col gap-2" style={{ width: isMobile ? '100%' : 280, maxWidth: '100%' }}>
                        <LearningCenterTeaser />
                      </div>
                    )}
                  </div>
                </Reveal>
              </div>
            </div>
            {/* end hero content */}

            {/* ── Quick Links — Extended Hero Background Area ── */}
            {!searchQuery.trim() && (
              <div className={`relative z-10 ${isMobile ? 'px-5 pb-6' : 'px-8 pb-10'}`}>
                <div
                  className="grid"
                  style={{
                    gap: isMobile ? 10 : 14,
                    gridTemplateColumns: isMobile
                      ? `repeat(auto-fit, minmax(160px, 1fr))`
                      : `repeat(auto-fit, minmax(260px, 1fr))`,
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
                    data-tour-id={`quicklink-${link.id}`}
                    onClick={() => navigate(link.path)}
                    className="group relative text-left rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-0.5 w-full"
                    style={{
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 100%)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      padding: isMobile ? '14px 14px 16px' : '20px',
                      minHeight: isMobile ? 96 : 140,
                      // 更扁的卡片比例，避免带鱼屏上拉伸过高
                      aspectRatio: isMobile ? 'auto' : '21/9',
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
                            filter: 'saturate(0.86) brightness(0.92)',
                          }}
                        />
                        {/* Downward shifted gradient to expose bright beautiful card tops */}
                        <div
                          className="absolute inset-x-0 bottom-0 pointer-events-none h-[75%]"
                          style={{
                            background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.95) 100%)',
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
                      <div className="flex items-start justify-between">
                        <div
                          className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
                          style={{
                            background: `linear-gradient(135deg, ${link.accent}35, ${link.accent}10)`,
                            border: `1px solid ${link.accent}40`,
                            boxShadow: `0 4px 20px -8px ${link.accent}50, inset 0 1px 0 rgba(255,255,255,0.15)`,
                            backdropFilter: 'blur(8px)',
                          }}
                        >
                          <Icon size={18} style={{ color: link.accent, filter: `drop-shadow(0 2px 4px ${link.accent}80)` }} />
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300">
                             <ArrowRight size={16} style={{ color: link.accent, filter: `drop-shadow(0 2px 4px ${link.accent}60)` }} />
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
                      </div>

                      <div className="flex-1" />

                      <div
                        className={`mt-2 font-semibold tracking-tight transition-transform duration-300 group-hover:-translate-y-0.5 ${isMobile ? 'text-[14px]' : 'text-[16px]'}`}
                        style={{ color: 'var(--text-primary, #ffffff)', textShadow: '0 1px 2px rgba(0,0,0,1), 0 2px 8px rgba(0,0,0,0.6)' }}
                      >
                        {link.label}
                      </div>
                      <div
                        className="text-[12px] mt-1.5 leading-relaxed line-clamp-2 transition-transform duration-300 group-hover:-translate-y-0.5 opacity-85 group-hover:opacity-100"
                        style={{ color: 'var(--text-muted, rgba(255,255,255,0.95))', textShadow: '0 1px 2px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.6)' }}
                      >
                        {link.desc}
                      </div>
                    </div>

                    {/* 更新中心卡：底部偶尔「跳出」一条 AI 资讯标题，点卡进入「AI 大事」时间线 */}
                    {isUpdates && <UpdateCenterNewsTeaser />}
                  </button>
                  </Reveal>
                );
              })}
                </div>
              </div>
            )}
          </div>
          {/* end expansive hero banner */}

        <div className={isMobile ? 'px-4 pt-2 pb-8' : 'px-8 pt-4 pb-12'}>
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
                  没有找到匹配的智能体
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
              {/* 智能体：AI + 完备生命周期 + 存储 */}
              {featured.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.agentsHeader} duration={REVEAL_DURATION}>
                    <SectionHeader
                      eyebrow="AGENTS"
                      title="智能体"
                      subtitle={`${featured.length} 个专属智能体，覆盖 PRD / 视觉 / 文学 / 视频 / 缺陷 / 周报 / 审查 / 竞技场 / 涌现`}
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

              {/* 实用工具：缺 AI / 生命周期 / 存储 三要素之一 */}
              {utilities.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.utilitiesHeader} duration={REVEAL_DURATION}>
                    <SectionHeader
                      eyebrow="UTILITIES"
                      title="实用工具"
                      subtitle="快捷指令 · 转录 · 翻译 · 摘要 · 代码审查 · 管理工具 — 按需展开使用"
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

              {/* 基础设施：平台级底座，即使用户隐藏了侧边栏仍在此稳定出现 */}
              {infra.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.infraHeader} duration={REVEAL_DURATION}>
                    <SectionHeader
                      eyebrow="INFRASTRUCTURE"
                      title="基础设施"
                      subtitle="知识库 · 我的资源 · 市场 · 模型 · 团队 · 工作流 — 平台级能力，所有智能体共享"
                      accent="#F59E0B"
                    />
                  </Reveal>
                  <div style={AUTO_GRID_COMPACT}>
                    {infra.map((item, i) => (
                      <Reveal
                        key={item.id}
                        delay={REVEAL.infraCardBase + i * REVEAL.infraCardStep}
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

      {/* 周报海报弹窗:登录后首屏挂载时自动拉取并展示(本会话已关闭则不再弹) */}
      <WeeklyPosterModal />
    </div>
  );
}
