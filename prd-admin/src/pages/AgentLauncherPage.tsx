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
import { RelativeTime } from '@/components/ui/RelativeTime';
import { ShowcaseGallery } from '@/components/showcase/ShowcaseGallery';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { WeeklyPosterModal } from '@/components/weekly-poster/WeeklyPosterModal';
import { Reveal } from '@/pages/home/components/Reveal';
import { getAccent, glassTileStyle } from '@/lib/tileAccent';
import { isoWeekNumber } from '@/lib/isoWeek';
import { TipsRotator } from '@/components/daily-tips/TipsRotator';
import { LearningCenterTeaser } from '@/components/daily-tips/LearningCenterTeaser';
import { AgentCardArtwork, AgentCardFrame, AgentCardTask, hasAgentCardArtwork } from '@/components/agent-shell/AgentCardArtwork';

/**
 * 登录后首页 = 工位（Desk），不是应用商店货架。
 *
 * 设计取向（2026-08-02 重做）：
 *  1. 门头只回答「今天几号、你是谁、从哪开始」——日期条（mono）+ 问候 + 一条
 *     贯通的命令条。命令条不再和问候语抢同一行栅格，它是门头唯一的主操作。
 *  2. 「手边的活儿」升格为首屏主产物：真实在办工作占据最大面积，收起时正好一行，
 *     展开才铺开（`content-fills-canvas` / `expectation-management`：先答"从哪继续"）。
 *  3. 目录从「三段各自堆叠 50 张卡」改成「一个分段筛选器 + 一片连续目录」：
 *     默认「全部」仍完整展示三组（导航登记不受影响），但用户可一键只看底座/工具，
 *     不必滚过 35 张智能体卡（`chief-designer-usability` 第四原则：能短就短）。
 *  4. 结构靠发丝线与留白建立，不靠层层套盒；颜色只出现在图标芯片、在办工作的
 *     色边与 hover 描边上，静时安静（沿用 `lib/tileAccent` 的色阶尺 SSOT）。
 */

/** 进场动效：区块级一次 fade，总时长半秒内，不做逐卡级联。 */
const REVEAL_DURATION = 400;
const REVEAL = {
  masthead: 0,
  command: 40,
  quickLinks: 70,
  continue: 100,
  catalog: 140,
  showcase: 180,
};

// ── Icon 映射（页面自持，不侵入 ToolCard） ──

const ICON_MAP: Record<string, LucideIcon> = {
  AudioLines, Blocks, BookOpen, Clapperboard, Factory, FileText, Palette, PenTool, Bug, Video, Swords, FileBarChart, Code2, Languages, FileSearch, BarChart3, Bot, Workflow, Zap, Globe, ClipboardCheck, ScanSearch, Wand2,
  // 迁移自用户菜单的管理工具
  FlaskConical, ScrollText, Sparkle, Sparkles, Library, Store,
  // 基础设施
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

/** 每分钟对齐一次的「现在」：门头日期条要跟着走，但不做每秒重绘。 */
function useNowByMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = new Date();
      setNow(current);
      // 对齐到下一个整分，避免长时间运行后累积漂移
      timer = setTimeout(tick, 60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()));
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(timer);
  }, []);
  return now;
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

// ── 目录分组（分段筛选器与区块标题共用同一份定义，避免两处漂移） ──

type CatalogGroupKey = 'agents' | 'tools' | 'infra';
type CatalogFilter = 'all' | CatalogGroupKey;

interface CatalogGroupMeta {
  key: CatalogGroupKey;
  /** 分段筛选器上的短标签（寸土寸金，只给两三个字） */
  chip: string;
  title: string;
  hint: string;
  layout: 'tile' | 'row';
}

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
      className={`home-desk-tile group relative w-full h-full overflow-hidden text-left rounded-xl flex flex-col ${hasArtwork ? 'is-art' : 'justify-between gap-3 p-4'}`}
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

// ── 工具/底座行卡（横向紧凑，密度优先） ──

function ToolRow({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const Icon = getIcon(item.icon);

  return (
    <button
      type="button"
      onClick={onClick}
      className="home-desk-row group relative w-full cursor-pointer text-left rounded-xl overflow-hidden flex items-center gap-3.5 px-4 py-3.5"
      style={glassTileStyle(accent)}
    >
      <div
        className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.border}, 0 10px 26px -14px ${accent.glow}` }}
      />

      <div
        className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-transform duration-200 group-hover:scale-105"
        style={{ background: accent.soft, border: `1px solid ${accent.border}` }}
      >
        <Icon size={18} style={{ color: accent.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {item.name}
        </div>
        <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
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

// ── 在办工作卡（首屏主产物：真实工作现场，不是导航标签） ──

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

function WorkCard({ item, onClick }: { item: RecentWorkItemDto; onClick: () => void }) {
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
      className="home-desk-work group"
      style={{
        '--work-accent': accent.color,
        '--work-accent-text': accent.text,
        '--work-accent-faint': accent.faint,
        '--work-accent-border': accent.border,
        '--work-accent-glow': accent.glow,
      } as CSSProperties}
    >
      <span aria-hidden className="home-desk-work-edge" />

      <span className="home-desk-work-head">
        <span className="home-desk-work-agent">
          <Icon size={13} className="shrink-0" />
          <span className="truncate">{meta.label}</span>
        </span>
        <span className="home-desk-work-time">
          <RelativeTime value={item.lastActiveAt} refreshIntervalMs={0} />
        </span>
      </span>

      <span className="home-desk-work-title">{item.title || '未命名工作'}</span>

      <span className="home-desk-work-foot">
        {progress != null ? (
          <span className="home-desk-work-track" aria-hidden>
            <span className="home-desk-work-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        ) : (
          <span className="home-desk-work-divider" aria-hidden />
        )}
        {item.progressLabel && <span className="home-desk-work-state">{item.progressLabel}</span>}
        <span className="home-desk-work-cta">
          继续
          <ArrowRight size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </span>
      </span>
    </button>
  );
}

// ── 区块标题：eyebrow 压在一条贯通的发丝线上，右侧留给该区块自己的操作 ──

function DeskSectionHead({
  eyebrow,
  title,
  hint,
  count,
  action,
  headingId,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
  count?: number;
  action?: ReactNode;
  headingId?: string;
}) {
  return (
    <div className="home-desk-head">
      <div className="home-desk-head-rule">
        <span className="home-desk-eyebrow">{eyebrow}</span>
        <span className="home-desk-rule" aria-hidden />
        {action}
      </div>
      <div className="home-desk-head-line">
        <h2 id={headingId} className="home-desk-head-title">{title}</h2>
        {typeof count === 'number' && <span className="home-desk-count">{count}</span>}
        {hint && <span className="home-desk-head-hint">{hint}</span>}
      </div>
    </div>
  );
}

// ── 页面 ──

export default function AgentLauncherPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>('all');
  // 「手边的活儿」默认收起为一行，展开后浏览全部足迹
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
  // 启动器静态入口的权限门（智能体/实用工具/基础设施），口径与移动端共用同一 SSOT
  const launcherPerms = useMemo(() => deriveLauncherPerms(permissions), [permissions]);

  // 更新中心未读数（首页快捷入口的红点徽章）
  const changelogUnread = useChangelogStore(selectUnreadCount);
  const loadChangelogCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);

  // 周报海报（主页弹窗）
  const loadWeeklyPoster = useWeeklyPosterStore((s) => s.loadCurrent);

  // 「手边的活儿」：跨智能体的真实工作现场（无数据时降级为一行引导）
  const loadRecentWork = useHomeRecentWorkStore((s) => s.load);
  const workItems = useHomeRecentWorkStore((s) => s.items);

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

  // 静态入口（智能体 / 实用工具 / 基础设施）—— SSOT 在 lib/homeLauncherItems（桌面+移动共用）
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
      // kind === 'agent'（或默认带 routePath 的内置条目）进智能体；其余进工具
      if (item.kind === 'tool') tools.push(item);
      else if (item.kind === 'agent' || item.routePath) agents.push(item);
      else tools.push(item);
    }
    agents.push(...staticAgents);
    tools.push(...staticUtilities);
    return { agents, tools, infra: staticInfra };
  }, [items, staticAgents, staticUtilities, staticInfra, canUseReviewAgent, canUsePrReview]);

  const query = searchQuery.trim().toLowerCase();

  /** 搜索横跨全部三组（用户不关心一个入口被我们归到哪一类）。 */
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

  const handleClick = useCallback((item: ToolboxItem) => {
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
  }, [navigate]);

  // 斜杠聚焦：命令条是首页最快的入口，给它一个不与全局 ⌘K（智能体浮层）冲突的键位
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
          {/* ── 门头：日期条 + 问候 + 教程承接卡 ── */}
          <Reveal delay={REVEAL.masthead} duration={REVEAL_DURATION}>
            <header className="home-launcher-masthead-grid">
              <div className="home-launcher-intro min-w-0">
                <div className="home-desk-dateline">
                  <span className="home-desk-clock">
                    {String(now.getHours()).padStart(2, '0')}:{String(now.getMinutes()).padStart(2, '0')}
                  </span>
                  <span className="home-desk-dateline-sep" aria-hidden />
                  <span>{dateLine}</span>
                </div>
                <h1 className={`home-launcher-title font-semibold tracking-tight ${isMobile ? 'text-[26px]' : 'text-[38px]'}`}>
                  {greeting}
                  {displayName ? '，' : ''}
                  {displayName && <span className="home-launcher-display-name">{displayName}</span>}
                </h1>
                <div data-tour-id="home-subtitle" className={`home-launcher-subtitle mt-1.5 ${isMobile ? 'text-sm' : 'text-[14px]'}`}>
                  <TipsRotator fallback="选一个智能体开始创作，或按下斜杠键直接搜索平台能力" />
                </div>
              </div>

              <div className="home-launcher-learning min-w-0">
                <LearningCenterTeaser />
              </div>
            </header>
          </Reveal>

          {/* ── 命令条：门头唯一的主操作，横贯整行 ── */}
          <Reveal className="home-desk-command" delay={REVEAL.command} duration={REVEAL_DURATION}>
            <div className="home-desk-command-field">
              <Search size={18} className="home-desk-command-icon" aria-hidden />
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
                  if (e.key === 'Enter' && searchResults.length > 0) {
                    handleClick(searchResults[0]);
                  }
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
          </Reveal>

          {/* ── 常去：扁平导航坞，靠分隔线建立秩序，不逐项套胶囊 ── */}
          {!query && quickLinks.length > 0 && (
            <Reveal delay={REVEAL.quickLinks} duration={REVEAL_DURATION}>
              <nav
                aria-label="首页快捷入口"
                className={`home-launcher-quick-nav home-launcher-quick-nav--${Math.min(quickLinks.length, MAX_HOME_QUICK_LINKS)}`}
              >
                {quickLinks.map((link) => {
                  const Icon = link.icon;
                  const showUnread = link.id === 'updates' && changelogUnread > 0;
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
                        <span className="home-desk-badge">{changelogUnread > 9 ? '9+' : changelogUnread}</span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </Reveal>
          )}

          {/* ── 手边的活儿：首屏主产物。有活就铺开，没活给一行引导，不留空盒 ── */}
          {!query && (
            <Reveal delay={REVEAL.continue} duration={REVEAL_DURATION}>
              <section className="home-desk-continue" aria-labelledby="home-continue-heading">
                <DeskSectionHead
                  eyebrow="CONTINUE"
                  title="手边的活儿"
                  hint="回到最近的工作现场"
                  headingId="home-continue-heading"
                  count={workItems.length > 0 ? workItems.length : undefined}
                  action={
                    workItems.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setWorkExpanded((v) => !v)}
                        aria-expanded={workExpanded}
                        className="home-desk-more"
                      >
                        {workExpanded ? '收起' : `全部 ${workItems.length} 条`}
                        <ArrowRight size={12} className={workExpanded ? '-rotate-90 transition-transform' : 'transition-transform'} />
                      </button>
                    ) : undefined
                  }
                />
                {workItems.length > 0 ? (
                  <div className={`home-desk-work-grid ${workExpanded ? 'is-expanded' : ''}`}>
                    {workItems.map((item) => (
                      <WorkCard
                        key={`${item.agentKey}:${item.route}`}
                        item={item}
                        onClick={() => navigate(item.route)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="home-desk-empty">
                    还没有进行中的工作。从下面挑一个智能体开始，或按
                    <kbd className="home-desk-empty-kbd">/</kbd>
                    直接搜索——做过的事会自动回到这里。
                  </p>
                )}
              </section>
            </Reveal>
          )}

          {/* ── 目录：一个分段筛选器 + 一片连续目录 ── */}
          {itemsLoading ? (
            <div className="flex items-center justify-center h-48">
              <MapSpinner size={24} color="var(--accent-primary)" />
            </div>
          ) : query ? (
            <section className="home-desk-section" aria-labelledby="home-search-heading">
              <DeskSectionHead
                eyebrow="SEARCH"
                title="搜索结果"
                headingId="home-search-heading"
                count={searchResults.length}
                hint={`关键词「${searchQuery.trim()}」`}
              />
              {searchResults.length === 0 ? (
                <p className="home-desk-empty">
                  没有匹配的能力。换个说法试试，或者清空搜索回到目录。
                </p>
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
              <section className="home-desk-section home-desk-catalog" aria-labelledby="home-catalog-heading">
                <Reveal delay={REVEAL.catalog} duration={REVEAL_DURATION}>
                  <DeskSectionHead
                    eyebrow="CATALOG"
                    title="全部能力"
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
                </Reveal>

                {visibleGroups.length === 0 && (
                  <p className="home-desk-empty">这一类当前没有可用入口，切回「全部」看看别的。</p>
                )}

                {visibleGroups.map((meta) => (
                  <div key={meta.key} className="home-desk-group">
                    <div className="home-desk-group-label">
                      <span className="home-desk-group-name">{meta.title}</span>
                      <span className="home-desk-group-count">{groups[meta.key].length}</span>
                      <span className="home-desk-rule" aria-hidden />
                      <span className="home-desk-group-hint">{meta.hint}</span>
                    </div>
                    {renderGroupBody(meta, groups[meta.key])}
                  </div>
                ))}
              </section>

              <section className="home-desk-section" aria-labelledby="home-showcase-heading">
                <Reveal delay={REVEAL.showcase} duration={REVEAL_DURATION}>
                  <DeskSectionHead
                    eyebrow="SHOWCASE"
                    title="作品广场"
                    hint="社区 AI 创意作品流"
                    headingId="home-showcase-heading"
                  />
                </Reveal>
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
