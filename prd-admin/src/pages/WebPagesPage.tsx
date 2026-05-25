import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Badge } from '@/components/design/Badge';
import { PageHeader } from '@/components/design/PageHeader';
import { Select } from '@/components/design/Select';
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
  revokeSiteShare,
  listShareViewLogs,
  listDocumentStores,
  addDocumentEntry,
  setSiteTeams,
} from '@/services';
import type { HostedSite, ShareLinkItem, TagCount, ShareViewLogItem, SiteOwnerCard } from '@/services/real/webPages';
import { TeamScopeBar, type TeamScope } from '@/components/team/TeamScopeBar';
import { ShareToTeamDialog } from '@/components/team/ShareToTeamDialog';
import { useTeamStore } from '@/stores/teamStore';
import type { DocumentStore } from '@/services/contracts/documentStore';
import { ShareDock, useDockDrag } from '@/components/share-dock';

/** 网页托管页面专用的 ShareDock MIME 类型 */
const WEB_PAGE_MIME = 'application/x-map-site-id';
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
  Check,
  X,
  Lock,
  Clock,
  RefreshCw,
  Link2,
  Link2Off,
  FileCode2,
  FileArchive,
  HardDrive,
  UploadCloud,
  QrCode,
  Globe,
  Library,
  BookOpen,
  Replace,
  AlertTriangle,
  Folder,
  Users,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';

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
const GROUP_MODE_KEY = 'web-pages-group-mode';

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
 * 因此「分组」与「排序」互不干扰 —— 排序决定顺序，分组只插标题。 */
function buildSiteGroups(items: HostedSite[], mode: GroupMode): SiteGroup[] {
  const map = new Map<string, SiteGroup>();
  for (const site of items) {
    let key: string;
    let label: string;
    if (mode === 'folder') {
      key = site.folder ? `f:${site.folder}` : 'f:__none__';
      label = site.folder || '未分类';
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
  const groups = [...map.values()];
  // 文件夹分组：组顺序按文件夹名字母序，「未分类」置底（对齐文学创作可预测排序）。
  // 时间分组：保持 first-seen（= 排序结果）顺序，让排序方向决定时间桶先后。
  if (mode === 'folder') {
    groups.sort((a, b) => {
      if (a.key === 'f:__none__') return 1;
      if (b.key === 'f:__none__') return -1;
      return a.label.localeCompare(b.label, 'zh-Hans-CN');
    });
  }
  return groups;
}

// ─── Main Page ───

export default function WebPagesPage() {
  const username = useAuthStore(s => s.user?.username);
  const [sites, setSites] = useState<HostedSite[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 我的 / 团队 作用域（默认我的）
  const initialScope = useTeamStore.getState().getScope('web-hosting');
  const [teamScope, setTeamScope] = useState<TeamScope>(initialScope);
  const [ownerCards, setOwnerCards] = useState<Record<string, SiteOwnerCard>>({});
  const [keyword, setKeyword] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeSourceType, setActiveSourceType] = useState<string | null>(null);
  const [sort, setSort] = useState('newest');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  // 分组方式（与排序不冲突：排序决定组内/整体顺序，分组只在边界插入分节标题）。
  // 持久化沿用文学创作的 sessionStorage 直存方式（项目禁用 localStorage）。
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    const saved = sessionStorage.getItem(GROUP_MODE_KEY);
    return saved === 'folder' ? 'folder' : 'time';
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 已分享站点集合（单站点分享）：驱动卡片「已分享」标记 + 分享按钮转「取消分享」 + 投放槽读心
  const [sharedSiteIds, setSharedSiteIds] = useState<Set<string>>(new Set());

  const [folders, setFolders] = useState<string[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);

  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [editItem, setEditItem] = useState<HostedSite | null>(null);
  const [pendingExternalFile, setPendingExternalFile] = useState<File | null>(null);
  // 上传成功的站点 ID 集合，触发"滑入 + 光环"入场动效。
  // 事件驱动（onSaved 回调）—— 不再用 sites diff 推断，避免筛选/排序变化误触发动效。
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  // 转知识库目标站点（非 null 时弹出选择文档空间的对话框）
  const [libraryTargetSite, setLibraryTargetSite] = useState<HostedSite | null>(null);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareTargetId, setShareTargetId] = useState<string | null>(null);
  const [showSharesPanel, setShowSharesPanel] = useState(false);
  const [shares, setShares] = useState<ShareLinkItem[]>([]);
  const [qrSite, setQrSite] = useState<HostedSite | null>(null);
  // 拖文件到卡片触发的"替换网页"二次确认（非 null 时弹出确认框）
  const [replaceTarget, setReplaceTarget] = useState<{ site: HostedSite; file: File } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [showShareToTeam, setShowShareToTeam] = useState(false);

  // ─── Load ───

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listSites({
      keyword: keyword || undefined,
      folder: activeFolder || undefined,
      tag: activeTag || undefined,
      sourceType: activeSourceType || undefined,
      sort,
      limit: 200,
      scope: teamScope.scope,
      teamId: teamScope.teamId,
    });
    if (res.success) {
      setSites(res.data.items);
      setTotal(res.data.total);
      setOwnerCards(res.data.owners ?? {});
    }
    setLoading(false);
  }, [keyword, activeFolder, activeTag, activeSourceType, sort, teamScope]);

  const loadMeta = useCallback(async () => {
    const [fRes, tRes] = await Promise.all([listSiteFolders(), listSiteTags()]);
    if (fRes.success) setFolders(fRes.data.folders);
    if (tRes.success) setTags(tRes.data.tags);
  }, []);

  // 拉真实分享列表（后端已排除 visit 便捷链 + 已撤销），刷新「已分享」标记
  const loadShares = useCallback(async () => {
    const res = await listSiteShares();
    if (res.success) setSharedSiteIds(buildSharedSiteIds(res.data.items));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => { loadShares(); }, [loadShares]);

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

  const handleShare = (id: string) => {
    setShareTargetId(id);
    setShowShareDialog(true);
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
  const siteGroups = useMemo(() => buildSiteGroups(sites, groupMode), [sites, groupMode]);

  // 单组内的卡片/列表渲染，按 viewMode 复用
  const renderGroupItems = (items: HostedSite[]) =>
    viewMode === 'grid' ? (
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 260px))',
          justifyContent: 'start',
        }}
      >
        {items.map(site => (
          <SiteCard
            key={site.id}
            site={site}
            selected={selectedIds.has(site.id)}
            fresh={freshIds.has(site.id)}
            shared={sharedSiteIds.has(site.id)}
            ownerCard={teamScope.scope === 'team' ? ownerCards[site.ownerUserId] : undefined}
            onSelect={() => toggleSelect(site.id)}
            onTogglePublic={() => handleMakePublic(site)}
            onEdit={() => { setEditItem(site); setShowUploadDialog(true); }}
            onDelete={() => handleDelete(site.id)}
            onShare={() => handleShare(site.id)}
            onCancelShare={() => cancelShareForSite(site.id)}
            onQrCode={() => setQrSite(site)}
            onTransferToLibrary={() => setLibraryTargetSite(site)}
            onReplaceFile={(file) => setReplaceTarget({ site, file })}
          />
        ))}
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        {items.map(site => (
          <SiteListItem
            key={site.id}
            site={site}
            selected={selectedIds.has(site.id)}
            shared={sharedSiteIds.has(site.id)}
            onSelect={() => toggleSelect(site.id)}
            onEdit={() => { setEditItem(site); setShowUploadDialog(true); }}
            onDelete={() => handleDelete(site.id)}
            onShare={() => handleShare(site.id)}
            onCancelShare={() => cancelShareForSite(site.id)}
            onQrCode={() => setQrSite(site)}
          />
        ))}
      </div>
    );

  return (
    <div className="h-full flex flex-col gap-4 p-4 overflow-auto" style={{ background: 'var(--bg-base)' }}>
      {/* 右侧投放面板：可拖动 + 可收起，拖站点卡片到槽位即可公开/分享/删除 */}
      <ShareDock
        mime={WEB_PAGE_MIME}
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
            const up = await uploadSite({ file: f });
            if (!up.success || !up.data) {
              toast.error('上传失败', up.error?.message || '请稍后重试');
              return;
            }
            const site = up.data;
            markSiteAsFresh(site.id);
            load();
            loadMeta();
            return {
              title: '上传成功',
              createShare: async (mode) => {
                const pwd = mode === 'password' ? genPassword() : undefined;
                const share = await createSiteShareLink({ siteId: site.id, shareType: 'single', expiresInDays: 0, password: pwd });
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
            key: 'public',
            icon: <Globe size={18} />,
            label: '公开',
            hint: '任何人可在 /u/主页查看',
            tone: 'sky',
            onDrop: (id) => {
              const site = sites.find(s => s.id === id);
              if (site) handleMakePublic(site);
            },
            // 读心：拖已公开的站点过来 → 槽位提示「取消公开」（onDrop 仍走 handleMakePublic，内部按当前状态翻转）
            resolve: (id) => {
              const site = sites.find(s => s.id === id);
              return site?.visibility === 'public'
                ? { label: '取消公开', icon: <Lock size={18} />, hint: '改回私有', tone: 'rose' }
                : null;
            },
          },
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
      <PageHeader
        title="网页托管"
        description="上传 HTML/ZIP、Markdown、PDF 或视频，自动托管并生成可分享的访问链接"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowSharesPanel(true)}>
              <Link2 size={14} className="mr-1" /> 分享管理
            </Button>
            <Button size="sm" variant="primary" onClick={() => { setEditItem(null); setShowUploadDialog(true); }}>
              <Upload size={14} className="mr-1" /> 上传站点
            </Button>
          </div>
        }
      />

      {/* Toolbar */}
      <GlassCard className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* 我的 / 团队 切换 + 管理团队 */}
          <TeamScopeBar
            moduleKey="web-hosting"
            value={teamScope}
            onChange={(next) => { setTeamScope(next); setSelectedIds(new Set()); }}
          />
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
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

          {/* Folder filter */}
          {folders.length > 0 && (
            <div className="w-[150px] shrink-0">
              <Select
                uiSize="sm"
                value={activeFolder ?? ''}
                onChange={e => setActiveFolder(e.target.value || null)}
              >
                <option value="">全部文件夹</option>
                {folders.map(f => <option key={f} value={f}>{f}</option>)}
              </Select>
            </div>
          )}

          {/* Source type filter */}
          <div className="w-[140px] shrink-0">
            <Select
              uiSize="sm"
              value={activeSourceType ?? ''}
              onChange={e => setActiveSourceType(e.target.value || null)}
            >
              <option value="">全部来源</option>
              <option value="upload">手动上传</option>
              <option value="workflow">工作流</option>
              <option value="api">API</option>
              <option value="saved-share">从分享保存</option>
            </Select>
          </div>

          {/* Sort */}
          <div className="w-[130px] shrink-0">
            <Select
              uiSize="sm"
              value={sort}
              onChange={e => setSort(e.target.value)}
            >
              <option value="newest">最新创建</option>
              <option value="oldest">最早创建</option>
              <option value="title">按标题</option>
              <option value="most-viewed">最多浏览</option>
              <option value="largest">最大体积</option>
            </Select>
          </div>

          {/* 分组方式：按时间 / 按文件夹（与排序并存，互不冲突） */}
          <div className="flex items-center rounded-lg overflow-hidden shrink-0" style={{ border: '1px solid var(--border-default)' }}>
            <button
              onClick={() => { setGroupMode('time'); sessionStorage.setItem(GROUP_MODE_KEY, 'time'); }}
              className="flex items-center gap-1 px-2.5 py-2 text-xs transition-colors"
              style={{
                background: groupMode === 'time' ? 'var(--bg-elevated)' : 'var(--bg-sunken)',
                color: groupMode === 'time' ? 'var(--accent-primary)' : 'var(--text-muted)',
              }}
              title="按时间分组"
            >
              <Clock size={12} /> 按时间
            </button>
            <button
              onClick={() => { setGroupMode('folder'); sessionStorage.setItem(GROUP_MODE_KEY, 'folder'); }}
              className="flex items-center gap-1 px-2.5 py-2 text-xs transition-colors"
              style={{
                background: groupMode === 'folder' ? 'var(--bg-elevated)' : 'var(--bg-sunken)',
                color: groupMode === 'folder' ? 'var(--accent-primary)' : 'var(--text-muted)',
              }}
              title="按文件夹分组"
            >
              <Folder size={12} /> 按文件夹
            </button>
          </div>

          {/* View mode */}
          <div className="flex items-center rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
            <button
              onClick={() => setViewMode('grid')}
              className="p-2 transition-colors"
              style={{ background: viewMode === 'grid' ? 'var(--bg-elevated)' : 'var(--bg-sunken)', color: 'var(--text-primary)' }}
            >
              <Grid3X3 size={14} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className="p-2 transition-colors"
              style={{ background: viewMode === 'list' ? 'var(--bg-elevated)' : 'var(--bg-sunken)', color: 'var(--text-primary)' }}
            >
              <List size={14} />
            </button>
          </div>

          {/* Refresh */}
          <button
            onClick={() => { load(); loadMeta(); }}
            className="p-2 rounded-lg transition-colors"
            style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
          >
            {loading ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <button
              onClick={() => setActiveTag(null)}
              className="px-2 py-0.5 rounded-full text-xs transition-colors"
              style={{
                background: !activeTag ? 'var(--accent-primary)' : 'var(--bg-sunken)',
                color: !activeTag ? '#fff' : 'var(--text-muted)',
              }}
            >
              全部
            </button>
            {tags.slice(0, 20).map(t => (
              <button
                key={t.tag}
                onClick={() => setActiveTag(t.tag === activeTag ? null : t.tag)}
                className="px-2 py-0.5 rounded-full text-xs transition-colors"
                style={{
                  background: activeTag === t.tag ? 'var(--accent-primary)' : 'var(--bg-sunken)',
                  color: activeTag === t.tag ? '#fff' : 'var(--text-muted)',
                }}
              >
                {t.tag} ({t.count})
              </button>
            ))}
          </div>
        )}

        {/* Batch actions */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>已选 {selectedIds.size} 项</span>
            <Button size="xs" variant="secondary" onClick={handleBatchShare}><Share2 size={12} className="mr-1" /> 合集分享</Button>
            <Button size="xs" variant="secondary" onClick={() => setShowShareToTeam(true)}><Users size={12} className="mr-1" /> 分享到团队</Button>
            <Button size="xs" variant="danger" onClick={handleBatchDelete}><Trash2 size={12} className="mr-1" /> 批量删除</Button>
            <Button size="xs" variant="ghost" onClick={() => setSelectedIds(new Set())}>取消选择</Button>
          </div>
        )}
      </GlassCard>

      {/* Stats */}
      <div className="flex items-center gap-4 text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>共 {total} 个站点</span>
        {activeFolder && <span>文件夹: {activeFolder}</span>}
        {activeTag && <span>标签: {activeTag}</span>}
        {activeSourceType && <span>来源: {sourceTypeLabels[activeSourceType] ?? activeSourceType}</span>}
      </div>

      {/* Content */}
      {loading && sites.length === 0 ? (
        <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      ) : sites.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
          <UploadCloud size={48} strokeWidth={1} />
          <p>还没有托管的网页</p>
          <Button size="sm" variant="primary" onClick={() => { setEditItem(null); setShowUploadDialog(true); }}>
            <Upload size={14} className="mr-1" /> 上传第一个站点
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {siteGroups.map(group => (
            <div key={group.key} className="flex flex-col gap-2">
              {/* 分节标题：时间桶（今天/昨天/M月D日）或文件夹名 */}
              <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {groupMode === 'folder'
                  ? <Folder size={12} style={{ color: 'var(--accent-primary)' }} />
                  : <Clock size={12} style={{ color: 'var(--accent-primary)' }} />}
                <span>{group.label}</span>
                <span style={{ color: 'var(--text-faint, var(--text-muted))' }}>· {group.items.length}</span>
                <div className="flex-1 h-px" style={{ background: 'var(--border-default)' }} />
              </div>
              {renderGroupItems(group.items)}
            </div>
          ))}
        </div>
      )}

      {/* Upload / Edit Dialog */}
      {showUploadDialog && (
        <UploadEditDialog
          item={editItem}
          folders={folders}
          initialFile={pendingExternalFile}
          onClose={() => { setShowUploadDialog(false); setEditItem(null); setPendingExternalFile(null); }}
          onSaved={(saved, isCreate) => {
            setShowUploadDialog(false);
            setEditItem(null);
            setPendingExternalFile(null);
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
                  即将用新文件覆盖「<span style={{ color: 'var(--text-primary)' }}>{replaceTarget.site.title}</span>」的全部网页内容，
                  原有文件将被清理且<span style={{ color: 'var(--text-primary)' }}>无法恢复</span>。访问链接保持不变。
                </span>
              </div>
              <div
                className="flex items-center gap-2.5 rounded-xl p-3"
                style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}
              >
                <Replace size={18} style={{ color: 'var(--accent-primary)' }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{replaceTarget.file.name}</p>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{fmtSize(replaceTarget.file.size)}</p>
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

      {/* Share Dialog */}
      {showShareDialog && (
        <ShareDialog
          siteId={shareTargetId}
          siteIds={shareTargetId ? undefined : [...selectedIds]}
          onClose={() => { setShowShareDialog(false); setShareTargetId(null); loadShares(); }}
        />
      )}

      {/* Shares Panel */}
      {showSharesPanel && (
        <SharesPanel
          shares={shares}
          setShares={setShares}
          onClose={() => setShowSharesPanel(false)}
        />
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

      {showShareToTeam && (
        <ShareToTeamDialog
          title={`分享到团队（已选 ${selectedIds.size} 项）`}
          onConfirm={async (teamIds) => {
            const ids = [...selectedIds];
            for (const id of ids) {
              await setSiteTeams(id, teamIds);
            }
            setShowShareToTeam(false);
            setSelectedIds(new Set());
            toast.success('已分享到团队', `${ids.length} 个站点已更新团队分享`);
            load();
          }}
          onClose={() => setShowShareToTeam(false)}
        />
      )}
    </div>
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
            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>知识库条目标题</label>
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
            <div className="flex flex-col items-center gap-3 py-6" style={{ color: 'var(--text-muted)' }}>
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
                      <Library size={18} style={{ color: 'var(--accent-primary)' }} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{store.name}</p>
                        <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
                        <span className="text-xs opacity-0 transition-opacity group-hover/store:opacity-100" style={{ color: 'var(--text-secondary)' }}>
                          转存 →
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                以引用方式保存：知识库里新建一条指向当前公开链接的条目，预览自动 iframe 嵌入站点页面。
              </p>
            </>
          )}
        </div>
      }
    />
  );
}

function SiteCard({ site, selected, fresh, shared, ownerCard, onSelect, onTogglePublic, onEdit, onDelete, onShare, onCancelShare, onQrCode, onTransferToLibrary, onReplaceFile }: {
  site: HostedSite;
  selected: boolean;
  fresh?: boolean;
  shared?: boolean;
  ownerCard?: SiteOwnerCard;
  onSelect: () => void;
  onTogglePublic: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onCancelShare: () => void;
  onQrCode: () => void;
  onTransferToLibrary: () => void;
  onReplaceFile: (file: File) => void;
}) {
  const isPublic = site.visibility === 'public';
  const [fileDragOver, setFileDragOver] = useState(false);
  // 取消分享 inline 轻确认：点一下转「确认 / 保留」两个小按钮，避免误触
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { onPointerDown } = useDockDrag({
    mime: WEB_PAGE_MIME,
    id: site.id,
    label: site.title,
    icon: '🌐',
  });

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const handleDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!fileDragOver) setFileDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // 仅当真正离开卡片时才收起（忽略子元素间冒泡）
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setFileDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setFileDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onReplaceFile(f);
  };

  // 访问 = 无密码分享链接（≥12 字母 token 形式 /s/wp/{token}），
  // 与分享的数字短链 /s/{seq} 体系彻底分开。先同步开窗规避拦截，再异步解析。
  const handleVisit = () => {
    const w = window.open('', '_blank');
    resolveVisitUrl(site).then(url => { if (w) w.location.href = url; });
  };

  return (
    <div
      className={['group relative w-full cursor-grab touch-none active:cursor-grabbing', fresh ? 'site-card-fresh' : ''].join(' ')}
      style={{
        borderRadius: 24,
        outline: selected ? '2px solid var(--accent-primary)' : '1px solid transparent',
        outlineOffset: selected ? 3 : 0,
      }}
      onPointerDown={onPointerDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className="relative overflow-hidden rounded-[18px] border transition-all duration-300 group-hover:-translate-y-0.5 group-hover:shadow-xl group-hover:shadow-black/25"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025))',
          borderColor: fileDragOver ? 'var(--accent-primary)' : selected ? 'var(--accent-primary)' : 'var(--border-default)',
        }}
      >
        {/* 拖文件到卡片上时显示"替换网页"提示，松手后弹二次确认 */}
        {fileDragOver && (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-[18px] backdrop-blur-sm"
            style={{
              background: 'color-mix(in srgb, var(--accent-primary) 26%, rgba(0,0,0,0.55))',
              border: '2px dashed var(--accent-primary)',
            }}
          >
            <Replace size={30} className="text-white" />
            <span className="text-[15px] font-semibold text-white">替换此网页</span>
            <span className="px-3 text-center text-[11px] text-white/80">松开以替换「{site.title}」的内容</span>
          </div>
        )}
        <div
          className="relative cursor-pointer overflow-hidden"
          style={{ aspectRatio: '16 / 9', background: 'var(--bg-sunken)' }}
          onClick={handleVisit}
        >
          {site.coverImageUrl ? (
            <img
              src={site.coverImageUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]"
            />
          ) : isPdfSite(site) ? (
            <PdfThumbnail
              sizeBytes={site.files.find(f => f.path?.toLowerCase().endsWith('.pdf'))?.size ?? site.totalSize}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <SitePreview url={site.siteUrl} className="h-full w-full transition-transform duration-700 group-hover:scale-[1.035]" />
          )}

          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.02) 34%, rgba(0,0,0,0.18) 100%)',
            }}
          />

          <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5">
            {/* 公开状态按钮固定在左上：私有态"设为公开"，公开态"公开"（悬浮变"取消公开"），位置不跳 */}
            {isPublic ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onTogglePublic(); }}
                className="group/pub inline-flex h-7 cursor-pointer items-center gap-1 rounded-full bg-sky-500/32 px-2.5 text-[11px] font-semibold text-sky-50 shadow-md backdrop-blur-md transition-colors hover:bg-rose-500/45 hover:text-rose-50"
                title="点击取消公开"
              >
                <Globe size={12} className="inline-block group-hover/pub:hidden" />
                <Lock size={12} className="hidden group-hover/pub:inline-block" />
                <span className="group-hover/pub:hidden">公开</span>
                <span className="hidden group-hover/pub:inline-block">取消公开</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onTogglePublic(); }}
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full bg-black/42 px-2.5 text-[11px] font-semibold text-white/90 shadow-md backdrop-blur-md transition-colors hover:bg-black/58"
                title="设为公开"
              >
                <Globe size={12} /> 设为公开
              </button>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSelect(); }}
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full bg-black/30 px-2.5 text-[11px] font-medium text-white/80 opacity-0 shadow-md backdrop-blur-md transition-opacity hover:bg-black/48 group-hover:opacity-100"
              title={selected ? '取消选择' : '选择'}
            >
              <input
                type="checkbox"
                checked={selected}
                readOnly
                className="pointer-events-none"
                style={{ accentColor: 'var(--accent-primary)' }}
              />
              选择
            </button>
          </div>

          {/* 来源标签：手动上传是常态，不展示；仅工作流/API/分享保存等非常态来源才标注 */}
          {site.sourceType !== 'upload' && (
            <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5">
              <span className="inline-flex h-7 items-center rounded-full bg-black/34 px-2.5 text-[10px] font-medium text-white/78 backdrop-blur-md">
                {sourceTypeLabels[site.sourceType] ?? site.sourceType}
              </span>
            </div>
          )}

          <div className="absolute bottom-3 left-3 z-20 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            {shared ? (
              confirmCancel ? (
                <>
                  <IconAction icon={<Check size={12} />} label="确认取消分享" color="#6ee7b7" onClick={() => { setConfirmCancel(false); onCancelShare(); }} />
                  <IconAction icon={<X size={12} />} label="保留分享" onClick={() => setConfirmCancel(false)} />
                </>
              ) : (
                <IconAction icon={<Link2Off size={12} />} label="取消分享" color="#fcd34d" onClick={() => setConfirmCancel(true)} />
              )
            ) : (
              <IconAction icon={<Share2 size={12} />} label="分享" onClick={onShare} />
            )}
            <IconAction icon={<QrCode size={12} />} label="二维码" onClick={onQrCode} />
            {isPublic && (
              <IconAction
                icon={<BookOpen size={12} />}
                label="转存到知识库"
                onClick={onTransferToLibrary}
              />
            )}
            <IconAction icon={<Edit3 size={12} />} label="编辑" onClick={onEdit} />
            <IconAction icon={<Trash2 size={12} />} label="删除" onClick={onDelete} danger />
          </div>
        </div>

        <div className="flex min-h-[92px] flex-col gap-1.5 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1">
              {shared && (
                <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                  <Link2 size={9} /> 已分享
                </span>
              )}
              <h3
                className="truncate text-[15px] font-semibold leading-tight cursor-pointer hover:underline"
                style={{ color: shared ? '#fbbf24' : 'var(--text-primary)' }}
                onClick={handleVisit}
                title={site.title}
              >
                {site.title}
              </h3>
            </div>
            {/* 描述行始终保留高度，无描述时显示浅色占位，让所有卡片底部对齐 */}
            <p
              className="mt-0.5 line-clamp-1 text-[11px] leading-snug"
              style={{ color: site.description ? 'var(--text-secondary)' : 'var(--text-muted)', fontStyle: site.description ? 'normal' : 'italic', opacity: site.description ? 1 : 0.6 }}
            >
              {site.description || '未填写描述'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span className="flex items-center gap-0.5"><Eye size={11} />{site.viewCount}</span>
            <span className="flex items-center gap-0.5"><Clock size={11} />{relativeTime(site.createdAt)}</span>
            <span className="flex items-center gap-0.5"><FileArchive size={11} />{site.files.length} 文件</span>
            <span className="flex items-center gap-0.5"><HardDrive size={11} />{fmtSize(site.totalSize)}</span>
            {site.folder && <span className="flex items-center gap-0.5"><FolderOpen size={11} />{site.folder}</span>}
          </div>

          {/* 团队作用域：左下角显示创建者头像 + 昵称 */}
          {ownerCard && (
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              <UserAvatar
                src={resolveAvatarUrl({ avatarFileName: ownerCard.avatarFileName })}
                className="w-4 h-4 rounded-full"
              />
              <span className="truncate">{ownerCard.displayName}</span>
            </div>
          )}

          {site.tags.length > 0 && (
            <div className="mt-auto flex max-h-[20px] flex-wrap items-center gap-1 overflow-hidden">
              {site.tags.slice(0, 3).map(tag => (
                <span
                  key={tag}
                  className="rounded-full px-1.5 py-0.5 text-[10px]"
                  style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}
                >
                  {tag}
                </span>
              ))}
              {site.tags.length > 3 && (
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  +{site.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IconAction({
  icon,
  label,
  onClick,
  danger,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** 自定义图标色（优先于 danger） */
  color?: string;
}) {
  const c = color ?? (danger ? '#fecaca' : undefined);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-black/38 text-white/88 shadow-md backdrop-blur-md transition-colors hover:bg-black/58"
      title={label}
      aria-label={label}
      style={c ? { color: c } : undefined}
    >
      {icon}
    </button>
  );
}

// ─── List View ───

function SiteListItem({ site, selected, shared, onSelect, onEdit, onDelete, onShare, onCancelShare, onQrCode }: {
  site: HostedSite;
  selected: boolean;
  shared?: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onCancelShare: () => void;
  onQrCode: () => void;
}) {
  const isPublic = site.visibility === 'public';
  const { onPointerDown } = useDockDrag({
    mime: WEB_PAGE_MIME,
    id: site.id,
    label: site.title,
    icon: '🌐',
  });
  // 访问地址与 SiteCard 网格视图一致：统一走 /s/wp/{token}，避免列表/网格切换得到不同 URL
  const handleVisit = () => {
    const w = window.open('', '_blank');
    resolveVisitUrl(site).then(url => { if (w) w.location.href = url; });
  };
  return (
    <GlassCard
      className="group flex items-center gap-4 p-3 cursor-grab active:cursor-grabbing touch-none"
      style={{ border: selected ? '2px solid var(--accent-primary)' : undefined }}
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
          <SitePreview url={site.siteUrl} className="w-full h-full" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {shared && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
              title="已分享"
            >
              <Link2 size={10} /> 已分享
            </span>
          )}
          <span
            className="text-sm font-medium truncate cursor-pointer hover:underline"
            style={{ color: shared ? '#fbbf24' : 'var(--text-primary)' }}
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
              className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/25 px-1.5 py-0.5 text-[10px] font-medium text-sky-200"
              title="已公开"
            >
              <Globe size={10} /> 公开
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{site.files.length} 个文件</span>
          <span>{fmtSize(site.totalSize)}</span>
          <span>{site.entryFile}</span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
        {site.folder && <span className="flex items-center gap-1"><FolderOpen size={12} /> {site.folder}</span>}
        <span className="flex items-center gap-1"><Eye size={12} /> {site.viewCount}</span>
        <span>{relativeTime(site.createdAt)}</span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button onClick={handleVisit} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <ExternalLink size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        {shared ? (
          <button onClick={onCancelShare} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="取消分享">
            <Link2Off size={14} style={{ color: '#fcd34d' }} />
          </button>
        ) : (
          <button onClick={onShare} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="分享">
            <Share2 size={14} style={{ color: 'var(--text-muted)' }} />
          </button>
        )}
        <button onClick={onQrCode} className="p-1 rounded hover:bg-[var(--bg-hover)]" title="二维码">
          <QrCode size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        <button onClick={onEdit} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <Edit3 size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
        <button onClick={onDelete} className="p-1 rounded hover:bg-[var(--bg-hover)]">
          <Trash2 size={14} style={{ color: '#ef4444' }} />
        </button>
      </div>
    </GlassCard>
  );
}

// ─── Upload / Edit Dialog ───

function UploadEditDialog({ item, folders, onClose, onSaved, initialFile }: {
  item: HostedSite | null;
  folders: string[];
  onClose: () => void;
  onSaved: (saved?: HostedSite, isCreate?: boolean) => void;
  initialFile?: File | null;
}) {
  const isEdit = !!item;
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [tagInput, setTagInput] = useState((item?.tags ?? []).join(', '));
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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const handleSave = async () => {
    setSaving(true);

    if (isEdit) {
      if (file) {
        // Reupload
        const res = await reuploadSite(item.id, file);
        if (!res.success) { setSaving(false); return; }
      }
      // Update metadata
      const tags = tagInput.split(/[,，]/).map(t => t.trim()).filter(Boolean);
      const res = await updateSite(item.id, {
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        tags,
        folder: folder.trim() || undefined,
      });
      setSaving(false);
      if (res.success) onSaved(res.data, /*isCreate*/ false);
    } else {
      if (!file) { setSaving(false); return; }
      const tags = tagInput.split(/[,，]/).map(t => t.trim()).filter(Boolean);
      const res = await uploadSite({
        file,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        folder: folder.trim() || undefined,
        tags: tags.length > 0 ? tags.join(',') : undefined,
      });
      setSaving(false);
      if (res.success) onSaved(res.data, /*isCreate*/ true);
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
      title={isEdit ? '编辑站点' : '上传站点'}
      content={
        <>
          <div className="flex flex-col gap-3 max-h-[65vh] overflow-y-auto pr-1">

            {/* File drop zone */}
            {(!isEdit || file !== null) ? (
              <div
                className="flex flex-col items-center justify-center gap-2 p-6 rounded-lg cursor-pointer transition-colors"
                style={{
                  background: dragOver ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-sunken)',
                  border: `2px dashed ${dragOver ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                }}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <UploadCloud size={32} style={{ color: 'var(--text-muted)' }} />
                {file ? (
                  <div className="text-center">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{file.name}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{fmtSize(file.size)}</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>拖拽文件到此处，或点击选择</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>支持 .html / .zip / .md / .pdf / 视频（.mp4/.webm/.mov），最大 500MB</p>
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
                <FileCode2 size={20} style={{ color: 'var(--accent-primary)' }} />
                <div className="flex-1">
                  <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{item.entryFile}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.files.length} 个文件, {fmtSize(item.totalSize)}</p>
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
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>站点标题</span>
              <input
                type="text"
                value={title}
                onChange={e => { titleEditedRef.current = true; setTitle(e.target.value); }}
                placeholder="站点标题（留空使用文件名）"
                className="px-3 py-2 rounded-lg text-sm outline-none"
                style={inputStyle}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>描述</span>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="站点描述..."
                rows={2}
                className="px-3 py-2 rounded-lg text-sm outline-none resize-none"
                style={inputStyle}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>标签（逗号分隔）</span>
              <input
                type="text"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                placeholder="前端, React, 教程"
                className="px-3 py-2 rounded-lg text-sm outline-none"
                style={inputStyle}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>文件夹</span>
              <input
                type="text"
                value={folder}
                onChange={e => setFolder(e.target.value)}
                placeholder="输入文件夹名或留空"
                list="folder-suggestions"
                className="px-3 py-2 rounded-lg text-sm outline-none"
                style={inputStyle}
              />
              <datalist id="folder-suggestions">
                {folders.map(f => <option key={f} value={f} />)}
              </datalist>
            </label>
          </div>

          <div className="flex justify-end gap-2 mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button onClick={handleSave} disabled={saving || (!isEdit && !file)}>
              {saving ? '处理中...' : isEdit ? '保存' : '上传并创建'}
            </Button>
          </div>
        </>
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

function ShareDialog({ siteId, siteIds, onClose }: {
  siteId: string | null;
  siteIds?: string[];
  onClose: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ shareUrl: string; token: string; password?: string; linkType: 'long' | 'short' } | null>(null);
  const [copied, setCopied] = useState(false);
  // 默认勾选密码保护：用户至少要主动取消才会裸链分享
  const [usePassword, setUsePassword] = useState(true);
  const [password, setPassword] = useState(() => genPassword());
  const [expiresInDays, setExpiresInDays] = useState(7);
  // 默认走字母长链 /s/wp/{token}（不可枚举）；短链 /s/{seq} 作为"高级选项"
  const [linkType, setLinkType] = useState<'long' | 'short'>('long');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 短链 + 取消密码场景的 10s 风险提示
  const [showRiskGate, setShowRiskGate] = useState(false);
  const [riskCountdown, setRiskCountdown] = useState(10);

  const isCollection = !siteId && siteIds && siteIds.length > 1;
  const isShort = linkType === 'short';
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
      });
      if (res.success) {
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

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title={result ? '分享链接已创建' : '快速分享'}
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
                <Lock size={16} style={{ color: 'rgba(59, 130, 246, 0.9)', flexShrink: 0 }} />
                <div className="flex-1">
                  <div className="text-xs mb-1" style={{ color: 'rgba(59, 130, 246, 0.8)' }}>访问密码</div>
                  <code className="text-sm font-mono font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>{result.password}</code>
                </div>
                <Button size="sm" variant="ghost" onClick={() => {
                  navigator.clipboard.writeText(result!.password!);
                }}>
                  <Copy size={14} />
                </Button>
              </div>
            )}
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {result.password ? '复制按钮会同时复制链接和密码' : '此链接无需密码，任何人可直接访问'}
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose}>关闭</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {isCollection && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                将分享 {siteIds!.length} 个站点的合集
              </p>
            )}
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              点击下方按钮即可一键生成分享链接，标题会自动生成。
            </p>

            {/* 分享选项 */}
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm" title={isShort ? '短链场景密码不可关闭' : ''}>
                <input
                  type="checkbox"
                  checked={usePassword}
                  onChange={e => handleTogglePassword(e.target.checked)}
                />
                <Lock size={12} style={{ color: 'var(--text-muted)' }} />
                <span style={{ color: 'var(--text-secondary)' }}>
                  密码保护{isShort && <span style={{ color: '#f97316' }}>（短链必须）</span>}
                </span>
              </label>
              {usePassword && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder={isShort ? '≥12 位，含大小写+数字+符号' : '输入密码'}
                      className="flex-1 px-3 py-1.5 rounded-lg text-sm outline-none"
                      style={{
                        ...inputStyle,
                        border: pwdInvalid ? '1px solid #ef4444' : inputStyle.border,
                      }}
                    />
                    <Button size="xs" variant="ghost" onClick={() => setPassword(isShort ? genStrongPassword() : genPassword())} title="随机生成密码">
                      <RefreshCw size={12} />
                    </Button>
                  </div>
                  <span className="text-xs" style={{ color: pwdInvalid ? '#ef4444' : 'var(--text-muted)' }}>
                    {pwdInvalid
                      ? '短链场景密码强度不足：需 ≥12 位，含大小写字母、数字、符号'
                      : isShort
                        ? '短链可被遍历枚举，密码是唯一防线，建议直接用随机生成的强密码'
                        : '可修改密码或点击右侧按钮重新生成'}
                  </span>
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Clock size={12} className="inline mr-1" />过期时间
                </span>
                <select
                  value={expiresInDays}
                  onChange={e => setExpiresInDays(Number(e.target.value))}
                  className="px-3 py-1.5 rounded-lg text-sm outline-none cursor-pointer"
                  style={inputStyle}
                >
                  <option value={0}>永不过期</option>
                  <option value={1}>1 天</option>
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>

              {/* 高级选项 — 链接类型 */}
              <button
                type="button"
                onClick={() => setShowAdvanced(v => !v)}
                className="text-xs flex items-center gap-1 self-start"
                style={{ color: 'var(--text-muted)' }}
              >
                <span style={{ display: 'inline-block', transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>›</span>
                高级选项
              </button>
              {showAdvanced && (
                <div className="flex flex-col gap-1.5 pl-4" style={{ borderLeft: '2px solid var(--border-default)' }}>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>链接形式</span>
                  <label className="flex items-start gap-2 cursor-pointer text-sm">
                    <input type="radio" checked={linkType === 'long'} onChange={() => setLinkType('long')} className="mt-1" />
                    <div className="flex flex-col">
                      <span style={{ color: 'var(--text-secondary)' }}>字母长链 /s/wp/xxxxxxxxxxx（推荐）</span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>72 bits 随机 token，不可枚举猜测；密码可选</span>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer text-sm">
                    <input type="radio" checked={linkType === 'short'} onChange={() => setLinkType('short')} className="mt-1" />
                    <div className="flex flex-col">
                      <span style={{ color: 'var(--text-secondary)' }}>超短数字链 /s/123（自用便捷）</span>
                      <span className="text-xs" style={{ color: '#f97316' }}>可被遍历猜测，必须配强密码使用</span>
                    </div>
                  </label>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-2">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button onClick={handleCreate} disabled={creating || pwdInvalid}>
                {creating ? '生成中...' : '一键分享'}
              </Button>
            </div>

            {/* 10s 风险确认模态：短链取消密码必看 */}
            {showRiskGate && (
              <div
                style={{
                  position: 'fixed', inset: 0, zIndex: 200,
                  background: 'rgba(0, 0, 0, 0.55)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 16,
                }}
                onClick={e => e.stopPropagation()}
              >
                <div
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid #f97316',
                    borderRadius: 12,
                    padding: 24,
                    maxWidth: 480,
                    width: '100%',
                  }}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <Lock size={20} style={{ color: '#f97316' }} />
                    <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                      风险确认：短链无密码 = 任何人可枚举访问
                    </h3>
                  </div>
                  <ul className="text-sm flex flex-col gap-1.5 mb-4" style={{ color: 'var(--text-secondary)' }}>
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
            )}
          </div>
        )
      }
    />
  );
}

// ─── Shares Panel ───

function SharesPanel({ shares, setShares, onClose }: {
  shares: ShareLinkItem[];
  setShares: (s: ShareLinkItem[]) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [viewLogsToken, setViewLogsToken] = useState<string | null>(null);
  const [viewLogs, setViewLogs] = useState<ShareViewLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await listSiteShares();
      if (res.success) setShares(res.data.items);
      setLoading(false);
    })();
  }, [setShares]);

  const handleRevoke = async (shareId: string) => {
    if (!confirm('确定撤销此分享链接？')) return;
    const res = await revokeSiteShare(shareId);
    if (res.success) {
      setShares(shares.filter(s => s.id !== shareId));
    }
  };

  const shareUrlOf = (s: ShareLinkItem) =>
    s.shortSeq && s.shortSeq > 0
      ? `${window.location.origin}/s/${s.shortSeq}`
      : `${window.location.origin}/s/wp/${s.token}`;

  const handleCopy = (s: ShareLinkItem) => {
    navigator.clipboard.writeText(shareUrlOf(s));
  };

  const handleShowLogs = async (token: string) => {
    setViewLogsToken(token);
    setLogsLoading(true);
    const res = await listShareViewLogs(token, 200);
    if (res.success) setViewLogs(res.data.items);
    setLogsLoading(false);
  };

  return (
    <Dialog
      open={true}
      onOpenChange={v => { if (!v) onClose(); }}
      title="分享管理"
      maxWidth={900}
      content={
        <>
          {loading ? (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : shares.length === 0 ? (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              还没有创建过分享链接
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
              {shares.map(share => (
                <div key={share.id}>
                  <div
                    className="flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Link2 size={14} style={{ color: 'var(--text-muted)' }} />
                        <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                          {share.title || (share.shareType === 'collection' ? `合集 (${share.siteIds.length} 站)` : '单站点分享')}
                        </span>
                        {share.shortSeq && share.shortSeq > 0 ? (
                          <span title={`/s/${share.shortSeq}`}>
                            <Badge variant="subtle">#{share.shortSeq}</Badge>
                          </span>
                        ) : (
                          <span title="老分享，仅长链可用">
                            <Badge variant="subtle">长链</Badge>
                          </span>
                        )}
                        <Badge variant={share.accessLevel === 'password' ? 'warning' : 'success'}>
                          {share.accessLevel === 'password' ? '密码保护' : '公开'}
                        </Badge>
                        {share.shareType === 'collection' && (
                          <Badge variant="subtle">{share.siteIds.length} 站合集</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        <span className="flex items-center gap-1"><Eye size={10} /> {share.viewCount} 次浏览</span>
                        <span>创建于 {fmtDate(share.createdAt)}</span>
                        {share.expiresAt && <span>过期于 {fmtDate(share.expiresAt)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="xs"
                        variant={viewLogsToken === share.token ? 'secondary' : 'ghost'}
                        onClick={() => viewLogsToken === share.token ? setViewLogsToken(null) : handleShowLogs(share.token)}
                        title="观看记录"
                      >
                        <Eye size={12} />
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => handleCopy(share)} title="复制链接">
                        <Copy size={12} />
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => window.open(shareUrlOf(share), '_blank')} title="预览">
                        <ExternalLink size={12} />
                      </Button>
                      <Button size="xs" variant="danger" onClick={() => handleRevoke(share.id)} title="撤销">
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
                      <div className="font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>观看记录</div>
                      {logsLoading ? (
                        <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
                      ) : viewLogs.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)' }}>暂无观看记录</div>
                      ) : (
                        <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                          {viewLogs.map(log => (
                            <div key={log.id} className="flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
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
              ))}
            </div>
          )}
          <div className="flex justify-end mt-4 pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
            <Button variant="ghost" onClick={onClose}>关闭</Button>
          </div>
        </>
      }
    />
  );
}
