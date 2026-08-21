import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { toast } from '@/lib/toast';
import { SitePreview } from '@/components/SitePreview';
import { PdfThumbnail, isPdfSite } from '@/components/PdfThumbnail';
import { Dialog } from '@/components/ui/Dialog';
import {
  uploadSite,
  reuploadSite,
  listSites,
  updateSite,
  deleteSite,
  batchDeleteSites,
  setSiteVisibility,
  listSiteFolders,
  listSiteTags,
  createSiteShareLink,
  listSiteShares,
  ensureSiteShareShortLink,
  revokeSiteShare,
  renewSiteShare,
  listShareViewLogs,
  listDocumentStores,
  addDocumentEntry,
  setSiteTeams,
  listSiteGroups,
  createSiteGroup,
  updateSiteGroup,
  deleteSiteGroup,
  setSiteGroup,
  copySiteToTeam,
} from '@/services';
import type { HostedSite, ShareLinkItem, TagCount, ShareViewLogItem, SiteOwnerCard, WebPageGroup } from '@/services/real/webPages';
import { getSiteAskConfig } from '@/services/real/webPages';
import { resolveShareAskSelection, addAskPick, toggleAskPick, ASK_MAX_DISPLAY } from '@/components/web-hosting/ask/askTypes';
import type { WebHostingRole, TeamListItem } from '@/services/real/teams';
import {
  canDeleteInWebHosting,
  canEditInWebHosting,
  canShareInWebHosting,
} from '@/lib/webHostingRole';
import { SpaceBar, TeamSpaceHeader, type Space } from '@/components/team/SpaceBar';
import { GroupAccessDialog } from '@/components/team/GroupAccessDialog';
import { useTeamStore } from '@/stores/teamStore';
import { recordSiteView } from '@/services/real/webAnalytics';
import { SiteViewersDrawer } from '@/components/web-hosting/SiteViewersDrawer';
import { ShareAnalyticsDrawer } from '@/components/web-hosting/ShareAnalyticsDrawer';
import SitePreviewModal from '@/components/web-hosting/SitePreviewModal';
import { ToolbarPopover } from '@/components/web-hosting/ToolbarPopover';
import { SiteContextPanel } from '@/components/web-hosting/SiteContextPanel';
import { SharePreviewPane, VISIBILITY_LABEL as SHARE_VISIBILITY_LABEL } from '@/components/web-hosting/SharePreviewPane';
import { buildUploadProgress, fmtDuration, type UnpackFrame } from '@/components/web-hosting/uploadProgress';
import { resolveSiteForm } from '@/components/web-hosting/siteFormRegistry';
import { getUploadProgress } from '@/services/real/webPages';
import { SharesWorkspace } from '@/components/web-hosting/SharesWorkspace';
import { buildShareLedger } from '@/components/web-hosting/shareLedger';
import { SITE_SOURCE_LABELS } from '@/components/web-hosting/siteFormRegistry';
import {
  SiteCard,
  SITE_CARD_SIZES,
  WEB_PAGE_MIME,
  type SiteCaps,
  type SiteCardSize,
  type SiteShareStats,
} from '@/components/web-hosting/SiteCard';
import AskConfigDrawer from '@/components/web-hosting/ask/AskConfigDrawer';
import { createPortal } from 'react-dom';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import type { DocumentStore } from '@/services/contracts/documentStore';
import { ShareDock, useDockDrag } from '@/components/share-dock';
import { MobileBottomSheet } from '@/components/mobile/MobileBottomSheet';
import { MobileFab } from '@/components/mobile/MobileFab';

/** ShareDock MIME 由 SiteCard 组件统一定义（卡片与投放槽必须同一个常量） */

// 树导航「未分组」虚拟节点 ID（仅前端过滤用，发往后端前必须还原成 null）
const UNGROUPED_ID = '__ungrouped__';
import { useAuthStore } from '@/stores/authStore';
import {
  Upload,
  Search,
  Trash2,
  ExternalLink,
  Share2,
  Edit3,
  Grid3X3,
  List,
  FolderOpen,
  Eye,
  Copy,
  Hash,
  Check,
  X,
  Lock,
  Clock,
  RefreshCw,
  Link2,
  Link2Off,
  FileCode2,
  UploadCloud,
  QrCode,
  Globe,
  Library,
  Replace,
  AlertTriangle,
  Folder,
  Users,
  User,
  FolderInput,
  BarChart3,
  MessageSquare,
  Plus,
  Settings2,
  MoreHorizontal,
  MessageCircleQuestion,
  EyeOff,
  FileArchive,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { useBreakpoint, useIsMobile } from '@/hooks/useBreakpoint';

// ─── Utility ───

function fmtDate(s: string | null | undefined) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relativeTime(s: string | null | undefined) {
  if (!s) return '';
  const now = Date.now();
  const t = new Date(s).getTime();
  const diff = now - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDate(s);
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 从分享列表（后端已过滤掉 visit 便捷链 + 已撤销）构建「已分享站点」集合。
 * 仅把"单站点分享"（siteId 或 siteIds 仅含一个）计入，使卡片标记与「只撤单站点」的取消语义一致；
 * 多站点合集分享不标记单卡。 */
/**
 * 按站点聚合分享侧的成果数据 —— 卡片大卡的「有效链接 / 最近访问」两格。
 *
 * 「有效」的口径与分享档顶栏那个数字必须是同一条：**未过期且未撤销**。
 * 合集链接（一条链接指向多个站点）对它命中的每个站点都计一次——用户问的是
 * 「这个站点还有几条对外链接活着」，合集链接对该站点同样活着。
 */
function buildSiteShareStats(items: ShareLinkItem[]): Map<string, SiteShareStats> {
  const map = new Map<string, SiteShareStats>();
  for (const it of items) {
    if (it.isRevoked || it.isExpired) continue;
    const siteIds = it.siteId ? [it.siteId] : (it.siteIds ?? []);
    for (const sid of siteIds) {
      const prev = map.get(sid);
      const lastViewedAt =
        !prev?.lastViewedAt || (it.lastViewedAt && it.lastViewedAt > prev.lastViewedAt)
          ? (it.lastViewedAt ?? prev?.lastViewedAt)
          : prev.lastViewedAt;
      map.set(sid, { activeLinks: (prev?.activeLinks ?? 0) + 1, lastViewedAt });
    }
  }
  return map;
}

function buildSharedSiteIds(items: ShareLinkItem[]): Set<string> {
  const set = new Set<string>();
  for (const it of items) {
    const sid = it.siteId ?? (it.siteIds?.length === 1 ? it.siteIds[0] : undefined);
    if (sid) set.add(sid);
  }
  return set;
}

const sourceTypeLabels: Record<string, string> = {
  upload: '手动上传',
  workflow: '工作流',
  api: 'API',
  'saved-share': '从分享保存',
};

/**
 * 「访问」专用地址解析 —— 与「分享」彻底分开：
 * - 访问：地址一律走 ≥12 字母 token 形式 /s/wp/{token}
 * - 分享：ShareDialog 走数字短链 /s/{seq}
 * 复用/新建判定全部在服务端闭环（createSiteShareLink 内部按 用户+站点+访问级别+purpose 去重，
 * 不依赖任何前端分页列表），前端只发指令、用返回 token 拼地址。
 * purpose:'visit' 使其落在独立池：永远是公开永久链，绝不复用或篡改用户主动创建的限期分享，
 * 也不出现在分享管理列表。解析失败时回退原始 siteUrl，保证访问永不失效。
 */
async function resolveVisitUrl(site: HostedSite): Promise<string> {
  try {
    const res = await createSiteShareLink({ siteId: site.id, shareType: 'single', expiresInDays: 0, purpose: 'visit' });
    if (res.success && res.data.token) return `${window.location.origin}/s/wp/${res.data.token}`;
  } catch {
    /* 网络异常回退裸链接 */
  }
  return site.siteUrl;
}

// ─── 分组方式（参考文学创作 LiteraryAgentWorkspaceListPage） ───

type GroupMode = 'time' | 'folder';
/** 卡片尺寸档的唯一定义在 SiteCard 组件（宽度与设计稿绑定），这里只消费。 */
type WebPageCardSize = SiteCardSize;

const CARD_SIZE_OPTIONS = SITE_CARD_SIZES;

function normalizeCardSize(v: string): WebPageCardSize {
  return v === 'small' || v === 'large' || v === 'medium' ? v : 'medium';
}

// ─── 列表偏好持久化（排序/视图/分组/卡片尺寸）───
// 用 localStorage：纯 UI 偏好（非敏感、设备本地、发版后用旧值无害），
// 关浏览器重开也要记住用户的排序/视图选择。符合 .claude/rules/no-localstorage.md 的例外清单。
const PREF_KEYS = {
  sort: 'webpages.pref.sort',
  viewMode: 'webpages.pref.viewMode',
  groupMode: 'webpages.pref.groupMode',
  cardSize: 'webpages.pref.cardSize',
} as const;

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式 / 存储已满时静默降级 */
  }
}

/** 把日期格式化成分组标题：今天 / 昨天 / M月D日 / YYYY年M月D日 */
function toDateBucketLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return '今天';
  if (dayDiff === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

interface SiteGroup {
  key: string;
  label: string;
  items: HostedSite[];
}

/** 按分组方式把（已排序的）站点列表切成分节。
 * 关键：保持传入数组的顺序（= 排序结果），只按 first-seen 顺序建组，
 * 因此「分组」与「排序」互不干扰 —— 排序决定顺序，分组只插标题。
 * teamGroups 传入时（团队空间）按专题/分类实体切分节；否则按个人空间的 folder 字段。 */
function buildSiteGroups(items: HostedSite[], mode: GroupMode, teamGroups?: WebPageGroup[]): SiteGroup[] {
  const groupById = new Map((teamGroups ?? []).map((g) => [g.id, g]));
  const map = new Map<string, SiteGroup>();
  for (const site of items) {
    let key: string;
    let label: string;
    if (mode === 'folder') {
      if (teamGroups) {
        const g = site.groupId ? groupById.get(site.groupId) : undefined;
        key = g ? `g:${g.id}` : 'g:__none__';
        label = g ? `${g.kind === 'topic' ? '专题' : '分类'} · ${g.name}` : '未分组';
      } else {
        key = site.folder ? `f:${site.folder}` : 'f:__none__';
        label = site.folder || '未分类';
      }
    } else {
      label = toDateBucketLabel(site.createdAt);
      key = `t:${label}`;
    }
    let g = map.get(key);
    if (!g) {
      g = { key, label, items: [] };
      map.set(key, g);
    }
    g.items.push(site);
  }
  // 所有分组都保持 first-seen（= 后端排序结果）顺序。
  // 这样“最新 / 最早 / 标题 / 浏览 / 体积”控制的是全局顺序，分组只负责插入标题。
  return [...map.values()];
}

// ─── 排序循环：单击在 5 个选项之间下一步 ───

/** 来源筛选项由形态注册表的来源标签派生，避免两处各写一份中文名 */
const SOURCE_FILTER_OPTIONS = Object.entries(SITE_SOURCE_LABELS).map(([value, label]) => ({ value, label }));

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'newest', label: '最新' },
  { value: 'oldest', label: '最早' },
  { value: 'title', label: '标题' },
  { value: 'most-viewed', label: '浏览' },
  { value: 'largest', label: '体积' },
];

// ─── 分段 pill 组件：当前项 pill 高亮 + 平铺所有选项，单击即切 ───
function SegmentPills({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      className="inline-flex max-w-full items-center gap-1 overflow-x-auto p-1 rounded-lg shrink-0"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-default)',
        scrollbarWidth: 'none',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="h-7 min-w-10 shrink-0 whitespace-nowrap px-3 rounded-md text-center text-[13px] transition-colors"
            style={
              active
                ? {
                    background: 'var(--selection-bg)',
                    color: 'var(--selection-text)',
                    fontWeight: 500,
                    boxShadow: 'inset 0 0 0 1px var(--selection-border)',
                  }
                : {
                    background: 'transparent',
                    color: 'var(--text-muted)',
                  }
            }
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.color = 'var(--text-muted)';
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Page ───

/**
 * 单站点在当前作用域下的操作能力（团队作用域按角色 + 是否站点创建者解析；个人作用域全开）。
 * 定义在 SiteCard 组件里，这里只做转出，避免同一判据分裂成两份各自漂移。
 */
export { SiteCard };
export type { SiteCaps };

export default function WebPagesPage() {
  const { isMobile } = useBreakpoint();
  const username = useAuthStore(s => s.user?.username);
  const currentUserId = useAuthStore(s => s.user?.userId);
  const [sites, setSites] = useState<HostedSite[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // SaaS 空间模型：个人空间 / 团队空间（协作边界）；空间内文件夹由内容派生（纯组织）
  const [currentSpace, setCurrentSpace] = useState<Space>({ kind: 'personal' });
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  // 团队空间分组（专题/日常分类）：团队级实体，可先建空分组再加内容
  const [teamGroups, setTeamGroups] = useState<WebPageGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  // 「从个人空间添加」复制选择器
  const [showCopyFromPersonal, setShowCopyFromPersonal] = useState(false);
  const { teams, loadTeams } = useTeamStore();
  const [movingSite, setMovingSite] = useState<HostedSite | null>(null);
  const [ownerCards, setOwnerCards] = useState<Record<string, SiteOwnerCard>>({});
  // 团队空间下我的有效角色（owner/editor/viewer）；个人空间为 null（=自己的，全权）
  const [myWebHostingRole, setMyWebHostingRole] = useState<WebHostingRole | null>(null);
  const [keyword, setKeyword] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // 来源筛选（手动上传 / 工作流生成 / API 生成 / 保存自分享）；null = 不限
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [sort, setSort] = useState(() => readPref(PREF_KEYS.sort, 'newest'));
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(
    () => readPref(PREF_KEYS.viewMode, 'grid') as 'grid' | 'list',
  );
  const [cardSize, setCardSize] = useState<WebPageCardSize>(
    () => normalizeCardSize(readPref(PREF_KEYS.cardSize, 'medium')),
  );

  // 空间 → 作用域（个人空间走 mine 再客户端剔除已进团队的；团队空间走 team）。下游隔离/角色门控不变
  const teamScope = useMemo(
    () => (currentSpace.kind === 'team'
      ? { scope: 'team' as const, teamId: currentSpace.teamId }
      : { scope: 'mine' as const, teamId: null }),
    [currentSpace],
  );
  const [groupMode, setGroupMode] = useState<GroupMode>(
    () => readPref(PREF_KEYS.groupMode, 'time') as GroupMode,
  );

  // 排序/视图/分组/卡片尺寸偏好变化即写回 localStorage，刷新/重开浏览器后自动恢复
  useEffect(() => { writePref(PREF_KEYS.sort, sort); }, [sort]);
  useEffect(() => { writePref(PREF_KEYS.viewMode, viewMode); }, [viewMode]);
  useEffect(() => { writePref(PREF_KEYS.groupMode, groupMode); }, [groupMode]);
  useEffect(() => { writePref(PREF_KEYS.cardSize, cardSize); }, [cardSize]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 已分享站点集合（单站点分享）：驱动卡片「已分享」标记 + 分享按钮转「取消分享」 + 投放槽读心
  const [sharedSiteIds, setSharedSiteIds] = useState<Set<string>>(new Set());
  // 分享链接原始列表（loadShares 同批取回），用于按站点聚合「有效链接数 / 最近访问」
  const [shareLinks, setShareLinks] = useState<ShareLinkItem[]>([]);

  const [folders, setFolders] = useState<string[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);

  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [editItem, setEditItem] = useState<HostedSite | null>(null);
  const [pendingExternalFile, setPendingExternalFile] = useState<File | null>(null);
  // 快照「打开新建上传弹窗时」的空间：弹窗内上传期间用户若切换空间，onSaved 仍按打开时的目标归属
  const uploadDialogSpaceRef = useRef<Space>({ kind: 'personal' });
  const openCreateUploadDialog = () => {
    uploadDialogSpaceRef.current = currentSpace;
    setEditItem(null);
    setShowUploadDialog(true);
  };
  // 上传成功的站点 ID 集合，触发"滑入 + 光环"入场动效。
  // 事件驱动（onSaved 回调）—— 不再用 sites diff 推断，避免筛选/排序变化误触发动效。
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  // 转知识库目标站点（非 null 时弹出选择文档空间的对话框）
  const [libraryTargetSite, setLibraryTargetSite] = useState<HostedSite | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareTargetId, setShareTargetId] = useState<string | null>(null);
  const [showSharesPanel, setShowSharesPanel] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [shares, setShares] = useState<ShareLinkItem[]>([]);
  const [qrSite, setQrSite] = useState<HostedSite | null>(null);
  // 拖文件到卡片触发的"替换网页"二次确认（非 null 时弹出确认框）
  const [replaceTarget, setReplaceTarget] = useState<{ site: HostedSite; file: File } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [viewersTarget, setViewersTarget] = useState<{ siteId: string; siteTitle: string } | null>(null);
  // 评论管理：点击站点卡「评论」按钮打开预览 + 评论面板（owner 可发表/删除 + 允许评论开关）
  const [commentSite, setCommentSite] = useState<HostedSite | null>(null);
  // 提问设置：站点卡「更多设置」直达。原先只有大预览顶栏的齿轮一个入口，
  // 用户在列表里找遍菜单也找不到提问配置（形状 2：接线只建了一半）。
  const [askConfigSite, setAskConfigSite] = useState<HostedSite | null>(null);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  // 桌面工具条上同时只展开一个气泡（显示 / 筛选），避免两块浮层互相盖住
  const [openToolbarPanel, setOpenToolbarPanel] = useState<'display' | 'filter' | null>(null);
  /**
   * 后台的两档语境：资产库（我有什么）/ 分享（谁在看）。
   * 访客阅读页**不是**第三档 —— 它在独立域名 /s/wp/{token} 上，访客根本不进后台；
   * 后台只保留一个「以访客身份预览」的动作。
   */
  const [workspaceTab, setWorkspaceTab] = useState<'library' | 'shares'>('library');

  // ─── Load ───

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listSites({
      keyword: keyword || undefined,
      tag: activeTag || undefined,
      sourceType: activeSource || undefined,
      sort,
      limit: 200,
      scope: teamScope.scope,
      teamId: teamScope.teamId,
    });
    if (res.success) {
      setSites(res.data.items);
      setTotal(res.data.total);
      setOwnerCards(res.data.owners ?? {});
      setMyWebHostingRole(res.data.myWebHostingRole ?? null);
    }
    setLoading(false);
  }, [keyword, activeTag, activeSource, sort, teamScope]);

  // 团队作用域：按「我的网页托管角色 + 是否站点创建者」解析每个站点的操作能力。
  // 个人作用域：列表全是自己的站点，全权。后端是权威（viewer 写会 404/403），这里只控展示。
  const siteCaps = useCallback((site: HostedSite): SiteCaps => {
    if (teamScope.scope !== 'team') {
      return { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };
    }
    const isOwner = !!currentUserId && site.ownerUserId === currentUserId;
    return {
      canEdit: isOwner || canEditInWebHosting(myWebHostingRole),
      canShare: isOwner || canShareInWebHosting(myWebHostingRole),
      canDelete: isOwner || canDeleteInWebHosting(myWebHostingRole),
      canSetVisibility: isOwner, // 公开状态管理仅站点创建者可调
    };
  }, [teamScope.scope, currentUserId, myWebHostingRole]);

  const loadMeta = useCallback(async () => {
    const [fRes, tRes] = await Promise.all([listSiteFolders(), listSiteTags()]);
    if (fRes.success) setFolders(fRes.data.folders);
    if (tRes.success) setTags(tRes.data.tags);
  }, []);

  // 团队空间分组列表（专题 + 日常分类）
  const loadGroups = useCallback(async () => {
    if (currentSpace.kind !== 'team') { setTeamGroups([]); return; }
    const res = await listSiteGroups(currentSpace.teamId);
    if (res.success) setTeamGroups(res.data.groups);
  }, [currentSpace]);

  useEffect(() => { void loadGroups(); }, [loadGroups]);

  // 拉真实分享列表（后端已排除 visit 便捷链 + 已撤销），刷新「已分享」标记
  const loadShares = useCallback(async () => {
    const res = await listSiteShares();
    if (res.success) {
      setSharedSiteIds(buildSharedSiteIds(res.data.items));
      // 原始链接也留一份：卡片的「有效链接 N / 最近访问」要按站点聚合，
      // 只留一个 Set 就只能回答「有没有分享过」，回答不了「还有几条有效、上次谁打开的」
      setShareLinks(res.data.items);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => { loadShares(); }, [loadShares]);
  useEffect(() => { void loadTeams(); }, [loadTeams]);

  // 把刚上传成功的站点 ID 加入 freshIds，1.3s 后自动移除（与 CSS 动画时长匹配）。
  // 仅在用户主动创建时触发；筛选/排序导致的 sites 重组不动它。
  const markSiteAsFresh = useCallback((id: string) => {
    setFreshIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      setFreshIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 1300);
  }, []);

  // ─── Actions ───

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此站点？站点文件将同时被清理。')) return;
    const res = await deleteSite(id);
    if (res.success) {
      setSites(prev => prev.filter(s => s.id !== id));
      setTotal(prev => prev - 1);
      loadMeta();
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`确定删除选中的 ${selectedIds.size} 个站点？`)) return;
    const res = await batchDeleteSites([...selectedIds]);
    if (res.success) {
      setSelectedIds(new Set());
      load();
      loadMeta();
    }
  };

  // 点击站点卡上的「分享」按钮：打开 SharesPanel scoped 到该站点。
  // 面板内既显示已有分享列表（含续期/取消），也提供「新建分享」CTA → 弹出 ShareDialog。
  // PR 2026-05-28 起：不再「一键直接生成新链接」，避免用户重复创建后链接互相覆盖。
  const handleShare = (id: string) => {
    setShareTargetId(id);
    setShowSharesPanel(true);
  };

  const handleMakePublic = useCallback(async (site: HostedSite) => {
    if (site.visibility === 'public') {
      if (!confirm(`「${site.title}」已经是公开状态，是否改回私有？`)) return;
      const res = await setSiteVisibility(site.id, 'private');
      if (res.success) {
        setSites(prev => prev.map(s => s.id === site.id ? res.data : s));
      }
      return;
    }
    if (!confirm(`将「${site.title}」设为公开？\n\n任何人都能在你的个人公开页（/u/${username ?? '...'}）看到此站点。`)) return;
    const res = await setSiteVisibility(site.id, 'public');
    if (res.success) {
      setSites(prev => prev.map(s => s.id === site.id ? res.data : s));
    } else {
      alert(res.error?.message || '设置失败');
    }
  }, [username]);

  const handleDropShare = useCallback((site: HostedSite) => {
    setShareTargetId(site.id);
    setShowShareDialog(true);
  }, []);

  const handleDropDelete = useCallback(async (site: HostedSite) => {
    if (!confirm(`确定删除「${site.title}」？站点文件将同时被清理，此操作不可撤销。`)) return;
    const res = await deleteSite(site.id);
    if (res.success) {
      setSites(prev => prev.filter(s => s.id !== site.id));
      setTotal(prev => prev - 1);
      loadMeta();
    }
  }, [loadMeta]);

  // 取消分享：撤销所有"仅指向该站点"的分享链接（单站点分享），多站点合集分享不动。
  const cancelShareForSite = useCallback(async (id: string) => {
    const res = await listSiteShares();
    if (!res.success) {
      toast.error('取消分享失败', res.error?.message || '请稍后重试');
      return;
    }
    const targets = res.data.items.filter((it) => {
      const sid = it.siteId ?? (it.siteIds?.length === 1 ? it.siteIds[0] : undefined);
      return sid === id;
    });
    if (targets.length === 0) { await loadShares(); return; }
    let ok = 0;
    for (const t of targets) {
      const r = await revokeSiteShare(t.id);
      if (r.success) ok++;
    }
    if (ok > 0) {
      const title = sites.find((s) => s.id === id)?.title ?? '站点';
      toast.success('已取消分享', `「${title}」的分享链接已撤销`);
    }
    await loadShares();
  }, [loadShares, sites]);

  const handleConfirmReplace = useCallback(async () => {
    if (!replaceTarget || replacing) return;
    setReplacing(true);
    try {
      const res = await reuploadSite(replaceTarget.site.id, replaceTarget.file);
      if (res.success) {
        toast.success('替换成功', `「${replaceTarget.site.title}」的网页内容已更新`);
        setReplaceTarget(null);
        load();
        loadMeta();
      } else {
        toast.error('替换失败', res.error?.message || '请稍后重试');
      }
    } catch (e) {
      // 网络异常等抛错时，若不在 finally 复位 replacing，按钮与弹窗会被永久锁死
      toast.error('替换失败', e instanceof Error ? e.message : '网络异常，请稍后重试');
    } finally {
      setReplacing(false);
    }
  }, [replaceTarget, replacing, load, loadMeta]);

  const handleBatchShare = () => {
    if (selectedIds.size === 0) return;
    setShareTargetId(null);
    setShowShareDialog(true);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 分组：保持服务端排序顺序，仅按 first-seen 切分节（排序与分组并存）
  // 当前空间的网页：个人空间=我拥有且未进任何团队空间的（客户端剔除）；团队空间=后端已按 Id 过滤
  const spaceSites = useMemo(
    () => (currentSpace.kind === 'team' ? sites : sites.filter((s) => !(s.sharedTeamIds && s.sharedTeamIds.length))),
    [sites, currentSpace],
  );
  // 空间内文件夹由内容派生（站点的 folder 字段）
  const spaceFolders = useMemo(
    () => Array.from(new Set(spaceSites.map((s) => s.folder).filter((f): f is string => !!f && !!f.trim()))).sort(),
    [spaceSites],
  );
  const displaySites = useMemo(() => {
    // 团队空间按分组（专题/日常分类）过滤；个人空间沿用文件夹过滤
    if (currentSpace.kind === 'team') {
      if (activeGroupId === UNGROUPED_ID) return spaceSites.filter((s) => !s.groupId);
      return activeGroupId ? spaceSites.filter((s) => s.groupId === activeGroupId) : spaceSites;
    }
    return activeFolder ? spaceSites.filter((s) => s.folder === activeFolder) : spaceSites;
  }, [spaceSites, activeFolder, activeGroupId, currentSpace.kind]);
  // 「未分组」是树导航的虚拟节点：投送/移入分组时必须还原成 null
  const activeRealGroupId = activeGroupId === UNGROUPED_ID ? null : activeGroupId;
  // 树导航的分组计数（来自当前空间已加载的站点）
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let ungrouped = 0;
    for (const s of spaceSites) {
      if (s.groupId) counts.set(s.groupId, (counts.get(s.groupId) ?? 0) + 1);
      else ungrouped++;
    }
    return { counts, ungrouped };
  }, [spaceSites]);
  const siteGroups = useMemo(
    () => buildSiteGroups(displaySites, groupMode, currentSpace.kind === 'team' ? teamGroups : undefined),
    [displaySites, groupMode, currentSpace.kind, teamGroups],
  );
  const cardWidth = CARD_SIZE_OPTIONS.find(o => o.value === cardSize)?.width ?? 264;
  const siteShareStats = useMemo(() => buildSiteShareStats(shareLinks), [shareLinks]);
  // 顶栏「分享 N」与分享档结论句同一个口径：未过期且未撤销
  const activeShareCount = useMemo(() => buildShareLedger(shareLinks).active.length, [shareLinks]);
  /**
   * 右栏讲哪个站点：选中恰好一个就讲它；否则讲列表里排在最前的那个（当前排序下最该被看见的）。
   * 不选中就空着会让右栏大部分时间是一块废地。
   */
  const contextSite = useMemo(() => {
    if (selectedIds.size === 1) {
      const id = [...selectedIds][0];
      return displaySites.find(s => s.id === id) ?? null;
    }
    return displaySites[0] ?? null;
  }, [selectedIds, displaySites]);

  /**
   * 打开站点本体。与卡片/列表两个视图共用同一条路径：先记一次访客痕迹，
   * 再用 /s/wp/{token} 访问链打开（同步开窗规避弹窗拦截，地址异步解析后填入）。
   */
  const handleVisitSite = useCallback((site: HostedSite) => {
    void recordSiteView(site.id);
    const w = window.open('', '_blank');
    void resolveVisitUrl(site).then(url => { if (w) w.location.href = url; });
  }, []);
  const activeSortLabel = SORT_OPTIONS.find(o => o.value === sort)?.label ?? '最新';
  const activeSpaceLabel = currentSpace.kind === 'team'
    ? (teams.find(t => t.team.id === currentSpace.teamId)?.team.name ?? '团队空间')
    : '个人空间';
  const activeFolderLabel = currentSpace.kind === 'team'
    ? (activeGroupId
        ? activeGroupId === UNGROUPED_ID
          ? '未分组'
          : (teamGroups.find(g => g.id === activeGroupId)?.name ?? '分组')
        : '全部分组')
    : (activeFolder ?? '全部文件夹');
  const filterCount = [
    activeFolder != null,
    activeGroupId != null,
    activeTag != null,
    activeSource != null,
    sort !== 'newest',
    groupMode !== 'time',
    viewMode !== 'grid',
  ].filter(Boolean).length;

  const enterSpace = (s: Space) => {
    // 幂等守卫：点的就是当前空间则不动（双击当前团队改名时，两次 click 不应触发整页重载）
    if (s.kind === currentSpace.kind && (s.kind === 'personal' || (currentSpace.kind === 'team' && s.teamId === currentSpace.teamId))) return;
    setCurrentSpace(s);
    setActiveFolder(null);
    setActiveGroupId(null);
    setSelectedIds(new Set());
    // 切空间立刻清空上一作用域的角色，避免用旧 scope 的角色误判权限（由随后的 load 重新填充）
    setMyWebHostingRole(null);
  };

  // ── 团队空间分组（专题/日常分类）操作 ──

  const handleCreateGroup = async (kind: 'topic' | 'daily', name: string) => {
    if (currentSpace.kind !== 'team') return;
    const res = await createSiteGroup({ teamId: currentSpace.teamId, kind, name });
    if (res.success) {
      toast.success('已创建', `${kind === 'topic' ? '专题' : '分类'}「${name}」已创建，可向其中添加网页`);
      await loadGroups();
    } else {
      toast.error('创建失败', res.error?.message);
    }
  };

  // 分组权限设置弹窗（仅空间 owner 入口可见）
  const [accessGroup, setAccessGroup] = useState<WebPageGroup | null>(null);

  const handleRenameGroup = async (g: WebPageGroup, name: string) => {
    // 乐观更新：树上立即显示新名，API 失败再回滚（不整列表刷新）
    setTeamGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, name } : x)));
    const res = await updateSiteGroup(g.id, { name });
    if (!res.success) {
      setTeamGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, name: g.name } : x)));
      toast.error('重命名失败', res.error?.message);
    }
  };

  const handleDeleteGroup = async (g: WebPageGroup) => {
    if (!confirm(`删除${g.kind === 'topic' ? '专题' : '分类'}「${g.name}」？组内网页不会被删除，只会回到「未分组」。`)) return;
    const res = await deleteSiteGroup(g.id);
    if (res.success) {
      if (activeGroupId === g.id) setActiveGroupId(null);
      await loadGroups();
      await load();
    } else {
      toast.error('删除失败', res.error?.message);
    }
  };

  const handleMoveSite = async (targetSpace: Space, folder: string | null) => {
    if (!movingSite) return;
    const teamIds = targetSpace.kind === 'team' ? [targetSpace.teamId] : [];
    const r1 = await setSiteTeams(movingSite.id, teamIds);
    if (!r1.success) { toast.error('移动失败', r1.error?.message); return; }
    // 同步文件夹（空间内组织）；移到个人空间也允许带文件夹名
    await updateSite(movingSite.id, { folder: folder ?? '' });
    setMovingSite(null);
    await load();
    toast.success('已移动', targetSpace.kind === 'team' ? '已移动到团队空间' : '已移动到个人空间');
  };

  // 单组内的卡片/列表渲染，按 viewMode 复用
  const renderGroupItems = (items: HostedSite[]) =>
    viewMode === 'grid' ? (
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : `repeat(auto-fill, minmax(min(100%, ${cardWidth}px), ${cardWidth}px))`,
          justifyContent: isMobile ? 'stretch' : 'center',
        }}
      >
        {items.map(site => (
          <SiteCard
            key={site.id}
            site={site}
            size={cardSize}
            selected={selectedIds.has(site.id)}
            fresh={freshIds.has(site.id)}
            shared={sharedSiteIds.has(site.id)}
            shareStats={siteShareStats.get(site.id)}
            caps={siteCaps(site)}
            ownerCard={teamScope.scope === 'team' ? ownerCards[site.ownerUserId] : undefined}
            onVisit={() => handleVisitSite(site)}
            onSelect={() => toggleSelect(site.id)}
            onTogglePublic={() => handleMakePublic(site)}
            onEdit={() => { setEditItem(site); setShowUploadDialog(true); }}
            onDelete={() => handleDelete(site.id)}
            onShare={() => handleShare(site.id)}
            onQrCode={() => setQrSite(site)}
            onTransferToLibrary={() => setLibraryTargetSite(site)}
            onReplaceFile={(file) => setReplaceTarget({ site, file })}
            onViewers={() => setViewersTarget({ siteId: site.id, siteTitle: site.title })}
            onMove={() => setMovingSite(site)}
            onComments={() => setCommentSite(site)}
            onAskConfig={siteCaps(site).canEdit ? () => setAskConfigSite(site) : undefined}
          />
        ))}
      </div>
    ) : (
      <div className="flex flex-col">
        {items.map(site => (
          <SiteListItem
            key={site.id}
            site={site}
            selected={selectedIds.has(site.id)}
            shared={sharedSiteIds.has(site.id)}
            caps={siteCaps(site)}
            onSelect={() => toggleSelect(site.id)}
            onEdit={() => { setEditItem(site); setShowUploadDialog(true); }}
            onDelete={() => handleDelete(site.id)}
            onShare={() => handleShare(site.id)}
            onQrCode={() => setQrSite(site)}
            onTogglePublic={() => handleMakePublic(site)}
            onComments={() => setCommentSite(site)}
            onAskConfig={siteCaps(site).canEdit ? () => setAskConfigSite(site) : undefined}
          />
        ))}
      </div>
    );

  return (
    <div
      data-tour-id="webpages-root"
      className={isMobile ? 'h-full flex flex-col gap-3 overflow-auto' : 'h-full flex flex-col gap-4 overflow-auto'}
      style={{
        // 不再自刷整幅不透明深色底（会盖住应用背景、与外壳 16px 内边距形成
        // "黑框 + 内容内缩"的错位，2026-07-08 用户反馈）；仅保留顶部一缕
        // 品牌靛蓝氛围光，透明叠加在应用背景上。p-4 同步移除——外壳已供内边距。
        background:
          'radial-gradient(ellipse 70% 40% at 50% -10%, rgba(99,102,241,0.12) 0%, transparent 55%)',
        width: '100%',
      }}
    >
      {/* 右侧投放面板：桌面保留拖拽工作流；手机端用主按钮与分享入口，避免浮层遮挡首屏。 */}
      {!isMobile && (
        <ShareDock
          mime={WEB_PAGE_MIME}
          // 右栏「站点上下文」常驻在右侧，投放面板默认展开会正好盖住它；
          // 折叠态仍在屏幕右缘留一条把手，拖卡片时高亮，用户展开过就记住展开
          defaultCollapsed
          title="投放面板"
          badgeCount={sites.filter(s => s.visibility === 'public').length}
          footerHref={username ? `/u/${encodeURIComponent(username)}` : undefined}
          footerText={
            sites.filter(s => s.visibility === 'public').length > 0 && username
              ? `已公开 ${sites.filter(s => s.visibility === 'public').length} 个 · 查看公开页`
              : '拖卡片到上方槽位'
          }
          persistKey="web-pages"
          compactSlots
          dropzone={{
          hint: '拖文件到此上传',
          accept: ['.html', '.zip', '.md', '.pdf', '.mp4', '.webm'],
          // 两阶段：先只上传，再由用户在 dock 内二选一（无密码 / 有密码）创建分享并自动复制链接
          onFiles: async (files) => {
            const f = files[0];
            if (!f) return;
            // 在 await 之前快照「发起上传时」的空间：上传期间用户若切换个人/其它团队空间，
            // 仍按发起时的目标投送，避免归属到错误团队（异步竞态防护）
            const targetSpace = currentSpace;
            // 同步快照当前选中的分组：正停留在某专题/分类视图里拖拽上传 → 新网页直接归入该分组
            const targetGroupId = targetSpace.kind === 'team' ? activeRealGroupId : null;
            // 权限闸门：团队空间内必须有编辑权限才能投放（与上传按钮的显隐条件一致）。
            // dropzone 始终挂载，不能让只读 viewer 通过拖拽绕过按钮把内容写进团队空间。
            // 仅在「角色已确切加载（非 null）」时硬拦截：刚切进团队空间 role 尚未就绪（null）时放行，
            // 由后端 403 + 「归属团队失败」兜底，避免误拦正在加载的编辑者（false 无权限 toast）。
            if (targetSpace.kind === 'team' && myWebHostingRole !== null && !canEditInWebHosting(myWebHostingRole)) {
              toast.error('无权限', '你在该团队空间是只读角色，无法上传网页');
              return;
            }
            const up = await uploadSite({ file: f });
            if (!up.success || !up.data) {
              toast.error('上传失败', up.error?.message || '请稍后重试');
              return;
            }
            const site = up.data;
            // 跟随发起时空间投送：在团队空间内拖拽上传的网页必须归属该团队，
            // 否则会落到上传者的个人空间（与弹窗上传路径保持一致）
            if (targetSpace.kind === 'team') {
              const assigned = await setSiteTeams(site.id, [targetSpace.teamId]);
              // 归属失败（网络 / 无权限 / 404）时必须告知用户：站点已上传但仍在个人空间，
              // 不能静默报“上传成功”，否则用户以为投到团队了却找不到
              if (!assigned.success) {
                load();
                loadMeta();
                toast.error('已上传，但归属团队失败', `${assigned.error?.message || '请稍后在卡片上手动移动到本团队'}（站点暂在个人空间）`);
                return;
              }
              // 正在某专题/分类视图内上传 → 顺手归入该分组（失败不阻断，仅提示）
              if (targetGroupId) {
                const grouped = await setSiteGroup(site.id, targetGroupId);
                if (!grouped.success) toast.error('已上传，但归入分组失败', grouped.error?.message || '可稍后通过批量操作移入分组');
              }
            }
            markSiteAsFresh(site.id);
            load();
            loadMeta();
            return {
              title: '上传成功',
              createShare: async (mode) => {
                const pwd = mode === 'password' ? genPassword() : undefined;
                // 快速分享的两个选项（无密码 / 有密码）都应产出「永久 + 对大家可见」的链接，
                // 区别仅在密码。这里必须显式传 visibility:'public'——否则后端兜底成 owner-only（仅我可见），
                // 快速分享就会错误地显示「仅我可见」。expiresInDays:0 = 永久。
                const share = await createSiteShareLink({ siteId: site.id, shareType: 'single', expiresInDays: 0, password: pwd, visibility: 'public' });
                if (share.success && share.data) {
                  loadShares();
                  return {
                    title: '已生成分享',
                    shareUrl: `${window.location.origin}${share.data.shareUrl}`,
                    password: share.data.password,
                  };
                }
                const msg = share.error?.message || '分享码生成失败';
                toast.error('分享码生成失败', `${msg}，可在卡片上手动分享`);
                throw new Error(msg);
              },
            };
          },
        }}
          slots={[
          {
            key: 'share',
            icon: <Share2 size={18} />,
            label: '分享',
            hint: '生成点对点链接',
            tone: 'violet',
            onDrop: (id) => {
              const site = sites.find(s => s.id === id);
              if (site) handleDropShare(site);
            },
            // 读心：拖已分享的站点过来 → 槽位变「取消分享」，落点撤销该站点的单站点分享
            resolve: (id) => sharedSiteIds.has(id)
              ? { label: '取消分享', icon: <Link2Off size={18} />, hint: '撤销该站点的分享链接', tone: 'amber', onDrop: (sid) => cancelShareForSite(sid) }
              : null,
          },
          {
            key: 'delete',
            icon: <Trash2 size={18} />,
            label: '回收站',
            hint: '永久删除',
            tone: 'rose',
            onDrop: (id) => {
              const site = sites.find(s => s.id === id);
              if (site) handleDropDelete(site);
            },
          },
          ]}
        />
      )}
      {!isMobile && (
        <PageHeader
          title="网页托管"
          actions={
            <div data-tour-id="webpages-header-actions" className="flex items-center gap-1.5">
              {/* 语境两档：资产库 / 分享。分享档按钮上的数字与分享档结论句同口径（未过期且未撤销） */}
              <div className="inline-flex items-center gap-1 rounded-lg p-1" style={{ background: 'var(--bg-input)' }}>
                <button
                  type="button"
                  data-tour-id="webpages-tab-library"
                  onClick={() => setWorkspaceTab('library')}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold transition-colors"
                  style={workspaceTab === 'library'
                    ? { background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }
                    : { color: 'var(--text-muted)' }}
                >
                  <FolderOpen size={13} /> 资产库
                </button>
                <button
                  type="button"
                  data-tour-id="webpages-tab-shares"
                  onClick={() => setWorkspaceTab('shares')}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-semibold transition-colors"
                  style={workspaceTab === 'shares'
                    ? { background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }
                    : { color: 'var(--text-muted)' }}
                >
                  <Link2 size={13} /> 分享
                  <span className="tabular-nums opacity-80">{activeShareCount}</span>
                </button>
              </div>
              <button
                type="button"
                data-tour-id="webpages-guest-preview"
                onClick={() => { if (contextSite) handleVisitSite(contextSite); }}
                disabled={!contextSite}
                title={contextSite ? `以访客身份打开「${contextSite.title}」` : '先选一个站点'}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:opacity-40"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                <Eye size={13} /> 以访客身份预览
              </button>
              <span className="mx-1 h-5 w-px" style={{ background: 'var(--border-default)' }} />
              {currentSpace.kind === 'team' && canEditInWebHosting(myWebHostingRole) && (
                <Button size="sm" variant="secondary" title="把个人空间的网页复制一份进当前团队（原网页不受影响）" onClick={() => setShowCopyFromPersonal(true)}>
                  <FolderInput size={14} className="mr-1" /> 从个人空间添加
                </Button>
              )}
              {(currentSpace.kind !== 'team' || canEditInWebHosting(myWebHostingRole)) && (
                <Button data-tour-id="webpages-upload-primary" size="sm" variant="primary" onClick={openCreateUploadDialog}>
                  <Upload size={14} className="mr-1" /> 上传站点
                </Button>
              )}
            </div>
          }
        />
      )}

      {/* Toolbar（只属于资产库档；分享档有自己的三层切换与搜索） */}
      <div className="flex flex-col gap-3" style={{ display: workspaceTab === 'library' ? undefined : 'none' }}>
        {/* 搜索 / 筛选：移动端从搜索开始；桌面端默认只保留一条工作台工具区。 */}
        {isMobile ? (
          <div className="px-2 pt-1 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
                <input
                  type="text"
                  placeholder="搜索站点名称、描述..."
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
                  style={{
                    background: 'var(--bg-sunken)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-default)',
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => setShowMobileFilters(true)}
                data-tour-id="webpages-mobile-filter"
                className="h-10 px-3 rounded-[12px] inline-flex items-center gap-1.5 shrink-0"
                style={{
                  background: filterCount > 0 ? 'var(--selection-bg)' : 'var(--bg-card)',
                  border: `1px solid ${filterCount > 0 ? 'var(--selection-border)' : 'var(--border-subtle)'}`,
                  color: filterCount > 0 ? 'var(--selection-text)' : 'var(--text-primary)',
                }}
              >
                <Settings2 size={15} />
                <span className="text-[13px] font-semibold">筛选</span>
                {filterCount > 0 && <span className="text-[12px] tabular-nums">{filterCount}</span>}
              </button>
            </div>
            <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-token-muted">
              <span className="truncate">{activeSpaceLabel}</span>
              <span className="opacity-45">·</span>
              <span className="truncate">{activeFolderLabel}</span>
              <span className="opacity-45">·</span>
              <span>{activeSortLabel}</span>
              <span className="opacity-45">·</span>
              <span className="shrink-0">共 {total} 个站点</span>
              {activeTag && (
                <>
                  <span className="opacity-45">·</span>
                  <span className="truncate">{activeTag}</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            {/*
              桌面工具条：只留三件常驻 —— 搜索、组织方式、视图。
              排序与卡片尺寸是「怎么显示」，收进「显示」气泡；文件夹与标签是「看哪一批」，
              收进「筛选」气泡并在按钮上带命中数。旧版把六组控件平铺在同一行，
              彼此没有主次，用户不知道先看哪个。
            */}
            <div className="surface-nav-bar flex items-center gap-3" style={{ overflow: 'visible' }}>
              <div className="min-w-[240px] max-w-[380px] flex-[0_1_380px]">
                <SpaceBar current={currentSpace} onChange={enterSpace} />
              </div>

              <div className="relative min-w-[220px] flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
                <input
                  type="text"
                  placeholder="搜索标题、描述、标签"
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
                  style={{
                    background: 'var(--bg-input)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-default)',
                  }}
                />
              </div>

              <div data-tour-id="webpages-group-pills" className="shrink-0">
                <SegmentPills
                  options={[
                    { value: 'time', label: '按时间' },
                    { value: 'folder', label: currentSpace.kind === 'team' ? '按分组' : '按文件夹' },
                  ]}
                  value={groupMode}
                  onChange={(v) => setGroupMode(v as GroupMode)}
                />
              </div>

              <div data-tour-id="webpages-view-toggle" className="inline-flex shrink-0 items-center overflow-hidden rounded-lg border border-token-default">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  title="网格视图"
                  aria-label="网格视图"
                  className="h-8 w-9 inline-flex items-center justify-center transition-colors"
                  style={{ background: viewMode === 'grid' ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-primary)' }}
                >
                  <Grid3X3 size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  title="列表视图"
                  aria-label="列表视图"
                  className="h-8 w-9 inline-flex items-center justify-center transition-colors"
                  style={{ background: viewMode === 'list' ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-primary)' }}
                >
                  <List size={14} />
                </button>
              </div>

              <ToolbarPopover
                label="显示"
                tourId="webpages-display-popover"
                open={openToolbarPanel === 'display'}
                onOpenChange={(v) => setOpenToolbarPanel(v ? 'display' : null)}
              >
                <div className="space-y-3" style={{ minWidth: 260 }}>
                  <div className="space-y-1">
                    <div className="text-[11px] font-semibold text-token-muted">排序</div>
                    <div data-tour-id="webpages-sort-pills">
                      <SegmentPills options={SORT_OPTIONS} value={sort} onChange={setSort} />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] font-semibold text-token-muted">卡片尺寸</div>
                    <div data-tour-id="webpages-card-size-pills">
                      <SegmentPills
                        options={CARD_SIZE_OPTIONS.map(({ value, label }) => ({ value, label }))}
                        value={cardSize}
                        onChange={(v) => setCardSize(normalizeCardSize(v))}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[11px] font-semibold text-token-muted">来源筛选</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {SOURCE_FILTER_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setActiveSource(activeSource === opt.value ? null : opt.value)}
                          className="h-7 rounded-full px-2.5 text-[12px] transition-colors"
                          style={
                            activeSource === opt.value
                              ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
                              : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }
                          }
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="text-[11px] text-token-muted">偏好会被记住，下次进来沿用。</div>
                </div>
              </ToolbarPopover>

              <ToolbarPopover
                label="筛选"
                tourId="webpages-desktop-filter"
                count={filterCount}
                open={openToolbarPanel === 'filter'}
                onOpenChange={(v) => setOpenToolbarPanel(v ? 'filter' : null)}
              >
                <div className="space-y-3" style={{ minWidth: 300, maxWidth: 420 }}>
                  {currentSpace.kind !== 'team' && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold text-token-muted">文件夹</div>
                      <div data-tour-id="webpages-folders" className="flex flex-wrap items-center gap-1.5">
                        {spaceFolders.length > 0 ? (
                          <>
                            <button
                              type="button"
                              onClick={() => setActiveFolder(null)}
                              className="h-7 rounded-full px-2.5 text-[12px]"
                              style={activeFolder === null
                                ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
                                : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
                            >
                              全部
                            </button>
                            {spaceFolders.map((f) => (
                              <button
                                key={f}
                                type="button"
                                onClick={() => setActiveFolder(f)}
                                className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px]"
                                style={activeFolder === f
                                  ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
                                  : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
                              >
                                <Folder size={11} /> {f}
                              </button>
                            ))}
                          </>
                        ) : (
                          <div
                            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px]"
                            style={{ background: 'var(--bg-input)', border: '1px dashed var(--border-subtle)', color: 'var(--text-muted)' }}
                          >
                            <Folder size={11} /> 上传时填「文件夹」即可在此归档
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {tags.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold text-token-muted">标签</div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setActiveTag(null)}
                          className="h-7 rounded-full px-2.5 text-[12px] transition-colors"
                          style={!activeTag
                            ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
                            : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
                        >
                          全部
                        </button>
                        {tags.map(t => (
                          <button
                            key={t.tag}
                            type="button"
                            onClick={() => setActiveTag(t.tag === activeTag ? null : t.tag)}
                            className="h-7 rounded-full px-2.5 text-[12px] transition-colors"
                            style={activeTag === t.tag
                              ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
                              : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
                          >
                            {t.tag} ({t.count})
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {filterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => { setActiveFolder(null); setActiveTag(null); setActiveSource(null); }}
                      className="h-7 rounded-md px-2.5 text-[12px]"
                      style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                      清空筛选
                    </button>
                  )}
                </div>
              </ToolbarPopover>

              <div className="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-token-muted">
                {activeFolderLabel} · {activeSortLabel} · 共 {total} 个站点
              </div>
            </div>

            {currentSpace.kind === 'team' && (
              <div className="surface-nav-bar" data-tour-id="webpages-team-space-header">
                <TeamSpaceHeader teamId={currentSpace.teamId} myWebHostingRole={myWebHostingRole} />
              </div>
            )}
          </>
        )}

        {isMobile && (currentSpace.kind !== 'team' || canEditInWebHosting(myWebHostingRole)) && (
          <MobileFab onClick={openCreateUploadDialog} icon={Upload} label="上传" />
        )}

        {/* Batch actions */}
        {isMobile && (
          <MobileBottomSheet
            open={showMobileFilters}
            onClose={() => setShowMobileFilters(false)}
            title="筛选与显示"
            note={`${activeSpaceLabel} · ${total} 个站点`}
          >
              <div className="px-5 pb-4 space-y-5">
                <section className="space-y-2">
                  <div className="text-[12px] font-semibold text-token-muted">空间</div>
                  <div className="rounded-[14px] p-2 bg-token-nested border border-token-subtle">
                    <SpaceBar current={currentSpace} onChange={enterSpace} />
                  </div>
                </section>

                {currentSpace.kind === 'team' && (
                  <section className="space-y-2">
                    <div className="rounded-[14px] p-2 bg-token-nested border border-token-subtle">
                      <TeamSpaceHeader teamId={currentSpace.teamId} myWebHostingRole={myWebHostingRole} />
                    </div>
                  </section>
                )}

                <section className="space-y-2">
                  <div className="text-[12px] font-semibold text-token-muted">
                    {currentSpace.kind === 'team' ? '团队分组' : '文件夹'}
                  </div>
                  {currentSpace.kind === 'team' ? (
                    <TeamGroupsTree
                      groups={teamGroups}
                      activeGroupId={activeGroupId}
                      canEdit={canEditInWebHosting(myWebHostingRole)}
                      canManageAccess={myWebHostingRole === 'owner'}
                      totalCount={spaceSites.length}
                      ungroupedCount={groupCounts.ungrouped}
                      counts={groupCounts.counts}
                      onSelect={setActiveGroupId}
                      onCreate={handleCreateGroup}
                      onDelete={handleDeleteGroup}
                      onRename={handleRenameGroup}
                      onOpenAccess={setAccessGroup}
                      fullWidth
                    />
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveFolder(null)}
                        className="h-8 px-3 rounded-full text-[13px]"
                        style={activeFolder === null
                          ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                          : { background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }}
                      >
                        全部文件夹
                      </button>
                      {spaceFolders.map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => setActiveFolder(f)}
                          className="h-8 px-3 rounded-full text-[13px]"
                          style={activeFolder === f
                            ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                            : { background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                {tags.length > 0 && (
                  <section className="space-y-2">
                    <div className="text-[12px] font-semibold text-token-muted">标签</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveTag(null)}
                        className="h-8 px-3 rounded-full text-[13px]"
                        style={!activeTag
                          ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                          : { background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }}
                      >
                        全部标签
                      </button>
                      {tags.map((t) => (
                        <button
                          key={t.tag}
                          type="button"
                          onClick={() => setActiveTag(t.tag === activeTag ? null : t.tag)}
                          className="h-8 px-3 rounded-full text-[13px]"
                          style={activeTag === t.tag
                            ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                            : { background: 'var(--nested-block-bg)', color: 'var(--text-muted)' }}
                        >
                          {t.tag} ({t.count})
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                <section className="space-y-2">
                  <div className="text-[12px] font-semibold text-token-muted">排序</div>
                  <SegmentPills options={SORT_OPTIONS} value={sort} onChange={setSort} />
                </section>

                <section className="space-y-2">
                  <div className="text-[12px] font-semibold text-token-muted">分组方式</div>
                  <SegmentPills
                    options={[
                      { value: 'time', label: '日期' },
                      { value: 'folder', label: currentSpace.kind === 'team' ? '分组' : '文件夹' },
                    ]}
                    value={groupMode}
                    onChange={(v) => setGroupMode(v as GroupMode)}
                  />
                </section>

                <section className="space-y-2">
                  <div className="text-[12px] font-semibold text-token-muted">显示</div>
                  <div data-tour-id="webpages-view-toggle" className="inline-flex items-center rounded-lg overflow-hidden border border-token-default">
                    <button
                      type="button"
                      onClick={() => setViewMode('grid')}
                      className="h-9 px-4 inline-flex items-center gap-1.5 transition-colors"
                      style={{ background: viewMode === 'grid' ? 'var(--bg-elevated)' : 'var(--bg-sunken)', color: 'var(--text-primary)' }}
                    >
                      <Grid3X3 size={14} /> 网格
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('list')}
                      className="h-9 px-4 inline-flex items-center gap-1.5 transition-colors"
                      style={{ background: viewMode === 'list' ? 'var(--bg-elevated)' : 'var(--bg-sunken)', color: 'var(--text-primary)' }}
                    >
                      <List size={14} /> 列表
                    </button>
                  </div>
                </section>

                <section className="space-y-2">
                  <div className="text-[12px] font-semibold text-token-muted">更多操作</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowMobileFilters(false);
                        setShowAnalytics(true);
                      }}
                      className="h-10 rounded-[12px] inline-flex items-center justify-center gap-1.5 text-[13px] font-semibold bg-token-nested text-token-primary border border-token-subtle"
                    >
                      <BarChart3 size={15} /> 分享统计
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowMobileFilters(false);
                        setShareTargetId(null);
                        setShowSharesPanel(true);
                      }}
                      className="h-10 rounded-[12px] inline-flex items-center justify-center gap-1.5 text-[13px] font-semibold bg-token-nested text-token-primary border border-token-subtle"
                    >
                      <Link2 size={15} /> 分享管理
                    </button>
                    {currentSpace.kind === 'team' && canEditInWebHosting(myWebHostingRole) && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowMobileFilters(false);
                          setShowCopyFromPersonal(true);
                        }}
                        className="h-10 rounded-[12px] inline-flex items-center justify-center gap-1.5 text-[13px] font-semibold col-span-2 bg-token-nested text-token-primary border border-token-subtle"
                      >
                        <FolderInput size={15} /> 从个人空间添加
                      </button>
                    )}
                  </div>
                </section>
              </div>
          </MobileBottomSheet>
        )}

        {selectedIds.size > 0 && (
          <div className="surface-nav-bar flex items-center gap-2" style={{ overflow: 'visible' }}>
            <span className="text-sm text-token-muted">已选 {selectedIds.size} 项</span>
            {/* 团队作用域按角色门控批量操作；个人作用域全开（站点都是自己的）。后端是最终权威。 */}
            {(teamScope.scope !== 'team' || canShareInWebHosting(myWebHostingRole)) && (
              <Button size="xs" variant="secondary" onClick={handleBatchShare}><Share2 size={12} className="mr-1" /> 合集分享</Button>
            )}
            {/* 团队空间：把选中的网页移入专题/分类（编辑权限） */}
            {teamScope.scope === 'team' && canEditInWebHosting(myWebHostingRole) && teamGroups.length > 0 && (
              <select
                className="h-7 px-2 rounded-[8px] text-[12px] outline-none bg-token-input border border-token-default text-token-primary"
                value=""
                onChange={async (e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const gid = v === '__none__' ? null : v;
                  let ok = 0;
                  for (const id of selectedIds) {
                    const r = await setSiteGroup(id, gid);
                    if (r.success) ok++;
                  }
                  toast.success('已更新分组', `${ok} 个网页已${gid ? '移入所选分组' : '移出分组'}`);
                  setSelectedIds(new Set());
                  await load();
                }}
              >
                <option value="">移入分组…</option>
                <option value="__none__">移出分组</option>
                {teamGroups.map((g) => (
                  <option key={g.id} value={g.id}>{g.kind === 'topic' ? '专题' : '分类'} · {g.name}</option>
                ))}
              </select>
            )}
            {(teamScope.scope !== 'team' || myWebHostingRole === 'owner') && (
              <Button size="xs" variant="danger" onClick={handleBatchDelete}><Trash2 size={12} className="mr-1" /> 批量删除</Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => setSelectedIds(new Set())}>取消选择</Button>
          </div>
        )}
      </div>

      {workspaceTab === 'shares' && (
        <div className="flex-1 min-h-0">
          <SharesWorkspace
            sites={sites}
            links={shareLinks}
            onLinksChange={setShareLinks}
            onOpenAnalytics={() => setShowAnalytics(true)}
            onCreateShare={() => setWorkspaceTab('library')}
          />
        </div>
      )}

      {/* Content：团队空间左侧挂分组树导航（空间 → 专题 → 分类），个人空间保持原布局 */}
      <div
        className={!isMobile ? 'flex items-stretch gap-4 flex-1 min-h-0' : 'flex flex-col flex-1 min-h-0'}
        style={{ display: workspaceTab === 'library' ? undefined : 'none' }}
      >
        {currentSpace.kind === 'team' && !isMobile && (
          <TeamGroupsTree
            groups={teamGroups}
            activeGroupId={activeGroupId}
            canEdit={canEditInWebHosting(myWebHostingRole)}
            canManageAccess={myWebHostingRole === 'owner'}
            totalCount={spaceSites.length}
            ungroupedCount={groupCounts.ungrouped}
            counts={groupCounts.counts}
            onSelect={setActiveGroupId}
            onCreate={handleCreateGroup}
            onDelete={handleDeleteGroup}
            onRename={handleRenameGroup}
            onOpenAccess={setAccessGroup}
          />
        )}
        <div className="flex-1 min-w-0 flex flex-col">
      {loading && sites.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-token-muted">
          加载中...
        </div>
      ) : displaySites.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-token-muted">
          <UploadCloud size={48} strokeWidth={1} />
          <p>{currentSpace.kind === 'team' ? (activeGroupId ? '这个分组还没有网页' : '这个团队空间还没有网页') : activeFolder ? '这个文件夹还没有网页' : '还没有托管的网页'}</p>
          {/* 与顶部上传按钮同款权限闸门：团队空间只读 viewer 不展示上传入口，
              避免点开弹窗 uploadSite 后被 setTeams 403、徒留站点在个人空间 */}
          {(currentSpace.kind !== 'team' || canEditInWebHosting(myWebHostingRole)) && (
            <Button size="sm" variant="primary" onClick={openCreateUploadDialog}>
              <Upload size={14} className="mr-1" /> 上传第一个站点
            </Button>
          )}
          {/* 教程引导锚点占位：空态下也让「网页托管 3 步」教程能找到 webpages-card / webpages-viewcount 目标，
              避免「没找到目标元素」报错。占位卡是一张轻量预览卡，告诉新用户站点卡长什么样。 */}
          <div
            data-tour-id="webpages-card"
            className="mt-2 inline-flex items-center gap-2 px-3 py-2 rounded-lg text-[11px]"
            style={{ background: 'var(--bg-input)', border: '1px dashed var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            示例卡片预览：标题 · 描述
            <span data-tour-id="webpages-viewcount" className="inline-flex items-center gap-0.5">
              <Eye size={11} /> 0
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {siteGroups.map(group => (
            <div key={group.key} className="flex flex-col gap-2">
              {/* 分节标题：时间桶（今天/昨天/M月D日）或文件夹名 */}
              <div className="flex items-center gap-2 text-xs font-medium text-token-muted">
                {groupMode === 'folder' ? (
                  <Folder size={12} className="text-token-accent" />
                ) : (
                  <Clock size={12} className="text-token-accent" />
                )}
                <span>{group.label}</span>
                <span style={{ color: 'var(--text-faint, var(--text-muted))' }}>· {group.items.length}</span>
              </div>
              {renderGroupItems(group.items)}
            </div>
          ))}
        </div>
      )}
        </div>
        {!isMobile && (
          <SiteContextPanel
            site={contextSite}
            links={shareLinks}
            onCreateShare={(site) => handleShare(site.id)}
            onManageShares={(site) => { setShareTargetId(site.id); setShowSharesPanel(true); }}
            onAnalytics={() => setShowAnalytics(true)}
            onGuestPreview={(site) => handleVisitSite(site)}
            onRenew={(link) => { setShareTargetId(link.siteId ?? null); setShowSharesPanel(true); }}
          />
        )}
      </div>

      {/* Upload / Edit Dialog */}
      {showUploadDialog && (
        <UploadEditDialog
          item={editItem}
          folders={folders}
          initialFile={pendingExternalFile}
          onClose={() => { setShowUploadDialog(false); setEditItem(null); setPendingExternalFile(null); }}
          onShareSite={(id) => { setShowUploadDialog(false); setEditItem(null); setPendingExternalFile(null); setShareTargetId(id); setShowShareDialog(true); }}
          onSaved={async (saved, isCreate, keepOpen) => {
            // keepOpen：新建上传成功后弹窗要停在「完成态」展示地址与后续动作，
            // 副作用（归属团队 / 刷新列表 / 新卡光环）照旧跑，只是不关窗。
            if (!keepOpen) {
              setShowUploadDialog(false);
              setEditItem(null);
              setPendingExternalFile(null);
            }
            // 串数据修复：在团队空间内新建的站点必须归属该团队空间，否则会落到个人空间。
            // 用打开弹窗时快照的空间（uploadDialogSpaceRef），避免上传期间切换空间归错团队
            const dialogSpace = uploadDialogSpaceRef.current;
            if (saved && isCreate && dialogSpace.kind === 'team') {
              const assigned = await setSiteTeams(saved.id, [dialogSpace.teamId]);
              // 归属失败不能静默：告知用户站点暂在个人空间（与 dropzone 路径一致）
              if (!assigned.success) {
                toast.error('已上传，但归属团队失败', `${assigned.error?.message || '请稍后在卡片上手动移动到本团队'}（站点暂在个人空间）`);
              } else if (currentSpace.kind === 'team' && currentSpace.teamId === dialogSpace.teamId && activeRealGroupId) {
                // 仍停留在同一团队的专题/分类视图 → 新网页顺手归入该分组
                const grouped = await setSiteGroup(saved.id, activeRealGroupId);
                if (!grouped.success) toast.error('已上传，但归入分组失败', grouped.error?.message || '可稍后通过批量操作移入分组');
              }
            }
            load();
            loadMeta();
            // 仅"新建上传"触发滑入 + 光环动效；编辑/重传现有站点不动
            if (saved && isCreate) markSiteAsFresh(saved.id);
          }}
        />
      )}

      {/* 拖文件替换网页 — 二次确认 */}
      <Dialog
        open={!!replaceTarget}
        onOpenChange={(o) => { if (!o && !replacing) setReplaceTarget(null); }}
        title="替换网页内容"
        maxWidth={460}
        content={
          replaceTarget && (
            <div className="flex flex-col gap-4">
              <div
                className="flex items-start gap-2.5 rounded-xl p-3 text-[13px]"
                style={{ background: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.32)', color: 'var(--text-secondary)' }}
              >
                <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: '#fb923c' }} />
                <span>
                  即将用新文件覆盖「<span className="text-token-primary">{replaceTarget.site.title}</span>」的全部网页内容，
                  原有文件将被清理且<span className="text-token-primary">无法恢复</span>。访问链接保持不变。
                </span>
              </div>
              <div
                className="flex items-center gap-2.5 rounded-xl p-3"
                style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}
              >
                <Replace size={18} className="text-token-accent" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-token-primary">{replaceTarget.file.name}</p>
                  <p className="text-[11px] text-token-muted">{fmtSize(replaceTarget.file.size)}</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" disabled={replacing} onClick={() => setReplaceTarget(null)}>取消</Button>
                <Button size="sm" variant="primary" disabled={replacing} onClick={handleConfirmReplace}>
                  {replacing ? <MapSpinner size={14} className="mr-1" /> : <Replace size={14} className="mr-1" />}
                  确认替换
                </Button>
              </div>
            </div>
          )
        }
      />

      {/* Share Dialog（保留：拖拽快速分享场景等非 SharesPanel 路径仍使用） */}
      {showShareDialog && (
        <ShareDialog
          site={shareTargetId ? (sites.find(x => x.id === shareTargetId) ?? null) : null}
          existingShareCount={shareTargetId ? shareLinks.filter(l => !l.isRevoked && !l.isExpired && (l.siteId === shareTargetId || l.siteIds?.includes(shareTargetId))).length : 0}
          siteId={shareTargetId}
          siteIds={shareTargetId ? undefined : [...selectedIds]}
          onClose={() => { setShowShareDialog(false); setShareTargetId(null); loadShares(); }}
        />
      )}

      {/* Shares Panel：分享按钮主入口 — 列表 + 续期 + 取消 + 新建 一体化 */}
      {showSharesPanel && (
        <SharesPanel
          shares={shares}
          setShares={setShares}
          scopedSiteId={shareTargetId}
          scopedSiteTitle={shareTargetId ? (sites.find(s => s.id === shareTargetId)?.title ?? null) : null}
          scopedSite={shareTargetId ? (sites.find(s => s.id === shareTargetId) ?? null) : null}
          onClose={() => {
            setShowSharesPanel(false);
            setShareTargetId(null);
            loadShares();
          }}
        />
      )}

      {/* 分享统计 Drawer — 全局聚合（参考 Cloudflare 简化版） */}
      {showAnalytics && (
        <ShareAnalyticsDrawer onClose={() => setShowAnalytics(false)} />
      )}

      {/* QR Code Dialog */}
      {qrSite && (
        <QrCodeDialog site={qrSite} onClose={() => setQrSite(null)} />
      )}

      {libraryTargetSite && (
        <TransferToLibraryDialog
          site={libraryTargetSite}
          onClose={() => setLibraryTargetSite(null)}
        />
      )}

      {viewersTarget && (
        <SiteViewersDrawer
          siteId={viewersTarget.siteId}
          siteTitle={viewersTarget.siteTitle}
          onClose={() => setViewersTarget(null)}
        />
      )}

      {/* 评论管理：站点预览 iframe + 评论面板 + 允许评论开关 */}
      {commentSite && (
        <SitePreviewModal
          site={commentSite}
          onClose={() => setCommentSite(null)}
          canToggleComments={siteCaps(commentSite).canEdit}
          onCommentsEnabledChange={(sid, enabled) => {
            // 同步父组件持有的 site 快照 + 列表，避免关闭再开开关回退到旧值
            setCommentSite((prev) => (prev && prev.id === sid ? { ...prev, commentsEnabled: enabled } : prev));
            setSites((prev) => prev.map((x) => (x.id === sid ? { ...x, commentsEnabled: enabled } : x)));
          }}
          onAskEnabledChange={(sid, enabled) => {
            setCommentSite((prev) => (prev && prev.id === sid ? { ...prev, askEnabled: enabled } : prev));
            setSites((prev) => prev.map((x) => (x.id === sid ? { ...x, askEnabled: enabled } : x)));
          }}
        />
      )}

      {/* 提问设置：站点卡「更多设置 → 提问设置」直达，不必先打开大预览再找齿轮 */}
      {askConfigSite && (
        <AskConfigDrawer
          siteId={askConfigSite.id}
          siteTitle={askConfigSite.title}
          onClose={() => setAskConfigSite(null)}
          onSaved={(cfg) => {
            // 与评论开关同一处理：回填列表，避免关掉再开退回旧值
            setSites((prev) => prev.map((x) => (x.id === askConfigSite.id ? { ...x, askEnabled: cfg.enabled } : x)));
            setAskConfigSite((prev) => (prev ? { ...prev, askEnabled: cfg.enabled } : prev));
          }}
        />
      )}

      {movingSite && (
        <MoveSiteDialog
          site={movingSite}
          teams={teams}
          onClose={() => setMovingSite(null)}
          onMove={handleMoveSite}
        />
      )}

      {/* 从个人空间复制网页进当前团队（物理复制，原网页不受影响） */}
      {showCopyFromPersonal && currentSpace.kind === 'team' && (
        <CopyFromPersonalDialog
          teamId={currentSpace.teamId}
          initialGroupId={activeRealGroupId}
          groups={teamGroups}
          onClose={() => setShowCopyFromPersonal(false)}
          onCopied={() => { void load(); }}
        />
      )}

      {accessGroup && currentSpace.kind === 'team' && (
        <GroupAccessDialog
          group={accessGroup}
          teamId={currentSpace.teamId}
          onClose={() => setAccessGroup(null)}
          onSaved={() => { void loadGroups(); void load(); }}
        />
      )}
    </div>
  );
}

// ─── 团队空间分组树导航（空间 → 专题 → 分类） ───

function TeamGroupsTree({
  groups,
  activeGroupId,
  canEdit,
  canManageAccess,
  totalCount,
  ungroupedCount,
  counts,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onOpenAccess,
  fullWidth = false,
}: {
  groups: WebPageGroup[];
  activeGroupId: string | null;
  canEdit: boolean;
  canManageAccess: boolean;
  totalCount: number;
  ungroupedCount: number;
  counts: Map<string, number>;
  onSelect: (groupId: string | null) => void;
  onCreate: (kind: 'topic' | 'daily', name: string) => void | Promise<void>;
  onDelete: (group: WebPageGroup) => void | Promise<void>;
  onRename: (group: WebPageGroup, name: string) => void | Promise<void>;
  onOpenAccess: (group: WebPageGroup) => void;
  fullWidth?: boolean;
}) {
  // 节内新建：点击节标题的 + 在该节底部展开输入框
  const [creating, setCreating] = useState<'topic' | 'daily' | null>(null);
  const [name, setName] = useState('');
  // 双击分组行进入就地改名（编辑权限门控）
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const commitRename = async () => {
    if (!editing) return;
    const g = groups.find((x) => x.id === editing.id);
    const next = editing.value.trim();
    setEditing(null);
    if (!g || !next || next === g.name) return;
    await onRename(g, next);
  };

  const submitCreate = async () => {
    const n = name.trim();
    if (!n || !creating) return;
    await onCreate(creating, n);
    setName('');
    setCreating(null);
  };

  const itemStyle = (on: boolean): React.CSSProperties => (on
    ? { background: 'rgba(212,175,55,0.18)', color: 'var(--accent-gold, #d4af37)' }
    : { color: 'var(--text-muted)' });

  const row = (g: WebPageGroup) => {
    const on = activeGroupId === g.id;
    if (editing?.id === g.id) {
      return (
        <input
          key={g.id}
          autoFocus
          value={editing.value}
          onChange={(e) => setEditing({ id: g.id, value: e.target.value })}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename();
            if (e.key === 'Escape') setEditing(null);
          }}
          className="w-full h-7 px-2 rounded-[6px] text-[12px] outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid rgba(212,175,55,0.5)', color: 'var(--text-primary)' }}
        />
      );
    }
    return (
      <div
        key={g.id}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(on ? null : g.id)}
        onDoubleClick={() => { if (canEdit) setEditing({ id: g.id, value: g.name }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') onSelect(on ? null : g.id); }}
        title={canEdit ? '双击重命名' : undefined}
        className="group/tree-item w-full h-7 px-2 rounded-[6px] text-[12px] flex items-center gap-1.5 cursor-pointer transition-colors hover-bg-soft"
        style={itemStyle(on)}
      >
        <Folder size={11} className="shrink-0" />
        <span className="flex-1 truncate" style={on ? undefined : { color: 'var(--text-primary)' }}>{g.name}</span>
        {g.visibility === 'restricted' && (
          <Lock size={9} className="shrink-0 opacity-70" aria-label="受限分组" />
        )}
        {canManageAccess && (
          <button
            type="button"
            title="访问权限"
            className="shrink-0 opacity-0 group-hover/tree-item:opacity-70 hover:!opacity-100"
            style={{ color: 'inherit' }}
            onClick={(e) => { e.stopPropagation(); onOpenAccess(g); }}
          >
            <Settings2 size={11} />
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            title="删除分组（组内网页回到未分组）"
            className="shrink-0 opacity-0 group-hover/tree-item:opacity-70 hover:!opacity-100"
            style={{ color: 'inherit' }}
            onClick={(e) => { e.stopPropagation(); void onDelete(g); }}
          >
            <X size={11} />
          </button>
        )}
        <span className="shrink-0 text-[10px] opacity-60">{counts.get(g.id) ?? 0}</span>
      </div>
    );
  };

  const section = (kind: 'topic' | 'daily', label: string, items: WebPageGroup[]) => (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between h-6 px-2">
        <span className="text-[11px] font-medium text-token-muted">{label}</span>
        {canEdit && (
          <button
            type="button"
            title={kind === 'topic' ? '新建专题（可先建空专题再加内容）' : '新建日常分类'}
            className="opacity-60 hover:opacity-100 text-token-muted"
            onClick={() => { setCreating(kind); setName(''); }}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {items.map(row)}
      {items.length === 0 && creating !== kind && (
        <div className="px-2 py-1 text-[11px] text-token-muted">
          {canEdit ? `点 + 新建${label}` : `还没有${label}`}
        </div>
      )}
      {creating === kind && (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'topic' ? '新专题名称，回车创建' : '新分类名称，回车创建'}
          className="w-full h-7 px-2 rounded-[6px] text-[12px] outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid rgba(212,175,55,0.5)', color: 'var(--text-primary)' }}
          onBlur={() => { if (!name.trim()) setCreating(null); else void submitCreate(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate(); if (e.key === 'Escape') setCreating(null); }}
        />
      )}
    </div>
  );

  return (
    <aside
      data-tour-id="webpages-folders"
      className={`${fullWidth ? 'w-full' : 'w-[212px]'} shrink-0 rounded-xl p-2 space-y-2`}
      style={{
        position: fullWidth ? undefined : 'sticky',
        top: fullWidth ? undefined : 0,
        alignSelf: 'flex-start',
        maxHeight: fullWidth ? 360 : '80vh',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(null)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSelect(null); }}
        className="w-full h-7 px-2 rounded-[6px] text-[12px] flex items-center gap-1.5 cursor-pointer transition-colors hover-bg-soft"
        style={itemStyle(activeGroupId === null)}
      >
        <Grid3X3 size={11} className="shrink-0" />
        <span className="flex-1" style={activeGroupId === null ? undefined : { color: 'var(--text-primary)' }}>全部</span>
        <span className="shrink-0 text-[10px] opacity-60">{totalCount}</span>
      </div>
      {ungroupedCount > 0 && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(activeGroupId === UNGROUPED_ID ? null : UNGROUPED_ID)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSelect(activeGroupId === UNGROUPED_ID ? null : UNGROUPED_ID); }}
          className="w-full h-7 px-2 rounded-[6px] text-[12px] flex items-center gap-1.5 cursor-pointer transition-colors hover-bg-soft"
          style={itemStyle(activeGroupId === UNGROUPED_ID)}
        >
          <FolderInput size={11} className="shrink-0" />
          <span className="flex-1" style={activeGroupId === UNGROUPED_ID ? undefined : { color: 'var(--text-primary)' }}>未分组</span>
          <span className="shrink-0 text-[10px] opacity-60">{ungroupedCount}</span>
        </div>
      )}
      <div className="h-px" style={{ background: 'var(--border-default)' }} />
      {section('topic', '专题', groups.filter((g) => g.kind === 'topic'))}
      {section('daily', '分类', groups.filter((g) => g.kind === 'daily'))}
    </aside>
  );
}

// ─── 从个人空间复制网页进团队 ───

function CopyFromPersonalDialog({
  teamId,
  initialGroupId,
  groups,
  onClose,
  onCopied,
}: {
  teamId: string;
  initialGroupId: string | null;
  groups: WebPageGroup[];
  onClose: () => void;
  onCopied: () => void;
}) {
  const [items, setItems] = useState<HostedSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copiedIds, setCopiedIds] = useState<Set<string>>(new Set());
  const [targetGroupId, setTargetGroupId] = useState<string>(initialGroupId ?? '');

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const res = await listSites({ limit: 200, scope: 'mine' });
      if (alive && res.success) {
        // 只列纯个人空间的网页（未进任何团队的），与个人空间视图口径一致
        setItems(res.data.items.filter((s) => !(s.sharedTeamIds && s.sharedTeamIds.length)));
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((s) => s.title.toLowerCase().includes(kw) || (s.description ?? '').toLowerCase().includes(kw));
  }, [items, keyword]);

  const handleCopy = async (site: HostedSite) => {
    if (copyingId) return;
    setCopyingId(site.id);
    const res = await copySiteToTeam(site.id, teamId, targetGroupId || null);
    setCopyingId(null);
    if (res.success) {
      setCopiedIds((prev) => new Set(prev).add(site.id));
      toast.success('已复制进团队', `「${site.title}」已复制为团队网页，原网页不受影响`);
      onCopied();
    } else {
      toast.error('复制失败', res.error?.message);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="rounded-[14px] w-full flex flex-col" style={{ maxWidth: 560, height: '70vh', maxHeight: '70vh', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-5 h-[52px] flex items-center justify-between border-b border-token-subtle">
          <span className="text-[15px] font-semibold text-token-primary">从个人空间添加网页</span>
          <button type="button" onClick={onClose} className="text-token-muted"><X size={18} /></button>
        </div>
        <div className="shrink-0 px-4 pt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-token-muted" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索个人空间的网页…"
              className="w-full h-8 pl-8 pr-2 rounded-[8px] text-[13px] outline-none bg-token-input border border-token-subtle text-token-primary"
            />
          </div>
          {groups.length > 0 && (
            <select
              value={targetGroupId}
              onChange={(e) => setTargetGroupId(e.target.value)}
              title="副本归入的专题/分类（可选）"
              className="h-8 px-2 rounded-[8px] text-[12px] outline-none bg-token-input border border-token-subtle text-token-primary"
            >
              <option value="">不归入分组</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.kind === 'topic' ? '专题' : '分类'} · {g.name}</option>
              ))}
            </select>
          )}
        </div>
        <p className="shrink-0 px-4 pt-2 text-[11px] text-token-muted">
          复制 = 物理拷贝一份独立副本进团队空间，原个人网页的链接、分享、规则全部不受影响。
        </p>
        <div className="flex-1 p-4 space-y-1.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading ? (
            <MapSectionLoader text="正在加载个人空间网页…" />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-token-muted">
              <UploadCloud size={32} strokeWidth={1} />
              <p className="text-[13px]">{keyword ? '没有匹配的网页' : '个人空间还没有可复制的网页'}</p>
            </div>
          ) : (
            filtered.map((site) => {
              const copied = copiedIds.has(site.id);
              return (
                <div key={site.id} className="flex items-center gap-3 px-3 py-2 rounded-[10px] bg-token-input border border-token-subtle">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-token-primary">{site.title}</p>
                    <p className="truncate text-[11px] text-token-muted">
                      {site.files.length} 个文件 · {fmtSize(site.totalSize)} · {relativeTime(site.updatedAt)}
                    </p>
                  </div>
                  <Button size="xs" variant={copied ? 'ghost' : 'secondary'} disabled={copied || copyingId === site.id}
                    onClick={() => handleCopy(site)}>
                    {copyingId === site.id ? <MapSpinner size={12} className="mr-1" /> : copied ? <Check size={12} className="mr-1" /> : <Copy size={12} className="mr-1" />}
                    {copied ? '已复制' : '复制进团队'}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── 移动到空间 / 文件夹 ───

function MoveSiteDialog({
  site,
  teams,
  onClose,
  onMove,
}: {
  site: HostedSite;
  teams: TeamListItem[];
  onClose: () => void;
  onMove: (space: Space, folder: string | null) => void | Promise<void>;
}) {
  const inTeam = !!(site.sharedTeamIds && site.sharedTeamIds.length);
  const initial: Space = inTeam ? { kind: 'team', teamId: site.sharedTeamIds![0] } : { kind: 'personal' };
  const [space, setSpace] = useState<Space>(initial);
  const [folder, setFolder] = useState(site.folder ?? '');

  const row = (label: React.ReactNode, on: boolean, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-[8px] text-[13px] text-left"
      style={on
        ? { background: 'rgba(212,175,55,0.16)', color: 'var(--text-primary)', border: '1px solid var(--accent-gold, #d4af37)' }
        : { background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
    >
      {label}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="rounded-[14px] w-full flex flex-col" style={{ maxWidth: 420, maxHeight: '80vh', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 px-5 h-[52px] flex items-center justify-between border-b border-token-subtle">
          <span className="text-[15px] font-semibold truncate text-token-primary">移动「{site.title}」</span>
          <button type="button" onClick={onClose} className="text-token-muted"><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3" style={{ overscrollBehavior: 'contain' }}>
          <div className="text-[12px] text-token-muted">移动到哪个空间</div>
          <div className="flex flex-col gap-1.5">
            {row(<><User size={14} /> 个人空间</>, space.kind === 'personal', () => setSpace({ kind: 'personal' }), 'personal')}
            {teams.map((t) =>
              row(
                <><Users size={14} /> {t.team.name}</>,
                space.kind === 'team' && space.teamId === t.team.id,
                () => setSpace({ kind: 'team', teamId: t.team.id }),
                t.team.id,
              ),
            )}
          </div>
          <div className="text-[12px] pt-1 text-token-muted">文件夹（空间内组织，可留空）</div>
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="文件夹名（留空 = 不归档）"
            className="w-full h-9 px-3 rounded-[8px] text-[13px] outline-none bg-token-input border border-token-subtle text-token-primary"
          />
        </div>
        <div className="shrink-0 flex justify-end gap-2 px-4 py-3 border-t border-token-subtle">
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button size="sm" variant="primary" onClick={() => onMove(space, folder.trim() || null)}>移动</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Card View ───

// ─── Iframe Thumbnail Preview ───

// ─── QR Code Dialog (auto-creates share link) ───

function QrCodeDialog({ site, onClose }: { site: HostedSite; onClose: () => void }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // 扫码访问 = 永久访问便捷链，与「访问」按钮同源走 resolveVisitUrl：
      // 落在隔离的 visit 池（purpose:'visit'），绝不复用/篡改用户主动创建的限期分享，
      // 也不依赖 listSiteShares 分页扫描。失败兜底裸链接，二维码恒可用。
      const url = await resolveVisitUrl(site);
      if (cancelled) return;
      setLoading(false);
      setShareUrl(url);
    })();
    return () => { cancelled = true; };
  }, [site]);

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title="扫码访问"
      description={site.title}
      content={
        <div className="flex flex-col items-center gap-4 py-4">
          {loading ? (
            <MapSectionLoader text="正在生成分享链接…" />
          ) : shareUrl ? (
            <>
              <div className="p-4 rounded-2xl" style={{ background: '#fff' }}>
                <QRCodeSVG value={shareUrl} size={280} level="H" />
              </div>
              <p className="text-xs text-center break-all px-4" style={{ color: 'var(--text-muted)', maxWidth: 320 }}>
                {shareUrl}
              </p>
            </>
          ) : null}
        </div>
      }
    />
  );
}

// SitePreview 已提取到 @/components/SitePreview

// ─── Transfer to Knowledge Library Dialog ───

function TransferToLibraryDialog({ site, onClose }: { site: HostedSite; onClose: () => void }) {
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null); // 正在转存的目标 storeId
  const [done, setDone] = useState<string | null>(null);             // 已转存成功的目标 storeId
  // 转存到知识库后展示的条目标题。默认 = 站点标题，可在转存前自由修改。
  const [entryTitle, setEntryTitle] = useState(site.title);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await listDocumentStores(1, 100);
      if (cancelled) return;
      setLoading(false);
      if (res.success) {
        setStores(res.data.items);
      } else {
        setError(res.error?.message || '加载知识库列表失败');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleTransfer = async (store: DocumentStore) => {
    if (submitting) return;
    const trimmed = entryTitle.trim();
    if (!trimmed) { setError('请填写条目标题'); return; }
    setSubmitting(store.id);
    setError('');
    const res = await addDocumentEntry(store.id, {
      title: trimmed,
      summary: site.description || undefined,
      sourceType: 'reference',
      contentType: 'text/html',
      tags: site.tags ?? [],
      metadata: {
        sourceUrl: site.siteUrl,
        sourceHostedSiteId: site.id,
        sourceKind: 'hosted_site',
      },
    });
    setSubmitting(null);
    if (res.success) {
      setDone(store.id);
      window.setTimeout(() => onClose(), 1000);
    } else {
      setError(res.error?.message || '转存失败');
    }
  };

  const trimmedTitle = entryTitle.trim();

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title="转存到知识库"
      description={`将「${site.title}」作为引用条目存到指定知识库（标题可改后再转存）`}
      content={
        <div className="flex flex-col gap-3">
          {/* 标题输入：默认拿站点标题，转存前可改 */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-token-muted">知识库条目标题</label>
            <input
              type="text"
              value={entryTitle}
              onChange={(e) => { setEntryTitle(e.target.value); if (error) setError(''); }}
              maxLength={200}
              placeholder="输入条目标题（默认 = 站点标题）"
              className="h-9 w-full rounded-lg px-3 text-[13px] outline-none"
              style={{
                background: 'var(--bg-sunken)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
            />
          </div>

          {loading ? (
            <MapSectionLoader text="正在加载知识库列表…" />
          ) : error && stores.length === 0 ? (
            <p className="text-sm py-6 text-center" style={{ color: '#ef4444' }}>{error}</p>
          ) : stores.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6 text-token-muted">
              <Library size={36} strokeWidth={1.4} />
              <p className="text-sm">还没有任何知识库</p>
              <p className="text-xs">先到「智识殿堂」创建一个，再回来转存。</p>
            </div>
          ) : (
            <>
              {error && <p className="text-xs" style={{ color: '#ef4444' }}>{error}</p>}
              <div className="flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
                {stores.map(store => {
                  const isSubmitting = submitting === store.id;
                  const isDone = done === store.id;
                  return (
                    <button
                      key={store.id}
                      type="button"
                      disabled={!!submitting || !!done || !trimmedTitle}
                      onClick={() => handleTransfer(store)}
                      className="group/store flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:opacity-60"
                      style={{
                        background: 'var(--bg-sunken)',
                        border: '1px solid var(--border-default)',
                      }}
                    >
                      <Library size={18} className="text-token-accent" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-token-primary">{store.name}</p>
                        <p className="truncate text-[11px] text-token-muted">
                          {store.description || `${store.documentCount ?? 0} 个文档`}
                        </p>
                      </div>
                      {isDone ? (
                        <span className="inline-flex items-center gap-1 text-xs" style={{ color: '#10b981' }}>
                          <Check size={14} /> 已转存
                        </span>
                      ) : isSubmitting ? (
                        <MapSpinner size={14} />
                      ) : (
                        <span className="text-xs opacity-0 transition-opacity group-hover/store:opacity-100 text-token-secondary">
                          转存 →
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-token-muted">
                以引用方式保存：知识库里新建一条指向当前公开链接的条目，预览自动 iframe 嵌入站点页面。
              </p>
            </>
          )}
        </div>
      }
    />
  );
}


type MoreAction = {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  color?: string;
} | null;

function MoreActionsButton({ actions }: { actions: MoreAction[] }) {
  const availableActions = actions.filter((action): action is NonNullable<MoreAction> => Boolean(action));
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  if (availableActions.length === 0) return null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-black/38 text-token-primary shadow-md backdrop-blur-md transition-colors hover:bg-black/58"
        title="更多设置"
        aria-label="更多设置"
        data-no-drag
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <AnchoredMenu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          minWidth={184}
          align="left"
          style={{ padding: 6 }}
        >
          {availableActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs font-medium transition-colors hover-bg-soft"
              style={{ color: action.color ?? (action.danger ? '#fecaca' : 'var(--text-secondary)') }}
              onClick={() => {
                setOpen(false);
                action.onClick();
              }}
            >
              <span className="inline-flex w-4 shrink-0 items-center justify-center">{action.icon}</span>
              <span className="truncate">{action.label}</span>
            </button>
          ))}
        </AnchoredMenu>
      )}
    </>
  );
}

// ─── List View ───

function SiteListItem({ site, selected, shared, caps, onSelect, onEdit, onDelete, onShare, onQrCode, onTogglePublic, onComments, onAskConfig }: {
  site: HostedSite;
  selected: boolean;
  shared?: boolean;
  caps?: SiteCaps;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onQrCode: () => void;
  onTogglePublic: () => void;
  onComments?: () => void;
  /** 提问设置抽屉；仅 canEdit 时传入 */
  onAskConfig?: () => void;
}) {
  const c = caps ?? { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };
  const isPublic = site.visibility === 'public';
  const { onPointerDown } = useDockDrag({
    mime: WEB_PAGE_MIME,
    id: site.id,
    label: site.title,
    icon: 'WEB',
  });
  // 访问地址与 SiteCard 网格视图一致：统一走 /s/wp/{token}，避免列表/网格切换得到不同 URL
  const handleVisit = () => {
    // 记录一次访客痕迹（fire-and-forget，不阻塞打开）
    void recordSiteView(site.id);
    const w = window.open('', '_blank');
    resolveVisitUrl(site).then(url => { if (w) w.location.href = url; });
  };
  return (
    <div
      className="group flex items-center gap-4 px-3 py-2 rounded-md cursor-grab active:cursor-grabbing touch-none transition-colors hover:bg-[var(--bg-hover,rgba(255,255,255,0.04))]"
      style={{
        background: selected ? 'rgba(99,102,241,0.10)' : 'transparent',
      }}
      onPointerDown={onPointerDown}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        className="shrink-0"
        style={{ accentColor: 'var(--accent-primary)' }}
      />

      {site.coverImageUrl ? (
        <img src={site.coverImageUrl} alt="" className="shrink-0 w-10 h-10 rounded object-cover" />
      ) : isPdfSite(site) ? (
        <PdfThumbnail className="shrink-0 w-10 h-10 rounded overflow-hidden" compact />
      ) : (
        <div className="shrink-0 w-10 h-10 rounded overflow-hidden" style={{ background: 'var(--bg-sunken)' }}>
          <SitePreview site={site} url={site.siteUrl} className="w-full h-full" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {shared && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-medium"
              style={{ color: 'var(--semantic-warning-text)' }}
              title="已分享"
            >
              <Link2 size={10} /> 已分享
            </span>
          )}
          <span
            className="text-sm font-medium truncate cursor-pointer hover:underline"
            style={{ color: shared ? 'var(--semantic-warning-text)' : 'var(--text-primary)' }}
            onClick={handleVisit}
          >
            {site.title}
          </span>
          {site.sourceType !== 'upload' && (
            <Badge variant={site.sourceType === 'workflow' ? 'subtle' : site.sourceType === 'api' ? 'warning' : 'subtle'}>
              {sourceTypeLabels[site.sourceType] ?? site.sourceType}
            </Badge>
          )}
          {isPublic && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: 'var(--semantic-success-soft)', color: 'var(--semantic-success-text)', border: '1px solid var(--semantic-success-border)' }}
              title="已公开"
            >
              <Globe size={10} /> 公开
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-token-muted">
          <span>{site.files.length} 个文件</span>
          <span>{fmtSize(site.totalSize)}</span>
          <span>{site.entryFile}</span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs shrink-0 text-token-muted">
        {site.folder && <span className="flex items-center gap-1"><FolderOpen size={12} /> {site.folder}</span>}
        <span className="flex items-center gap-1"><Eye size={12} /> {site.viewCount}</span>
        <span>{relativeTime(site.createdAt)}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button onClick={handleVisit} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="打开" aria-label="打开">
          <ExternalLink size={14} className="text-token-muted" />
        </button>
        {c.canShare && (
          <button
            onClick={onShare}
            className="p-1 rounded hover:bg-[var(--bg-hover)]"
            title={shared ? '已分享' : '分享'}
            aria-label={shared ? '已分享' : '分享'}
          >
            {shared
              ? <Link2 size={14} style={{ color: '#fcd34d' }} />
              : <Share2 size={14} className="text-token-muted" />}
          </button>
        )}
        {c.canEdit && (
          <button onClick={onEdit} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="编辑" aria-label="编辑">
            <Edit3 size={14} className="text-token-muted" />
          </button>
        )}
        <MoreActionsButton
          actions={[
            { label: '二维码', icon: <QrCode size={13} />, onClick: onQrCode },
            c.canSetVisibility
              ? isPublic
                ? { label: '取消公开', icon: <Lock size={13} />, onClick: onTogglePublic, color: '#fca5a5' }
                : { label: '发布到公开页', icon: <Globe size={13} />, onClick: onTogglePublic, color: 'var(--semantic-success-text)' }
              : null,
            onComments
              ? { label: '评论管理', icon: <MessageSquare size={13} />, onClick: onComments }
              : null,
            onAskConfig
              ? { label: '提问设置', icon: <MessageCircleQuestion size={13} />, onClick: onAskConfig }
              : null,
            c.canDelete
              ? { label: '删除', icon: <Trash2 size={13} />, onClick: onDelete, danger: true }
              : null,
          ]}
        />
      </div>
    </div>
  );
}

// ─── Upload / Edit Dialog ───

function UploadEditDialog({ item, folders, onClose, onSaved, onShareSite, initialFile }: {
  item: HostedSite | null;
  folders: string[];
  onClose: () => void;
  /** keepOpen=true 时页面只跑副作用、不关窗（新建成功后停在完成态） */
  onSaved: (saved?: HostedSite, isCreate?: boolean, keepOpen?: boolean) => void;
  /** 完成态「立即分享」：关掉本窗，直接拉起分享弹窗 */
  onShareSite: (siteId: string) => void;
  initialFile?: File | null;
}) {
  const isEdit = !!item;
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  /** 已确认的标签（chips）；tagInput 只是还没回车的那一个 */
  const [tags, setTags] = useState<string[]>(item?.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [folder, setFolder] = useState(item?.folder ?? '');
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  // 用户是否亲自编辑过标题；编辑过则不再自动同步文件名
  const titleEditedRef = useRef(false);
  // 新增上传场景下，文件类型为 .md/.markdown 时把"文件名（去扩展名）"作为默认标题
  useEffect(() => {
    if (isEdit) return;
    if (titleEditedRef.current) return;
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (ext !== '.md' && ext !== '.markdown') return;
    const stem = file.name.slice(0, file.name.lastIndexOf('.')) || file.name;
    setTitle(stem);
  }, [file, isEdit]);
  const [saving, setSaving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 上传中 / 完成态（设计稿屏 3 的另外两态）──
  // 上传是这个弹窗里唯一会让用户干等的动作，500MB 的包能等好几分钟；
  // 之前只有一个「处理中...」的按钮文字，屏幕上没有任何东西在动。
  const [sent, setSent] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 });
  const [elapsed, setElapsed] = useState(0);
  /** 服务端解包进度（旁路轮询回来的真实帧）；拿不到就保持 null，前端据此退回诚实说法 */
  const [unpack, setUnpack] = useState<UnpackFrame | null>(null);
  const startedAtRef = useRef(0);
  /** 本次上传的标识；随表单发给后端，后端据它记进度 */
  const uploadIdRef = useRef<string>('');
  /** 在飞的 XHR，用户点「中止」时 abort 它 */
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  // 用户点了「转到后台」→ 本窗关掉但 XHR 不中断，完成后由页面 toast + 刷新兜底
  const backgroundedRef = useRef(false);
  const [created, setCreated] = useState<HostedSite | null>(null);

  useEffect(() => {
    if (!saving) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 400);
    return () => clearInterval(t);
  }, [saving]);

  // 解包进度旁路轮询。1s 一次：解包是秒级过程，再密就是白打请求。
  // 拿不到（Redis 不可用 / 还没开始 / 单文件站没有解包这一步）就一直是 null，
  // buildUploadProgress 会退回「这一步没有进度可报」，不会编一个数出来。
  useEffect(() => {
    if (!saving || !uploadIdRef.current) return;
    let alive = true;
    const tick = async () => {
      const res = await getUploadProgress(uploadIdRef.current);
      if (!alive) return;
      if (res.success && !res.data.pending) setUnpack(res.data);
    };
    void tick();
    const t = setInterval(() => { void tick(); }, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [saving]);

  const progress = buildUploadProgress(sent.loaded, sent.total, elapsed, unpack);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const handleSave = async () => {
    if (!isEdit && !file) return;
    // 打完字直接点「开始上传」是常态，没回车的那一个也算数，别静默丢掉
    const pendingTag = tagInput.trim();
    const effectiveTags = pendingTag && !tags.includes(pendingTag) ? [...tags, pendingTag] : tags;

    startedAtRef.current = Date.now();
    setElapsed(0);
    setSent({ loaded: 0, total: file?.size ?? 0 });
    setUnpack(null);
    uploadIdRef.current = crypto.randomUUID();
    setSaving(true);

    try {
      if (isEdit) {
        if (file) {
          // Reupload
          const res = await reuploadSite(item.id, file);
          if (!res.success) {
            toast.error('重新上传失败', res.error?.message || '请稍后重试');
            return;
          }
        }
        // Update metadata
        const res = await updateSite(item.id, {
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          tags: effectiveTags,
          folder: folder.trim() || undefined,
        });
        if (!res.success) {
          toast.error('保存失败', res.error?.message || '请稍后重试');
          return;
        }
        onSaved(res.data, /*isCreate*/ false);
      } else {
        const res = await uploadSite({
          file: file!,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          folder: folder.trim() || undefined,
          tags: effectiveTags.length > 0 ? effectiveTags.join(',') : undefined,
          onProgress: (loaded, total) => setSent({ loaded, total }),
          uploadId: uploadIdRef.current,
          onStart: (xhr) => { xhrRef.current = xhr; },
        });
        if (!res.success) {
          // 用户自己点的中止不是错误，不弹红条
          if (res.error?.code !== 'ABORTED') toast.error('上传失败', res.error?.message || '请稍后重试');
          return;
        }
        if (backgroundedRef.current) {
          // 用户已经把它转到后台、弹窗早关了 —— 走原路径让页面收尾（刷新 + 新卡光环）
          toast.success('后台上传完成', `「${res.data.title || file!.name}」已进入网页库`);
          onSaved(res.data, true);
          return;
        }
        // 停在完成态：给可打开的地址 + 下一步动作，而不是关窗让用户自己去列表里找
        setCreated(res.data);
        onSaved(res.data, /*isCreate*/ true, /*keepOpen*/ true);
      }
    } catch (error) {
      toast.error(isEdit ? '保存失败' : '上传失败', error instanceof Error ? error.message : '网络异常，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title={created ? '上传完成' : isEdit ? '编辑站点' : '上传站点'}
      content={
        created ? (
          /* ── 完成态：给可打开的地址 + 三个下一步，而不是关窗让用户自己去列表里找 ── */
          <div className="flex flex-col gap-4">
            <div
              className="flex items-start gap-2.5 rounded-xl p-3"
              style={{ background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.28)' }}
            >
              <Check size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-fg-emerald)' }} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium" style={{ color: 'var(--accent-fg-emerald)' }}>
                  「{created.title || created.entryFile}」已经可以打开了
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  入口 {created.entryFile}{' · '}用时 {fmtDuration(elapsed)}
                </div>
              </div>
            </div>

            {/* 产物预览：让用户当场确认「传上去的确实是这一份」，
                而不是只看到一个地址就要相信它 */}
            <div className="overflow-hidden rounded-xl" style={{ border: '1px solid var(--border-subtle)' }}>
              <div className="px-3 py-1.5 text-[11px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                构建产物预览
              </div>
              <div style={{ height: 132, background: 'var(--bg-card)' }}>
                <SitePreview site={created} url={created.siteUrl} className="h-full w-full" />
              </div>
              <div className="px-3 py-2" style={{ background: 'var(--bg-card)', borderTop: '1px solid var(--border-faint)' }}>
                <div className="truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {created.title || created.entryFile}
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {resolveSiteForm(created).toUpperCase()} 站 · {created.files.length.toLocaleString()} 文件 · {fmtSize(created.totalSize)}
                </div>
              </div>
            </div>

            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>可打开的地址</div>
            <div className="-mt-2 flex items-center gap-2">
              <input
                type="text"
                value={`${window.location.origin}${created.siteUrl}`}
                readOnly
                className="flex-1 px-3 py-2 rounded-lg text-sm outline-none font-mono"
                style={inputStyle}
              />
              <Button size="sm" variant="secondary" onClick={() => {
                navigator.clipboard.writeText(`${window.location.origin}${created.siteUrl}`);
                toast.success('地址已复制');
              }}>
                <Copy size={14} />
              </Button>
            </div>

            {/* 提问默认关闭：这是最容易被误以为「功能坏了」的一处，
                所以在用户刚上传完、还记得这个站点时就说清楚，而不是等他去预览里找按钮 */}
            <div
              className="flex items-start gap-2.5 rounded-xl p-3 text-xs leading-relaxed"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              <MessageCircleQuestion size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
              <span>
                这个站点的「向我提问」<span style={{ color: 'var(--text-primary)' }}>默认是关闭的</span>
                （开启后访客每次提问都会消耗模型额度）。要让访客能问，在卡片菜单的
                <span style={{ color: 'var(--text-primary)' }}>「提问设置」</span>里打开。
              </span>
            </div>

            {/* 主次分明：立即分享是满宽主按钮，另两个是次操作。
                三个平级按钮等于没有推荐动作，用户还得自己想先点哪个 */}
            <Button
              onClick={() => onShareSite(created.id)}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              <Share2 size={14} className="mr-1" />立即分享
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" style={{ justifyContent: 'center' }} onClick={() => window.open(created.siteUrl, '_blank', 'noopener')}>
                <ExternalLink size={14} className="mr-1" />打开站点
              </Button>
              <Button variant="secondary" style={{ justifyContent: 'center' }} onClick={() => {
                // 再传一个：清空表单回到待选态，省掉「关窗 → 再点上传」两步
                setCreated(null);
                setFile(null);
                setTitle('');
                setDescription('');
                setTags([]);
                setTagInput('');
                setUnpack(null);
                titleEditedRef.current = false;
                setSent({ loaded: 0, total: 0 });
                setElapsed(0);
              }}>
                <Upload size={14} className="mr-1" />再传一个
              </Button>
            </div>
          </div>
        ) : saving && !isEdit ? (
          /* ── 上传中：屏幕上必须有真实在动的东西，且说得出「还要多久」 ── */
          <div className="flex flex-col gap-4 py-1">
            {/* 文件行 */}
            <div className="flex items-center gap-2">
              <FileArchive size={15} style={{ color: 'var(--text-muted)' }} />
              <span className="flex-1 truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{file?.name}</span>
              <span className="font-mono text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {fmtSize(sent.total || (file?.size ?? 0))}
              </span>
            </div>

            {/* 大数字进度：这一屏用户只关心一件事——还要多久 */}
            <div className="flex items-end justify-between gap-3">
              <div className="flex items-baseline gap-0.5">
                <span className="text-[34px] font-semibold leading-none tabular-nums" style={{ color: 'var(--text-primary)' }}>
                  {Math.round(progress.ratio * 100)}
                </span>
                <span className="text-[15px]" style={{ color: 'var(--text-muted)' }}>%</span>
              </div>
              <span className="pb-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>{progress.detail}</span>
            </div>

            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
              {/* 服务端报不出解包进度时进度条会停在满格，用呼吸动画表示「还在动」，
                  而不是让满条静止装完成 */}
              <div
                className={progress.phase === 'processing' && progress.steps.length === 0 ? 'h-full rounded-full animate-pulse' : 'h-full rounded-full'}
                style={{
                  width: `${Math.round(progress.ratio * 100)}%`,
                  background: 'var(--accent-primary)',
                  transition: 'width 300ms ease-out',
                }}
              />
            </div>

            {/* 解包分步清单：全部来自服务端真实计数，拿不到就整块不出现 */}
            {progress.steps.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {progress.steps.map((st, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px]">
                    {st.state === 'done'
                      ? <Check size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-fg-emerald)' }} />
                      : <span className="mt-1.5 block shrink-0 rounded-full" style={{ width: 6, height: 6, background: 'var(--accent-primary)' }} />}
                    <div className="min-w-0">
                      <div style={{ color: st.state === 'done' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{st.text}</div>
                      {st.sub && (
                        <div className="truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{st.sub}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div
              className="rounded-lg px-3 py-2 text-[11.5px] leading-relaxed"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
            >
              可以关掉这个弹窗，上传在后台继续；完成后卡片会带滑入 + 光环出现在列表最前面，你能立刻认出刚传的是哪张。
            </div>

            {/* 等宽两列（设计稿如此）：两者都是「离开这个等待」的出口，分量相当；
                右对齐的小按钮会让它们看起来像次要动作，而中止是有后果的 */}
            <div className="grid grid-cols-2 gap-2">
              {/* 转后台：XHR 不随弹窗卸载而中断，完成时由页面 toast + 刷新兜底 */}
              <button
                type="button"
                onClick={() => { backgroundedRef.current = true; onClose(); }}
                className="rounded-lg py-2 text-[13px]"
                style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
              >
                转到后台
              </button>
              <button
                type="button"
                onClick={() => {
                  // 中止走 xhr.abort()，服务层把它翻成 ABORTED 而不是「网络异常」——
                  // 这是用户自己按的，不该报成故障
                  xhrRef.current?.abort();
                  setSaving(false);
                }}
                className="rounded-lg py-2 text-[13px]"
                style={{
                  border: '1px solid var(--semantic-danger-border)',
                  background: 'var(--semantic-danger-soft)',
                  color: 'var(--accent-fg-danger)',
                }}
              >
                中止
              </button>
            </div>
          </div>
        ) : (
        <>
          <div className="flex flex-col gap-3 max-h-[65vh] overflow-y-auto pr-1">

            {/* File drop zone */}
            {(!isEdit || file !== null) ? (
              <div
                className="flex flex-col items-center justify-center gap-2 p-6 rounded-lg cursor-pointer transition-colors"
                style={{
                  background: dragOver ? 'rgba(var(--accent-primary-rgb), 0.10)' : 'var(--bg-sunken)',
                  // 虚线走 accent：设计稿这一框是橙虚线，灰虚线读起来像「禁用」
                  border: `1.5px dashed ${dragOver ? 'var(--accent-primary)' : 'rgba(var(--accent-primary-rgb), 0.45)'}`,
                }}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <UploadCloud size={32} className="text-token-muted" />
                {file ? (
                  <div className="text-center">
                    <p className="text-sm font-medium text-token-primary">{file.name}</p>
                    <p className="text-xs text-token-muted">{fmtSize(file.size)}</p>
                  </div>
                ) : (
                  <div className="text-center leading-relaxed">
                    <p className="text-sm text-token-secondary">把文件拖到这里，或点击选择</p>
                    <p className="mt-1 text-xs text-token-muted">.html / .htm · .zip（≤5000 个文件，自动识别入口）</p>
                    <p className="text-xs text-token-muted">.md · .pdf · .mp4 / .webm / .mov</p>
                    <p className="text-xs text-token-muted">单个文件上限 500 MB</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".html,.htm,.zip,.md,.markdown,.pdf,.mp4,.webm,.mov,.m4v"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); }}
                />
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}>
                <FileCode2 size={20} className="text-token-accent" />
                <div className="flex-1">
                  <p className="text-sm text-token-primary">{item.entryFile}</p>
                  <p className="text-xs text-token-muted">{item.files.length} 个文件, {fmtSize(item.totalSize)}</p>
                </div>
                <Button size="xs" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={12} className="mr-1" /> 重新上传
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".html,.htm,.zip,.md,.markdown,.pdf,.mp4,.webm,.mov,.m4v"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); }}
                />
              </div>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-token-secondary">
                标题<span className="ml-1.5 font-normal text-token-muted">留空取文件名</span>
              </span>
              <input
                type="text"
                value={title}
                onChange={e => { titleEditedRef.current = true; setTitle(e.target.value); }}
                placeholder="2026 W34 视觉验收报告"
                className="px-3 py-2 rounded-lg text-sm outline-none"
                style={inputStyle}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-token-secondary">描述</span>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="一句话说明这个站点是给谁看的…"
                rows={2}
                className="px-3 py-2 rounded-lg text-sm outline-none resize-none"
                style={inputStyle}
              />
            </label>

            {/* 标签与分组并排：两者都是「这个站点归到哪儿」，各占半行刚好，
                竖排会把「开始上传」挤到折叠线以下 */}
            <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,200px)' }}>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-token-secondary">
                  标签<span className="ml-1.5 font-normal text-token-muted">逗号分隔</span>
                </span>
                {/* chips + 回车：逗号分隔的一长串输入框看不出「已经加了几个」，
                    也没法单独删掉其中一个 */}
                <div
                  className="flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1.5"
                  style={inputStyle}
                >
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px]"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                    >
                      {t}
                      <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`移除标签 ${t}`}>
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      // 逗号也当确认：用户从别处粘一串「a, b, c」进来时不用再逐个敲回车
                      if (e.key !== 'Enter' && e.key !== ',' && e.key !== '，') return;
                      e.preventDefault();
                      const t = tagInput.trim().replace(/[,，]$/, '');
                      if (t && !tags.includes(t)) setTags([...tags, t]);
                      setTagInput('');
                    }}
                    placeholder={tags.length ? '' : '输入后回车…'}
                    className="min-w-[80px] flex-1 bg-transparent text-sm outline-none"
                    style={{ color: 'var(--text-primary)' }}
                  />
                </div>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-token-secondary">
                  分组<span className="ml-1.5 font-normal text-token-muted">留空=未分组</span>
                </span>
                {/* 下拉而不是自由文本：文件夹是有限集合，让用户手敲等于把「和别人拼错一个字
                    就分到两个组」的风险交给他。仍保留「新建」入口，不减能力。 */}
                <select
                  value={folders.includes(folder) ? folder : (folder ? '__custom__' : '')}
                  onChange={(e) => {
                    if (e.target.value === '__custom__') {
                      const v = prompt('新分组名称', folder);
                      if (v !== null) setFolder(v.trim());
                      return;
                    }
                    setFolder(e.target.value);
                  }}
                  className="rounded-lg px-3 py-2 text-sm outline-none"
                  style={inputStyle}
                >
                  <option value="">未分组</option>
                  {folders.map(f => <option key={f} value={f}>{f}</option>)}
                  {folder && !folders.includes(folder) && <option value="__custom__">{folder}</option>}
                  <option value="__custom__">＋ 新建分组…</option>
                </select>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>封面：默认取站点首屏渲染</span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button onClick={handleSave} disabled={saving || (!isEdit && !file)}>
                {saving ? '处理中...' : isEdit ? '保存' : '开始上传'}
              </Button>
            </div>
          </div>
        </>
        )
      }
    />
  );
}

// ─── Share Dialog ───

/**
 * 长链场景密码 — 字母长链 token 已有 72 bits 熵，密码主要防顺手分享外泄。
 * 字符集去 i/l/o/0/1 易混淆字符，便于口述/抄写。
 */
function genPassword(len = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => chars[b % chars.length]).join('');
}

/**
 * 短链场景密码 — 短链 URL `/s/{seq}` 可被遍历枚举，密码是唯一防线。
 * 12 位含大小写+数字+符号，熵 ≈ 78 bits；后端配合失败锁防在线暴破。
 */
function genStrongPassword(len = 12) {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digit = '23456789';
  const symbol = '!@#$%^&*-_=+';
  const all = lower + upper + digit + symbol;
  const pick = (s: string) => s[crypto.getRandomValues(new Uint8Array(1))[0] % s.length];
  // 保证四类各 ≥ 1，剩余位随机填充后整体洗牌
  const arr = [pick(lower), pick(upper), pick(digit), pick(symbol),
    ...Array.from(crypto.getRandomValues(new Uint8Array(len - 4))).map(b => all[b % all.length])];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint8Array(1))[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

const STRONG_PWD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*\-_=+]).{12,}$/;

function ShareDialog({ siteId, siteIds, onClose, onCreated, site, existingShareCount = 0 }: {
  siteId: string | null;
  siteIds?: string[];
  onClose: () => void;
  /** 创建成功回调（用于 SharesPanel 嵌套场景，触发列表刷新） */
  onCreated?: () => void;
  /** 这条链接指向的站点，用于顶部身份条。合集分享或调用方拿不到时为空，身份条自隐 */
  site?: HostedSite | null;
  /** 这个站点已经有几条分享链接 */
  existingShareCount?: number;
}) {
  const shareSite = site ?? null;
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ shareUrl: string; token: string; password?: string; linkType: 'long' | 'short' } | null>(null);
  const [copied, setCopied] = useState(false);
  // 默认勾选密码保护：用户至少要主动取消才会裸链分享
  const [usePassword, setUsePassword] = useState(true);
  const [password, setPassword] = useState(() => genPassword());
  const [expiresInDays, setExpiresInDays] = useState(7);
  // 默认 owner-only（PR 2026-05-28 防盗：分享链接被复制后不能被任意第三方访问）；
  // 用户需要显式升级到 logged-in / public
  const [visibility, setVisibility] = useState<'owner-only' | 'logged-in' | 'public'>('owner-only');
  // 默认走字母长链 /s/wp/{token}（不可枚举）；短链 /s/{seq} 作为"高级选项"
  const [linkType, setLinkType] = useState<'long' | 'short'>('long');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 短链 + 取消密码场景的 10s 风险提示
  const [showRiskGate, setShowRiskGate] = useState(false);
  const [riskCountdown, setRiskCountdown] = useState(10);

  // ── 分享时自选开场问题 ──
  // 站点题库（owner 在「提问设置」里维护）。只有单站点分享 + 站点开了提问才拉。
  const [askLibrary, setAskLibrary] = useState<string[] | null>(null);
  const [askPicked, setAskPicked] = useState<string[]>([]);
  const [askCustom, setAskCustom] = useState('');
  /**
   * 用户有没有动过这一栏。
   * 没动 = 不传该字段（后端 null → 继承站点题库，日后 owner 改题库这条链接会跟着变）；
   * 动过 = 传数组（哪怕是空数组，表示"这条链接不显示开场问题"）。
   * 把"没动"也当成"选了当前全部"会把题库冻结成快照，是两回事。
   */
  const [askTouched, setAskTouched] = useState(false);

  const isCollection = !siteId && siteIds && siteIds.length > 1;
  const isShort = linkType === 'short';
  // 窄屏把右侧预览栏降成上下堆叠，避免 232px 固定列把配置区挤成竖条
  const narrowDialog = useIsMobile();
  const [pwdVisible, setPwdVisible] = useState(true);

  // 合集分享一期不支持按站点挑问题（一条链接对多个站点，题库无法归一），故只在单站点时拉
  useEffect(() => {
    if (!siteId || isCollection) return;
    let alive = true;
    void getSiteAskConfig(siteId).then((res) => {
      if (!alive) return;
      if (res.success && res.data?.enabled) {
        const lib = res.data.suggestedQuestions ?? [];
        setAskLibrary(lib);
        // 题库可能有 12 条，但面板只显示 ASK_MAX_DISPLAY 条——初始勾选也必须按上限截，
        // 否则一进来就是"选了 12 条"，存下去只留 4 条，其余静默消失。
        setAskPicked(lib.slice(0, ASK_MAX_DISPLAY));
      } else {
        setAskLibrary(null);
      }
    });
    return () => { alive = false; };
  }, [siteId, isCollection]);
  const pwdInvalid = isShort && usePassword && !STRONG_PWD_RE.test(password);

  // 切到短链：强制开启密码，且若现有密码不达强密码标准就自动重生成
  useEffect(() => {
    if (isShort) {
      setUsePassword(true);
      setPassword(prev => (STRONG_PWD_RE.test(prev) ? prev : genStrongPassword()));
    }
  }, [isShort]);

  // 10s 倒计时
  useEffect(() => {
    if (!showRiskGate) return;
    setRiskCountdown(10);
    const t = setInterval(() => setRiskCountdown(v => (v <= 1 ? 0 : v - 1)), 1000);
    return () => clearInterval(t);
  }, [showRiskGate]);

  const handleTogglePassword = (next: boolean) => {
    if (!next && isShort) {
      // 短链取消密码 = 高风险，强制看完 10s 警告再确认
      setShowRiskGate(true);
      return;
    }
    setUsePassword(next);
    if (next && !password) setPassword(isShort ? genStrongPassword() : genPassword());
    if (!next) setPassword('');
  };

  const handleRiskAccept = () => {
    setShowRiskGate(false);
    setUsePassword(false);
    setPassword('');
  };

  const doCreate = async () => {
    setCreating(true);
    const pwd = usePassword ? (password.trim() || undefined) : undefined;

    // 复用 vs 新建、有效期刷新全部在服务端闭环：createSiteShareLink 按
    // 用户+站点/合集+访问级别 去重（不依赖任何前端分页列表，账号链接再多也不失效），
    // 并把有效期刷新为本次所选窗口。前端只发指令、用返回值展示。
    try {
      const res = await createSiteShareLink({
        siteId: siteId || undefined,
        siteIds: isCollection ? siteIds : undefined,
        shareType: isCollection ? 'collection' : 'single',
        password: pwd,
        expiresInDays,
        // 用户在面板中显式新建（PR 2026-05-28）：跳过服务端复用，每次都换新 token
        forceNew: true,
        visibility,
        // 数字短链按需分配（2026-06-11）：只有用户在高级选项里主动选「数字短链」才生成
        // /s/{seq}，否则后端不写 short_links，只发不可枚举的 /s/wp/{token} 长链——
        // 杜绝「用户没选短链却拿到数字链」+「管理员短链页冒出几百条」。
        allocateShortLink: isShort,
        // 三态：没动过就整个字段不传（继承站点题库），动过才传数组（空数组=这条链接不显示）。
        // 判定收在 resolveShareAskSelection 里，有守卫盯着，别在这儿就地写三元。
        askSuggestedQuestions: resolveShareAskSelection(askTouched, askPicked),
      });
      if (res.success) {
        onCreated?.();
        // 复用已有带密码链接时，后端返回的是既有密码（可能与本次输入不同），以它为准
        const effPwd = res.data.password ?? pwd;
        // P1 调整（2026-05-21 用户反馈）：
        //   shareUrl        = /s/wp/{token}（带分类前缀长链，URL 有语义、利于总管理分类）
        //   shortShareUrl   = /s/{seq}（数字超短链，须配强密码）
        //   unifiedShareUrl = /s/{token}（字母统一长链，ShortLink 索引支持，高级用）
        // 默认走 shareUrl 带前缀长链；短链选项走 shortShareUrl
        const chosenUrl = isShort
          ? (res.data.shortShareUrl ?? res.data.shareUrl)
          : res.data.shareUrl;
        const shareResult = { shareUrl: chosenUrl, token: res.data.token, password: effPwd, linkType };
        setResult(shareResult);
        let text = `${window.location.origin}${shareResult.shareUrl}`;
        if (effPwd) text += `\n访问密码：${effPwd}`;
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error('创建分享链接失败', res.error?.message || '请稍后重试');
      }
    } catch (e) {
      // 网络异常等抛错时若无 catch，会变成未处理的 promise rejection，用户毫无反馈
      toast.error('创建分享链接失败', e instanceof Error ? e.message : '网络异常，请稍后重试');
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = () => {
    if (pwdInvalid) {
      toast.error('密码强度不足', '短链密码需 ≥12 位且含大小写、数字、符号');
      return;
    }
    void doCreate();
  };

  const handleCopy = () => {
    let text = `${window.location.origin}${result!.shareUrl}`;
    if (result!.password) text += `\n访问密码：${result!.password}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const inputStyle = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  // 「仅我自己」卡片放当前用户头像，其余可见性放语义图标
  const currentUser = useAuthStore(s => s.user);
  const myAvatar = currentUser
    ? resolveAvatarUrl({
        username: currentUser.username,
        userType: currentUser.userType,
        botKind: currentUser.botKind,
        avatarFileName: currentUser.avatarFileName ?? null,
        avatarUrl: currentUser.avatarUrl ?? null,
      })
    : '';

  // 分段卡通用样式：默认蓝色高亮，danger 项（公开/短链）选中走橙色
  const segCardStyle = (active: boolean, danger?: boolean): React.CSSProperties => ({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '10px 6px',
    borderRadius: 10,
    cursor: 'pointer',
    textAlign: 'center',
    transition: 'border-color 120ms, background 120ms',
    // 选中态走品牌 accent，不是写死的蓝：设计稿整套强调色就是 --accent-primary
    // （深色档 #D97757 / 浅色档 #A64B35），这里原来那个 #3b82f6 是历史遗留，
    // 与设计系统对不上，在浅色档下也和周围格格不入。
    border: active
      ? `1.5px solid ${danger ? '#f97316' : 'var(--accent-primary)'}`
      : '1px solid var(--border-default)',
    background: active
      ? danger
        ? 'rgba(249,115,22,0.10)'
        : 'rgba(var(--accent-primary-rgb), 0.12)'
      : 'var(--bg-sunken)',
  });

  // 三张卡各自的副标题：卡片只有一个词说不清差别，副标题说的是「选了它你会得到什么」
  const VISIBILITY_SUB: Record<typeof visibility, string> = {
    'owner-only': '默认',
    'logged-in': '能拿到访客名单',
    public: '匿名可看',
  };
  // 当前选中档的一段解释（仅展示选中项，非选中项零文字）
  const VISIBILITY_DESC: Record<typeof visibility, string> = {
    'owner-only': '默认档。链接建出来只有你本人打开有内容，别人看到「无权限」——适合先建链接、自己核一遍再改档发出去。',
    'logged-in': '任何登录用户都能打开，访客名单里会留下他们的昵称——想知道谁看过就选这档。',
    public: '任何拿到链接的人都能打开，包括未登录的。配一道密码可以挡住顺手转发。',
  };
  // 档位对齐设计稿的 3/7/14/30/90；「1 天」与「永久」是既有能力，删掉等于减功能，保留。
  const EXPIRY_OPTS = [
    { v: 1, label: '1 天' },
    { v: 3, label: '3 天' },
    { v: 7, label: '7 天' },
    { v: 14, label: '14 天' },
    { v: 30, label: '30 天' },
    { v: 90, label: '90 天' },
    { v: 0, label: '永久' },
  ];

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title={
        result ? '分享链接已创建' : (
          <span className="flex items-baseline gap-2">
            建一条分享链接
            {existingShareCount > 0 && (
              <span className="text-[11.5px] font-normal" style={{ color: 'var(--text-muted)' }}>
                这个站点已有 {existingShareCount} 条
              </span>
            )}
          </span>
        )
      }
      // 配置态是左配置右预览两栏，需要比默认 520 宽；结果态回到窄弹窗
      maxWidth={result ? 520 : 820}
      content={
        result ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)' }}>
              <Check size={16} style={{ color: '#22c55e' }} />
              <span className="text-sm flex-1" style={{ color: '#22c55e' }}>分享链接已生成，已复制到剪贴板</span>
              <a
                href="/my-assets?tab=shares"
                target="_blank"
                rel="noopener"
                className="text-xs underline whitespace-nowrap"
                style={{ color: '#22c55e' }}
              >
                查看所有分享 →
              </a>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={`${window.location.origin}${result.shareUrl}`}
                readOnly
                className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                style={inputStyle}
              />
              <Button size="sm" onClick={handleCopy}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            {result.password && (
              <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
                <Lock size={16} style={{ color: 'var(--accent-fg-blue)', flexShrink: 0 }} />
                <div className="flex-1">
                  <div className="text-xs mb-1" style={{ color: 'var(--accent-fg-blue)' }}>访问密码</div>
                  <code className="text-sm font-mono font-bold tracking-wider text-token-primary">{result.password}</code>
                </div>
                <Button size="sm" variant="ghost" onClick={() => {
                  navigator.clipboard.writeText(result!.password!);
                }}>
                  <Copy size={14} />
                </Button>
              </div>
            )}
            <p className="text-xs text-token-muted">
              {result.password ? '复制按钮会同时复制链接和密码' : '此链接无需密码，任何人可直接访问'}
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose}>关闭</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {isCollection && (
              <p className="text-sm text-token-muted">
                将分享 {siteIds!.length} 个站点的合集
              </p>
            )}
            {/* 站点身份条：这条链接指向哪个站点、多大、什么形态。
                没有它，弹窗里三个开关是悬空的——用户得回头看自己点的是哪张卡 */}
            {shareSite && (
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
              >
                <FileCode2 size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                <span className="truncate text-[13px]" style={{ color: 'var(--text-primary)' }}>{shareSite.title}</span>
                <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {fmtSize(shareSite.totalSize)} · {resolveSiteForm(shareSite).toUpperCase()}
                </span>
              </div>
            )}

            {/* 左配置 / 右实时预览：三个开关的组合结果是「访客打开链接时看到什么」，
                右栏把这个结果画出来，用户不必在脑子里合成 */}
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: narrowDialog ? 'minmax(0,1fr)' : 'minmax(0,1fr) 232px' }}
            >
            {/* 分享选项 */}
            <div className="flex flex-col gap-4 min-w-0">
              {/* 谁能访问 — 防盗核心控件（PR 2026-05-28）：头像/图标 + 短标题分段卡，
                  说明仅展示选中项一行（公开项走橙色风险色） */}
              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-1.5 text-xs text-token-muted">
                  谁能访问
                  <span
                    className="rounded px-1 py-px text-[10px]"
                    style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}
                  >
                    必填
                  </span>
                </span>
                <div className="flex gap-2">
                  {([
                    ['owner-only', SHARE_VISIBILITY_LABEL['owner-only']],
                    ['logged-in', SHARE_VISIBILITY_LABEL['logged-in']],
                    ['public', SHARE_VISIBILITY_LABEL.public],
                  ] as const).map(([key, label]) => {
                    const on = visibility === key;
                    const danger = key === 'public';
                    const fg = on ? (danger ? '#f97316' : 'var(--accent-primary)') : 'var(--text-secondary)';
                    const Icon = key === 'owner-only' ? User : key === 'logged-in' ? Users : Globe;
                    return (
                      <button key={key} type="button" onClick={() => setVisibility(key)} style={segCardStyle(on, danger)}>
                        {key === 'owner-only' && myAvatar
                          ? <UserAvatar src={myAvatar} alt="我" className="rounded-full" style={{ width: 22, height: 22 }} />
                          : <Icon size={18} style={{ color: fg }} />}
                        <span className="text-xs" style={{ color: fg }}>{label}</span>
                        {/* 副标题：卡片只有一个词说不清差别，这一行说的是「选了它你会得到什么」 */}
                        <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{VISIBILITY_SUB[key]}</span>
                      </button>
                    );
                  })}
                </div>
                <span className="text-xs leading-relaxed" style={{ color: visibility === 'public' ? '#f97316' : 'var(--text-muted)' }}>
                  {VISIBILITY_DESC[visibility]}
                </span>
              </div>

              {/* 密码卡 + 有效期卡并排：两者都是「这条链接的寿命与门槛」，
                  竖着排会把有效期挤到折叠线以下，用户看不见就用不上默认值以外的档 */}
              <div className="grid gap-3" style={{ gridTemplateColumns: narrowDialog ? 'minmax(0,1fr)' : 'minmax(0,1fr) minmax(0,200px)' }}>
              <div
                className="flex flex-col gap-1.5 rounded-xl p-2.5"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
              >
                {/* 开关而不是复选框：设计稿这里是 toggle。复选框读作「勾一个选项」，
                    开关读作「这道门开着还是关着」——后者才是这个控件真正的语义 */}
                <div className="flex items-center gap-2" title={isShort ? '短链场景密码不可关闭' : ''}>
                  <Lock size={13} className="text-token-muted" />
                  <span className="text-sm text-token-secondary">访问密码</span>
                  <span
                    className="rounded px-1 py-px text-[10px]"
                    style={{ background: 'rgba(34,197,94,0.14)', color: 'var(--accent-fg-emerald)' }}
                  >
                    {isShort ? '短链必须' : '建议开启'}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={usePassword}
                    aria-label="访问密码"
                    onClick={() => handleTogglePassword(!usePassword)}
                    className="ml-auto shrink-0 rounded-full"
                    style={{
                      width: 36, height: 20, padding: 2, cursor: 'pointer', border: 'none',
                      background: usePassword ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                      transition: 'background 140ms',
                    }}
                  >
                    <span
                      className="block rounded-full"
                      style={{
                        width: 16, height: 16, background: '#fff',
                        transform: usePassword ? 'translateX(16px)' : 'translateX(0)',
                        transition: 'transform 140ms',
                      }}
                    />
                  </button>
                </div>
                {usePassword && (
                  <>
                    <div className="flex items-center gap-2">
                      {/* 单个输入框 + 明暗切换：分享密码是要念给对方听的，
                          默认可见；需要当着别人的面配置时再遮起来。
                          眼睛压在框内右侧（设计稿如此）：它是这个输入框的附属动作，
                          摆到框外就和「重新生成」同级了，那是两种不同分量的操作。 */}
                      <div className="relative flex-1">
                        <input
                          type={pwdVisible ? 'text' : 'password'}
                          value={password}
                          onChange={e => setPassword(e.target.value)}
                          placeholder={isShort ? '≥12 位，含大小写+数字+符号' : '输入密码'}
                          className="w-full rounded-lg py-1.5 pl-3 pr-8 text-sm outline-none font-mono"
                          style={{ ...inputStyle, border: pwdInvalid ? '1px solid #ef4444' : inputStyle.border }}
                        />
                        <button
                          type="button"
                          onClick={() => setPwdVisible(v => !v)}
                          title={pwdVisible ? '隐藏密码' : '显示密码'}
                          className="absolute right-2 top-1/2 -translate-y-1/2"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {pwdVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPassword(isShort ? genStrongPassword() : genPassword())}
                        className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs"
                        style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                      >
                        重新生成
                      </button>
                    </div>
                    <span className="text-[11px] leading-relaxed" style={{ color: pwdInvalid ? '#ef4444' : 'var(--text-muted)' }}>
                      {pwdInvalid
                        ? '密码强度不足：需 ≥12 位，含大小写、数字、符号'
                        : isShort
                          ? '短链可被遍历枚举，建议用随机生成的强密码'
                          : '长链默认 8 位随机。密码是任意字符串，长度不定，可自己改写、可粘贴。'}
                    </span>
                  </>
                )}
              </div>

              {/* 有效期 — 胶囊代替下拉 */}
              <div
                className="flex flex-col gap-1.5 rounded-xl p-2.5"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
              >
                <span className="flex items-center gap-1.5 text-xs text-token-muted">
                  <Clock size={12} />有效期
                  <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>默认 7 天</span>
                </span>
                <div className="flex gap-2 flex-wrap">
                  {EXPIRY_OPTS.map(opt => {
                    const active = expiresInDays === opt.v;
                    return (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => setExpiresInDays(opt.v)}
                        className="px-3 py-1 rounded-lg text-xs"
                        style={{
                          cursor: 'pointer',
                          transition: 'border-color 120ms, background 120ms',
                          border: active ? '1.5px solid var(--accent-primary)' : '1px solid var(--border-default)',
                          background: active ? 'rgba(var(--accent-primary-rgb), 0.12)' : 'var(--bg-sunken)',
                          color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                        }}
                      >
                            {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              </div>

              {/* 开场问题 — 这条链接上访客一点即问的引子。
                  发给客户和发给同事可以不一样，所以按分享链接各自选，而不是全站一套。 */}
              {askLibrary !== null && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-token-muted">
                    <MessageCircleQuestion size={12} className="inline mr-1" />开场问题
                    <span className="ml-1 text-token-muted">（访客打开提问面板时可一点即问）</span>
                  </span>

                  {askLibrary.length === 0 && askPicked.length === 0 && (
                    <span className="text-xs text-token-muted">
                      这个站点还没有开场问题，可在「提问设置」里建题库，也可以在下面直接加。
                    </span>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {Array.from(new Set([...askLibrary, ...askPicked])).map((q) => {
                      const active = askPicked.includes(q);
                      // 挑满就挡住：这份选择就是面板要显示的那份，选超了后端也存不下，
                      // 与其让第 5 条静默消失，不如当场说明「最多几条」。
                      const blocked = !active && askPicked.length >= ASK_MAX_DISPLAY;
                      return (
                        <button
                          key={q}
                          type="button"
                          disabled={blocked}
                          title={blocked ? `一个面板最多显示 ${ASK_MAX_DISPLAY} 条，取消一条再选` : undefined}
                          onClick={() => {
                            setAskTouched(true);
                            setAskPicked((prev) => toggleAskPick(prev, q));
                          }}
                          className="px-3 py-1 rounded-lg text-xs text-left"
                          style={{
                            cursor: blocked ? 'not-allowed' : 'pointer',
                            opacity: blocked ? 0.45 : 1,
                            maxWidth: '100%',
                            transition: 'border-color 120ms, background 120ms',
                            border: active ? '1.5px solid var(--accent-primary)' : '1px solid var(--border-default)',
                            background: active ? 'rgba(var(--accent-primary-rgb), 0.12)' : 'var(--bg-sunken)',
                            color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                          }}
                        >
                          {q}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex gap-2">
                    <input
                      value={askCustom}
                      maxLength={60}
                      disabled={askPicked.length >= ASK_MAX_DISPLAY}
                      onChange={(e) => setAskCustom(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const q = askCustom.trim();
                        if (!q) return;
                        setAskTouched(true);
                        setAskPicked((prev) => addAskPick(prev, q));
                        setAskCustom('');
                      }}
                      placeholder={askPicked.length >= ASK_MAX_DISPLAY
                        ? `最多 ${ASK_MAX_DISPLAY} 条，取消一条再加`
                        : '给这条链接单独加一个问题…'}
                      className="flex-1 px-3 py-1.5 rounded-lg text-xs outline-none"
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const q = askCustom.trim();
                        if (!q) return;
                        setAskTouched(true);
                        setAskPicked((prev) => addAskPick(prev, q));
                        setAskCustom('');
                      }}
                      disabled={!askCustom.trim() || askPicked.length >= ASK_MAX_DISPLAY}
                      className="px-3 py-1.5 rounded-lg text-xs"
                      style={{
                        cursor: askCustom.trim() ? 'pointer' : 'default',
                        border: '1px solid var(--border-default)',
                        background: 'var(--bg-sunken)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      添加
                    </button>
                  </div>

                  {askTouched && askPicked.length === 0 && (
                    <span className="text-xs text-token-muted">这条链接不显示开场问题，访客直接自己打字提问。</span>
                  )}
                </div>
              )}

              {/* 高级选项 — 链接形式（收起时只显示当前值） */}
              <button
                type="button"
                onClick={() => setShowAdvanced(v => !v)}
                className="text-xs flex items-center gap-1 self-start text-token-muted"
              >
                <span style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>›</span>
                高级{!showAdvanced && (
                  <span> {linkType === 'long' ? '长链（推荐）' : '数字短链'} · {askTouched ? '开场问题已单独选' : '开场问题继承题库'}</span>
                )}
              </button>
              {showAdvanced && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-token-muted">链接形式</span>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setLinkType('long')} style={segCardStyle(linkType === 'long')}>
                      <Link2 size={20} style={{ color: linkType === 'long' ? 'var(--accent-primary)' : 'var(--text-secondary)' }} />
                      <span className="text-xs" style={{ color: linkType === 'long' ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>字母长链 · 推荐</span>
                    </button>
                    <button type="button" onClick={() => setLinkType('short')} style={segCardStyle(linkType === 'short', true)}>
                      <Link2 size={20} style={{ color: linkType === 'short' ? '#f97316' : 'var(--text-secondary)' }} />
                      <span className="text-xs" style={{ color: linkType === 'short' ? '#f97316' : 'var(--text-secondary)' }}>数字短链 · 自用</span>
                    </button>
                  </div>
                  <span className="text-xs" style={{ color: linkType === 'short' ? '#f97316' : 'var(--text-muted)' }}>
                    {linkType === 'long'
                      ? '/s/wp/xxx · 72 bits 随机 token，不可枚举'
                      : '/s/123 · 可被遍历猜测，必须配强密码'}
                  </span>
                </div>
              )}
            </div>

            {/* 右栏：改任何一个开关，这里立刻变 */}
            <div className="min-w-0">
              <SharePreviewPane
                visibility={visibility}
                hasPassword={usePassword}
                password={password}
                expiresInDays={expiresInDays}
                askCount={askPicked.length}
                askInherited={!askTouched}
                // 这一分支里链接还没生成，token 不存在。给一条**形状正确**的示意地址，
                // 而不是拿一个假 token 冒充真地址——用户会照着它去发。
                shareUrl={`${window.location.host}/s/wp/${isShort ? '{数字短链}' : '{生成后可见}'}`}
                onCopy={() => toast.info('链接还没生成', '先点右下角「生成链接」，之后这里就能一次复制链接和密码')}
              />
            </div>
            </div>

            <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
              {/* 一句话复述这条链接：按下按钮前最后一次核对，不必回头逐个看开关 */}
              <span className="text-xs min-w-0" style={{ color: 'var(--text-muted)' }}>
                {SHARE_VISIBILITY_LABEL[visibility]}
                {usePassword ? ' · 有密码' : ' · 无密码'}
                {expiresInDays === 0 ? ' · 永久有效' : ` · 有效 ${expiresInDays} 天`}
                {isShort ? ' · 数字短链' : ''}
              </span>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>取消</Button>
                <Button onClick={handleCreate} disabled={creating || pwdInvalid}>
                  {creating ? '生成中...' : '生成链接'}
                </Button>
              </div>
            </div>

            {/* 10s 风险确认模态：短链取消密码必看 */}
            {showRiskGate && (
              <div
                style={{
                  position: 'fixed', inset: 0, zIndex: 200,
                  background: 'rgba(0, 0, 0, 0.8)',
                  backdropFilter: 'blur(3px)',
                  WebkitBackdropFilter: 'blur(3px)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 16,
                }}
                onClick={e => e.stopPropagation()}
              >
                <div
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '2px solid #ef4444',
                    borderRadius: 12,
                    boxShadow: '0 0 0 1px rgba(239, 68, 68, 0.35), 0 24px 70px rgba(0, 0, 0, 0.55)',
                    maxWidth: 480,
                    width: '100%',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    className="flex items-center gap-2 px-6 py-4"
                    style={{ background: 'rgba(239, 68, 68, 0.16)', borderBottom: '1px solid rgba(239, 68, 68, 0.4)' }}
                  >
                    <AlertTriangle size={20} style={{ color: '#ef4444', flexShrink: 0 }} />
                    <h3 className="text-base font-bold" style={{ color: '#ef4444' }}>
                      风险确认：短链无密码 = 任何人可枚举访问
                    </h3>
                  </div>
                  <div className="px-6 pt-4 pb-5">
                    <ul className="text-sm flex flex-col gap-1.5 mb-4 text-token-secondary">
                      <li>· 数字短链 /s/123 是全局自增 ID，攻击者可从 1 起逐个尝试</li>
                      <li>· 没有密码的短链意味着任何获得链接（甚至猜对数字）的人都能查看内容</li>
                      <li>· 你即将分享的内容如果包含未公开信息，请改用字母长链或保留密码</li>
                    </ul>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onClick={() => setShowRiskGate(false)}>放弃，保留密码</Button>
                      <Button onClick={handleRiskAccept} disabled={riskCountdown > 0}>
                        {riskCountdown > 0 ? `我已知晓继续 (${riskCountdown}s)` : '我已知晓继续'}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      }
    />
  );
}

// ─── Shares Panel ───

function SharesPanel({ shares, setShares, onClose, scopedSiteId, scopedSiteTitle, scopedSite }: {
  shares: ShareLinkItem[];
  setShares: (s: ShareLinkItem[]) => void;
  onClose: () => void;
  /** 若提供，则只展示与该站点关联的分享 + 新建按钮限定到该站点 */
  scopedSiteId?: string | null;
  /** scopedSiteId 时用于「本站点统计」标题 */
  scopedSiteTitle?: string | null;
  /** 站点本体，透传给嵌套 ShareDialog 画顶部身份条 */
  scopedSite?: HostedSite | null;
}) {
  const [loading, setLoading] = useState(true);
  const [viewLogsToken, setViewLogsToken] = useState<string | null>(null);
  const [viewLogs, setViewLogs] = useState<ShareViewLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  // 嵌套创建：在面板内点「新建分享」会拉起 ShareDialog
  const [showCreate, setShowCreate] = useState(false);
  const [renewingId, setRenewingId] = useState<string | null>(null);
  // 本站点统计 Drawer（scopedSiteId 模式下可用）
  const [showScopedAnalytics, setShowScopedAnalytics] = useState(false);
  // fetchIdRef stale-response 守卫（PR #685 Bugbot Low）：连续创建分享触发多次
  // refreshShares 时，慢响应不覆盖新结果。
  const sharesFetchIdRef = useRef(0);
  const refreshShares = useCallback(async () => {
    const myId = ++sharesFetchIdRef.current;
    setLoading(true);
    try {
      const res = await listSiteShares();
      if (myId !== sharesFetchIdRef.current) return;
      if (res.success) setShares(res.data.items);
    } finally {
      // 只有最新请求才清 loading；stale 请求让位（PR #685 Bugbot Medium）
      if (myId === sharesFetchIdRef.current) setLoading(false);
    }
  }, [setShares]);

  useEffect(() => { void refreshShares(); }, [refreshShares]);

  // scope 过滤：scopedSiteId 提供时只显示与该站点相关的分享
  const visibleShares = scopedSiteId
    ? shares.filter(s => s.siteId === scopedSiteId || (s.siteIds && s.siteIds.includes(scopedSiteId)))
    : shares;

  const handleRevoke = async (shareId: string) => {
    if (!confirm('确定撤销此分享链接？撤销后任何人都无法再访问。')) return;
    const res = await revokeSiteShare(shareId);
    if (res.success) {
      setShares(shares.filter(s => s.id !== shareId));
    }
  };

  const handleRenew = async (shareId: string, extendDays: number) => {
    setRenewingId(shareId);
    try {
      const res = await renewSiteShare(shareId, extendDays);
      if (res.success) {
        // 局部更新该条链接的 expiresAt，避免全列表重拉
        setShares(shares.map(s =>
          s.id === shareId
            ? { ...s, expiresAt: res.data.newExpiresAt, isExpired: false, inGracePeriod: false }
            : s,
        ));
      } else {
        alert(res.error?.message || '续期失败');
      }
    } finally {
      setRenewingId(null);
    }
  };

  // 主链接恒为不可枚举的字母长链 /s/wp/{token}（2026-06-11）：
  // 用户创建时默认选的就是长链，复制/点击/预览都应给长链，不再因「后端碰巧分配了
  // shortSeq」就把数字短链当主链返回——那正是「我没选数字短链却总拿到数字链」的根因。
  // 数字短链 /s/{seq} 仅作为用户主动生成后的次级可选项单独展示。
  const shareUrlOf = (s: ShareLinkItem) => `${window.location.origin}/s/wp/${s.token}`;
  const shortUrlOf = (s: ShareLinkItem) =>
    s.shortSeq && s.shortSeq > 0 ? `${window.location.origin}/s/${s.shortSeq}` : null;

  const handleCopy = (s: ShareLinkItem) => {
    navigator.clipboard.writeText(shareUrlOf(s));
  };

  // 事后生成数字短链（懒分配入口）：用户在某条分享上主动点「生成数字短链」时调用，
  // 成功后把返回的 shortSeq 写回该条分享并复制数字短链。
  const [allocatingId, setAllocatingId] = useState<string | null>(null);
  const handleShortLink = async (s: ShareLinkItem) => {
    const existing = shortUrlOf(s);
    if (existing) {
      navigator.clipboard.writeText(existing);
      return;
    }
    setAllocatingId(s.id);
    try {
      const res = await ensureSiteShareShortLink(s.id);
      if (res.success && res.data.shortSeq > 0) {
        setShares(shares.map(x => x.id === s.id ? { ...x, shortSeq: res.data.shortSeq } : x));
        navigator.clipboard.writeText(`${window.location.origin}/s/${res.data.shortSeq}`);
      } else {
        alert(res.error?.message || '生成数字短链失败');
      }
    } finally {
      setAllocatingId(null);
    }
  };

  const handleShowLogs = async (token: string) => {
    setViewLogsToken(token);
    setLogsLoading(true);
    const res = await listShareViewLogs(token, 200);
    if (res.success) setViewLogs(res.data.items);
    setLogsLoading(false);
  };

  const visibilityChip = (v?: string) => {
    const eff = v || 'public';
    if (eff === 'owner-only')
      return <span title="仅我自己/团队成员可访问"><Badge variant="success">仅我可见</Badge></span>;
    if (eff === 'logged-in')
      return <span title="任何登录用户可访问"><Badge variant="subtle">需登录</Badge></span>;
    return <span title="任何拿到链接的人都可访问"><Badge variant="warning">公开</Badge></span>;
  };

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title={scopedSiteId ? '此网页的分享管理' : '分享管理'}
      maxWidth={900}
      content={
        <>
          {/* 顶部 CTA — P2-3 修复：长文案左侧给定宽 max-w，按钮组右侧定位防止挤压换行 */}
          <div
            className="flex items-start justify-between gap-3 p-3 mb-3 rounded-lg"
            style={{ background: 'var(--bg-elevated)', border: '1px dashed var(--border-default)' }}
          >
            <div className="text-xs leading-relaxed min-w-0 flex-1 text-token-secondary">
              {scopedSiteId
                ? '每次创建都生成新链接（不复用旧的）。过期 7 天内仍可续期。'
                : '查看所有分享链接、续期、撤销，或查看访问日志。'}
            </div>
            {scopedSiteId && (
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setShowScopedAnalytics(true)} title="只看本站点的访问统计">
                  <BarChart3 size={14} className="mr-1" />本站点统计
                </Button>
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus size={14} className="mr-1" />新建分享
                </Button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="py-8 text-center text-sm text-token-muted">加载中...</div>
          ) : visibleShares.length === 0 ? (
            <div className="py-8 text-center text-sm flex flex-col items-center gap-3 text-token-muted">
              <div>{scopedSiteId ? '此网页还没有分享链接' : '还没有创建过分享链接'}</div>
              {scopedSiteId && (
                <Button size="sm" variant="primary" onClick={() => setShowCreate(true)}>
                  <Plus size={14} className="mr-1" />创建第一个
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
              {visibleShares.map(share => {
                const now = Date.now();
                const expMs = share.expiresAt ? new Date(share.expiresAt).getTime() : null;
                const isExpired = expMs != null && expMs < now;
                const inGrace = isExpired && expMs! > now - 7 * 24 * 3600 * 1000;
                return (
                <div key={share.id}>
                  <div
                    className="flex items-center gap-3 p-3 rounded-lg"
                    style={{
                      background: isExpired ? 'rgba(249, 115, 22, 0.05)' : 'var(--bg-sunken)',
                      border: isExpired ? '1px solid rgba(249, 115, 22, 0.3)' : '1px solid var(--border-default)',
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link2 size={14} className="text-token-muted" />
                        <a
                          href={shareUrlOf(share)}
                          target="_blank"
                          rel="noopener"
                          className="text-sm font-medium truncate hover:underline text-token-primary"
                          title="预览分享链接"
                        >
                          {share.title || (share.shareType === 'collection' ? `合集 (${share.siteIds.length} 站)` : '单站点分享')}
                        </a>
                        {share.shortSeq && share.shortSeq > 0 && (
                          <span title={`已生成数字短链 /s/${share.shortSeq}`}>
                            <Badge variant="subtle">#{share.shortSeq}</Badge>
                          </span>
                        )}
                        {visibilityChip(share.visibility)}
                        <Badge variant={share.accessLevel === 'password' ? 'warning' : 'subtle'}>
                          {share.accessLevel === 'password' ? '密码保护' : '无密码'}
                        </Badge>
                        {share.shareType === 'collection' && (
                          <Badge variant="subtle">{share.siteIds.length} 站合集</Badge>
                        )}
                        {isExpired && (
                          <span title={inGrace ? '可续期，将于 7 天宽限期后彻底失效' : '已彻底失效'}>
                            <Badge variant="warning">
                              {inGrace ? '已过期 · 可续期' : '已过期'}
                            </Badge>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-token-muted">
                        <span className="flex items-center gap-1"><Eye size={10} /> {share.viewCount} PV</span>
                        {(share.uniqueIpCount ?? 0) > 0 && (
                          <span title="基于访问日志估算的访客线索">{share.uniqueIpCount} 位访客</span>
                        )}
                        <span>创建于 {fmtDate(share.createdAt)}</span>
                        {share.expiresAt && <span>{isExpired ? '过期于' : '到期'} {fmtDate(share.expiresAt)}</span>}
                        {(share.renewalCount ?? 0) > 1 && (
                          <span title="历次续期 / 复用次数">续 {(share.renewalCount ?? 0) - 1} 次</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {inGrace && (
                        <Button
                          size="xs"
                          variant="primary"
                          disabled={renewingId === share.id}
                          onClick={() => handleRenew(share.id, 30)}
                          title="续期 30 天"
                        >
                          {renewingId === share.id ? <MapSpinner size={12} /> : <><RefreshCw size={12} className="mr-1" />续期</>}
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant={viewLogsToken === share.token ? 'secondary' : 'ghost'}
                        onClick={() => viewLogsToken === share.token ? setViewLogsToken(null) : handleShowLogs(share.token)}
                        title="观看记录"
                      >
                        <Eye size={12} />
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => handleCopy(share)} title="复制链接（长链）">
                        <Copy size={12} />
                      </Button>
                      {share.shortSeq && share.shortSeq > 0 ? (
                        <Button size="xs" variant="ghost" onClick={() => handleShortLink(share)} title={`复制数字短链 /s/${share.shortSeq}`}>
                          <Hash size={12} />
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={allocatingId === share.id}
                          onClick={() => handleShortLink(share)}
                          title="生成数字短链（自用，可枚举，建议配密码）"
                        >
                          {allocatingId === share.id ? <MapSpinner size={12} /> : <Hash size={12} style={{ opacity: 0.45 }} />}
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => window.open(shareUrlOf(share), '_blank')} title="预览">
                        <ExternalLink size={12} />
                      </Button>
                      <Button size="xs" variant="danger" onClick={() => handleRevoke(share.id)} title="取消分享">
                        <X size={12} />
                      </Button>
                    </div>
                  </div>
                  {/* View logs sub-panel */}
                  {viewLogsToken === share.token && (
                    <div
                      className="ml-6 mt-1 mb-2 p-3 rounded-lg text-xs"
                      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
                    >
                      <div className="font-medium mb-2 text-token-secondary">观看记录</div>
                      {logsLoading ? (
                        <div className="text-token-muted">加载中...</div>
                      ) : viewLogs.length === 0 ? (
                        <div className="text-token-muted">暂无观看记录</div>
                      ) : (
                        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                          {viewLogs.map(log => (
                            <div key={log.id} className="flex items-center gap-3 text-token-muted">
                              <span style={{ color: log.viewerName ? 'var(--text-primary)' : 'var(--text-muted)', minWidth: 70 }}>
                                {log.viewerName || '匿名访客'}
                              </span>
                              <span>{fmtDate(log.viewedAt)}</span>
                              {log.ipAddress && <span className="opacity-60">{log.ipAddress}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );})}
            </div>
          )}
          <div className="flex justify-end mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <Button variant="ghost" onClick={onClose}>关闭</Button>
          </div>

          {/* 嵌套 ShareDialog：在 SharesPanel 内点「新建分享」时弹出 */}
          {showCreate && scopedSiteId && (
            <ShareDialog
              siteId={scopedSiteId}
              site={scopedSite ?? null}
              existingShareCount={shares.filter(l => !l.isRevoked && !l.isExpired && (l.siteId === scopedSiteId || l.siteIds?.includes(scopedSiteId))).length}
              onClose={() => { setShowCreate(false); }}
              onCreated={refreshShares}
            />
          )}

          {/* 嵌套 ShareAnalyticsDrawer：本站点 scoped 统计 */}
          {showScopedAnalytics && scopedSiteId && (
            <ShareAnalyticsDrawer
              onClose={() => setShowScopedAnalytics(false)}
              scopedSiteId={scopedSiteId}
              scopedSiteTitle={scopedSiteTitle ?? undefined}
            />
          )}
        </>
      }
    />
  );
}
