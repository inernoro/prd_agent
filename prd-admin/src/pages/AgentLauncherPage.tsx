import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  Radar,
  ChevronDown,
  X,
  type LucideIcon,
} from 'lucide-react';
import { PaSecretary } from '@/lib/paSecretaryIconRegistry';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useAuthStore } from '@/stores/authStore';
import { deriveLauncherPerms, buildStaticAgents, buildStaticUtilities, buildStaticInfra } from '@/lib/homeLauncherItems';
import { useChangelogStore, selectUnreadCount } from '@/stores/changelogStore';
import { useWeeklyPosterStore } from '@/stores/weeklyPosterStore';
import {
  DEFAULT_HOME_QUICK_LINK_IDS,
  MAX_HOME_QUICK_LINKS,
  normalizeHomeQuickLinkIds,
  useHomeLauncherPreferencesStore,
  type HomeQuickLinkId,
} from '@/stores/homeLauncherPreferencesStore';
import { useIsMobile } from '@/hooks/useBreakpoint';
import type { ToolboxItem, RecentWorkItemDto } from '@/services';
import { useHomeRecentWorkStore } from '@/stores/homeRecentWorkStore';
import { useAgentSwitcherStore } from '@/stores/agentSwitcherStore';
import { migrateLegacyNavId } from '@/lib/launcherCatalog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ShowcaseGallery } from '@/components/showcase/ShowcaseGallery';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { WeeklyPosterModal } from '@/components/weekly-poster/WeeklyPosterModal';
import { getAccent, glassTileStyle } from '@/lib/tileAccent';
import { isoWeekNumber } from '@/lib/isoWeek';
import { useHomePulse, formatCompactNumber } from '@/lib/homePulse';
import { TipsRotator } from '@/components/daily-tips/TipsRotator';
import { LearningCenterTeaser } from '@/components/daily-tips/LearningCenterTeaser';
import { AgentCardArtwork, AgentCardFrame, AgentCardTask, hasAgentCardArtwork } from '@/components/agent-shell/AgentCardArtwork';

/**
 * 登录后首页 = 工位（Desk）。
 *
 * 三条纪律（2026-08-02 用户当面拍板）：
 *  1. **密度优先**：这是每天进出几十次的工作台，不是画册。同样一屏要装下
 *     更多真实信息——在办工作、近 7 日用量、动态、以及全部能力目录。
 *  2. **靠面分区，不靠线分区**：结构由实体面板与留白承担；发丝线只在卡片
 *     边缘出现，不做贯通全宽的装饰横线（"全是线条"是明确被否掉的形态）。
 *  3. **纸墨一家**：颜色只来自主题 token 与 lib/tileAccent 的墨系色带
 *     （紫/靛/品红不在色带内），暗浅双主题共用同一支赭红身份色。
 *
 * 与移动首页、未登录官网共享同一套语言：紧凑标题行、实体卡、墨系类别色、
 * 近 7 日同一份数据（lib/homePulse）。
 */

// ── Icon 映射（页面自持，不侵入 ToolCard） ──

const ICON_MAP: Record<string, LucideIcon> = {
  AudioLines, Blocks, BookOpen, Clapperboard, Factory, FileText, Palette, PenTool, Bug, Video, Swords, FileBarChart, Code2, Languages, FileSearch, BarChart3, Bot, Workflow, Zap, Globe, ClipboardCheck, ScanSearch, Wand2,
  FlaskConical, ScrollText, Sparkle, Sparkles, Library, Store,
  FolderHeart, Cpu, Users, Hammer, FolderKanban, GitPullRequest, GraduationCap, Link2, ListTree, Mail, Mic, Plug, Route, Share2, Terminal, Radar,
  PaSecretary,
};

function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] || Bot;
}

function getGreeting(hour: number): string {
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 每分钟对齐一次的「现在」：日期条要跟着走，但不做每秒重绘。 */
function useNowByMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = new Date();
      setNow(current);
      timer = setTimeout(tick, 60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()));
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, []);
  return now;
}

type HomeQuickLink = {
  id?: HomeQuickLinkId;
  icon: LucideIcon;
  label: string;
  desc: string;
  path: string;
};

/** 首页置顶入口（用户可在偏好里定制，最多 MAX_HOME_QUICK_LINKS 个） */
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
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(item);
  }
  return deduped;
}

// ── 目录分组（分段筛选器与组标签共用同一份定义） ──

type CatalogGroupKey = 'agents' | 'tools' | 'infra';
type CatalogFilter = 'all' | CatalogGroupKey;

interface CatalogGroupMeta {
  key: CatalogGroupKey;
  /** 分段筛选器上的短标签 */
  chip: string;
  title: string;
  hint: string;
  layout: 'tile' | 'row';
}

/**
 * 「手边的活儿」与「我的动态」收起态条数：默认只露一半，台面不吃掉整屏；
 * 想看更多走列底部居中的「更多」就地展开，不跳页。
 */
const WORK_PREVIEW_COUNT = 6;

/**
 * 官方精选：编辑部口径的旗舰智能体，**不是**算法排名，所以标签就叫「官方精选」。
 * 想改推荐位改这里一处；顺序即展示顺序。
 */
const FEATURED_AGENT_KEYS = [
  'visual-agent',
  'literary-agent',
  'defect-agent',
  'report-agent',
  'md-to-ppt-agent',
  'pr-review',
];

/** 「你常用的」进榜门槛：打开过 2 次以上才算习惯，避免一次误点就占推荐位 */
const FREQUENT_MIN_USAGE = 2;
const FREQUENT_MAX = 6;

const CATALOG_GROUPS: CatalogGroupMeta[] = [
  { key: 'agents', chip: '智能体', title: '智能体', hint: 'AI 参与、生命周期完整、产物可留存', layout: 'tile' },
  { key: 'tools', chip: '工具', title: '实用工具', hint: '单点能力，打开即用', layout: 'row' },
  { key: 'infra', chip: '底座', title: '基础设施', hint: '平台级能力，所有智能体共享', layout: 'row' },
];

// ── 智能体瓦片（有插画走大图卡，无插画走图标卡） ──

function AgentTile({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const Icon = getIcon(item.icon);
  const hasArtwork = hasAgentCardArtwork(item.agentKey);

  return (
    <button
      type="button"
      onClick={onClick}
      title={item.description}
      className={`home-desk-tile group relative w-full h-full overflow-hidden text-left rounded-[10px] flex flex-col ${hasArtwork ? 'is-art' : 'justify-between gap-2 p-3'}`}
      style={{
        ...glassTileStyle(accent),
        minHeight: hasArtwork ? 158 : undefined,
        background: hasArtwork ? 'var(--media-card-base)' : glassTileStyle(accent).background,
        border: hasArtwork ? 'none' : glassTileStyle(accent).border,
      }}
    >
      <AgentCardArtwork agentKey={item.agentKey} compact tint={accent.color} />
      {hasArtwork ? (
        <AgentCardFrame hoverBorder="var(--media-card-border-hover)" />
      ) : (
        <div
          className="absolute inset-0 rounded-[10px] opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
          style={{ boxShadow: `inset 0 0 0 1px ${accent.border}, 0 10px 26px -16px ${accent.glow}` }}
        />
      )}

      {hasArtwork ? (
        <>
          <div className="relative z-10 flex items-start justify-between gap-2 px-2.5 pt-2.5">
            <div
              className="max-w-[60%] text-[15px] font-semibold leading-[1.22] tracking-[-0.01em]"
              style={{ color: 'var(--text-on-media)' }}
            >
              {item.name}
            </div>
            <AgentCardTask agentKey={item.agentKey} dense />
          </div>

          <div
            className="relative z-10 mt-auto px-2 pb-2 pt-2"
            style={{
              background: 'var(--media-card-panel-translucent)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                {item.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none"
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
                size={14}
                className="shrink-0 opacity-30 transition-[transform,opacity] duration-200 group-hover:translate-x-0.5 group-hover:opacity-[0.65]"
                style={{ color: 'var(--media-card-tag-text)' }}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          <div
            className="relative z-10 shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-transform duration-200 group-hover:scale-105"
            style={{ background: accent.soft, border: `1px solid ${accent.border}` }}
          >
            <Icon size={16} style={{ color: accent.color }} />
          </div>
          <div className="relative z-10 min-w-0">
            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {item.name}
            </div>
            <p className="text-[12px] mt-0.5 leading-snug line-clamp-2" style={{ color: 'var(--text-muted)' }}>
              {item.description}
            </p>
          </div>
        </>
      )}
    </button>
  );
}

// ── 工具/底座行卡（横向紧凑，密度优先） ──

function ToolRow({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const Icon = getIcon(item.icon);

  return (
    <button
      type="button"
      onClick={onClick}
      title={item.description}
      className="home-desk-row group relative w-full cursor-pointer text-left rounded-[10px] overflow-hidden flex items-center gap-2.5 px-2.5 py-2"
      style={glassTileStyle(accent)}
    >
      <div
        className="absolute inset-0 rounded-[10px] opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.border}` }}
      />
      <div
        className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center"
        style={{ background: accent.soft, border: `1px solid ${accent.border}` }}
      >
        <Icon size={14} style={{ color: accent.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {item.name}
        </div>
        <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
          {item.description}
        </div>
      </div>
    </button>
  );
}

// ── 在办工作卡（首屏主产物：真实工作现场） ──

/** 与后端 HomeRecentWorkController 的 agentKey 枚举一一对应 */
const RECENT_AGENT_META: Record<string, { icon: LucideIcon; label: string; iconKey: string }> = {
  'visual-agent': { icon: Palette, label: '视觉创作', iconKey: 'Palette' },
  'literary-agent': { icon: PenTool, label: '文学创作', iconKey: 'PenTool' },
  'workflow-agent': { icon: Workflow, label: '工作流', iconKey: 'Workflow' },
  'defect-agent': { icon: Bug, label: '缺陷管理', iconKey: 'Bug' },
  'report-agent': { icon: FileBarChart, label: '周报', iconKey: 'FileBarChart' },
  'review-agent': { icon: ClipboardCheck, label: '产品评审', iconKey: 'ClipboardCheck' },
  'document-store': { icon: Library, label: '知识库', iconKey: 'Library' },
};

function WorkCard({ item, onClick }: { item: RecentWorkItemDto; onClick: () => void }) {
  const meta = RECENT_AGENT_META[item.agentKey] ?? { icon: Bot, label: '智能体', iconKey: 'Bot' };
  const accent = getAccent(meta.iconKey);
  const Icon = meta.icon;
  const progress = item.progress == null ? null : Math.round(Math.max(0, Math.min(1, item.progress)) * 100);

  return (
    <button
      type="button"
      onClick={onClick}
      title={`继续处理：${item.title}`}
      aria-label={`继续处理${meta.label}工作：${item.title}`}
      className="home-desk-work group"
      style={{
        '--work-accent': accent.color,
        '--work-accent-text': accent.text,
        '--work-accent-soft': accent.soft,
      } as CSSProperties}
    >
      <span className="home-desk-work-icon" aria-hidden>
        <Icon size={13} />
      </span>
      <span className="home-desk-work-title">{item.title || '未命名工作'}</span>
      <span className="home-desk-work-agent">{meta.label}</span>
      <span className="home-desk-work-state-slot">
        {item.progressLabel && (
          <span className="home-desk-work-state">
            {item.progressLabel}
            {progress != null ? ` ${progress}%` : ''}
          </span>
        )}
      </span>
      <span className="home-desk-work-time">
        <RelativeTime value={item.lastActiveAt} refreshIntervalMs={0} />
      </span>
    </button>
  );
}

// ── 紧凑区块标题（实心排版，不用贯通横线） ──

function SectionHead({
  title,
  count,
  hint,
  action,
  headingId,
}: {
  title: string;
  count?: number;
  hint?: string;
  action?: ReactNode;
  headingId?: string;
}) {
  return (
    <div className="home-desk-sec-head">
      <h2 id={headingId} className="home-desk-sec-title">{title}</h2>
      {typeof count === 'number' && <span className="home-desk-sec-count">{count}</span>}
      {hint && <span className="home-desk-sec-hint">{hint}</span>}
      <span className="home-desk-sec-gap" />
      {action}
    </div>
  );
}

// ── 页面 ──

export default function AgentLauncherPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>('all');
  // 收起时铺满左栏（两列六行），与右侧「近 7 日 + 我的动态」大致等高，
  // 不在工作带里留一块空白；有更多脚印时由「全部 N」展开。
  const [workExpanded, setWorkExpanded] = useState(false);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const { items, itemsLoading, loadItems } = useToolboxStore();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions ?? []);
  const now = useNowByMinute();

  const canUseReviewAgent = permissions.includes('review-agent.use');
  const canUsePrReview = permissions.includes('pr-review.use');
  const launcherPerms = useMemo(() => deriveLauncherPerms(permissions), [permissions]);

  const changelogUnread = useChangelogStore(selectUnreadCount);
  const loadChangelogCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  const loadWeeklyPoster = useWeeklyPosterStore((s) => s.loadCurrent);

  const loadRecentWork = useHomeRecentWorkStore((s) => s.load);
  const workItems = useHomeRecentWorkStore((s) => s.items);

  // 近 7 日 + 我的动态：与移动首页同一份数据源
  const pulse = useHomePulse(8);

  // 真实打开次数（agentSwitcherStore 已把 usageCounts / recentVisits 同步到服务端）
  const usageCounts = useAgentSwitcherStore((s) => s.usageCounts);
  const recentVisits = useAgentSwitcherStore((s) => s.recentVisits);

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
      const resolved = QUICK_LINK_BY_ID[id];
      return resolved ? [resolved] : [];
    });
  }, [launcherPerms.canManageOpenPlatform, launcherPerms.canReadModels, launcherPerms.canReadTeamActivity, launcherPerms.canReadUsers, quickLinkIds]);

  useEffect(() => {
    loadItems();
    void loadChangelogCurrentWeek({ daysLimit: 8 });
    void loadHomeLauncherPreferences();
    void loadWeeklyPoster();
    // force：从工作区返回首页时台账已更新，不吃 store 缓存（Codex P2）
    void loadRecentWork({ force: true });
  }, [loadItems, loadChangelogCurrentWeek, loadHomeLauncherPreferences, loadWeeklyPoster, loadRecentWork]);

  const staticAgents: ToolboxItem[] = useMemo(() => buildStaticAgents(), []);
  const staticUtilities: ToolboxItem[] = useMemo(() => buildStaticUtilities(launcherPerms), [launcherPerms]);
  const staticInfra: ToolboxItem[] = useMemo(() => buildStaticInfra(launcherPerms), [launcherPerms]);

  /** 三组目录：`all` 与单组视图走同一条渲染路径，避免两套分支各自漂移。 */
  const groups = useMemo<Record<CatalogGroupKey, ToolboxItem[]>>(() => {
    const agents: ToolboxItem[] = [];
    const tools: ToolboxItem[] = [];
    for (const item of dedupeToolboxItems(items)) {
      if (item.agentKey === 'review-agent' && !canUseReviewAgent) continue;
      if (item.agentKey === 'pr-review' && !canUsePrReview) continue;
      if (item.kind === 'tool') tools.push(item);
      else if (item.kind === 'agent' || item.routePath) agents.push(item);
      else tools.push(item);
    }
    agents.push(...staticAgents);
    tools.push(...staticUtilities);
    return { agents, tools, infra: staticInfra };
  }, [items, staticAgents, staticUtilities, staticInfra, canUseReviewAgent, canUsePrReview]);

  const query = searchQuery.trim().toLowerCase();

  /** 搜索横跨三组（用户不关心一个入口被我们归到哪一类）。 */
  const searchResults = useMemo<ToolboxItem[]>(() => {
    if (!query) return [];
    const all = dedupeToolboxItems([...groups.agents, ...groups.tools, ...groups.infra]);
    return all.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  }, [groups, query]);

  /**
   * 首页唯一的跳转出口。
   *
   * 「你常用的」那一档只认 agentSwitcherStore 的打开次数，而记账点漏一个，
   * 那条路径的启动就永远不计数（先漏了瓦片点击，又漏了在办工作条）。
   * 所以这里收成一个出口：**本文件不允许再出现第二个 navigate 调用**，
   * 带 entry 的调用自动记账，纯内容跳转（动态流）显式不记。
   * 守卫见 themeSystem.test.ts 的「首页跳转只有一个出口」用例。
   */
  const openRoute = useCallback((route: string, entry?: { id: string; agentKey?: string; name: string; icon?: string }) => {
    if (entry) {
      useAgentSwitcherStore.getState().addRecentVisit({
        // 首页历史上用过 __xxx__ 形态，统一交给 migrateLegacyNavId 归一到命令面板同款 id
        id: migrateLegacyNavId(entry.agentKey || entry.id),
        agentKey: entry.agentKey ?? '',
        agentName: entry.name,
        title: entry.name,
        path: route,
        icon: entry.icon,
      });
    }
    navigate(route);
  }, [navigate]);

  const handleClick = useCallback((item: ToolboxItem) => {
    if (item.agentKey === 'prd-agent') {
      setDownloadDialogOpen(true);
      return;
    }
    if (!item.routePath) {
      useToolboxStore.getState().selectItem(item);
    }
    openRoute(item.routePath || '/ai-toolbox', {
      id: item.id,
      agentKey: item.agentKey,
      name: item.name,
      icon: item.icon,
    });
  }, [openRoute]);

  // 斜杠聚焦：不与全局 ⌘K（智能体浮层）抢键位
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const greeting = getGreeting(now.getHours());
  const displayName = user?.displayName || '';
  const dateLine = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEKDAY_LABELS[now.getDay()]} · 第 ${isoWeekNumber(now)} 周`;
  const totalCount = groups.agents.length + groups.tools.length + groups.infra.length;
  const visibleGroups = CATALOG_GROUPS.filter((g) => (catalogFilter === 'all' || catalogFilter === g.key) && groups[g.key].length > 0);

  const statCells = [
    { label: 'AI 调用', value: pulse.stats?.aiCalls ?? 0 },
    { label: '生图', value: pulse.stats?.imageGenerations ?? 0 },
    { label: '缺陷', value: pulse.stats?.defects ?? 0 },
    { label: 'Token', value: pulse.stats?.totalTokens ?? 0 },
  ];

  /**
   * 智能体分三档，回答"我该点哪个"：
   *  - 你常用的：来自 agentSwitcherStore 的真实打开次数（服务端持久化），
   *    没到门槛就整档不出现——不编造"猜你喜欢"
   *  - 官方精选：编辑部口径的旗舰位，如实标注是"官方"选的
   *  - 更多智能体：其余全部，一个都不藏
   */
  const agentShelves = useMemo(() => {
    const all = groups.agents;
    const usageOf = (item: ToolboxItem) => {
      // 首页与命令面板写的是同一个归一化 id；路径匹配作为老数据的兜底
      const canonical = migrateLegacyNavId(item.agentKey || item.id);
      const byRoute = recentVisits.find((v) => v.path && item.routePath && v.path === item.routePath);
      return usageCounts[canonical] ?? (byRoute ? usageCounts[byRoute.id] ?? 0 : 0);
    };

    const frequent = all
      .map((item) => ({ item, count: usageOf(item) }))
      .filter((entry) => entry.count >= FREQUENT_MIN_USAGE)
      .sort((a, b) => b.count - a.count)
      .slice(0, FREQUENT_MAX)
      .map((entry) => entry.item);

    const frequentIds = new Set(frequent.map((item) => item.id));
    const featured = FEATURED_AGENT_KEYS
      .flatMap((key) => all.filter((item) => item.agentKey === key))
      .filter((item) => !frequentIds.has(item.id));

    const shownIds = new Set([...frequentIds, ...featured.map((item) => item.id)]);
    const rest = all.filter((item) => !shownIds.has(item.id));

    return [
      { key: 'frequent', title: '你常用的', hint: '按你的真实打开次数排', items: frequent },
      { key: 'featured', title: '官方精选', hint: '编辑部挑的旗舰位，不是算法排名', items: featured },
      { key: 'rest', title: '更多智能体', hint: '其余全部，一个都不藏', items: rest },
    ].filter((shelf) => shelf.items.length > 0);
  }, [groups.agents, recentVisits, usageCounts]);

  const renderGroupBody = (meta: CatalogGroupMeta, list: ToolboxItem[]) =>
    meta.layout === 'tile' ? (
      <div className="home-desk-grid-tile">
        {list.map((item) => (
          <AgentTile key={item.id} item={item} onClick={() => handleClick(item)} />
        ))}
      </div>
    ) : (
      <div className="home-desk-grid-row">
        {list.map((item) => (
          <ToolRow key={item.id} item={item} onClick={() => handleClick(item)} />
        ))}
      </div>
    );

  return (
    <div className="home-desk h-full min-h-0 flex flex-col relative">
      <div className="flex-1 min-h-0 overflow-auto relative" style={{ zIndex: 1 }}>
        <div aria-hidden className="home-launcher-color-field" />

        <div className="home-desk-inner relative z-10">
          {/* ── 状态栏：无框、纯文字，只报"此刻 + 你是谁"，不参与容器竞争 ── */}
          <header className="home-desk-statusbar">
            <span className="home-desk-clock">
              {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
            </span>
            <span className="home-desk-dateline">{dateLine}</span>
            <span className="home-desk-status-gap" />
            <span className="home-desk-status-learning">
              <LearningCenterTeaser />
            </span>
          </header>

          <div className="home-desk-greet-row">
            <h1 className={`home-desk-greet ${isMobile ? 'is-compact' : ''}`}>
              {greeting}
              {displayName ? '，' : ''}
              {displayName && <span className="home-launcher-display-name">{displayName}</span>}
            </h1>
            <div data-tour-id="home-subtitle" className="home-desk-tips">
              <TipsRotator fallback="选一个智能体开始创作，或按下斜杠键直接搜索平台能力" />
            </div>
          </div>

          {/* ── 台面：上层唯一的容器。命令条 + 用量 + 常去 + 在办 + 动态全在里面 ── */}
          <div className="home-desk-deck">
            <div className="home-desk-deck-top">
              <div className="home-desk-command-field">
                <Search size={16} className="home-desk-command-icon" aria-hidden />
                <input
                  ref={searchRef}
                  data-tour-id="home-search"
                  type="search"
                  placeholder="搜索智能体、工具或平台能力"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchQuery('');
                      e.currentTarget.blur();
                    }
                    if (e.key === 'Enter' && searchResults.length > 0) handleClick(searchResults[0]);
                  }}
                  aria-label="搜索智能体、工具或平台能力"
                  className="home-desk-command-input"
                />
                {query ? (
                  <span className="home-desk-command-meta">
                    <span className="home-desk-command-hint">
                      {searchResults.length > 0 ? `${searchResults.length} 项 · 回车打开第一项` : '无匹配'}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}
                      aria-label="清空搜索"
                      className="home-desk-command-clear"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ) : (
                  <kbd className="home-desk-command-kbd" aria-hidden>/</kbd>
                )}
              </div>

              {/* 近 7 日：从独立面板降级为命令条右侧的一条数字，不再自成一块 */}
              <dl className="home-desk-kpis" aria-label="近 7 日真实用量">
                {statCells.map((cell) => (
                  <div key={cell.label} className="home-desk-kpi">
                    <dt className="home-desk-kpi-label">{cell.label}</dt>
                    <dd className={`home-desk-kpi-value ${cell.value > 0 ? '' : 'is-zero'}`}>
                      {pulse.loading ? '—' : formatCompactNumber(cell.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {!query && quickLinks.length > 0 && (
              <nav aria-label="首页快捷入口" className="home-desk-quick">
                {quickLinks.map((link) => {
                  const Icon = link.icon;
                  const showUnread = link.id === 'updates' && changelogUnread > 0;
                  return (
                    <button
                      key={link.path}
                      type="button"
                      data-tour-id={`quicklink-${link.id}`}
                      onClick={() => openRoute(link.path, { id: link.id ?? link.path, name: link.label })}
                      title={link.desc}
                      className="home-desk-quick-item"
                    >
                      <Icon size={13} className="shrink-0" />
                      <span className="truncate">{link.label}</span>
                      {showUnread && <span className="home-desk-badge">{changelogUnread > 9 ? '9+' : changelogUnread}</span>}
                    </button>
                  );
                })}
              </nav>
            )}

            {!query && (
              <div className="home-desk-deck-body">
                <section className="home-desk-col" aria-labelledby="home-continue-heading">
                  <SectionHead
                    title="手边的活儿"
                    count={workItems.length > 0 ? workItems.length : undefined}
                    headingId="home-continue-heading"
                  />
                  {workItems.length > 0 ? (
                    <div className="home-desk-work-list">
                      {(workExpanded ? workItems : workItems.slice(0, WORK_PREVIEW_COUNT)).map((item) => (
                        <WorkCard
                          key={`${item.agentKey}:${item.route}`}
                          item={item}
                          onClick={() => openRoute(item.route, {
                            id: item.agentKey,
                            agentKey: item.agentKey,
                            name: RECENT_AGENT_META[item.agentKey]?.label ?? '智能体',
                          })}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="home-desk-empty">
                      还没有进行中的工作。挑一个智能体开始，或按
                      <kbd className="home-desk-empty-kbd">/</kbd>
                      搜索——做过的事会自动回到这里。
                    </p>
                  )}
                  {workItems.length > WORK_PREVIEW_COUNT && (
                    <button
                      type="button"
                      className="home-desk-expand"
                      aria-expanded={workExpanded}
                      onClick={() => setWorkExpanded((v) => !v)}
                    >
                      <ChevronDown size={13} className={workExpanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
                      {workExpanded ? '收起' : `更多 ${workItems.length - WORK_PREVIEW_COUNT} 条`}
                    </button>
                  )}
                </section>

                <section className="home-desk-col home-desk-col--feed" aria-labelledby="home-feed-heading">
                  <SectionHead
                    title="我的动态"
                    headingId="home-feed-heading"
                    action={
                      <button type="button" className="home-desk-more" onClick={() => openRoute('/visual-agent?tab=assets', { id: 'my-assets', name: '我的资源' })}>
                        我的资源<ArrowRight size={12} />
                      </button>
                    }
                  />
                  {pulse.feed.length === 0 ? (
                    <p className="home-desk-empty">用过知识库、周报、生图或缺陷之后，动态会出现在这里。</p>
                  ) : (
                    <ul className="home-desk-feed">
                      {pulse.feed.slice(0, WORK_PREVIEW_COUNT).map((entry) => (
                        <li key={entry.id}>
                          <button type="button" className="home-desk-feed-row" onClick={() => openRoute(entry.navigateTo)}>
                            <span className={`home-desk-feed-dot is-${entry.type}`} aria-hidden />
                            <span className="home-desk-feed-title">{entry.title}</span>
                            <span className="home-desk-feed-time">
                              <RelativeTime value={entry.updatedAt} refreshIntervalMs={0} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </div>

          {/* ── 目录 ── */}
          {itemsLoading ? (
            <div className="flex items-center justify-center h-40">
              <MapSpinner size={24} color="var(--accent-primary)" />
            </div>
          ) : query ? (
            <section className="home-desk-section" aria-labelledby="home-search-heading">
              <SectionHead
                title="搜索结果"
                count={searchResults.length}
                hint={`关键词「${searchQuery.trim()}」`}
                headingId="home-search-heading"
              />
              {searchResults.length === 0 ? (
                <p className="home-desk-empty">没有匹配的能力。换个说法试试，或者清空搜索回到目录。</p>
              ) : (
                // 搜索结果一律用瓦片：混排行卡会被瓦片栅格拉成等高，反而更乱
                <div className="home-desk-grid-tile">
                  {searchResults.map((item) => (
                    <AgentTile key={item.id} item={item} onClick={() => handleClick(item)} />
                  ))}
                </div>
              )}
            </section>
          ) : (
            <>
              <section className="home-desk-section" aria-labelledby="home-catalog-heading">
                <SectionHead
                  title="全部能力"
                  count={totalCount}
                  hint="平台上所有能开工的入口"
                  headingId="home-catalog-heading"
                  action={
                    <div className="home-desk-seg" role="group" aria-label="按类型筛选平台能力">
                      <button
                        type="button"
                        className="home-desk-seg-btn"
                        aria-pressed={catalogFilter === 'all'}
                        onClick={() => setCatalogFilter('all')}
                      >
                        全部<span className="home-desk-seg-num">{totalCount}</span>
                      </button>
                      {CATALOG_GROUPS.map((g) => (
                        <button
                          key={g.key}
                          type="button"
                          className="home-desk-seg-btn"
                          aria-pressed={catalogFilter === g.key}
                          onClick={() => setCatalogFilter(g.key)}
                        >
                          {g.chip}<span className="home-desk-seg-num">{groups[g.key].length}</span>
                        </button>
                      ))}
                    </div>
                  }
                />

                {visibleGroups.length === 0 && (
                  <p className="home-desk-empty">这一类当前没有可用入口，切回「全部」看看别的。</p>
                )}

                {visibleGroups.map((meta) => (
                  <div key={meta.key} className="home-desk-group">
                    {meta.key === 'agents' ? (
                      agentShelves.map((shelf) => (
                        <div key={shelf.key} className="home-desk-shelf">
                          <div className="home-desk-group-label">
                            <span className="home-desk-group-name">{shelf.title}</span>
                            <span className="home-desk-group-count">{shelf.items.length}</span>
                            <span className="home-desk-group-hint">{shelf.hint}</span>
                          </div>
                          {renderGroupBody(meta, shelf.items)}
                        </div>
                      ))
                    ) : (
                      <>
                        <div className="home-desk-group-label">
                          <span className="home-desk-group-name">{meta.title}</span>
                          <span className="home-desk-group-count">{groups[meta.key].length}</span>
                          <span className="home-desk-group-hint">{meta.hint}</span>
                        </div>
                        {renderGroupBody(meta, groups[meta.key])}
                      </>
                    )}
                  </div>
                ))}
              </section>

              <section className="home-desk-section" aria-labelledby="home-showcase-heading">
                <SectionHead title="作品广场" hint="社区 AI 创意作品流" headingId="home-showcase-heading" />
                <ShowcaseGallery />
              </section>
            </>
          )}
        </div>
      </div>

      <DesktopDownloadDialog open={downloadDialogOpen} onOpenChange={setDownloadDialogOpen} />

      {/* 周报海报弹窗：登录后首屏挂载时自动拉取并展示（本会话已关闭则不再弹） */}
      <WeeklyPosterModal />
    </div>
  );
}
