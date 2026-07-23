import { useEffect, useMemo, useState } from 'react';
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
  AudioLines,
  Blocks,
  BookOpen,
  Clapperboard,
  Factory,
  FolderKanban,
  GitPullRequest,
  GraduationCap,
  Store,
  Library,
  Link2,
  ListTree,
  Mail,
  Mic,
  Plug,
  Route,
  Share2,
  Sparkles,
  Sparkle,
  Terminal,
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
  History,
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
import {
  DEFAULT_HOME_QUICK_LINK_IDS,
  MAX_HOME_QUICK_LINKS,
  normalizeHomeQuickLinkIds,
  useHomeLauncherPreferencesStore,
  type HomeQuickLinkId,
} from '@/stores/homeLauncherPreferencesStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { ToolboxItem, RecentWorkItemDto } from '@/services';
import { useHomeRecentWorkStore } from '@/stores/homeRecentWorkStore';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ShowcaseGallery } from '@/components/showcase/ShowcaseGallery';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { Reveal } from '@/pages/home/components/Reveal';
import { getAccent, glassTileStyle } from '@/lib/tileAccent';
import { TipsRotator } from '@/components/daily-tips/TipsRotator';
import { LearningCenterTeaser } from '@/components/daily-tips/LearningCenterTeaser';
import { AgentCardArtwork, AgentCardFrame, AgentCardTask, hasAgentCardArtwork } from '@/components/agent-shell/AgentCardArtwork';

/**
 * 进场动效节奏 —— 区块级一次 fade，不做逐卡级联。
 * 首页是每天进出几十次的工作台，不是营销页：动画只负责"页面不生硬"，
 * 不承担表演任务。每个区块一个 Reveal，总时长控制在半秒内。
 */
const REVEAL_DURATION = 400;
const REVEAL = {
  heroEyebrow: 0,
  heroTitle: 15,
  heroSubtitle: 30,
  heroSearch: 45,
  recent: 60,
  quickLinks: 80,
  agents: 110,
  utilities: 140,
  infra: 170,
  showcase: 200,
};

// ── Icon & Color mapping (self-contained, doesn't touch ToolCard) ──

const ICON_MAP: Record<string, LucideIcon> = {
  AudioLines, Blocks, BookOpen, Clapperboard, Factory, FileText, Palette, PenTool, Bug, Video, Swords, FileBarChart, Code2, Languages, FileSearch, BarChart3, Bot, Workflow, Zap, Globe, ClipboardCheck, ScanSearch, Wand2,
  // 迁移自用户菜单的管理工具
  FlaskConical, ScrollText, Sparkle, Sparkles, Library, Store,
  // 基础设施
  FolderHeart, Cpu, Users, Hammer, FolderKanban, GitPullRequest, GraduationCap, Link2, ListTree, Mail, Mic, Plug, Route, Share2, Terminal,
  PaSecretary,
};

// 色阶尺配色 + 玻璃瓦片表面：SSOT 抽至 lib/tileAccent（百宝箱 ToolCard 共用同一套）

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
  id?: HomeQuickLinkId;
  icon: LucideIcon;
  label: string;
  desc: string;
  path: string;
};

/**
 * 首页置顶入口（扁平导航坞）。
 * - 最多 MAX_HOME_QUICK_LINKS 个，用户可在偏好里定制
 * - 零封面零横幅：入口只承担导航，名称与说明共享同一栅格
 * - 「更新中心」带未读徽章，通过 `id==='updates'` 触发
 */
const QUICK_LINKS_BASE: HomeQuickLink[] = [
  { id: 'marketplace', icon: Store, label: '海鲜市场', desc: '发现和 Fork 优质提示词与配置', path: '/marketplace' },
  { id: 'library', icon: Library, label: '智识殿堂', desc: '探索社区共享的知识库', path: '/library' },
  { id: 'showcase', icon: Sparkles, label: '作品广场', desc: '探索 AI 驱动的创意作品与灵感', path: '/showcase' },
  { id: 'updates', icon: Sparkles, label: '更新中心', desc: '代码级周报 · 本周仓库变更速览', path: '/changelog' },
];

const VOC_QUICK_LINK: HomeQuickLink = {
  id: 'voc',
  icon: Radar,
  label: 'VOC',
  desc: '用户原声闭环 · 行为洞察与 AI 根因诊断',
  path: '/team-activity',
};

const QUICK_LINK_BY_ID: Partial<Record<HomeQuickLinkId, HomeQuickLink>> = {
  marketplace: QUICK_LINKS_BASE[0],
  library: QUICK_LINKS_BASE[1],
  voc: VOC_QUICK_LINK,
  showcase: QUICK_LINKS_BASE[2],
  updates: QUICK_LINKS_BASE[3],
  'document-store': { id: 'document-store', icon: Library, label: '知识库', desc: '文档存储与知识管理，支持文件夹、GitHub 同步', path: '/document-store' },
  'my-assets': { id: 'my-assets', icon: FolderHeart, label: '我的资源', desc: '图片、附件、素材等个人资源统一管理', path: '/visual-agent?tab=assets' },
  'workflow-agent': { id: 'workflow-agent', icon: Workflow, label: '工作流引擎', desc: '可视化工作流编排，自动化多步骤任务串联', path: '/workflow-agent' },
  'web-pages': { id: 'web-pages', icon: Globe, label: '网页托管', desc: '上传 HTML 或 ZIP，托管并分享你的网页', path: '/web-pages' },
  'open-platform': { id: 'open-platform', icon: Code2, label: '开放平台', desc: 'API 签发、应用接入与调用监控', path: '/open-platform' },
  models: { id: 'models', icon: Cpu, label: '模型中心', desc: '大模型与模型池配置、健康监控', path: '/mds' },
  teams: { id: 'teams', icon: Users, label: '团队协作', desc: '团队成员、用户组、分享与协作', path: '/users' },
};

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

// ── Agent Tile（紧凑应用瓦片：图标 + 名称 + 两行描述，无封面） ──
//
// 工作台首页要的是密度与秒认：封面图（近似的星云素材）无法帮助用户区分
// 智能体，却吃掉每张卡大部分面积。封面与悬停视频保留给百宝箱/作品广场
// 这类"逛"的场景，首页一律紧凑瓦片。

function FeaturedCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const Icon = getIcon(item.icon);
  const hasArtwork = hasAgentCardArtwork(item.agentKey);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative w-full h-full overflow-hidden text-left rounded-xl transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 flex flex-col ${hasArtwork ? '' : 'justify-between gap-3 p-4'}`}
      style={{
        ...glassTileStyle(accent),
        minHeight: hasArtwork ? 188 : undefined,
        background: hasArtwork ? 'var(--media-card-base)' : glassTileStyle(accent).background,
        border: hasArtwork ? 'none' : glassTileStyle(accent).border,
      }}
    >
      <AgentCardArtwork agentKey={item.agentKey} compact tint={accent.color} />
      {hasArtwork ? (
        <AgentCardFrame hoverBorder="var(--media-card-border-hover)" />
      ) : (
        <div
          className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
          style={{ boxShadow: `inset 0 0 0 1px ${accent.border}, 0 12px 32px -16px ${accent.glow}` }}
        />
      )}

      {hasArtwork ? (
        <>
          <div className="relative z-10 flex items-start justify-between gap-2 px-3 pt-3">
            <div
              className="max-w-[58%] text-[17px] font-semibold leading-[1.2] tracking-[-0.02em]"
              style={{ color: 'var(--text-on-media)' }}
            >
              {item.name}
            </div>
            <AgentCardTask agentKey={item.agentKey} dense />
          </div>

          <div
            className="relative z-10 mt-auto px-2.5 pb-2.5 pt-2.5"
            style={{
              background: 'var(--media-card-panel-translucent)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                {item.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    className="shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium leading-none"
                    style={{
                      color: 'var(--media-card-tag-text)',
                      background: 'var(--media-card-tag-bg)',
                      borderColor: 'var(--media-card-tag-border)',
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <ArrowRight
                size={15}
                className="shrink-0 opacity-30 transition-[transform,opacity] duration-200 group-hover:translate-x-0.5 group-hover:opacity-[0.65]"
                style={{ color: 'var(--media-card-tag-text)' }}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="relative z-10 flex items-start justify-between">
            <div
              className="shrink-0 w-10 h-10 rounded-[10px] flex items-center justify-center transition-transform duration-200 group-hover:scale-105"
              style={{ background: accent.soft, border: `1px solid ${accent.border}` }}
            >
              <Icon size={19} style={{ color: accent.color }} />
            </div>
            <ArrowRight
              size={15}
              className="shrink-0 mt-1 opacity-0 -translate-x-1 group-hover:opacity-60 group-hover:translate-x-0 transition-all duration-200"
              style={{ color: 'var(--text-muted)' }}
            />
          </div>
          <div className="relative z-10 min-w-0">
            <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {item.name}
            </div>
            <p className="text-[12px] mt-1 leading-relaxed line-clamp-2" style={{ color: 'var(--text-muted)' }}>
              {item.description}
            </p>
          </div>
        </>
      )}
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
      className="group relative w-full cursor-pointer text-left rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 flex items-center gap-3.5 px-4 py-3.5"
      style={glassTileStyle(accent)}
    >
      {/* Hover：本卡色相描边 + 同色投影 */}
      <div
        className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.border}, 0 10px 26px -14px ${accent.glow}` }}
      />

      <div
        className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-transform duration-200 group-hover:scale-105"
        style={{
          background: accent.soft,
          border: `1px solid ${accent.border}`,
        }}
      >
        <Icon size={18} style={{ color: accent.color }} />
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

// ── Recent Work Card（「继续上次」：工作现场，不与下方智能体入口抢层级） ──
//
// 这里展示的是用户正在进行的真实工作，不是导航标签。卡片只呈现后端已提供的
// 类型、标题、时间与可选进度；低矮矩形、弱表面、无封面，保持工作台感。

/** 与后端 HomeRecentWorkController 的 agentKey 枚举一一对应（iconKey 走 ICON_HUE 色阶尺） */
const RECENT_AGENT_META: Record<string, { icon: LucideIcon; label: string; iconKey: string }> = {
  'visual-agent': { icon: Palette, label: '视觉创作', iconKey: 'Palette' },
  'literary-agent': { icon: PenTool, label: '文学创作', iconKey: 'PenTool' },
  'workflow-agent': { icon: Workflow, label: '工作流', iconKey: 'Workflow' },
  'defect-agent': { icon: Bug, label: '缺陷管理', iconKey: 'Bug' },
  'report-agent': { icon: FileBarChart, label: '周报', iconKey: 'FileBarChart' },
  'review-agent': { icon: ClipboardCheck, label: '产品评审', iconKey: 'ClipboardCheck' },
  'document-store': { icon: Library, label: '知识库', iconKey: 'Library' },
};

function RecentWorkCard({ item, onClick }: { item: RecentWorkItemDto; onClick: () => void }) {
  const meta = RECENT_AGENT_META[item.agentKey] ?? { icon: Bot, label: '智能体', iconKey: 'Bot' };
  const accent = getAccent(meta.iconKey);
  const Icon = meta.icon;
  const progress = item.progress == null ? null : Math.max(0, Math.min(1, item.progress));
  return (
    <button
      type="button"
      onClick={onClick}
      title={`继续处理：${item.title}`}
      aria-label={`继续处理${meta.label}工作：${item.title}`}
      className="home-launcher-recent group min-w-0 cursor-pointer text-left rounded-[10px] transition-colors duration-200 focus-visible:outline-none"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = accent.faint;
        e.currentTarget.style.borderColor = accent.border;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '';
        e.currentTarget.style.borderColor = '';
      }}
    >
      <span className="flex min-w-0 items-start gap-3">
        <span
          className="home-launcher-recent-icon inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px]"
          style={{ color: accent.color, background: accent.faint, borderColor: accent.border }}
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="truncate text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
              {meta.label}{item.progressLabel ? ` · ${item.progressLabel}` : ''}
            </span>
            <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
              <RelativeTime value={item.lastActiveAt} refreshIntervalMs={0} />
            </span>
          </span>
          <span className="mt-1 block truncate text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {item.title || '未命名工作'}
          </span>
        </span>
      </span>
      <span className="mt-3 flex items-center gap-3">
        {progress != null ? (
          <span className="home-launcher-recent-progress h-1 min-w-0 flex-1 overflow-hidden rounded-full" aria-hidden>
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.round(progress * 100)}%`, background: accent.color }}
            />
          </span>
        ) : (
          <span className="home-launcher-recent-divider h-px min-w-0 flex-1" aria-hidden />
        )}
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--accent-primary)' }}>
          继续
          <ArrowRight size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </span>
      </span>
    </button>
  );
}

// ── Section Header（/home 风格：eyebrow + title + subtitle + accent 短杠） ──

interface SectionHeaderProps {
  eyebrow: string;
  title: string;
  /** 一句话上下文；禁止关键词堆砌（"覆盖 A / B / C…"是给搜索引擎看的，不是给人看的） */
  subtitle?: string;
  /** 条目数：小徽章呈现，替代把数量写进副标题长句 */
  count?: number;
  /** 区块强调色统一走全站主强调色，不再一区一色 */
  accent?: string;
}

function SectionHeader({ eyebrow, title, subtitle, count, accent = 'var(--section-label-text)' }: SectionHeaderProps) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <div
          className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] uppercase mb-1"
          style={{ color: accent, opacity: 0.85 }}
        >
          <span
            className="inline-block w-4 h-[2px] rounded-full"
            style={{ background: accent }}
          />
          {eyebrow}
        </div>
        <div className="flex items-baseline gap-2.5">
          <h2
            className="text-[19px] font-semibold tracking-tight"
            style={{ color: 'var(--text-primary, #fff)' }}
          >
            {title}
          </h2>
          {typeof count === 'number' && (
            <span
              className="home-launcher-section-count px-1.5 py-0.5 rounded-md text-[12px] font-medium tabular-nums"
            >
              {count}
            </span>
          )}
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

// 高密度自适应：1440px 约五列；21:9 带鱼屏继续增列，同时随视口适度放宽卡片下限。
const AUTO_GRID_FEATURED: React.CSSProperties = {
  display: 'grid',
  gap: 10,
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, clamp(228px, 12vw, 278px)), 1fr))',
  alignItems: 'stretch',
};

const AUTO_GRID_COMPACT: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
};

// ── Main Page ──

export default function AgentLauncherPage() {
  const [searchQuery, setSearchQuery] = useState('');
  // 「继续上次」默认收起只露一行，展开后允许浏览全部脚印
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const { items, itemsLoading, loadItems } = useToolboxStore();
  const { isMobile } = useBreakpoint();
  // 浅色外观（2026-07-17 全局化）下隐藏 hero 的暗色装饰层、改走文字 token，
  // 否则白字/白雾直接糊在纸面上（首页是门面，浅色必须能看）
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

  // 「继续上次」：跨智能体的最近工作现场（无数据时该区块整体不渲染）
  const loadRecentWork = useHomeRecentWorkStore((s) => s.load);
  const recentWorkItems = useHomeRecentWorkStore((s) => s.items);

  const quickLinkIds = useHomeLauncherPreferencesStore((s) => s.quickLinkIds);
  const loadHomeLauncherPreferences = useHomeLauncherPreferencesStore((s) => s.loadFromServer);

  const quickLinks = useMemo<HomeQuickLink[]>(() => {
    const canUseQuickLink = (id: HomeQuickLinkId) => {
      if (id === 'voc') return launcherPerms.canReadTeamActivity;
      if (id === 'open-platform') return launcherPerms.canManageOpenPlatform;
      if (id === 'models') return launcherPerms.canReadModels;
      if (id === 'teams') return launcherPerms.canReadUsers;
      return true;
    };
    const normalizedIds = normalizeHomeQuickLinkIds(quickLinkIds);
    const visibleIds = normalizedIds.filter(canUseQuickLink);
    for (const id of DEFAULT_HOME_QUICK_LINK_IDS) {
      if (visibleIds.length >= MAX_HOME_QUICK_LINKS) break;
      if (!visibleIds.includes(id) && canUseQuickLink(id)) visibleIds.push(id);
    }

    return visibleIds.slice(0, MAX_HOME_QUICK_LINKS).flatMap((id) => {
      const resolvedLink = QUICK_LINK_BY_ID[id];
      if (!resolvedLink) return [];
      return resolvedLink;
    });
  }, [launcherPerms.canManageOpenPlatform, launcherPerms.canReadModels, launcherPerms.canReadTeamActivity, launcherPerms.canReadUsers, quickLinkIds]);

  useEffect(() => {
    loadItems();
    void loadChangelogCurrentWeek({ daysLimit: 8 });
    void loadHomeLauncherPreferences();
    void loadWeeklyPoster();
    // force：同一 SPA 会话内从工作区/缺陷等页面返回首页时，台账已更新，
    // 不能吃 store 的 loaded 缓存（Codex P2）；端点轻量，挂载即重拉
    void loadRecentWork({ force: true });
  }, [loadItems, loadChangelogCurrentWeek, loadHomeLauncherPreferences, loadWeeklyPoster, loadRecentWork]);

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
  const recentPreviewCount = isMobile ? 3 : 5;
  const visibleRecentWork = recentExpanded
    ? recentWorkItems
    : recentWorkItems.slice(0, recentPreviewCount);
  const commandShortcutLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘ K'
    : 'Ctrl K';

  return (
    <div
      className="h-full min-h-0 flex flex-col relative"
      style={{
        background: 'transparent',
      }}
    >
      <div className="flex-1 min-h-0 overflow-auto relative" style={{ zIndex: 1 }}>
        <div aria-hidden className="home-launcher-color-field" />

        {/* ── 页面主体内容（悬浮在背景图之上） ── */}
        <div className="relative z-10">

            {/* 克制型工作台门头：问候、主搜索、学习中心共享同一栅格，不做营销式横幅。 */}
            <div className="home-launcher-masthead relative px-5 pt-6">
              <div className="home-launcher-masthead-grid">
                <div className="home-launcher-intro min-w-0">
                  {/* 小型 eyebrow 标签：品牌定位 */}
                  <Reveal delay={REVEAL.heroEyebrow} duration={REVEAL_DURATION}>
                    <div
                      className="home-launcher-eyebrow inline-flex items-center gap-1.5 mb-2 px-2.5 py-0.5 rounded-full text-[10px] font-medium tracking-[0.08em] uppercase"
                    >
                      <Sparkles size={10} />
                      MAP · 米多智能体生态平台
                    </div>
                  </Reveal>
                  <Reveal delay={REVEAL.heroTitle} duration={REVEAL_DURATION} offset={20}>
                    <h1
                      className={`home-launcher-title font-semibold tracking-tight ${isMobile ? 'text-2xl' : 'text-[34px]'}`}
                      style={{
                        lineHeight: 1.15,
                      }}
                    >
                      {greeting}
                      {displayName ? '，' : ''}
                      {displayName && (
                        <span className="home-launcher-display-name">
                          {displayName}
                        </span>
                      )}
                    </h1>
                  </Reveal>
                  <Reveal delay={REVEAL.heroSubtitle} duration={REVEAL_DURATION}>
                    <div
                      data-tour-id="home-subtitle"
                      className={`home-launcher-subtitle mt-2 ${isMobile ? 'text-sm' : 'text-[15px]'}`}
                      style={{
                        maxWidth: 520,
                      }}
                    >
                      <TipsRotator fallback="选一个智能体开始创作，或在下方的实用工具里探索平台能力" />
                    </div>
                  </Reveal>
                </div>

                <Reveal className="home-launcher-command min-w-0" delay={REVEAL.heroSearch} duration={REVEAL_DURATION}>
                  <div className="relative w-full">
                    <Search
                      size={17}
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--text-muted)' }}
                    />
                    <input
                      data-tour-id="home-search"
                      type="search"
                      placeholder="搜索智能体或工作内容"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      aria-label="搜索智能体或工作内容"
                      className="home-launcher-search h-12 w-full rounded-[11px] pl-11 pr-20 text-[13px] outline-none transition-[background-color,border-color,box-shadow] duration-200"
                    />
                    <kbd className="home-launcher-search-shortcut pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[10px] font-medium">
                      {commandShortcutLabel}
                    </kbd>
                  </div>
                </Reveal>

                <Reveal className="home-launcher-learning min-w-0" delay={REVEAL.heroSearch} duration={REVEAL_DURATION}>
                  <LearningCenterTeaser />
                </Reveal>
              </div>

            {/* 平台级快捷方式：扁平导航坞，靠分隔线建立秩序，不再逐项套胶囊。 */}
            {!searchQuery.trim() && quickLinks.length > 0 && (
              <Reveal className="mt-5" delay={REVEAL.quickLinks} duration={REVEAL_DURATION}>
                <nav
                  aria-label="首页快捷入口"
                  className={`home-launcher-quick-nav home-launcher-quick-nav--${Math.min(quickLinks.length, MAX_HOME_QUICK_LINKS)}`}
                >
                  {quickLinks.map((link) => {
                    const Icon = link.icon;
                    const isUpdates = link.id === 'updates';
                    const showUnread = isUpdates && changelogUnread > 0;
                    return (
                      <button
                        key={link.path}
                        type="button"
                        data-tour-id={`quicklink-${link.id}`}
                        onClick={() => navigate(link.path)}
                        title={link.desc}
                        className="home-launcher-quick-link group flex min-w-0 cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors duration-200 focus-visible:outline-none"
                      >
                        <Icon size={16} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {link.label}
                          </span>
                          <span className="mt-0.5 block truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                            {link.desc}
                          </span>
                        </span>
                        {showUnread && (
                          <span
                            className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold"
                            style={{ background: 'var(--accent-primary)', color: 'var(--bg-base)' }}
                          >
                            {changelogUnread > 9 ? '9+' : changelogUnread}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </nav>
              </Reveal>
            )}

            {/* 继续上次：真实工作现场，收起是一行工作台，展开后浏览全部。 */}
            {!searchQuery.trim() && recentWorkItems.length > 0 && (
              <Reveal className="pb-6 pt-5" delay={REVEAL.recent} duration={REVEAL_DURATION}>
                <section aria-labelledby="home-recent-heading">
                  <div className="mb-3 flex items-end justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[10px] font-semibold tracking-[0.13em]" style={{ color: 'var(--section-label-text)' }}>
                        CONTINUE
                      </div>
                      <div className="mt-1 flex min-w-0 items-baseline gap-2.5">
                        <h2 id="home-recent-heading" className="text-[18px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
                          继续上次
                        </h2>
                        <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          回到最近的工作现场
                        </span>
                      </div>
                    </div>
                    {recentWorkItems.length > recentPreviewCount && (
                      <button
                        type="button"
                        onClick={() => setRecentExpanded((value) => !value)}
                        aria-expanded={recentExpanded}
                        className="home-launcher-recent-more inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 px-2 text-[11.5px] font-medium transition-colors duration-200 focus-visible:outline-none"
                      >
                        <History size={13} />
                        {recentExpanded ? '收起' : `查看全部 ${recentWorkItems.length}`}
                        <ArrowRight
                          size={12}
                          className={`transition-transform duration-200 ${recentExpanded ? '-rotate-90' : 'rotate-0'}`}
                        />
                      </button>
                    )}
                  </div>
                  <div className={`home-launcher-recent-grid ${recentExpanded ? 'is-expanded' : ''}`}>
                    {visibleRecentWork.map((item) => (
                      <RecentWorkCard
                        key={`${item.agentKey}:${item.route}`}
                        item={item}
                        onClick={() => navigate(item.route)}
                      />
                    ))}
                  </div>
                </section>
              </Reveal>
            )}
            </div>
          </div>

        <div className={isMobile ? 'px-4 pt-1 pb-8' : 'px-5 pt-1 pb-12'}>
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
              {/* 智能体：AI + 完备生命周期 + 存储（区块级一次 fade，不做逐卡级联） */}
              {featured.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.agents} duration={REVEAL_DURATION}>
                    <SectionHeader eyebrow="AGENTS" title="智能体" count={featured.length} />
                    <div style={AUTO_GRID_FEATURED}>
                      {featured.map((item) => (
                        <FeaturedCard key={item.id} item={item} onClick={() => handleClick(item)} />
                      ))}
                    </div>
                  </Reveal>
                </section>
              )}

              {/* 实用工具：缺 AI / 生命周期 / 存储 三要素之一 */}
              {utilities.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.utilities} duration={REVEAL_DURATION}>
                    <SectionHeader eyebrow="UTILITIES" title="实用工具" count={utilities.length} />
                    <div style={AUTO_GRID_COMPACT}>
                      {utilities.map((item) => (
                        <CompactCard key={item.id} item={item} onClick={() => handleClick(item)} />
                      ))}
                    </div>
                  </Reveal>
                </section>
              )}

              {/* 基础设施：平台级底座，即使用户隐藏了侧边栏仍在此稳定出现 */}
              {infra.length > 0 && (
                <section className={isMobile ? 'mb-8' : 'mb-10'}>
                  <Reveal delay={REVEAL.infra} duration={REVEAL_DURATION}>
                    <SectionHeader eyebrow="INFRASTRUCTURE" title="基础设施" count={infra.length} subtitle="平台级能力，所有智能体共享" />
                    <div style={AUTO_GRID_COMPACT}>
                      {infra.map((item) => (
                        <CompactCard key={item.id} item={item} onClick={() => handleClick(item)} />
                      ))}
                    </div>
                  </Reveal>
                </section>
              )}

              {/* Showcase Gallery — 作品广场（滚动到视口时由 IntersectionObserver 触发） */}
              <section>
                <Reveal delay={REVEAL.showcase} duration={REVEAL_DURATION}>
                  <SectionHeader
                    eyebrow="SHOWCASE"
                    title="作品广场"
                    subtitle="社区 AI 创意作品流"
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
