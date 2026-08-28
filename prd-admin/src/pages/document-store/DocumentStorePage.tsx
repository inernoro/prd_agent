import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  Library,
  Orbit,
  Plus,
  Upload,
  FilePlus,
  FileUp,
  AudioLines,
  Video,
  ArrowLeft,
  X,
  Rss,
  Github,
  Sparkle,
  Trash2,
  FileText,
  BookOpen,
  Share2,
  Globe,
  Lock as GlobeLock,
  Copy,
  Link as LinkIcon,
  Eye,
  Pencil,
  Heart,
  Bookmark,
  Clock,
  Users,
  ArrowUpRight,
  Wand2,
  CheckCircle2,
  AlertCircle,
  Search,
  ArrowUpDown,
  ArrowLeftRight,
  Check,
  Tag,
  FolderSync,
  BarChart3,
  Send,
  MoreHorizontal,
  SlidersHorizontal,
  Download,
  Pin,
  ClipboardCheck,
  CalendarDays,
  GraduationCap,
  Bug,
  Newspaper,
  Image as ImageIcon,
  Boxes,
  KeyRound,
  Network,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useReaderChromeStore } from '@/stores/readerChromeStore';
import { useHistoryBackedView } from '@/hooks/useHistoryBackedView';
import { MobileBottomSheet } from '@/components/mobile/MobileBottomSheet';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { TeamScopeBar, type TeamScope } from '@/components/team/TeamScopeBar';
import { TeamWebPagesSection } from '@/pages/document-store/TeamWebPagesSection';
import { StoreSyncBadge, SyncManagerPanel } from './SyncManagerPanel';
import { RecentEntriesList } from './RecentEntriesList';
import { SendToPeerDialog } from '@/components/sync/SendToPeerDialog';
import { SyncCenterDialog } from './SyncCenterDialog';
import { listPeerSyncRuns } from '@/services/real/peerSync';
import { updateDocumentStorePins } from '@/services/real/userPreferences';
import { ConnectAiDialog } from './ConnectAiDialog';
import { describeShareScope, isLiveShareLink, pickScopeShareLinks, resolveInitialShareScope, shareLinkUrl, upsertShareLink, type ShareScope } from './shareScope';
import { ShareLinkPanel } from './ShareLinkPanel';
import {
  DOC_DOWNLOAD_FORMATS,
  resolveInitialDownloadScope,
  resolveTextExtension,
  shouldFetchOriginalFile,
  toPlainText,
  type DocDownloadFormat,
  type DocDownloadScope,
} from './downloadFormats';
import {
  hasQuickRecordRequest,
  hasRecordInStoreRequest,
  withoutRecordInStoreRequest,
  parseDocumentStoreDeepLink,
  withDocumentStoreEntry,
  withoutDocumentStoreTabRequest,
  withoutOrphanedDocumentStoreEntry,
  withoutQuickRecordRequest,
} from './documentStoreDeepLink';
import {
  consumeDetailInitialAction,
  detailInitialActionForStore,
  type DetailInitialActionRequest,
  type DocumentStoreDetailAction,
} from './detailInitialAction';
import { useTeamStore } from '@/stores/teamStore';
import { useAuthStore } from '@/stores/authStore';
import { AnimatePresence, motion } from 'motion/react';
import CountUp from '@/components/reactbits/CountUp';
import { StoreSizeBadge } from './StoreSizeBadge';
import {
  listDocumentStoresWithPreview,
  createDocumentStore,
  deleteDocumentStore,
  listDocumentEntries,
  uploadDocumentFileWithProgress,
  replaceDocumentFile,
  getDocumentContent,
  addSubscription,
  addGitHubSubscription,
  setPrimaryEntry,
  createFolder,
  togglePinnedEntry,
  searchDocumentEntries,
  getDocumentStore,
  deleteDocumentEntry,
  moveDocumentEntry,
  getLatestAgentRun,
  updateDocumentContent,
  listEntryVersions,
  getEntryVersion,
  restoreEntryVersion,
  setFolderPrimaryChild,
  rebuildContentIndex,
  addDocumentEntry,
  updateDocumentEntry,
  updateDocumentStore,
  createDocStoreShareLink,
  listDocStoreShareLinks,
  revokeDocStoreShareLink,
  ensureDocStoreShareLinkShortSeq,
  listMyFavoriteDocumentStores,
  listMyLikedDocumentStores,
  listRecentDocumentEntries,
  setStoreTeams,
  getStoresAnalyticsSummary,
  getUserPreferences,
  getAgentRun,
  getOrCreateQuickCaptureStore,
  importCdsAcceptanceReport,
  completeRecordingUpload,
  getRecordingUpload,
  getTutorialLinkGraph,
  resolveTutorialLinkRoute,
  createLlmGatewaySsoTicket,
} from '@/services';
import { ShareToTeamDialog } from '@/components/team/ShareToTeamDialog';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import ShinyText from '@/components/reactbits/ShinyText';
import { createPortal } from 'react-dom';
import { CreatePaletteFab } from '@/components/doc-browser/CreatePaletteFab';
import { resolveAvatarUrl } from '@/lib/avatar';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import { DocEmptyState } from '@/components/doc-browser/DocEmptyState';
import { BacklinksPanel } from '@/components/doc-browser/BacklinksPanel';
import { WikilinkHoverCard } from '@/components/doc-browser/WikilinkHoverCard';
import { setWikilinkEntries } from '@/lib/wikilinkCache';
import type {
  DocumentStore,
  DocumentStoreWithPreview,
  DocumentEntry,
  DocumentStoreShareLink,
  InteractionStoreCard,
  RecentDocumentEntry,
  DocumentStoreAgentRun,
  DocumentStoreAccountSummary,
  TutorialLinkGraphSnapshot,
} from '@/services/contracts/documentStore';
import type { DocBrowserEntry, EntryPreview, DocBrowserSortMode } from '@/components/doc-browser/DocBrowser';
import { resolveDocBrowserSortMode } from '@/components/doc-browser/docBrowserSort';
import { ACCEPTANCE_TEMPLATE_KEY } from '@/lib/acceptanceVerdictRegistry';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { SubscriptionDetailDrawer } from './SubscriptionDetailDrawer';
import { SubtitleGenerationDrawer } from './SubtitleGenerationDrawer';
import { TranscribeFlowDrawer } from './TranscribeFlowDrawer';
import { RecordAudioSheet } from './RecordAudioSheet';
import {
  decideUploadedRecordingFollowUp,
  decideBackgroundRunLookup,
  bindBackgroundTranscriptionSource,
  describeBackgroundTranscriptionBanner,
  stalledTranscriptionNotice,
  countTranscriptSentences,
  splitPartialTranscript,
  type FailedTranscriptionNotice,
  decideVaultServerRecovery,
  deferredRunIdForRecoveredVaultCompletion,
  enqueueBackgroundTranscriptionRun,
  recoverableBackgroundTranscriptionRunId,
  isStalledBackgroundTranscriptionRun,
  describeFailedTranscription,
  shouldRetryVaultServerCompletion,
  startSerialBackgroundPoller,
  vaultClearServerCompletion,
  vaultDeleteSession,
  vaultListSessions,
  vaultLoadSessionFile,
} from './recordingVault';
import { ReprocessChatDrawer, saveActiveShortVideoRun } from './ReprocessChatDrawer';
import { ShortVideoRunIndicator } from './ShortVideoRunIndicator';
import { ViewersDrawer } from './ViewersDrawer';
import { useReprocessRunStore, selectStreamingByEntry } from '@/stores/reprocessRunStore';
import { parseCdsReportImportDeepLink, withoutCdsReportImportDeepLink } from './cdsReportImportDeepLink';
import { TutorialLinkGraphDrawer, TutorialLinkedPages } from './TutorialLinkGraphDrawer';
import { resolveLlmGatewaySso } from '@/lib/llmGatewaySso';
import { getSharedQuickCaptureRequest, type QuickCaptureRequestHolder } from './quickCaptureRequest';

// 上传白名单：文档 + 音频 + 视频 + 图片（音频进库后可转录/生成字幕；后端 InferMime 已支持这些扩展名）。
// 2026-07-13 用户反馈"上传录音文件上传不了"——旧白名单只有文档类，音频被文件选择器直接过滤。
const ACCEPT_TYPES = '.md,.mdc,.txt,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.json,.yaml,.yml,.csv,.xml,.html,'
  + '.mp3,.m4a,.wav,.aac,.ogg,.flac,.weba,.webm,.mp4,.mov,.png,.jpg,.jpeg,.gif,.webp';

/** 后端单文件上限（DocumentStoreController.MaxUploadBytes = 20MB），前端预检即时报错，不让用户白等 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type DocumentStoreEmptyActionKey = 'create' | 'upload' | 'emergence';

export const DOCUMENT_STORE_EMPTY_ACTIONS: Array<{
  key: DocumentStoreEmptyActionKey;
  title: string;
  desc: string;
}> = [
  { key: 'create', title: '创建知识库', desc: '按项目或主题组织文档' },
  { key: 'upload', title: '上传文档', desc: '先建知识库，再把文件上传进去' },
  { key: 'emergence', title: '涌现探索', desc: '从文档出发，发现新可能' },
];

const DOCUMENT_STORE_EMPTY_ACTION_ICONS: Record<DocumentStoreEmptyActionKey, LucideIcon> = {
  create: Library,
  upload: Upload,
  emergence: Sparkle,
};

// 账号级总计的紧凑格式化：大数走「万」，停留走「时/分」。
function formatCountCompact(n: number): string {
  // count-up 动画喂进来的是插值浮点，先取整，避免 <1万 时闪现小数
  const r = Math.round(n);
  if (r < 10_000) return String(r);
  return `${(r / 10_000).toFixed(r % 10_000 === 0 ? 0 : 1)} 万`;
}
function formatDwellCompact(ms: number): string {
  if (!ms || ms < 1000) return '0 秒';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时${min % 60 ? ` ${min % 60} 分` : ''}`;
}

// 账号级总计的「缓过来」动效：数字从上一个值缓动到目标值（easeOutCubic）。
function useCountUp(target: number, durationMs = 700): number {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    const to = target;
    if (from === to) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else { fromRef.current = to; setVal(to); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return val;
}

function AnimatedStat({ value, format }: { value: number; format: (n: number) => string }) {
  const v = useCountUp(value);
  return <strong style={{ color: 'var(--text-primary)' }}>{format(v)}</strong>;
}

// 挂载后淡入，避免账号总计「突然蹦出来」撑宽整行。
function FadeIn({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  return <span style={{ opacity: shown ? 1 : 0, transition: 'opacity 0.45s ease' }}>{children}</span>;
}

function getPeerSyncLabel(store: Pick<DocumentStore, 'peerSyncStatus' | 'peerSyncDirection'>) {
  if (store.peerSyncStatus === 'syncing') return '正在跨系统同步';
  if (store.peerSyncStatus === 'error') return '跨系统同步异常';
  switch (store.peerSyncDirection) {
    case 'both': return '双向同步';
    case 'push': return '已发送到对端';
    case 'pull': return '已从对端拉取';
    case 'received': return '已接收对端同步';
    default: return '已跨系统同步';
  }
}

function PeerSyncBadge({ store, compact = false }: { store: DocumentStore | DocumentStoreWithPreview; compact?: boolean }) {
  if (!store.peerSyncStatus) return null;
  const isError = store.peerSyncStatus === 'error';
  const isSyncing = store.peerSyncStatus === 'syncing';
  const Icon = isError ? AlertCircle : isSyncing ? FolderSync : store.peerSyncDirection === 'both' ? ArrowLeftRight : Send;
  const label = getPeerSyncLabel(store);
  const title = [
    label,
    store.peerSyncNodeName ? `对端：${store.peerSyncNodeName}` : '',
    store.peerSyncLastResult || '',
  ].filter(Boolean).join('\n');
  const color = isError ? 'rgba(252,165,165,0.96)' : 'rgba(252,211,77,0.96)';
  const background = isError ? 'rgba(239,68,68,0.10)' : 'rgba(245,158,11,0.12)';
  const borderColor = isError ? 'rgba(239,68,68,0.30)' : 'rgba(245,158,11,0.35)';
  if (compact) {
    // 卡片右上角走「安静状态图标」：纯图标 + tooltip，不做成按钮盒——
    // 状态与动作分离，右上角不再一排方块互相打架（2026-07-16 用户反馈）
    return (
      <span
        className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center"
        style={{ color }}
        title={title}
        aria-label={label}
      >
        <Icon size={13} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex max-w-[160px] items-center gap-1 overflow-hidden rounded-full border font-semibold whitespace-nowrap"
      style={{
        padding: '5px 9px',
        fontSize: 11,
        background,
        borderColor,
        color,
      }}
      title={title}
    >
      <Icon size={12} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

// 库内文档排序控件（落在 DocBrowser 左栏顶部 sidebarHeader 槽位）。
// 选中即服务端持久化（store.defaultSortMode），换设备/重登录/刷新都保持。
function DocSortControl({ value, onChange }: { value: DocBrowserSortMode; onChange: (m: DocBrowserSortMode) => void }) {
  const opts: { key: DocBrowserSortMode; label: string; hint?: string }[] = [
    { key: 'default', label: '书籍顺序', hint: '自定义顺序：在下方列表里拖拽文档即可调整位置' },
    { key: 'created-desc', label: '最新创建' },
    { key: 'updated-desc', label: '最近更新' },
  ];
  // 标签由筛选面板的分组标题承担，这里不再重复写「排序」二字
  return (
    <div className="flex shrink-0 items-center">
      <div className="inline-flex shrink-0 items-center gap-0.5 rounded-[8px] p-0.5" style={{ background: 'rgba(148,163,184,0.10)' }}>
        {opts.map(o => {
          const active = o.key === value;
          return (
            <button
              key={o.key}
              onClick={() => onChange(o.key)}
              title={o.hint}
              className={`shrink-0 whitespace-nowrap rounded-[6px] px-2 py-1 text-[11px] transition-colors ${active ? '' : 'hover-bg-soft'}`}
              style={active
                ? { background: 'var(--selection-bg)', color: 'var(--selection-text)', fontWeight: 600 }
                : { color: 'var(--text-muted)' }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 顶栏「更多」下拉菜单项
function MoreItem({ icon, label, onClick, disabled, dataTourId }: {
  icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; dataTourId?: string;
}) {
  return (
    <button
      type="button"
      data-tour-id={dataTourId}
      onClick={onClick}
      disabled={disabled}
      className="hover-bg-soft flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors disabled:opacity-50"
      style={{ color: 'var(--text-primary)' }}
    >
      <span className="text-token-muted">{icon}</span>
      {label}
    </button>
  );
}

// 「今天有更新」判定：本地日历日口径（用户说的是"今天"，不是 24h 滚动窗）
function isUpdatedToday(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return false;
  const now = new Date();
  return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
}

// 卡片右键菜单容器：createPortal 到 body + fixed 定位（遵守 frontend-modal.md），
// 位置按视口边缘收敛，点外/ESC 关闭。菜单项复用 MoreItem，与三点「更多」同源。
function StoreContextMenu({ x, y, onClose, children }: {
  x: number; y: number; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - 208));
  const top = Math.max(8, Math.min(y, window.innerHeight - 288));
  const menu = (
    <div ref={ref} className="surface-popover fixed z-[10000] min-w-[184px] rounded-[10px] py-1" style={{ left, top }}>
      {children}
    </div>
  );
  return createPortal(menu, document.body);
}

// 按知识库类别选图标（模板键 / appKey / 首个标签关键词 → lucide 图标），让卡片一眼看出类别。
function iconForStore(store: { templateKey?: string; appKey?: string | null; tags?: string[]; name?: string }): LucideIcon {
  if (store.templateKey === ACCEPTANCE_TEMPLATE_KEY) return ClipboardCheck; // 验收报告
  const hay = `${store.appKey ?? ''} ${(store.tags ?? []).join(' ')} ${store.name ?? ''}`.toLowerCase();
  const has = (...kw: string[]) => kw.some(k => hay.includes(k));
  if (has('日报', 'daily')) return CalendarDays;
  if (has('周报', 'weekly', 'report', '报告')) return Newspaper;
  if (has('教程', 'guide', 'tutorial', '指南', '手册')) return GraduationCap;
  if (has('缺陷', 'bug', 'defect', '问题')) return Bug;
  if (has('视觉', 'image', 'visual', '海报', '图片')) return ImageIcon;
  if (has('文档', 'doc', '规格', 'spec', '需求', 'prd')) return FileText;
  if (has('产品', 'product', '项目', 'project')) return Boxes;
  return Library;
}

// ── 创建空间对话框 ──
function CreateStoreDialog({ onClose, onCreated }: {
  onClose: () => void;
  // 父级可能在 onCreated 内执行 setStoreTeams 等异步动作,
  // 必须返回 Promise 才能在它真正完成前继续 loading + 阻塞按钮。
  onCreated: (store: DocumentStore) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (loading) return; // 双保险:即使父级没及时禁用,也不允许重复触发
    if (!name.trim()) { setError('空间名称不能为空'); return; }
    setLoading(true);
    setError('');
    const res = await createDocumentStore({ name: name.trim(), description: description.trim() || undefined });
    if (res.success) {
      try {
        await onCreated(res.data); // 等父级 share/导航完成再放行
      } catch (e) {
        setError((e as Error)?.message ?? '后续操作失败');
      }
    } else {
      setError(res.error?.message ?? '创建失败');
    }
    setLoading(false);
  };

  // 创建/分享 in-flight 时阻断所有关闭路径(backdrop / X / 取消),避免对话框过早消失
  // 让后续 await 在"无主"状态下完成导航 → 用户误点其他 tab。
  const safeClose = () => { if (!loading) onClose(); };

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) safeClose(); }}>
      <div className="surface-popover w-[420px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Library size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">
              新建知识库
            </span>
          </div>
          <button onClick={safeClose} disabled={loading}
            className="hover-bg-soft flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed">
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">空间名称</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如：产品文档库" disabled={loading}
            className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none transition-colors duration-200 disabled:opacity-60"
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
          />
        </div>
        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">描述（可选）</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="这个空间用来存放什么文档" disabled={loading}
            className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none transition-colors duration-200 disabled:opacity-60"
          />
        </div>

        {error && <p className="mb-3 text-[12px] text-token-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={safeClose} disabled={loading}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleCreate} disabled={loading}>
            {loading ? '创建中…' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 编辑知识库对话框（重命名 + 打标签） ──
function EditStoreDialog({ storeId, initialName, initialTags, onClose, onSaved }: {
  storeId: string;
  initialName: string;
  initialTags: string[];
  onClose: () => void;
  onSaved: (patch: { name: string; tags: string[] }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagInput, setTagInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addTag = (raw: string) => {
    const trimmed = raw.trim().replace(/^#/, '');
    if (!trimmed) return;
    if (trimmed.length > 20) { setError('单个标签最多 20 个字'); return; }
    if (tags.includes(trimmed)) { setTagInput(''); return; }
    if (tags.length >= 10) { setError('最多 10 个标签'); return; }
    setError('');
    setTags(prev => [...prev, trimmed]);
    setTagInput('');
  };

  const removeTag = (t: string) => setTags(prev => prev.filter(x => x !== t));

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const sameAsInitial = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError('空间名称不能为空'); return; }
    // 把未提交的输入也当作一个标签
    const pendingTag = tagInput.trim().replace(/^#/, '');
    const finalTags = pendingTag && !tags.includes(pendingTag) ? [...tags, pendingTag] : tags;

    const nameChanged = trimmedName !== initialName;
    const tagsChanged = !sameAsInitial(finalTags, initialTags);
    if (!nameChanged && !tagsChanged) { onClose(); return; }

    setLoading(true);
    setError('');
    const res = await updateDocumentStore(storeId, {
      ...(nameChanged ? { name: trimmedName } : {}),
      ...(tagsChanged ? { tags: finalTags } : {}),
    });
    if (res.success) {
      onSaved({ name: trimmedName, tags: finalTags });
      toast.success('已更新');
      onClose();
    } else {
      setError(res.error?.message ?? '更新失败');
    }
    setLoading(false);
  };

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover w-[440px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Pencil size={14} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">
              编辑知识库
            </span>
          </div>
          <button onClick={onClose}
            className="hover-bg-soft flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200">
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">空间名称</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="如：产品文档库"
            className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none transition-colors duration-200"
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
          />
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">
            标签 <span className="text-[10px] text-token-muted">（回车或逗号分隔，最多 10 个）</span>
          </label>
          <div
            className="prd-field flex min-h-9 flex-wrap items-center gap-1.5 rounded-[10px] px-2 py-1.5">
            {tags.map(t => (
              <span key={t}
                className="surface-action-accent inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium">
                # {t}
                <button
                  onClick={() => removeTag(t)}
                  className="ml-0.5 flex cursor-pointer items-center justify-center"
                  title="移除">
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={tags.length === 0 ? '如：产品、需求' : ''}
              className="h-6 min-w-[80px] flex-1 bg-transparent text-[12px] text-token-primary outline-none"
            />
          </div>
        </div>

        {error && <p className="mb-3 text-[12px] text-token-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleSave} disabled={loading}>
            {loading ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 分享对话框 ──
// 一个范围 = 一条链接。范围（整库 / 这一篇）写在最上面，不让用户猜。
// export 供 __tests__/ShareDialog.test.tsx 直接渲染断言范围文案。
// 历史教训（2026-07-31 用户反馈）：旧版把「公开直链 + 创建短链 + 全部链接列表（整库与单篇混排）」
// 三段并列，从顶栏点「分享」只能建整库链接 —— 用户以为在分享当前这篇，结果整库被公开；
// 重复点「生成链接」时后端复用旧链接、前端仍无脑 prepend，列表里就多出一行同 id 同短链的重复卡片。
export function ShareDialog({ storeId, storeName, isPublic, entryId, entryTitle, currentEntryId, currentEntryTitle, anchorRef, onClose }: {
  storeId: string;
  storeName: string;
  isPublic: boolean;
  /** 非空 = 从文件树「分享此文档」进来，范围默认落在这一篇 */
  entryId?: string;
  entryTitle?: string;
  /** 顶栏「分享」进来时当前正在阅读的文档，用于「只分享这一篇」的范围切换 */
  currentEntryId?: string;
  currentEntryTitle?: string;
  /** 桌面端锚点：传入则就地悬浮在该按钮下方，不传（或手机）走居中弹窗 */
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const pickedEntryId = entryId ?? currentEntryId;
  const pickedEntryTitle = entryTitle ?? currentEntryTitle;
  // 默认分享「当前这篇」：只要手上有正在读的文档就落单篇范围（2026-07-31 用户明确要求）。
  // 分享的绝大多数场景是「把我正在看的这篇发给别人」，整库公开是少数且后果更大，不该当默认。
  const [scope, setScope] = useState<ShareScope>(() => resolveInitialShareScope(entryId, currentEntryId));
  // 没有可选文档时永远停在整库范围，避免出现「选了这一篇却没有这一篇」的空范围
  const activeScope: ShareScope = pickedEntryId ? scope : 'store';
  const targetEntryId = activeScope === 'entry' ? pickedEntryId : undefined;

  const [links, setLinks] = useState<DocumentStoreShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [shortLinkBusy, setShortLinkBusy] = useState(false);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    const res = await listDocStoreShareLinks(storeId);
    if (res.success) setLinks(res.data.items);
    setLoading(false);
  }, [storeId]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  // 当前范围内生效中的链接（后端对同一 (库, 人, 范围) 会复用，正常最多一条）
  const scopeLinks = useMemo(() => pickScopeShareLinks(links, targetEntryId), [links, targetEntryId]);
  const activeLink = scopeLinks[0];
  // 站在「只分享这一篇」的范围里时，整库链接仍然生效 = 全部文档照样对外可见，必须当面告知
  const liveStoreLinks = useMemo(() => links.filter(l => isLiveShareLink(l) && !l.entryId), [links]);

  const handleCreate = async () => {
    setCreating(true);
    const res = await createDocStoreShareLink(storeId, { expiresInDays, entryId: targetEntryId });
    if (res.success) {
      // 按 id 去重：后端复用旧链接时返回的就是已在列表里的那条，不能再 prepend 一行
      const created = res.data;
      setLinks(prev => upsertShareLink(prev, created));
      toast.success('链接已生成', '复制后发给别人就能打开');
    } else {
      toast.error('生成失败', res.error?.message);
    }
    setCreating(false);
  };

  const handleRevoke = async (linkId: string) => {
    if (!confirm('确认撤销此分享链接？撤销后拿到链接的人立即无法打开。')) return;
    const res = await revokeDocStoreShareLink(linkId);
    if (res.success) {
      setLinks(prev => prev.map(l => l.id === linkId ? { ...l, isRevoked: true } : l));
      toast.success('已撤销', '这条链接已经失效');
    } else {
      toast.error('撤销失败', res.error?.message);
    }
  };

  // 地址形态判定走 shareScope.ts 这一个来源：主链恒长链，数字短链是次级可选项
  const buildShareUrl = (link: DocumentStoreShareLink) => shareLinkUrl(window.location.origin, link);

  const copyText = (url: string) => navigator.clipboard.writeText(url).then(() => toast.success('链接已复制'));

  // 数字短链懒分配：只有用户在面板里主动点，才去后端占一个号
  const handleMakeShortLink = async (link: DocumentStoreShareLink) => {
    setShortLinkBusy(true);
    const res = await ensureDocStoreShareLinkShortSeq(link.id);
    if (res.success && res.data.shortSeq > 0) {
      const seq = res.data.shortSeq;
      setLinks(prev => prev.map(l => l.id === link.id ? { ...l, shortSeq: seq } : l));
      copyText(`${window.location.origin}/s/${seq}`);
    } else {
      toast.error('生成失败', res.error?.message ?? '数字短链生成失败，请稍后重试');
    }
    setShortLinkBusy(false);
  };

  const directLink = `${window.location.origin}/library/${storeId}`;
  // 范围说明：一句话讲清「拿到链接的人能看到什么」，这是本弹窗唯一需要用户理解的事
  const scopeNote = describeShareScope(activeScope, storeName, pickedEntryTitle);

  // 桌面端从「分享」按钮右上角就地悬浮弹出（不遮挡正文、不打断阅读）；
  // 手机端屏幕窄，仍走居中弹窗，否则悬浮层会挤成一条（2026-07-31 用户要求）。
  const body = (
    <>
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Share2 size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">分享</span>
          </div>
          <button onClick={onClose}
            className="hover-bg-soft flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* 第一行先把当前状态说清楚（同语雀「当前文档为公开…」），再谈操作 */}
          <p className="mb-3 text-[12px] leading-relaxed text-token-secondary">{scopeNote}</p>

          {/* 链接区：主链恒为不可枚举长链，复制 + 二维码并排 */}
          {loading ? (
            <div className="flex justify-center py-8"><MapSpinner size={14} /></div>
          ) : activeLink ? (
            <ShareLinkPanel
              link={activeLink}
              activeScope={activeScope}
              storeName={storeName}
              entryTitle={pickedEntryTitle}
              canPickEntry={Boolean(pickedEntryId)}
              shortLinkBusy={shortLinkBusy}
              onCopy={copyText}
              onSelectScope={setScope}
              onShortLink={() => handleMakeShortLink(activeLink)}
              onRevoke={() => handleRevoke(activeLink.id)}
            />
          ) : (
            <div className="surface-inset rounded-[12px] p-4">
              {/* 还没链接：范围 + 有效期 摆在一起，一次点完 */}
              <div className="mb-2 flex gap-1">
                <button type="button" onClick={() => setScope('entry')} disabled={!pickedEntryId}
                  title={pickedEntryId ? `只分享《${pickedEntryTitle ?? ''}》` : '先打开一篇文档，才能单独分享它'}
                  className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold transition-colors ${!pickedEntryId ? 'cursor-not-allowed opacity-45 text-token-muted' : activeScope === 'entry' ? 'surface-action-accent cursor-pointer' : 'cursor-pointer text-token-muted hover-bg-soft'}`}>
                  <FileText size={12} /> 只分享当前这篇
                </button>
                <button type="button" onClick={() => setScope('store')}
                  className={`flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold transition-colors ${activeScope === 'store' ? 'surface-action-accent' : 'text-token-muted hover-bg-soft'}`}>
                  <Library size={12} /> 整个知识库
                </button>
              </div>
              <div className="flex gap-2">
                <select value={expiresInDays} onChange={e => setExpiresInDays(Number(e.target.value))}
                  className="prd-field h-9 flex-1 cursor-pointer rounded-[9px] px-3 text-[12px] outline-none">
                  <option value={0}>永不过期</option>
                  <option value={1}>1 天后过期</option>
                  <option value={7}>7 天后过期</option>
                  <option value={30}>30 天后过期</option>
                  <option value={90}>90 天后过期</option>
                </select>
                <Button variant="primary" size="xs" className="h-9 rounded-[9px]" onClick={handleCreate} disabled={creating}>
                  {creating ? <MapSpinner size={12} /> : <LinkIcon size={12} />}
                  {creating ? '生成中…' : '生成链接'}
                </Button>
              </div>
            </div>
          )}

          {/* 同一范围还有别的历史链接时如实列出，不藏 */}
          {scopeLinks.length > 1 && (
            <div className="mt-3">
              <div className="mb-2 text-[11px] font-semibold text-token-muted">
                这个范围还有 {scopeLinks.length - 1} 条早先生成的链接仍然有效
              </div>
              <div className="space-y-1.5">
                {scopeLinks.slice(1).map(link => (
                  <div key={link.id} className="surface-row flex items-center gap-2 rounded-[9px] px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-token-muted">{buildShareUrl(link)}</span>
                    <button onClick={() => copyText(buildShareUrl(link))}
                      className="surface-action flex h-7 flex-shrink-0 cursor-pointer items-center gap-1 rounded-[8px] px-2.5 text-[11px] font-semibold">
                      <Copy size={11} /> 复制
                    </button>
                    <button onClick={() => handleRevoke(link.id)}
                      className="hover-text-error flex h-7 flex-shrink-0 cursor-pointer items-center gap-1 rounded-[8px] px-2 text-[11px] text-token-muted transition-colors">
                      <Trash2 size={11} /> 撤销
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 只分享一篇时，如果整库链接还生效，必须当面说清并给出撤销入口 */}
          {activeScope === 'entry' && liveStoreLinks.length > 0 && (
            <div className="mt-3 rounded-[12px] p-3.5"
              style={{ background: 'var(--semantic-warning-soft)', border: '1px solid var(--semantic-warning-border)' }}>
              <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--semantic-warning-text)' }}>
                <AlertCircle size={12} /> 这个知识库另有整库分享链接生效中
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-token-muted">
                只分享单篇不会收回已经发出去的整库链接。拿到那条链接的人依旧能看到全部文档，需要的话在这里撤销。
              </p>
              <div className="mt-2.5 space-y-1.5">
                {liveStoreLinks.map(link => (
                  <div key={link.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-token-muted">{buildShareUrl(link)}</span>
                    <button onClick={() => handleRevoke(link.id)}
                      className="hover-text-error flex h-7 flex-shrink-0 cursor-pointer items-center gap-1 rounded-[8px] px-2 text-[11px] text-token-muted transition-colors">
                      <Trash2 size={11} /> 撤销
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 已发布到智识殿堂时的公开直链：与分享短链是两回事，单篇范围下不适用 */}
          {isPublic && activeScope === 'store' && (
            <div className="surface-inset mt-3 rounded-[12px] p-4">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Globe size={12} className="text-token-accent" />
                <span className="text-[12px] font-semibold text-token-accent">智识殿堂公开页</span>
              </div>
              <p className="mb-2.5 text-[11px] text-token-muted">
                这个知识库已发布到智识殿堂，不用分享链接也能被访问
              </p>
              <div className="flex items-center gap-2">
                <input value={directLink} readOnly
                  className="prd-field h-9 min-w-0 flex-1 rounded-[9px] px-3 font-mono text-[12px] outline-none" />
                <button onClick={() => copyText(directLink)}
                  className="surface-action flex h-9 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-[9px] px-3.5 text-[12px] font-semibold">
                  <Copy size={12} /> 复制
                </button>
              </div>
            </div>
          )}
        </div>
    </>
  );

  // 桌面：锚定在「分享」按钮下方的悬浮面板（createPortal 到 body，见 frontend-modal.md）
  if (!isMobile && anchorRef) {
    return (
      <AnchoredMenu open onClose={onClose} anchorRef={anchorRef} minWidth={420}
        className="surface-popover flex max-h-[80vh] w-[440px] max-w-[92vw] flex-col rounded-[16px] p-5">
        {body}
      </AnchoredMenu>
    );
  }

  // 手机 / 无锚点（文件树右键分享）：居中弹窗。
  // createPortal 到 body + 布局关键尺寸走 inline style，见 .claude/rules/frontend-modal.md：
  // 祖先的 overflow-hidden / transform 会裁掉 fixed 层，Tailwind arbitrary 值也可能在某些
  // 构建模式下不生效，高度约束一旦丢失内容就会撑破屏幕。
  return createPortal(
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover flex flex-col rounded-[16px] p-6"
        style={{ height: 'auto', maxHeight: '85vh', width: 560, maxWidth: '92vw' }}>
        {body}
      </div>
    </div>,
    document.body,
  );
}

// ── 下载：范围 + 格式 ──
// 范围/格式判定是纯函数，抽到 downloadFormats.ts 供测试（见 __tests__/downloadFormats.test.ts）
/**
 * 按所选格式把一条文档导出成一个可写盘的文件。
 * 返回 null = 这条确实没有可导出的内容（正文为空且原始文件也取不到），由调用方计入失败数。
 */
async function buildEntryDownload(
  entry: { id: string; title: string },
  format: DocDownloadFormat,
  makeName: (title: string, ext: string) => string,
): Promise<{ name: string; data: Blob | string } | null> {
  const res = await getDocumentContent(entry.id);
  if (!res.success || !res.data) return null;
  const { content, fileUrl, contentType } = res.data;
  const hasText = content != null && content !== '';

  // 「原始文件」且是二进制条目（pdf/docx/图片…）：先试原文件。fileUrl 多为对象存储/CDN 绝对
  // 地址（TencentCosStorage 返回公网 URL），不带 Access-Control-Allow-Origin，浏览器端 fetch
  // 会被 CORS 拦掉；取不到就降级为抽取正文，至少不整条丢失（真·原文件需后端同源代理）。
  if (shouldFetchOriginalFile(format, contentType, fileUrl)) {
    try {
      const resp = await fetch(fileUrl!);
      if (resp.ok) {
        const blob = await resp.blob();
        const m = /\.([a-zA-Z0-9]{1,8})(?:\?|$)/.exec(fileUrl!);
        return {
          name: makeName(entry.title.replace(/\.[a-zA-Z0-9]{1,8}$/, ''), m ? `.${m[1]}` : ''),
          data: blob,
        };
      }
    } catch {
      // CORS / 网络失败 → 落到下面的正文降级
    }
  }
  if (!hasText) return null;
  // 纯文本格式要真的去掉标记，不能只换后缀（否则 .txt 里全是 # / [](), 与文案不符）
  const data = format === 'text' ? toPlainText(content!, contentType) : content!;
  if (data === '') return null;
  return { name: makeName(entry.title, resolveTextExtension(format, contentType)), data };
}

// 下载对话框：范围默认「当前这篇」，没有打开文档时自动落到整库并禁用单篇选项。
// export 供 __tests__/DownloadDialog.test.tsx 直接渲染断言默认范围（用户明确要求默认当前文章）。
export function DownloadDialog({ storeName, entryTitle, busy, onDownload, onClose }: {
  storeName: string;
  /** 当前正在阅读的文档标题；undefined = 没打开文档，只能整库下载 */
  entryTitle?: string;
  busy: boolean;
  onDownload: (scope: DocDownloadScope, format: DocDownloadFormat) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<DocDownloadScope>(() => resolveInitialDownloadScope(Boolean(entryTitle)));
  const [format, setFormat] = useState<DocDownloadFormat>('markdown');
  const activeScope: DocDownloadScope = entryTitle ? scope : 'store';

  // 同 ShareDialog：createPortal 到 body + 尺寸走 inline style（frontend-modal.md 三硬约束）
  return createPortal(
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover flex flex-col rounded-[16px] p-6"
        style={{ height: 'auto', maxHeight: '85vh', width: 460, maxWidth: '92vw' }}>
        <div className="mb-4 flex flex-shrink-0 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Download size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">下载文档</span>
          </div>
          <button onClick={onClose}
            className="hover-bg-soft flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="mb-2 text-[12px] font-semibold text-token-primary">下载范围</div>
          <div className="surface-inset flex gap-1 rounded-[10px] p-1">
            <button type="button" onClick={() => setScope('entry')} disabled={!entryTitle}
              title={entryTitle ? `只下载《${entryTitle}》` : '先打开一篇文档，才能单独下载它'}
              className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[8px] px-3 text-[12px] font-semibold transition-colors ${!entryTitle ? 'cursor-not-allowed opacity-45 text-token-muted' : activeScope === 'entry' ? 'surface-action-accent cursor-pointer' : 'cursor-pointer text-token-muted hover-bg-soft'}`}>
              <FileText size={12} /> 当前文章
            </button>
            <button type="button" onClick={() => setScope('store')}
              className={`flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[8px] px-3 text-[12px] font-semibold transition-colors ${activeScope === 'store' ? 'surface-action-accent' : 'text-token-muted hover-bg-soft'}`}>
              <Library size={12} /> 整个知识库
            </button>
          </div>
          <p className="mb-4 mt-2 truncate text-[11px] text-token-muted"
            title={activeScope === 'entry' ? entryTitle : storeName}>
            {activeScope === 'entry'
              ? `只下载《${entryTitle ?? ''}》一篇，直接得到一个文件`
              : `下载「${storeName}」的全部文档，打包成一个 ZIP`}
          </p>

          <div className="mb-2 text-[12px] font-semibold text-token-primary">文件格式</div>
          <div className="space-y-1.5">
            {DOC_DOWNLOAD_FORMATS.map(opt => (
              <button key={opt.value} type="button" onClick={() => setFormat(opt.value)}
                className={`surface-row flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-colors ${format === opt.value ? 'surface-row-active' : ''}`}
                style={format === opt.value
                  ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)' }
                  : undefined}>
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full"
                  style={{
                    border: `1px solid ${format === opt.value ? 'var(--selection-border)' : 'var(--border-default)'}`,
                    background: format === opt.value ? 'var(--selection-bg)' : 'transparent',
                  }}>
                  {format === opt.value && <Check size={10} style={{ color: 'var(--selection-text)' }} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-semibold text-token-primary">{opt.label}</span>
                  <span className="block text-[11px] text-token-muted">{opt.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex flex-shrink-0 items-center justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" disabled={busy}
            onClick={() => onDownload(activeScope, format)}>
            {busy ? <MapSpinner size={12} /> : <Download size={12} />}
            {busy ? '导出中…' : '开始下载'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── 空间详情视图（文档列表 + 上传）──
function StoreDetailView({ storeId, onBack, onOpenLibrary, onOpenLegacySyncPanel, initialEntryId, initialAction, onInitialActionConsumed }: {
  storeId: string;
  onBack: () => void;
  onOpenLibrary: (storeId: string) => void;
  onOpenLegacySyncPanel: () => void;
  /** 当前深链指定的文档；首次进入及浏览器前进/后退时均需同步 */
  initialEntryId?: string;
  /** 进入时自动触发的新增动作（外层知识库列表「+」选库后带入；挂载时消费一次） */
  initialAction?: DetailInitialActionRequest;
  /** 自动动作是真正的一次性意图：开始执行即通知父层清除，不能跟着下一次知识库挂载重放。 */
  onInitialActionConsumed: (requestId: number) => void;
}) {
  const tutorialPublisher = 'llmgw-authoritative-tutorial';
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  // 移动端沉浸阅读：DocBrowser 接管了 AppShell 顶栏（文档标题 + 返回），
  // 本页店头行（库名 · 文档数 · 同步 · 分享）整行让位给正文（2026-08-10 用户确认交互）
  const readerImmersive = useReaderChromeStore((s) => !!s.override);
  const canManageTutorialGraph = useAuthStore(state => state.isRoot || state.user?.role === 'ADMIN');
  const currentUserId = useAuthStore(state => state.user?.userId ?? null);
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  /** 已被「单篇分享」的文档 id 集合（文件树标黄用） */
  const [sharedEntryIds, setSharedEntryIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(initialEntryId);
  const [tutorialGraph, setTutorialGraph] = useState<TutorialLinkGraphSnapshot | null>(null);
  const [showTutorialGraph, setShowTutorialGraph] = useState(false);
  const isTutorialGraphStore = tutorialGraph?.exists === true;
  const tutorialTitles = useMemo(() => Object.fromEntries(entries.flatMap(entry => {
    const sourceId = entry.metadata?.sourceId;
    return sourceId && entry.metadata?.publisher === tutorialPublisher ? [[sourceId, entry.title]] : [];
  })), [entries]);
  // 当前正在阅读的那一篇（目录不算）。分享与下载都以它作为「当前文章」范围的锚点，
  // 免得用户读着一篇却只能对整库操作。
  // entries 只是首页 200 条：大库里「后端搜索命中」的条目不在其中，只能靠 DocBrowser 回传的
  // 解析结果兜底，否则读着搜索结果点分享会静默回落到整库范围（Codex P1）。
  const [browserSelectedEntry, setBrowserSelectedEntry] = useState<{ id: string; title: string; isFolder?: boolean } | undefined>();
  const selectedDocEntry = useMemo(() => {
    const local = entries.find(e => e.id === selectedEntryId && !e.isFolder);
    if (local) return local;
    const fallback = browserSelectedEntry;
    return fallback && fallback.id === selectedEntryId && !fallback.isFolder ? fallback : undefined;
  }, [entries, selectedEntryId, browserSelectedEntry]);

  // 从宇宙图等外部页面跳转过来时，sessionStorage 里可能有一个 pending entry：
  // 在 entries 加载完成后消费一次（设置选中条目并清理 key，避免下次进入再次自动跳转）。
  useEffect(() => {
    if (entries.length === 0) return;
    const pending = sessionStorage.getItem('doc-store-pending-entry');
    if (!pending) return;
    if (entries.some(e => e.id === pending)) {
      setSelectedEntryId(pending);
    }
    sessionStorage.removeItem('doc-store-pending-entry');
  }, [entries]);

  // 喂 wikilink 缓存：每次 entries 变化（增删改、切库）都重灌一次，
  // 让 MarkdownViewer 悬停预览 + WikilinkAutocomplete 走的"虚链接"判定能即时拿到最新映射。
  useEffect(() => {
    setWikilinkEntries(entries.filter(e => !e.isFolder).map(e => ({
      id: e.id, title: e.title, summary: e.summary, updatedAt: e.updatedAt,
    })));
  }, [entries]);

  // 双链跳转：监听 MarkdownViewer / BacklinksPanel 派发的 wikilink:click 事件，
  // 在当前知识库的 entries 里按标题查 entryId 并切换选中。命中不到时降级为搜索关键字
  // 提示（不报错，让用户去搜索栏继续找）。
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ title?: string; entryId?: string }>;
      const directId = ce.detail?.entryId;
      if (directId && entries.some(en => en.id === directId)) {
        setSelectedEntryId(directId);
        return;
      }
      const title = (ce.detail?.title ?? '').trim();
      if (!title) return;
      const hit = entries.find(en => en.title === title);
      if (hit) {
        setSelectedEntryId(hit.id);
      }
      // 命中不到：当前 MVP 不自动跳转，未来可加 toast 或自动创建文档草稿
    };
    document.addEventListener('wikilink:click', handler);
    return () => document.removeEventListener('wikilink:click', handler);
  }, [entries]);
  // URL 深链变化或账号统计跳转时，跟随外层传入的目标文档。
  useEffect(() => {
    setSelectedEntryId(initialEntryId);
  }, [initialEntryId]);

  // 当前文档也是知识库深链的一部分。双链跳转、文件树切换和刷新都应落在同一个 store + entry。
  useEffect(() => {
    const currentDeepLink = parseDocumentStoreDeepLink(location.search);
    // store 的历史由外层 hook 维护；等它写入后再补 entry，避免 mount 时 push/replace 竞争。
    if (currentDeepLink.storeId !== storeId) return;
    const nextSearch = withDocumentStoreEntry(location.search, storeId, selectedEntryId);
    if (nextSearch === location.search) return;
    navigate({ pathname: location.pathname, search: nextSearch, hash: location.hash }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate, selectedEntryId, storeId]);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  /** 桌面端分享面板的锚点：就地悬浮在「分享」按钮下方 */
  const shareAnchorRef = useRef<HTMLSpanElement>(null);
  const [showViewers, setShowViewers] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 下载进行中（单篇直接下、整库打包 ZIP） */
  const [downloading, setDownloading] = useState(false);
  /** 下载对话框：选范围（当前文章 / 整个知识库）与格式，默认当前文章 */
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  /** 离开本详情视图后置 false：下载这类长异步流程据此中止 setState / 触发下载，避免用户已离开还弹出文件 */
  const downloadAliveRef = useRef(true);
  useEffect(() => {
    downloadAliveRef.current = true;
    return () => { downloadAliveRef.current = false; };
  }, []);
  /** 同步的「下载进行中」闸门：state 要等下次渲染才更新，连点两下会同时穿过；用 ref 同步挡住并发 */
  const downloadInFlightRef = useRef(false);
  /** 当前打开的订阅详情 entryId（null = 未打开） */
  const [subscriptionDetailId, setSubscriptionDetailId] = useState<string | null>(null);
  /** 当前打开的字幕生成 Drawer 目标 entry（null = 未打开） */
  const [subtitleTarget, setSubtitleTarget] = useState<{ id: string; title: string } | null>(null);
  // 录音转录全链路：file = 新上传录音；entryId = 已有音/视频条目。
  // vaultSessionId = 本机保险箱会话（云端归档可用后才删除，断网/崩溃可恢复，不丢数据）。
  // style = 首次转录整理方式；restyleRun = 「换个整理方式」直接进 done 态整理面板。
  const [transcribeFlow, setTranscribeFlow] = useState<{
    file?: File;
    entryId?: string;
    title: string;
    vaultSessionId?: string;
    style?: import('@/services/real/documentStore').TranscribeStyleParams;
    restyleRun?: { runId: string; outputEntryId: string };
    storeId?: string;
    /** 本次入口新建的录音，允许用户明确取消并删除；已有条目转录不显示删除。 */
    isNewRecording?: boolean;
  } | null>(null);
  // 「录音转笔记」现场录音面板（完成产出 File 后进入 transcribeFlow）
  const [showRecorder, setShowRecorder] = useState(false);
  // 上传进度（浮动进度卡：文件名 + 百分比 + 第 n / 共 m）
  const [uploadProgress, setUploadProgress] = useState<{ name: string; percent: number; index: number; total: number } | null>(null);
  // 「后台运行」看护的 SSOT。保险箱恢复与当前录音上传必须接入同一观察器，
  // 否则归档中的延迟转写会在抽屉外静默完成或失败。
  const transcribeRunRef = useRef<string | null>(null);
  const transcribeFlowOpenRef = useRef(false);
  const [bgTranscribeRunIds, setBgTranscribeRunIds] = useState<string[]>([]);
  const revealCompletedTranscribeRunsRef = useRef(new Set<string>());
  const recordingVaultByEntryIdRef = useRef(new Map<string, string>());
  const recordingRunSourceRef = useRef(new Map<string, { entryId: string; vaultSessionId?: string }>());
  // 抽屉回调存在 entry 先创建、runId 后返回的合法时序；不能只在两个值同时存在时建映射。
  const latestTranscribeSourceRef = useRef<{ entryId: string; vaultSessionId?: string } | null>(null);
  useEffect(() => {
    latestTranscribeSourceRef.current = transcribeFlow?.entryId
      ? {
          entryId: transcribeFlow.entryId,
          ...(transcribeFlow.vaultSessionId ? { vaultSessionId: transcribeFlow.vaultSessionId } : {}),
        }
      : null;
  }, [transcribeFlow?.entryId, transcribeFlow?.vaultSessionId]);
  const localRecordingPlaybackUrlsRef = useRef(new Map<string, string>());
  const localRecordingPlaybackLoadsRef = useRef(new Map<string, Promise<string | null>>());
  const resolveLocalRecordingPlaybackUrl = useCallback(async (
    entryId: string,
    serverUploadSessionId?: string,
  ): Promise<string | null> => {
    const cached = localRecordingPlaybackUrlsRef.current.get(entryId);
    if (cached) return cached;
    const running = localRecordingPlaybackLoadsRef.current.get(entryId);
    if (running) return running;
    const load = (async () => {
      let vaultSessionId = recordingVaultByEntryIdRef.current.get(entryId);
      if (!vaultSessionId && serverUploadSessionId) {
        const sessions = await vaultListSessions();
        const matched = sessions.find(session => session.serverUploadSessionId === serverUploadSessionId);
        vaultSessionId = matched?.id;
        if (vaultSessionId) recordingVaultByEntryIdRef.current.set(entryId, vaultSessionId);
      }
      if (!vaultSessionId) return null;
      const file = await vaultLoadSessionFile(vaultSessionId);
      if (!file) return null;
      const url = URL.createObjectURL(file);
      localRecordingPlaybackUrlsRef.current.set(entryId, url);
      return url;
    })().finally(() => {
      localRecordingPlaybackLoadsRef.current.delete(entryId);
    });
    localRecordingPlaybackLoadsRef.current.set(entryId, load);
    return load;
  }, []);
  useEffect(() => () => {
    for (const url of localRecordingPlaybackUrlsRef.current.values()) URL.revokeObjectURL(url);
    localRecordingPlaybackUrlsRef.current.clear();
    localRecordingPlaybackLoadsRef.current.clear();
  }, []);
  const watchBackgroundTranscription = useCallback((runId: string, revealOnComplete = false) => {
    const normalized = runId.trim();
    if (!normalized) return;
    if (revealOnComplete) revealCompletedTranscribeRunsRef.current.add(normalized);
    transcribeRunRef.current = normalized;
    setBgTranscribeRunIds(current => enqueueBackgroundTranscriptionRun(current, normalized));
  }, []);

  // 最近一次转录失败的说明（按当前选中条目）。null = 没失败过或已被新一轮覆盖。
  const [transcribeFailure, setTranscribeFailure] = useState<FailedTranscriptionNotice | null>(null);
  /**
   * 当前选中条目那条**在途**转录 run。轮询本来就把完整 run 拿到了手里，
   * 却在非终局时直接丢掉——于是「正在做什么、到哪一步了、还要多久」全屏无处可看，
   * 只剩一句没有进度的横幅。这里接住它，交给结果区渲染三阶段（设计稿 R4）。
   */
  const [activeTranscribeRun, setActiveTranscribeRun] = useState<DocumentStoreAgentRun | null>(null);
  // 在途轮询的 effect 只依赖 runId 列表（不能把选中项塞进 deps，否则每次切条目都重建定时器），
  // 所以「这条失败 run 是不是当前这篇的」得靠 ref 取当下值，闭包里的旧值会张冠李戴。
  const selectedEntryIdRef = useRef<string | undefined>(selectedEntryId);
  useEffect(() => { selectedEntryIdRef.current = selectedEntryId; }, [selectedEntryId]);

  // 刷新不能抹掉服务端正在执行的转录/整理任务。选中文档恢复后，从服务端权威 run
  // 重新接回轮询；再补一次短延迟确认，覆盖首屏请求与 worker 认领并发的窗口。
  useEffect(() => {
    const entryId = selectedEntryId?.trim();
    // 换条目先清空，否则上一条的失败说明会挂在下一条头上
    setTranscribeFailure(null);
    if (!entryId) return;
    let cancelled = false;
    let recovered = false;
    const recover = async () => {
      if (cancelled || recovered) return;
      const res = await getLatestAgentRun(entryId, 'transcribe', { ownUserOnly: true });
      if (cancelled || !res.success) return;
      // getAgentRun 只允许读取自己发起的任务；团队库里若最近一次在途 run 属于
      // 其他协作者，不能把它加入当前用户的轮询队列，否则 404 会让提示永久不消失。
      if (!currentUserId || res.data?.userId !== currentUserId) return;
      if (isStalledBackgroundTranscriptionRun(res.data)) {
        setTranscribeFailure(stalledTranscriptionNotice(
          res.data.heartbeatAt ?? res.data.startedAt ?? res.data.createdAt ?? null,
          // 排队久了不等于什么都没产出：已经生成的那几句现在就能读，稿面 cap-S10 的核心承诺
          splitPartialTranscript(res.data.transcriptText),
        ));
        return;
      }
      // 失败态在这里落地：在途 run 有下面的看护、成功 run 会长出笔记，
      // 只有失败 run 两头不沾，不接住就等于「跑过但界面装作没跑过」。
      setTranscribeFailure(describeFailedTranscription(res.data));
      const runId = recoverableBackgroundTranscriptionRunId(res.data);
      if (!runId) return;
      recovered = true;
      recordingRunSourceRef.current.set(runId, { entryId });
      watchBackgroundTranscription(runId);
    };
    void recover();
    const retryTimer = window.setTimeout(() => { void recover(); }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [currentUserId, selectedEntryId, watchBackgroundTranscription]);
  // 保险箱恢复只在进页时检查一次
  const vaultCheckedRef = useRef(false);

  // 进页检查录音保险箱：上次录音若因断网/崩溃/忘关没有完成上传，提示恢复并转录（不丢数据）
  useEffect(() => {
    if (vaultCheckedRef.current) return;
    vaultCheckedRef.current = true;
    void (async () => {
      const all = await vaultListSessions();
      // 普通本地会话超过七天清理；服务端已接管的会话必须保留保险文件，
      // 直到确认同一幂等会话完成或明确退回未接管状态。
      const now = Date.now();
      for (const s of all.filter(s => !s.serverUploadSessionId && now - s.startedAt > 7 * 24 * 3600 * 1000)) {
        void vaultDeleteSession(s.id);
      }
      const currentStoreSessions = all.filter(
        s => s.storeId === storeId
          && (Boolean(s.serverUploadSessionId) || now - s.startedAt <= 7 * 24 * 3600 * 1000),
      );
      const sessions = [] as typeof currentStoreSessions;
      for (const session of currentStoreSessions) {
        if (!session.serverUploadSessionId) {
          sessions.push(session);
          continue;
        }

        const status = await getRecordingUpload(session.serverUploadSessionId).catch(() => null);
        let completion = null as Awaited<ReturnType<typeof completeRecordingUpload>> | null;
        if (shouldRetryVaultServerCompletion(status)) {
          completion = await completeRecordingUpload(session.serverUploadSessionId).catch(() => null);
        }
        const decision = decideVaultServerRecovery(status, completion);
        if (decision === 'completed' && completion?.success) {
          const deferredRunId = deferredRunIdForRecoveredVaultCompletion(completion);
          if (completion.data.entry.metadata?.audioArchiveStatus === 'pending') {
            recordingVaultByEntryIdRef.current.set(completion.data.entry.id, session.id);
          }
          if (deferredRunId) {
            recordingRunSourceRef.current.set(deferredRunId, {
              entryId: completion.data.entry.id,
              vaultSessionId: session.id,
            });
            watchBackgroundTranscription(deferredRunId);
          }
          setEntries(prev => [
            completion.data.entry,
            ...prev.filter(item => item.id !== completion.data.entry.id),
          ]);
          if (completion.data.archivePending !== true) await vaultDeleteSession(session.id);
          toast.success(
            '后台录音已完成',
            deferredRunId
              ? '录音已恢复，转录笔记仍在后台生成'
              : '已恢复服务端接管的同一条录音',
          );
          continue;
        }
        if (decision === 'keep-protected') continue;

        // 服务端明确未持有可恢复结果后，才解除保护并允许本地整文件恢复。
        await vaultClearServerCompletion(session.id);
        const recoverable = { ...session };
        delete recoverable.serverUploadSessionId;
        sessions.push(recoverable);
      }
      if (sessions.length === 0) return;
      const latest = sessions[0];
      const d = new Date(latest.startedAt);
      const p = (n: number) => String(n).padStart(2, '0');
      const when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      const sizeMb = Math.max(0.1, latest.bytes / 1024 / 1024).toFixed(1);
      const ok = await systemDialog.confirm({
        title: '发现未完成的录音',
        message: `上次有一段录音（${when} 开始，约 ${sizeMb}MB）没有完成上传。要恢复并转录成笔记吗？`,
        confirmText: '恢复并转录',
        cancelText: '丢弃',
      });
      if (ok) {
        const file = await vaultLoadSessionFile(latest.id);
        if (file) {
          setTranscribeFlow({ file, title: file.name, vaultSessionId: latest.id, isNewRecording: true });
          transcribeFlowOpenRef.current = true;
        }
        // 本库更老的滞留会话一并清理，只恢复最新一段（避免弹窗轰炸）
        for (const s of sessions.slice(1)) void vaultDeleteSession(s.id);
      } else {
        for (const s of sessions) void vaultDeleteSession(s.id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 当前打开的智能体抽屉目标：可绑定文档，也可作为知识库工具会话打开。 */
  const [reprocessTarget, setReprocessTarget] = useState<{
    id?: string;
    title: string;
    mode?: 'document' | 'short-video';
    initialInput?: string;
  } | null>(null);
  /** 当前打开的「单篇文档分享」目标（null = 未打开） */
  const [docShareTarget, setDocShareTarget] = useState<{ id: string; title: string } | null>(null);
  /** 新建后需要自动进入编辑态的文档 id（用一次即清） */
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | undefined>(undefined);
  /** 统一同步面板（本库范围）：方向 + 自动 + 对齐 + 记录，全部在这一个面板里 */
  const [showSyncCenter, setShowSyncCenter] = useState(false);
  /** 本库是否有进行中的同步（轮询运行台账得出，驱动「同步」按钮动起来） */
  const [syncActive, setSyncActive] = useState(false);
  /** 顶栏「更多」下拉 */
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // 「更多」下拉用 AnchoredMenu（自带 portal 到 body + 按 anchorRef 定位 + 点外关闭），
  // 不再手写 createPortal/morePos（PageHeader overflow-hidden 会裁原地 absolute）。
  const toggleMore = useCallback(() => setMoreOpen((o) => !o), []);

  // 文件上传状态
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 替换文件：记录待替换的 entryId + 独立 file input
  const replaceTargetRef = useRef<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  // 上传录音转笔记：独立 audio input（选中即进入转录全链路卡）
  const audioInputRef = useRef<HTMLInputElement>(null);
  const audioUploadStoreRef = useRef(storeId);
  // tag 颜色保存的 single-flight 队列：
  // 不只是防 rollback race，还要保证"老请求成功后到达"不会覆盖新意图。
  // 实现：当前在飞 = inFlight=true；新意图来了写 pending；当前结束后若 pending 非空则继续发，
  // 总是把最后一个意图作为终态推到服务器（latest-write-wins）。
  const tagColorInFlightRef = useRef(false);
  const tagColorPendingRef = useRef<Record<string, import('@/lib/tagPalette').TagColorKey> | null>(null);

  // 加载空间详情和条目
  const loadStore = useCallback(async () => {
    const res = await getDocumentStore(storeId);
    if (res.success) setStore(res.data);
  }, [storeId]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentEntries(storeId, 1, 200);
    if (res.success) {
      setEntries(res.data.items);
      setSharedEntryIds(new Set(res.data.sharedEntryIds ?? []));
    }
    setLoading(false);
  }, [storeId]);

  const pendingRecordingArchiveSignature = useMemo(
    () => entries
      .filter(entry => (entry.contentType ?? '').toLowerCase().startsWith('audio/')
        && entry.metadata?.audioArchiveStatus === 'pending')
      .map(entry => entry.id)
      .sort()
      .join('|'),
    [entries],
  );
  const notifiedRecordingArchivesRef = useRef(new Set<string>());

  const applyPolledEntries = useCallback((nextEntries: DocumentEntry[]) => {
    setEntries(previous => {
      if (previous.length !== nextEntries.length) return nextEntries;
      const unchanged = previous.every((entry, index) => {
        const next = nextEntries[index];
        return entry.id === next?.id
          && entry.updatedAt === next.updatedAt
          && entry.title === next.title
          && entry.metadata?.audioArchiveStatus === next.metadata?.audioArchiveStatus
          && entry.metadata?.audioArchiveNeedsRetry === next.metadata?.audioArchiveNeedsRetry
          && entry.metadata?.liveTranscript === next.metadata?.liveTranscript;
      });
      return unchanged ? previous : nextEntries;
    });
  }, []);

  // 待归档录音不能只留一张静态“后台处理中”卡片。只要本库仍有 pending 录音，
  // 就静默刷新条目；归档完成后 updatedAt 改变会驱动 DocBrowser 重拉正式音频，
  // 当前页面原地更新，不要求用户手动刷新或猜测后台是否结束。
  useEffect(() => {
    if (!pendingRecordingArchiveSignature) return;
    const pendingIds = new Set(pendingRecordingArchiveSignature.split('|').filter(Boolean));
    let cancelled = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const res = await listDocumentEntries(storeId, 1, 200);
        if (cancelled || !res.success) return;
        let nextEntries = res.data.items;
        const selectedPending = nextEntries.find(entry => (
          entry.id === selectedEntryId
          && entry.metadata?.audioArchiveStatus === 'pending'
          && Boolean(entry.metadata?.recordingUploadSessionId)
        ));
        if (selectedPending?.metadata?.recordingUploadSessionId) {
          const status = await getRecordingUpload(
            selectedPending.metadata.recordingUploadSessionId,
            4_000,
          ).catch(() => null);
          if (!cancelled && status?.success && status.data.archiveStatus !== 'completed') {
            const needsRetry = Boolean(status.data.archiveError);
            nextEntries = nextEntries.map(entry => entry.id === selectedPending.id
              ? {
                  ...entry,
                  metadata: {
                    ...entry.metadata,
                    audioArchiveNeedsRetry: needsRetry ? 'true' : 'false',
                    audioArchiveAttempts: String(status.data.archiveAttempts),
                  },
                }
              : entry);
          }
        }
        if (cancelled) return;
        const completed = nextEntries.filter(entry => (
          pendingIds.has(entry.id) && entry.metadata?.audioArchiveStatus !== 'pending'
        ));
        applyPolledEntries(nextEntries);
        setSharedEntryIds(new Set(res.data.sharedEntryIds ?? []));
        for (const entry of completed) {
          const vaultSessionId = recordingVaultByEntryIdRef.current.get(entry.id);
          if (vaultSessionId) {
            recordingVaultByEntryIdRef.current.delete(entry.id);
            void vaultDeleteSession(vaultSessionId);
          }
          if (notifiedRecordingArchivesRef.current.has(entry.id)) continue;
          notifiedRecordingArchivesRef.current.add(entry.id);
          toast.success('云端副本已保存', '当前页面已自动切换正式音频，原文跟随可继续使用');
        }
      } finally {
        checking = false;
      }
    };
    const first = window.setTimeout(() => { void check(); }, 2500);
    const timer = window.setInterval(() => { void check(); }, 6000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [applyPolledEntries, pendingRecordingArchiveSignature, selectedEntryId, storeId]);

  // 轮询本库运行台账：有 syncing 记录时让顶栏「同步」按钮动起来（含对端推来的 incoming）。
  // 4s 一刷足够即时；无任务时也保持 4s（payload 很小），关页自动停。
  useEffect(() => {
    let alive = true;
    let seq = 0; // 发号器：只应用「最新一发」的结果，防慢响应覆盖快响应（学习规则：轮询需 stale-response 守卫）
    const check = async () => {
      const my = ++seq;
      const res = await listPeerSyncRuns('document-store', storeId);
      if (alive && my === seq && res.success && res.data) {
        // 仅把「近 30 分钟内开始的 syncing 运行」算作进行中：崩溃残留的 syncing 运行（超过租约 TTL）
        // 视为陈旧，不让按钮永久脉冲（与后端租约 TTL 同口径，Bugbot）。
        const freshMs = 30 * 60 * 1000;
        const now = Date.now();
        setSyncActive((res.data.items || []).some(r =>
          r.status === 'syncing' && now - new Date(r.startedAt).getTime() < freshMs));
      }
    };
    void check();
    const t = window.setInterval(check, 4000);
    return () => { alive = false; window.clearInterval(t); };
  }, [storeId]);

  // 「更多」下拉点外关闭由 AnchoredMenu 自身处理（菜单已 portal 到 body，
  // 不能再用 document.mousedown 在 click 落到菜单项前就关掉）

  // 文档列表排序：服务端持久化（换设备 / 重登录 / 刷新都保持）。store.defaultSortMode 为 SSOT。
  const handleChangeSort = useCallback(async (mode: DocBrowserSortMode) => {
    let prevMode: string | undefined;
    setStore(prev => { prevMode = prev?.defaultSortMode; return prev ? { ...prev, defaultSortMode: mode } : prev; }); // 乐观更新 + 捕获回滚值
    const res = await updateDocumentStore(storeId, { defaultSortMode: mode });
    if (!res.success) {
      setStore(prev => prev ? { ...prev, defaultSortMode: prevMode } : prev); // 失败回滚，避免侧栏排序与服务端不一致
      toast.error('保存排序失败', res.error?.message);
    }
  }, [storeId]);

  useEffect(() => {
    loadStore();
    loadEntries();
  }, [loadStore, loadEntries]);

  useEffect(() => {
    if (!canManageTutorialGraph) {
      setTutorialGraph(null);
      return;
    }
    setTutorialGraph(null);
    let alive = true;
    void getTutorialLinkGraph(storeId).then(result => {
      if (alive && result.success) setTutorialGraph(result.data);
    });
    return () => { alive = false; };
  }, [canManageTutorialGraph, storeId]);

  useEffect(() => {
    if (!canManageTutorialGraph || !isTutorialGraphStore) return;
    let alive = true;
    void (async () => {
      const pageSize = 500;
      const authoritative: DocumentEntry[] = [];
      let page = 1;
      let total = Infinity;
      while (authoritative.length < total) {
        const result = await listDocumentEntries(storeId, page, pageSize);
        if (!alive || !result.success || !result.data) return;
        authoritative.push(...result.data.items.filter(entry => entry.metadata?.publisher === tutorialPublisher));
        total = result.data.total ?? 0;
        if (page * pageSize >= total || result.data.items.length === 0) break;
        page += 1;
      }
      if (!alive) return;
      setEntries(current => {
        const merged = new Map(current.map(entry => [entry.id, entry]));
        authoritative.forEach(entry => merged.set(entry.id, entry));
        return [...merged.values()];
      });
    })();
    return () => { alive = false; };
  }, [canManageTutorialGraph, isTutorialGraphStore, storeId]);

  useEffect(() => {
    if (!canManageTutorialGraph || !isTutorialGraphStore || new URLSearchParams(location.search).get('tutorialLinks') !== '1') return;
    setShowTutorialGraph(true);
    const params = new URLSearchParams(location.search);
    params.delete('tutorialLinks');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
  }, [canManageTutorialGraph, isTutorialGraphStore, location.pathname, location.search, navigate]);

  const openTutorialSource = useCallback((sourceId: string) => {
    const entry = entries.find(item => item.metadata?.publisher === tutorialPublisher && item.metadata?.sourceId === sourceId);
    if (!entry) {
      toast.error('教程不存在', `没有找到 sourceId 为 ${sourceId} 的已发布教程`);
      return;
    }
    setShowTutorialGraph(false);
    setSelectedEntryId(entry.id);
  }, [entries]);

  const openGatewayRoute = useCallback(async (route: string) => {
    const ticket = await createLlmGatewaySsoTicket();
    if (!ticket.success) {
      toast.error('无法打开 LLM Gateway', ticket.error?.message ?? '当前账号没有管理员跳转权限');
      return;
    }
    // 落点由服务端按平台已发布入口表下发；前端不再自己按 hostname 拼域名。
    const resolution = resolveLlmGatewaySso(ticket.data.code, ticket.data.console, route);
    if (!resolution.ok) {
      toast.error('无法打开 LLM Gateway', resolution.message);
      return;
    }
    const target = resolution.href;
    window.location.assign(target);
  }, []);

  // ── 文档再加工：页面级任务中枢（关抽屉 / 刷新都不丢） ──
  const dismissRun = useReprocessRunStore((s) => s.dismissRun);
  // 只订阅一个【不含 streamedText】的签名串：状态/阶段/进度(取整)/标题等。
  // 这样 SSE 文本 chunk（最高频、只改 streamedText）不会触发本页 + 整棵文件树重渲染，
  // 仅在进度等真实变化时才更新（Bugbot 性能报告）。打字内容由抽屉自身订阅渲染。
  const reprocessSig = useReprocessRunStore((s) =>
    Object.values(s.runs)
      .filter((r) => r.storeId === storeId)
      .map((r) => `${r.runId}|${r.status}|${r.phase}|${Math.round(r.progress)}|${r.sourceEntryId}|${r.sourceTitle}|${r.outputEntryId ?? ''}`)
      .sort()
      .join('~~'),
  );
  // 本知识库下的所有再加工任务（pill 渲染用）——按签名记忆，引用稳定
  const storeRuns = useMemo(
    () => Object.values(useReprocessRunStore.getState().runs)
      .filter((r) => r.storeId === storeId)
      .sort((a, b) => b.startedAt - a.startedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reprocessSig, storeId],
  );
  // 源文档 → 进度（文件树 chip 用）
  const reprocessingMap = useMemo(
    () => selectStreamingByEntry(useReprocessRunStore.getState().runs, storeId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reprocessSig, storeId],
  );

  // 写回成功时刷新文件树 + 在 mode='new' 时选中新条目
  const handleReprocessApplied = useCallback((mode: 'replace' | 'append' | 'new', targetEntryId: string) => {
    void loadEntries();
    if (mode === 'new') setSelectedEntryId(targetEntryId);
    setTimeout(() => { void loadEntries(); }, 1500);
  }, [loadEntries]);

  // 「后台运行」看护：轮询在途转录 run 到终态 → 刷新列表 + toast 告知结果
  const backgroundRunPollFailuresRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (bgTranscribeRunIds.length === 0) return;
    let cancelled = false;
    const handledRunIds = new Set<string>();
    const poll = async () => {
      for (const runId of bgTranscribeRunIds) {
        if (handledRunIds.has(runId)) continue;
        const res = await getAgentRun(runId);
        if (cancelled) continue;
        let latestRun: Awaited<ReturnType<typeof getLatestAgentRun>>['data'] = null;
        let latestLookupSucceeded = false;
        // 直接按 runId 读取可能因团队库发起人不同或短暂路由错误失败；不能因此让
        // “后台处理中”永久留在页面。用源 entry 的服务端最新 run 做同 ID 交叉确认。
        const source = recordingRunSourceRef.current.get(runId);
        // 即使旧 run 仍可直查到 running，也要对照同条目的最新 own run；共享 Mongo
        // 允许不同部署各建任务，旧 owner 下线后旧 run 可能永远不变终态。
        if (source) {
          const latest = await getLatestAgentRun(
            source.entryId,
            'transcribe',
            { ownUserOnly: true },
          );
          latestLookupSucceeded = latest.success;
          latestRun = latest.success ? latest.data : null;
        }
        const failureCount = res.success
          ? 0
          : (backgroundRunPollFailuresRef.current.get(runId) ?? 0) + 1;
        const decision = decideBackgroundRunLookup({
          runId,
          directRun: res.success ? res.data : null,
          directErrorCode: res.success ? null : res.error.code,
          latestEntryRun: latestRun,
          latestLookupSucceeded,
          consecutiveFailures: failureCount,
        });
        if (decision.kind === 'keep-watching') {
          backgroundRunPollFailuresRef.current.set(runId, failureCount);
          continue;
        }
        backgroundRunPollFailuresRef.current.delete(runId);
        if (decision.kind === 'retire-watcher') {
          handledRunIds.add(runId);
          const recordingSource = recordingRunSourceRef.current.get(runId);
          recordingRunSourceRef.current.delete(runId);
          revealCompletedTranscribeRunsRef.current.delete(runId);
          setBgTranscribeRunIds(current => current.filter(id => id !== runId));
          if (transcribeRunRef.current === runId) transcribeRunRef.current = null;
          /*
           * 停止看护也要把这条 run 从进度位上摘掉。留着的话状态卡照旧按「处理中」渲染，
           * 进度条冻在最后一个百分比，而下面刚刚 setTranscribeFailure 出来的失败卡与重试
           * 按钮被它压住不显示——界面上是一条永远走不完的进度，用户连重试的入口都看不见
           * （终态那一路早就摘了，退役这一路漏了，Codex 第十九轮 P1）。
           */
          setActiveTranscribeRun(current => (current?.id === runId ? null : current));

          const replacementRunId = recoverableBackgroundTranscriptionRunId(decision.replacementRun);
          if (replacementRunId && recordingSource) {
            recordingRunSourceRef.current.set(replacementRunId, recordingSource);
            watchBackgroundTranscription(replacementRunId);
          } else if (decision.replacementRun?.status === 'failed'
              && recordingSource?.entryId === selectedEntryIdRef.current) {
            setTranscribeFailure(describeFailedTranscription(decision.replacementRun));
          }

          if (decision.reason === 'access-lost') {
            toast.error('录音状态看护已停止', '登录状态或访问权限已变化，请刷新页面后重试');
          } else if (decision.reason === 'lookup-unavailable') {
            toast.error('暂时无法确认录音状态', '已停止持续等待；录音仍保留，请刷新页面或点击重试');
          } else if (decision.reason === 'stalled-run') {
            if (recordingSource?.entryId === selectedEntryIdRef.current) {
              const staleRun = decision.replacementRun ?? (res.success ? res.data : latestRun);
              setTranscribeFailure(stalledTranscriptionNotice(
                staleRun?.heartbeatAt ?? staleRun?.startedAt ?? staleRun?.createdAt ?? null,
                splitPartialTranscript(staleRun?.transcriptText),
              ));
            }
            toast.error('录音任务超过一小时未报告状态', '已停止等待旧任务；录音仍保留，可以点击重试');
          }
          void loadEntries();
          continue;
        }
        const observedRun = decision.run;
        const st = observedRun.status;
        if (st !== 'done' && st !== 'failed' && st !== 'cancelled') {
          // 在途：只有「这条 run 正是当前这一屏的录音」才往界面上放，
          // 否则会把别的录音的进度画到用户正看着的这条上（同屏多录音时的串台）。
          if (observedRun.sourceEntryId === selectedEntryIdRef.current) {
            setActiveTranscribeRun(observedRun);
          }
          continue;
        }
        // 走到终局：这条 run 不该再占着进度条
        setActiveTranscribeRun(current => (current?.id === runId ? null : current));
        handledRunIds.add(runId);
        const recordingSource = recordingRunSourceRef.current.get(runId);
        recordingRunSourceRef.current.delete(runId);
        // 只有转录真正完成才证明云端归档已经可供后续消费。失败或取消时继续保留
        // 本地保险音频，避免后台任务失败反而让用户失去唯一可播放副本。
        if (recordingSource && st === 'done') {
          recordingVaultByEntryIdRef.current.delete(recordingSource.entryId);
          if (recordingSource.vaultSessionId) void vaultDeleteSession(recordingSource.vaultSessionId);
        }
        setBgTranscribeRunIds(current => current.filter(id => id !== runId));
        if (transcribeRunRef.current === runId) transcribeRunRef.current = null;
        void loadEntries();
        if (st === 'done') {
          const shouldReveal = revealCompletedTranscribeRunsRef.current.delete(runId);
          if (shouldReveal && observedRun.outputEntryId) {
            setSelectedEntryId(observedRun.outputEntryId);
            toast.success('录音转录完成', '已打开录音原文');
          } else {
            toast.success('录音转录完成', '录音原文已保存');
          }
        } else if (st === 'failed') {
          revealCompletedTranscribeRunsRef.current.delete(runId);
          toast.error('录音转录失败', (observedRun.errorMessage ?? '').split('\n')[0] || '请重试');
          // 失败说明也要落到常驻的失败卡上，不能只弹一条会自己消失的 toast。
          // 只有 toast 的话，它消失之后页面又变回「跑过但装作没跑过」——正是这张卡要治的病；
          // 原先只有「重新选中条目 / 刷新页面」那条恢复路径才会填这个 state。
          if (observedRun.sourceEntryId && observedRun.sourceEntryId === selectedEntryIdRef.current) {
            setTranscribeFailure(describeFailedTranscription(observedRun));
          }
        }
      }
    };
    const stopPolling = startSerialBackgroundPoller(poll, 5000);
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgTranscribeRunIds]);

  // 文件上传处理
  const handleFiles = useCallback(async (files: File[]) => {
    // 前端预检 20MB 上限：超限文件即时报错，不进入上传白等
    const oversized = files.filter(f => f.size > MAX_UPLOAD_BYTES);
    for (const f of oversized) {
      toast.error(`文件过大: ${f.name}`, `单文件上限 20MB（该文件 ${(f.size / 1024 / 1024).toFixed(1)}MB）`);
    }
    const accepted = files.filter(f => f.size <= MAX_UPLOAD_BYTES);
    if (accepted.length === 0) return;

    setUploading(true);
    let successCount = 0;
    let firstUploadedId: string | null = null;
    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i];
      setUploadProgress({ name: file.name, percent: 0, index: i + 1, total: accepted.length });
      const res = await uploadDocumentFileWithProgress(storeId, file, (percent) => {
        setUploadProgress({ name: file.name, percent, index: i + 1, total: accepted.length });
      });
      if (res.success) {
        setEntries(prev => [res.data.entry, ...prev]);
        firstUploadedId ??= res.data.entry.id;
        successCount++;
      } else {
        toast.error(`上传失败: ${file.name}`, res.error?.message);
      }
    }
    setUploadProgress(null);
    if (successCount > 0) {
      toast.success(`上传完成`, `${successCount} 个文件已存储`);
      // 上传成功自动跳转到刚上传的文档（多文件跳第一个），不让用户自己去列表里找
      if (firstUploadedId) setSelectedEntryId(firstUploadedId);
    }
    setUploading(false);
  }, [storeId]);

  // 替换文件：右键菜单触发 → 打开文件选择器，记录目标 entryId
  const handleReplaceFile = useCallback((entryId: string) => {
    replaceTargetRef.current = entryId;
    replaceInputRef.current?.click();
  }, []);

  const doReplaceFile = useCallback(async (file: File) => {
    const entryId = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (!entryId) return;
    setUploading(true);
    const res = await replaceDocumentFile(entryId, file);
    if (res.success) {
      // 注入 res.data.entry（含更新后的 updatedAt），DocBrowser 内容缓存键
      // 以 entryId+updatedAt 组合为版本，updatedAt 变化即自动重载新正文，
      // 无需 undefined→id 的 setTimeout hack
      setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...res.data.entry } : e));
      toast.success('替换成功', '文档内容已更新，标签与位置保留');
    } else {
      toast.error('替换失败', res.error?.message);
    }
    setUploading(false);
  }, []);

  // 仅响应外部文件拖入（排除内部条目拖拽，避免误触发上传遮罩）
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
  }, [handleFiles]);

  // 设置主文档：根级条目设为 store 主文档，文件夹内条目设为该文件夹主文档
  const handleSetPrimary = useCallback(async (entryId: string) => {
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    if (entry.parentId) {
      // 文件夹内条目：设为文件夹的主子项
      const res = await setFolderPrimaryChild(entry.parentId, entryId);
      if (res.success) {
        // 更新本地 entries 中父文件夹的 metadata
        setEntries(prev => prev.map(e =>
          e.id === entry.parentId
            ? { ...e, metadata: { ...(e.metadata ?? {}), primaryChildId: entryId } }
            : e));
        toast.success('已设为此文件夹的主文档');
      } else {
        toast.error('设置失败', res.error?.message);
      }
    } else {
      // 根级条目：设为 store 主文档
      const res = await setPrimaryEntry(storeId, entryId);
      if (res.success) {
        setStore(prev => prev ? { ...prev, primaryEntryId: entryId } : prev);
        toast.success('已设为主文档');
      }
    }
  }, [storeId, entries]);

  const handleTogglePin = useCallback(async (entryId: string, pin: boolean) => {
    const res = await togglePinnedEntry(storeId, entryId, pin);
    if (res.success) {
      setStore(prev => prev ? { ...prev, pinnedEntryIds: res.data.pinnedEntryIds } : prev);
      toast.success(pin ? '已置顶' : '已取消置顶');
    }
  }, [storeId]);

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    const res = await deleteDocumentEntry(entryId);
    if (res.success) {
      setEntries(prev => prev.filter(e => e.id !== entryId));
      if (selectedEntryId === entryId) setSelectedEntryId(undefined);
      toast.success('已删除');
    } else {
      toast.error('删除失败', res.error?.message);
    }
  }, [selectedEntryId]);

  const handleUpdateEntryTags = useCallback(async (entryId: string, tags: string[]) => {
    const res = await updateDocumentEntry(entryId, { tags });
    if (res.success) {
      setEntries(prev => prev.map(entry => entry.id === entryId ? { ...entry, ...res.data, tags: res.data.tags ?? tags } : entry));
      toast.success(tags.length > 0 ? '标签已更新' : '标签已清空');
      return;
    }
    toast.error('标签更新失败', res.error?.message);
    throw new Error(res.error?.message ?? '标签更新失败');
  }, []);

  const handleRenameEntry = useCallback(async (entryId: string, newTitle: string) => {
    const res = await updateDocumentEntry(entryId, { title: newTitle });
    if (res.success) {
      setEntries(prev => prev.map(entry => entry.id === entryId
        ? { ...entry, ...res.data, title: res.data.title ?? newTitle }
        : entry));
      toast.success('已重命名');
      return;
    }
    toast.error('重命名失败', res.error?.message);
    throw new Error(res.error?.message ?? '重命名失败');
  }, []);

  const handleMoveEntry = useCallback(async (entryId: string, targetFolderId: string | null) => {
    const res = await moveDocumentEntry(entryId, targetFolderId);
    if (res.success) {
      setEntries(prev => prev.map(e =>
        e.id === entryId ? { ...e, parentId: targetFolderId ?? undefined } : e));
      toast.success('已移动');
    } else {
      toast.error('移动失败', res.error?.message);
    }
  }, []);

  // 拖拽自定义排序：乐观更新本地 SortOrder（行立即移动到新位置，变化可感知），
  // 逐条 PUT 落库（后端纯排序写入不 bump UpdatedAt，不会误点亮 NEW / 打乱「最近更新」）。
  const handleReorderEntries = useCallback(async (updates: { entryId: string; sortOrder: number }[]) => {
    setEntries(prev => prev.map(e => {
      const u = updates.find(x => x.entryId === e.id);
      return u ? { ...e, sortOrder: u.sortOrder } : e;
    }));
    const results = await Promise.all(
      updates.map(u => updateDocumentEntry(u.entryId, { sortOrder: u.sortOrder })),
    );
    if (results.some(r => !r.success)) {
      toast.error('保存自定义顺序失败', '已恢复为服务器上的顺序');
      void loadEntries();
    }
  }, [loadEntries]);

  const handleSaveContent = useCallback(async (entryId: string, newContent: string) => {
    const res = await updateDocumentContent(entryId, newContent);
    if (res.success) {
      // 更新本地 entries 中的 summary（前 200 字）
      const summary = newContent.length > 200 ? newContent.slice(0, 200) : newContent;
      setEntries(prev => prev.map(e =>
        e.id === entryId ? {
          ...e,
          summary: summary.trim(),
          updatedAt: res.data.updatedAt ?? e.updatedAt,
          updatedBy: res.data.updatedBy ?? e.updatedBy,
          updatedByName: res.data.updatedByName ?? e.updatedByName,
        } : e));
      toast.success('已保存');
      // 返回服务端最新 updatedAt：DocBrowser 用它推进 loadedContentKey，短路掉保存后的内容重拉
      return { updatedAt: res.data.updatedAt };
    } else {
      toast.error('保存失败', res.error?.message);
      throw new Error(res.error?.message ?? '保存失败');
    }
  }, []);

  // 版本控制接口：透传给 DocBrowser → VersionHistoryModal
  const versionApi = useMemo(() => ({
    list: (entryId: string, page: number, pageSize: number) => listEntryVersions(entryId, page, pageSize),
    get: (entryId: string, versionId: string) => getEntryVersion(entryId, versionId),
    restore: (entryId: string, versionId: string) => restoreEntryVersion(entryId, versionId),
  }), []);

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    const res = await getDocumentContent(entryId);
    const entry = entriesRef.current.find(item => item.id === entryId);
    const isPendingAudio = Boolean(
      entry
      && (entry.contentType ?? '').toLowerCase().startsWith('audio/')
      && entry.metadata?.audioArchiveStatus === 'pending',
    );
    const localFileUrl = isPendingAudio
      ? await resolveLocalRecordingPlaybackUrl(entryId, entry?.metadata?.recordingUploadSessionId)
      : null;
    if (!res.success) {
      return localFileUrl && entry
        ? { text: null, fileUrl: localFileUrl, contentType: entry.contentType }
        : null;
    }
    return {
      text: res.data.hasContent ? res.data.content : null,
      fileUrl: res.data.fileUrl || localFileUrl,
      contentType: res.data.contentType,
    };
  }, [resolveLocalRecordingPlaybackUrl]);

  const handleCreateFolder = useCallback(async (name: string) => {
    const res = await createFolder(storeId, name);
    if (res.success) {
      setEntries(prev => [res.data, ...prev]);
      toast.success('文件夹已创建');
    } else {
      toast.error('创建失败', res.error?.message);
    }
  }, [storeId]);

  const handleCreateDocument = useCallback(async () => {
    // 直接创建一个空白文档，后续支持在 Edit 模式中填充
    const res = await addDocumentEntry(storeId, {
      title: '新建文档',
      sourceType: 'upload',
      contentType: 'text/markdown',
      summary: '',
    });
    if (res.success) {
      setEntries(prev => [res.data, ...prev]);
      setSelectedEntryId(res.data.id);
      // 新建文档默认直接进入编辑态，省去用户再点一次「编辑」
      setAutoEditEntryId(res.data.id);
      toast.success('已创建文档，开始写作吧');
    } else {
      toast.error('创建失败', res.error?.message);
    }
  }, [storeId]);

  const handleOpenVideoParser = useCallback(() => {
    setReprocessTarget({
      title: '短视频解析',
      mode: 'short-video',
    });
  }, []);

  // 外层列表「+」选库进入后自动触发对应新增动作（消费一次；与库内 FAB 出一样的结果）
  const initialActionConsumedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!initialAction || initialActionConsumedRef.current === initialAction.id || !store || loading) return;
    initialActionConsumedRef.current = initialAction.id;
    onInitialActionConsumed(initialAction.id);
    if (initialAction.action === 'doc') void handleCreateDocument();
    else if (initialAction.action === 'record') setShowRecorder(true);
    else if (initialAction.action === 'upload') fileInputRef.current?.click();
    else if (initialAction.action === 'video') handleOpenVideoParser();
  }, [initialAction, store, loading, handleCreateDocument, handleOpenVideoParser, onInitialActionConsumed]);

  const handleSearch = useCallback(async (keyword: string, contentSearch: boolean): Promise<DocBrowserEntry[] | null> => {
    // 启用内容搜索时，先触发一次 ContentIndex 回填（后端对已有 ContentIndex 的条目会跳过）
    if (contentSearch) {
      await rebuildContentIndex(storeId);
    }
    const res = await searchDocumentEntries(storeId, keyword, contentSearch);
    if (res.success) return res.data.items;
    return null;
  }, [storeId]);

  // 切换发布到智识殿堂
  const handleTogglePublish = useCallback(async () => {
    if (!store) return;
    setPublishing(true);
    const newVal = !store.isPublic;
    const res = await updateDocumentStore(storeId, { isPublic: newVal });
    if (res.success) {
      setStore(prev => prev ? { ...prev, isPublic: newVal } : prev);
      toast.success(
        newVal ? '已发布到智识殿堂' : '已取消发布',
        newVal ? '其他用户现在可以浏览你的知识库了' : '知识库已设为私有',
      );
    } else {
      toast.error('操作失败', res.error?.message);
    }
    setPublishing(false);
  }, [store, storeId]);

  // 下载：范围（当前这篇 / 整个知识库）+ 格式由用户在对话框里选，默认「当前这篇」。
  // 单篇 → 直接落一个文件（不再逼人为了一篇文章下载整库 ZIP）；整库 → 分页拉全量后打包 ZIP。
  // 禁止空白等待：按钮转圈 + toast 报进度，失败计数照实报。
  const handleDownload = useCallback(async (scope: DocDownloadScope, format: DocDownloadFormat) => {
    // 同步闸门挡并发：连点两下时 downloading state 还没刷新，靠 ref 立刻拒绝第二次进入
    if (!store || downloadInFlightRef.current) return;
    if (scope === 'entry' && !selectedDocEntry) return;
    downloadInFlightRef.current = true;
    setShowDownloadDialog(false);
    setMoreOpen(false);
    setDownloading(true);
    // 文件名安全化 + 去重（同名加序号），保留可读标题
    const usedNames = new Set<string>();
    const safeName = (title: string, ext: string) => {
      const base = (title || '未命名').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名';
      let name = `${base}${ext}`;
      let i = 2;
      while (usedNames.has(name)) name = `${base} (${i++})${ext}`;
      usedNames.add(name);
      return name;
    };
    const saveFile = (data: Blob, filename: string) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(data);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    };
    try {
      // ── 单篇：一次内容请求 + 一个文件，没有打包环节 ──
      if (scope === 'entry') {
        const target = selectedDocEntry!;
        toast.info('正在准备下载…', `正在导出《${target.title}》`);
        const file = await buildEntryDownload(target, format, safeName);
        if (!downloadAliveRef.current) return; // 已离开视图：不再触发用户没预期的文件下载
        if (!file) {
          toast.error('下载失败', '这篇文档没有可导出的内容（正文为空，或原始文件取不到）');
          return;
        }
        saveFile(
          file.data instanceof Blob ? file.data : new Blob([file.data], { type: 'text/plain;charset=utf-8' }),
          file.name);
        toast.success('下载完成', file.name);
        return;
      }

      // ── 整库：分页拉全量条目（loadEntries 只取首页 200，大库会漏；这里按 total 翻页拉齐）──
      toast.info('正在准备下载…', '正在汇总知识库全部文档');
      const PAGE = 200;
      const allEntries: DocumentEntry[] = [];
      let page = 1;
      let total = Infinity;
      while (allEntries.length < total) {
        const res = await listDocumentEntries(storeId, page, PAGE);
        if (!downloadAliveRef.current) return; // 已离开视图：中止，不弹文件不改状态
        // 任意一页拉取失败都必须硬失败，禁止静默打包「缺了后几页」的残缺 ZIP
        if (!res.success || !res.data) {
          toast.error('下载失败', '获取文档列表时出错，请重试（已避免导出不完整的文件）');
          return;
        }
        allEntries.push(...res.data.items);
        total = res.data.total ?? allEntries.length;
        if (allEntries.length >= total) break; // 已拉齐
        if (res.data.items.length === 0) {
          // 没拉齐却返回空页 = 服务端分页不一致：宁可报错，也不打包「以为是全量」的残缺 ZIP
          toast.error('下载失败', '文档列表未能完整加载，请重试（已避免导出不完整的文件）');
          return;
        }
        page++;
      }
      const docs = allEntries.filter(e => !e.isFolder);
      if (docs.length === 0) {
        toast.warning('没有可下载的文档', '当前知识库还没有任何文档条目');
        return;
      }
      toast.info('正在打包文档…', `共 ${docs.length} 篇，正在逐篇导出`);

      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      let ok = 0;
      let fail = 0;
      for (const entry of docs) {
        if (!downloadAliveRef.current) return; // 已离开视图：中止逐篇拉取
        try {
          const file = await buildEntryDownload(entry, format, safeName);
          if (!file) { fail++; continue; }
          zip.file(file.name, file.data);
          ok++;
        } catch {
          fail++;
        }
      }
      if (ok === 0) {
        toast.error('下载失败', '所有文档均未能导出（可能正文为空或网络受限）');
        return;
      }
      const out = await zip.generateAsync({ type: 'blob' });
      if (!downloadAliveRef.current) return; // 已离开视图：不再触发用户没预期的文件下载
      saveFile(out, `${(store.name || '知识库').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
      toast.success('下载完成', `已打包 ${ok} 篇${fail > 0 ? `（${fail} 篇导出失败）` : ''}`);
    } catch (err) {
      console.error('[DocumentStore] download failed:', err);
      if (downloadAliveRef.current) toast.error('下载失败', '导出文档时出错，请重试');
    } finally {
      downloadInFlightRef.current = false;
      if (downloadAliveRef.current) setDownloading(false);
    }
  }, [store, storeId, selectedDocEntry]);

  if (!store) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ minHeight: 'calc(100vh - 160px)' }}>
        <MapSpinner size={16} />
      </div>
    );
  }

  // 同步进行中：以「近期 syncing 运行记录」为准（syncActive）。
  // 不再叠加 store.peerSyncStatus==='syncing'——后端 IsDue 已不用该字段判在途，
  // 崩溃残留的 syncing 会让按钮永久脉冲（Bugbot: Stale syncing status pins UI）。
  const syncBusy = syncActive;
  // 「同步」按钮文案即状态：同步中 > 需要处理 > 已同步·对端 > 同步（还没建立关系）。
  // 「已建立」= 真正成功同步过一次（status=synced）。失败(error)/取消(cancelled)/未同步都算未建立，
  // 顶栏只显示「同步」，不显示「已同步·对端」（Codex P2：取消的首次同步不应显示为 synced）。
  const syncEstablished = !syncBusy && store.peerSyncStatus === 'synced'
    && ['push', 'pull', 'both', 'align-remote', 'align-local', 'align-both'].includes(store.peerSyncDirection ?? '');
  const syncButtonLabel = syncBusy ? (isMobile ? '同步中' : '同步中…')
    : store.peerSyncStatus === 'error' ? '需要处理'
      : syncEstablished ? (isMobile || !store.peerSyncNodeName ? '已同步' : `已同步 · ${store.peerSyncNodeName}`)
        : '同步';
  const syncButtonTitle = syncEstablished
    ? `同步面板：与「${store.peerSyncNodeName ?? '对端'}」的同步关系、立即同步、自动同步与记录`
    : '同步面板：选择方向（发送 / 拉回 / 双向）建立与对端节点的同步关系';
  const backgroundTranscriptionBanner = describeBackgroundTranscriptionBanner({
    selectedEntryId,
    selectedHasFailure: Boolean(transcribeFailure),
    currentRunHasInlineCard: Boolean(activeTranscribeRun),
    runs: bgTranscribeRunIds.map((runId) => {
      const source = recordingRunSourceRef.current.get(runId);
      return {
        entryId: source?.entryId,
        title: source ? entries.find((entry) => entry.id === source.entryId)?.title : null,
      };
    }),
  });

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden"
      onDragEnter={handleDragEnter} onDragLeave={handleDragLeave}
      onDragOver={handleDragOver} onDrop={handleDrop}>
      <input ref={fileInputRef} type="file" className="hidden" accept={ACCEPT_TYPES} multiple
        onChange={e => { const f = Array.from(e.target.files ?? []); if (f.length) handleFiles(f); e.target.value = ''; }} />
      <input ref={replaceInputRef} type="file" className="hidden" accept={ACCEPT_TYPES}
        onChange={e => { const f = e.target.files?.[0]; if (f) doReplaceFile(f); e.target.value = ''; }} />
      <input ref={audioInputRef} type="file" className="hidden" accept="audio/*"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) {
            setTranscribeFlow({ file: f, title: f.name, storeId: audioUploadStoreRef.current, isNewRecording: true });
            transcribeFlowOpenRef.current = true;
          }
          e.target.value = '';
        }} />

      {!(isMobile && readerImmersive) && (
      <TabBar
        title={
          <div className="flex items-center gap-2">
            <button onClick={onBack}
              className="hover-bg-soft cursor-pointer rounded-[8px] px-2 py-1 text-[12px] text-token-muted transition-colors duration-200">
              <ArrowLeft size={14} />
            </button>
            {!isMobile && <Library size={14} className="text-token-muted" />}
            <span className="text-[13px] font-semibold text-token-primary">{store.name}</span>
            <span className="text-[11px] text-token-muted tabular-nums">
              <CountUp to={entries.filter(e => e.sourceType !== 'github_directory').length} from={0} duration={0.8} /> 个文档
            </span>
            {/* refreshKey 含各 entry 的 updatedAt：编辑/恢复/替换会 bump updatedAt 但条目数不变，
                只用 length 会让大小数字停留在旧值；带上 updatedAt 串内容变化即刷新（Codex P2）。 */}
            {!isMobile && <StoreSizeBadge storeId={store.id} refreshKey={`${entries.length}:${entries.map(e => e.updatedAt ?? '').join('|')}`} />}
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* 统一同步入口（唯一）：文案即状态——同步中 / 需要处理 / 已同步·对端 / 同步（未建立）。
                原「发送到」按钮已合并进面板：发送只是方向为 push 的同步，不再独立成门面。 */}
            <button
              onClick={() => setShowSyncCenter(true)}
              className={`surface-action flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] px-3 text-[11px] font-semibold transition-all ${syncBusy ? 'animate-pulse' : ''}`}
              style={syncBusy
                ? { color: 'rgba(252,211,77,0.98)', background: 'rgba(245,158,11,0.14)', boxShadow: 'inset 0 0 0 1px rgba(245,158,11,0.42)' }
                : store.peerSyncStatus === 'error'
                  ? { color: 'var(--accent-fg-danger)', background: 'rgba(239,68,68,0.10)', boxShadow: 'inset 0 0 0 1px rgba(239,68,68,0.30)' }
                  : syncEstablished
                    ? { color: 'var(--accent-fg-blue)', background: 'rgba(20,184,166,0.10)', boxShadow: 'inset 0 0 0 1px rgba(45,212,191,0.30)' }
                    : undefined}
              title={syncButtonTitle}
            >
              {syncBusy ? <MapSpinner size={11} /> : <ArrowLeftRight size={11} />}
              {syncButtonLabel}
            </button>
            {/* 旧版同步链接徽章：仅当本库已加入同步配对时显示，点击进入隐藏兼容管理面板。 */}
            {!isMobile && <StoreSyncBadge
              storeId={store.id}
              onManage={onOpenLegacySyncPanel}
            />}
            {canManageTutorialGraph && isTutorialGraphStore && tutorialGraph && (
              <button
                type="button"
                onClick={() => setShowTutorialGraph(true)}
                className="surface-action flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-[11px] font-semibold text-token-primary"
                title="查看页面、教程步骤和验收证据的双向关系"
              >
                <Network size={13} /><span className={isMobile ? 'sr-only' : ''}>教程关系</span>
              </button>
            )}
            <span ref={shareAnchorRef} className="inline-flex">
              <Button variant="secondary" size="xs" onClick={() => setShowShareDialog(v => !v)}>
                <Share2 size={13} /> 分享
              </Button>
            </span>
            {/* 顶栏「上传文档」按钮已下线：库内「新增」收敛为右下角调色盘 FAB（唯一入口）。
                上传中的状态提示保留在此处，避免用户点完 FAB 上传后失去反馈。 */}
            {uploading && (
              <span className="flex h-7 items-center gap-1.5 rounded-[8px] px-3 text-[11px] font-semibold"
                style={{ color: 'var(--accent-fg-blue)', background: 'rgba(59,130,246,0.12)' }}>
                <MapSpinner size={12} /> 上传中
              </span>
            )}
            {/* 知识星球：3D 文档星系直达入口（此前藏在「宇宙图」里，新用户找不到）。
                保留原始 orbit icon 语义，叠加胶囊背景光扫与 icon 轻动效。 */}
            {!isMobile && <button
              type="button"
              onClick={() => navigate(`/document-store/${storeId}/galaxy`)}
              title="知识星球 — 3D 文档星系，悬停看简介、点击进入文档"
              className="galaxy-entry-button relative isolate flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden rounded-[8px] px-3 text-[11px] font-semibold"
              style={{
                color: 'var(--semantic-purple-text)',
                background: 'var(--semantic-purple-soft)',
                border: '1px solid var(--semantic-purple-border)',
                animation: 'galaxyEntryPulse 2.4s ease-in-out infinite',
              }}
            >
              <span className="galaxy-entry-icon" aria-hidden="true">
                <span className="galaxy-entry-spark galaxy-entry-spark-a" />
                <span className="galaxy-entry-spark galaxy-entry-spark-b" />
                <svg className="galaxy-entry-orbit" viewBox="0 0 24 24" focusable="false">
                  <circle className="galaxy-entry-core" cx="12" cy="12" r="2.35" />
                  <path className="galaxy-entry-orbit-path" d="M7.6 16.4a6.2 6.2 0 0 1 0-8.8" />
                  <path className="galaxy-entry-orbit-path" d="M16.4 7.6a6.2 6.2 0 0 1 0 8.8" />
                  <path className="galaxy-entry-orbit-path" d="M4.2 19.8a11 11 0 0 1 0-15.6" />
                  <path className="galaxy-entry-orbit-path" d="M19.8 4.2a11 11 0 0 1 0 15.6" />
                </svg>
              </span>
              <span className="relative z-[1]">知识星球</span>
              <style>{`
                @keyframes galaxyEntryPulse {
                  0%, 100% { box-shadow: 0 0 0 0 rgba(168,85,247,0); }
                  50% { box-shadow: 0 0 0 3px rgba(168,85,247,0.14); }
                }

                @keyframes galaxyEntrySweep {
                  0% { transform: translateX(-125%); opacity: 0; }
                  14% { opacity: 0.82; }
                  52% { transform: translateX(118%); opacity: 0.54; }
                  70%, 100% { transform: translateX(118%); opacity: 0; }
                }

                @keyframes galaxyEntryIconLift {
                  0%, 100% { transform: translateY(0) rotate(0deg) scale(1); filter: drop-shadow(0 0 0 rgba(196,181,253,0)); }
                  34% { transform: translateY(-1px) rotate(10deg) scale(1.06); filter: drop-shadow(0 0 8px rgba(196,181,253,0.5)); }
                  58% { transform: translateY(0) rotate(-4deg) scale(0.99); filter: drop-shadow(0 0 2px rgba(196,181,253,0.22)); }
                }

                @keyframes galaxyEntryOrbitFlow {
                  0% { stroke-dashoffset: 30; opacity: 0.72; }
                  38% { stroke-dashoffset: 0; opacity: 1; }
                  100% { stroke-dashoffset: -36; opacity: 0.72; }
                }

                @keyframes galaxyEntryCorePulse {
                  0%, 100% { transform: scale(0.92); opacity: 0.74; }
                  38% { transform: scale(1.16); opacity: 1; }
                  62% { transform: scale(1); opacity: 0.88; }
                }

                @keyframes galaxyEntrySparkPop {
                  0%, 100% { opacity: 0; transform: translate3d(0, 2px, 0) scale(0.6); }
                  32% { opacity: 0.9; }
                  60% { opacity: 0.35; transform: translate3d(2px, -1px, 0) scale(1); }
                }

                .galaxy-entry-icon {
                  position: relative;
                  z-index: 1;
                  width: 16px;
                  height: 16px;
                  display: inline-grid;
                  flex: 0 0 16px;
                  place-items: center;
                  overflow: visible;
                }

                .galaxy-entry-button::before {
                  content: '';
                  position: absolute;
                  inset: -2px;
                  z-index: 0;
                  background: linear-gradient(
                    105deg,
                    transparent 0%,
                    transparent 30%,
                    rgba(255,255,255,0.16) 42%,
                    rgba(196,181,253,0.32) 50%,
                    rgba(255,255,255,0.13) 58%,
                    transparent 70%,
                    transparent 100%
                  );
                  transform: translateX(-125%);
                  animation: galaxyEntrySweep 3s cubic-bezier(0.22, 1, 0.36, 1) infinite;
                  pointer-events: none;
                }

                .galaxy-entry-orbit {
                  width: 15px;
                  height: 15px;
                  overflow: visible;
                  color: rgba(196,181,253,0.98);
                  animation: galaxyEntryIconLift 3s cubic-bezier(0.22, 1, 0.36, 1) infinite;
                  transform-origin: 50% 50%;
                }

                .galaxy-entry-orbit-path {
                  fill: none;
                  stroke: currentColor;
                  stroke-linecap: round;
                  stroke-linejoin: round;
                  stroke-width: 2;
                  stroke-dasharray: 18 24;
                  animation: galaxyEntryOrbitFlow 3s ease-in-out infinite;
                }

                .galaxy-entry-core {
                  fill: currentColor;
                  transform-box: fill-box;
                  transform-origin: center;
                  animation: galaxyEntryCorePulse 3s ease-in-out infinite;
                }

                .galaxy-entry-spark {
                  position: absolute;
                  z-index: 0;
                  width: 2px;
                  height: 2px;
                  border-radius: 999px;
                  background: rgba(255,255,255,0.92);
                  box-shadow: 0 0 6px rgba(196,181,253,0.82);
                  opacity: 0;
                  animation: galaxyEntrySparkPop 3s ease-in-out infinite;
                }

                .galaxy-entry-spark-a {
                  left: 0;
                  top: 1px;
                  animation-delay: 0.1s;
                }

                .galaxy-entry-spark-b {
                  right: 0;
                  bottom: 2px;
                  animation-delay: 0.42s;
                }
              `}</style>
            </button>}
            {/* 更多：收纳低频管理动作（发布 / 关系图谱 / 统计 / 订阅），折叠屏只占一个位 */}
            <div className="relative" ref={moreRef}>
              <Button variant="secondary" size="xs" onClick={toggleMore} title="更多操作">
                <MoreHorizontal size={14} /> {!isMobile && '更多'}
              </Button>
              {/* createPortal 到 body：PageHeader 是 overflow-hidden 圆角玻璃条，绝对定位下拉会被裁掉。见 AnchoredMenu / frontend-modal.md */}
              <AnchoredMenu open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} minWidth={200}>
                {store.isPublic ? (
                  <>
                    <MoreItem icon={<ArrowUpRight size={14} />} label="前往公开页" onClick={() => { setMoreOpen(false); onOpenLibrary(store.id); }} />
                    <MoreItem icon={<GlobeLock size={14} />} label={publishing ? '处理中…' : '取消发布'} disabled={publishing} onClick={handleTogglePublish} />
                  </>
                ) : (
                  <MoreItem icon={<Globe size={14} />} label={publishing ? '处理中…' : '发布到智识殿堂'} disabled={publishing} onClick={handleTogglePublish} dataTourId="document-store-publish" />
                )}
                <MoreItem icon={<Download size={14} />} label={downloading ? '导出中…' : '下载文档…'} disabled={downloading}
                  onClick={() => { setMoreOpen(false); setShowDownloadDialog(true); }} />
                <MoreItem icon={<LinkIcon size={14} />} label="Obsidian 双链图" onClick={() => { setMoreOpen(false); navigate(`/document-store/${storeId}/universe`); }} />
                <MoreItem icon={<Orbit size={14} />} label="知识星球（3D 星系）" onClick={() => { setMoreOpen(false); navigate(`/document-store/${storeId}/galaxy`); }} />
                <MoreItem icon={<BarChart3 size={14} />} label="访客统计" onClick={() => { setMoreOpen(false); setShowViewers(true); }} />
                <MoreItem icon={<Rss size={14} />} label="添加订阅" onClick={() => { setMoreOpen(false); setShowSubscribe(true); }} />
              </AnchoredMenu>
            </div>
          </div>
        }
      />
      )}

      {/* 全局拖拽遮罩 */}
      {dragging && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
          style={{ background: 'rgba(59,130,246,0.05)', border: '3px dashed rgba(59,130,246,0.3)' }}>
          <div className="text-center">
            <Upload size={32} style={{ color: 'rgba(59,130,246,0.6)', margin: '0 auto 8px' }} />
            <p className="text-[14px] font-semibold" style={{ color: 'var(--accent-fg-blue)' }}>释放文件到此处上传</p>
          </div>
        </div>
      )}

      {/* 左右分栏文档浏览器 —— 与上方 TabBar 左右边缘对齐（不再额外 px-5 内缩，
          消除左上角空白竖条）；仅留 pt-3 作为与标题栏的视觉间距 */}
      <div className="flex-1 min-h-0 flex flex-col pt-3">
        {backgroundTranscriptionBanner && !transcribeFlow && (
          <div
            role="status"
            aria-live="polite"
            className="mx-3 mb-3 flex shrink-0 items-start gap-3 rounded-[14px] px-4 py-3"
            style={{ background: 'var(--semantic-info-bg)', border: '1px solid var(--semantic-info-border)' }}>
            <div className="mt-0.5 shrink-0"><MapSpinner size={16} /></div>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-token-primary">
                {backgroundTranscriptionBanner.title}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
                {backgroundTranscriptionBanner.detail}
              </p>
            </div>
          </div>
        )}
        <DocBrowser
          entries={entries}
          immersiveOnMobile
          // 移动端沉浸阅读时店头行隐藏——空间信息与「分享」收进阅读区「更多」菜单（2026-08-10 demo 确认）
          readerMenuExtra={isMobile ? (
            <>
              <div
                className="px-2.5 pt-1 pb-2 mb-1 text-[11px] truncate"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-faint)' }}
                title={store.name}
              >
                {store.name} · {entries.filter(e => e.sourceType !== 'github_directory').length} 个文档
              </div>
              <button
                type="button"
                onClick={() => setShowShareDialog(true)}
                className="hover-bg-soft flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12px] text-token-secondary transition-colors"
              >
                <Share2 size={13} className="flex-shrink-0 text-token-muted" />
                <span className="truncate">分享</span>
              </button>
            </>
          ) : undefined}
          tagColors={(store.tagColors ?? {}) as Record<string, import('@/lib/tagPalette').TagColorKey>}
          onTagColorsChange={(next) => {
            // 乐观更新本地立刻反映；服务器保存走 single-flight 队列。
            // 用 ref 队列保证：1) 同一时刻最多 1 个 PUT 在飞 2) 队列末尾永远是最新意图
            // → 老请求即使成功也不会覆盖新意图（服务器最终一致到 latest）。
            setStore(s => s ? { ...s, tagColors: next } : s);
            tagColorPendingRef.current = next;
            if (tagColorInFlightRef.current) return;
            (async () => {
              tagColorInFlightRef.current = true;
              try {
                while (tagColorPendingRef.current) {
                  const payload = tagColorPendingRef.current;
                  tagColorPendingRef.current = null;
                  const res = await updateDocumentStore(storeId, { tagColors: payload });
                  // 失败时仅当没有更新的 pending 时才提示，避免 toast 风暴
                  if (!res.success && !tagColorPendingRef.current) {
                    toast.error('保存 tag 颜色失败', res.error?.message);
                    // 失败不主动 rollback UI：再次失败 + 没有 pending = 用户最后意图未落库，
                    // 下次刷新会从服务器拉到真实状态自动纠正
                  }
                }
              } finally {
                tagColorInFlightRef.current = false;
              }
            })();
          }}
          /* 验收库以时间为主线（哪天验收的是关键信息），保留时间默认显示；普通知识库默认不显示，
             需要的人去「筛选」面板打开（2026-07-31 用户：有了时间可见区域就少很多）。 */
          showUpdatedTimeDefault={store.templateKey === ACCEPTANCE_TEMPLATE_KEY}
          /* 排序：持久化偏好为 SSOT；未设置时所有知识库统一按创建时间倒序，新内容在最前。
             用户明确选择“书籍顺序”后仍返回 default，并跨设备持久化。 */
          sortMode={resolveDocBrowserSortMode(store.defaultSortMode)}
          sidebarFilters={
            <DocSortControl
              value={resolveDocBrowserSortMode(store.defaultSortMode)}
              onChange={handleChangeSort}
            />
          }
          primaryEntryId={store.primaryEntryId}
          pinnedEntryIds={store.pinnedEntryIds ?? []}
          selectedEntryId={selectedEntryId}
          onSelectEntry={setSelectedEntryId}
          onSelectedEntryChange={setBrowserSelectedEntry}
          onBackToList={() => setSelectedEntryId(undefined)}
          onSetPrimary={handleSetPrimary}
          onTogglePin={handleTogglePin}
          onDeleteEntry={handleDeleteEntry}
          onUpdateEntryTags={handleUpdateEntryTags}
          onRenameEntry={handleRenameEntry}
          onMoveEntry={handleMoveEntry}
          onReorderEntries={handleReorderEntries}
          onSaveContent={handleSaveContent}
          versionApi={versionApi}
          onEntryContentRestored={(entryId, updatedAt) => {
            setEntries(prev => prev.map(e => e.id === entryId ? { ...e, updatedAt } : e));
          }}
          enableSelectionAi
          loadContent={loadContent}
          onCreateFolder={handleCreateFolder}
          onCreateDocument={handleCreateDocument}
          onUploadFile={() => fileInputRef.current?.click()}
          onOpenVideoParser={handleOpenVideoParser}
          onSearch={handleSearch}
          onOpenSubscription={(id) => setSubscriptionDetailId(id)}
          onGenerateSubtitle={(id) => {
            const entry = entries.find(e => e.id === id);
            if (entry) setSubtitleTarget({ id, title: entry.title });
          }}
          transcribeFailure={transcribeFailure}
          /*
           * 「别把 A 的进度画到 B 头上」这件事在**渲染期**判，不在 state 里清
           * （Codex P1 给的两条修法里的第二条）。清 state 那条走不通：换条目时先清、
           * 再由 recover 异步接回来，中间这张卡会卸载一次又挂回来——录音刚结束那一屏
           * 因此闪一下，发布门禁抓到的正是这一下（元素 detach + 首个可用结果超时）。
           * 判据只认「这条 run 的源条目就是选中的这条」，不满足就不画，state 留着无害。
           */
          transcribeRun={activeTranscribeRun && activeTranscribeRun.sourceEntryId === selectedEntryId ? {
            ...activeTranscribeRun,
            // 后端在写入阶段才把原文落到 transcriptText；有几句给几句，
            // 一句都没有时状态卡自己渲染骨架，不在这里造句
            transcriptPreview: (activeTranscribeRun.transcriptText ?? '')
              .split('\n')
              .map(line => line.trim())
              .filter(Boolean)
              .slice(0, 3),
            // 「原文 N 句」数整篇，不数上面这三句预览
            transcriptSentenceCount: countTranscriptSentences(activeTranscribeRun.transcriptText),
          } : null}
          onTranscribe={(id, styleKey) => {
            const entry = entries.find(e => e.id === id);
            if (entry) {
              // 重试即当作新一轮，先撤掉上一轮的失败说明，别让旧原因压在新进度上
              setTranscribeFailure(null);
              setTranscribeFlow({ entryId: id, title: entry.title, style: styleKey ? { styleKey } : undefined });
              transcribeFlowOpenRef.current = true;
            }
          }}
          onOpenRecordingResult={(audioEntryId) => {
            /*
             * 原文还在跑的时候，这一下该去的是**处理页**，不是结果页：稿面 v2-R4 /
             * cap-A4/A5 画的就是那一屏（三阶段 + 音频卡 + 屏底「进入结果页并开始播放」），
             * 而结果页在这一刻只有一份空原文。此前这条路由建好、登记好、却没有任何地方
             * 走进去——用户只能靠手敲 URL 到达（predicate-and-wiring-discipline 形状 2：
             * 建了一半的接线，删掉也不会红）。
             */
            const inflight = activeTranscribeRun
              && activeTranscribeRun.sourceEntryId === audioEntryId
              && activeTranscribeRun.status !== 'done'
              && activeTranscribeRun.status !== 'failed'
              && activeTranscribeRun.status !== 'cancelled';
            if (inflight) {
              navigate(`/document-store/${storeId}/recording/${audioEntryId}/processing`);
              return;
            }
            // 设计稿这一下是「进入结果页并开始播放」：跳转与起播是同一个动作。
            // play=1 交给结果页在挂载后发一次播放请求——起播必须发生在那一屏，
            // 在这里先播会造成「声音已经在响、画面还在旧页」。
            navigate(`/document-store/${storeId}/recording/${audioEntryId}?play=1`);
          }}
          onRestyleTranscribe={(id) => {
            const entry = entries.find(e => e.id === id);
            if (!entry) return;
            // 免重跑 ASR：取该音频最近一次「已完成且有产物」的转录 run（过滤掉失败的
            // restyle run，否则一次失败后整理面板永远打不开，Codex P2），直接进 done 态整理面板
            void getLatestAgentRun(id, 'transcribe', { status: 'done', requireOutput: true }).then((res) => {
              const run = res.success ? res.data : null;
              if (run && run.status === 'done' && run.outputEntryId) {
                setTranscribeFlow({
                  entryId: id,
                  title: entry.title,
                  restyleRun: { runId: run.id, outputEntryId: run.outputEntryId },
                });
                transcribeFlowOpenRef.current = true;
              } else {
                toast.error('暂不能重新整理', '没有找到已完成的转录记录，请先完成一次转录');
              }
            });
          }}
          onUploadAudio={() => setShowRecorder(true)}
          onQuickRecord={() => navigate('/document-store?quickRecord=1')}
          onReprocess={(id) => {
            const entry = entries.find(e => e.id === id);
            if (entry) setReprocessTarget({ id, title: entry.title });
          }}
          onAskRecording={(id) => {
            const entry = entries.find(e => e.id === id);
            if (!entry) return;
            setReprocessTarget({
              id,
              title: entry.title,
              initialInput: '请基于整场录音回答我的问题。先给简明结论，再引用支持结论的原文时间段；有多处依据时分别列出，不要编造录音中没有的信息。我的问题是：',
            });
          }}
          onShareEntry={(id) => {
            const entry = entries.find(e => e.id === id);
            if (entry) setDocShareTarget({ id, title: entry.title });
          }}
          autoEditEntryId={autoEditEntryId}
          onAutoEditConsumed={() => setAutoEditEntryId(undefined)}
          onReplaceFile={handleReplaceFile}
          reprocessingMap={reprocessingMap}
          sharedEntryIds={sharedEntryIds}
          loading={loading}
          emptyState={
            <div className="flex-1 flex items-center justify-center">
              <DocEmptyState
                onCreateDocument={handleCreateDocument}
                onUploadFile={() => fileInputRef.current?.click()}
                onAddSubscription={() => setShowSubscribe(true)}
              />
            </div>
          }
          contentFooter={(entryId) => {
            const entry = entries.find(item => item.id === entryId);
            return (
              <>
                {canManageTutorialGraph && <TutorialLinkedPages sourceId={entry?.metadata?.sourceId} snapshot={tutorialGraph} onOpenRoute={openGatewayRoute} />}
                <BacklinksPanel entryId={entryId} onJumpToEntry={(id) => setSelectedEntryId(id)} />
              </>
            );
          }}
          autocompleteStoreId={storeId}
        />
        <WikilinkHoverCard />
      </div>

      {/* 统一同步面板（本库）：状态 + 立即同步 + 方向/自动关系设定 + 强制对齐 + 记录 */}
      {showSyncCenter && (
        <SyncCenterDialog
          storeId={store.id}
          storeName={store.name}
          autoEnabled={store.peerSyncAutoEnabled}
          autoIntervalMinutes={store.peerSyncIntervalMinutes}
          autoMode={store.peerSyncAutoMode}
          peerSyncDirection={store.peerSyncDirection}
          peerNodeId={store.peerSyncNodeId}
          peerNodeName={store.peerSyncNodeName}
          onClose={() => setShowSyncCenter(false)}
          onAfterSync={() => { void loadStore(); void loadEntries(); }}
        />
      )}
      {canManageTutorialGraph && showTutorialGraph && tutorialGraph && (
        <TutorialLinkGraphDrawer
          storeId={storeId}
          snapshot={tutorialGraph}
          tutorialTitles={tutorialTitles}
          onClose={() => setShowTutorialGraph(false)}
          onSnapshotChange={setTutorialGraph}
          onOpenTutorial={openTutorialSource}
          onOpenProductRoute={openGatewayRoute}
        />
      )}

      {/* 添加订阅对话框 */}
      {showSubscribe && (
        <SubscribeDialog
          storeId={storeId}
          onClose={() => setShowSubscribe(false)}
          onCreated={(entry) => { setShowSubscribe(false); setEntries(prev => [entry, ...prev]); }}
        />
      )}

      {/* 分享对话框：把「当前正在读的这篇」一并带进去，用户不必回文件树右键才能单篇分享 */}
      {showShareDialog && (
        <ShareDialog
          storeId={storeId}
          storeName={store.name}
          isPublic={store.isPublic}
          currentEntryId={selectedDocEntry?.id}
          currentEntryTitle={selectedDocEntry?.title}
          anchorRef={shareAnchorRef}
          onClose={() => setShowShareDialog(false)}
        />
      )}

      {/* 下载对话框：范围（当前文章 / 整个知识库）+ 文件格式 */}
      {showDownloadDialog && (
        <DownloadDialog
          storeName={store.name}
          entryTitle={selectedDocEntry?.title}
          busy={downloading}
          onDownload={handleDownload}
          onClose={() => setShowDownloadDialog(false)}
        />
      )}

      {/* 单篇文档分享对话框（来自文件树右键「分享」） */}
      {docShareTarget && (
        <ShareDialog
          storeId={storeId}
          storeName={store.name}
          isPublic={store.isPublic}
          entryId={docShareTarget.id}
          entryTitle={docShareTarget.title}
          onClose={() => setDocShareTarget(null)}
        />
      )}

      {/* 订阅详情抽屉 */}
      {subscriptionDetailId && (
        <SubscriptionDetailDrawer
          entryId={subscriptionDetailId}
          onClose={() => setSubscriptionDetailId(null)}
          onChanged={() => loadEntries()}
        />
      )}

      {/* 字幕生成抽屉 — 用 AnimatePresence 包裹，让 motion exit 动画能播放 */}
      <AnimatePresence>
        {subtitleTarget && (
          <SubtitleGenerationDrawer
            entryId={subtitleTarget.id}
            entryTitle={subtitleTarget.title}
            onClose={() => setSubtitleTarget(null)}
            onDone={(newId) => {
              // 立即刷一次拿到刚 insert 的新 entry
              void loadEntries();
              setSelectedEntryId(newId);
              // 1.5s 后再兜底刷一次：兼容 DB 副本同步延迟 / 后端进度状态稍后才稳定的情况
              setTimeout(() => { void loadEntries(); }, 1500);
            }}
          />
        )}
      </AnimatePresence>

      {/* 「录音转笔记」现场录音：MediaRecorder 录音 → 产出 File → 进入下方转录全链路；
          无权限/不支持/已有文件时兜底走 audioInputRef 文件选择 */}
      <AnimatePresence>
        {showRecorder && (
          <RecordAudioSheet
            storeId={storeId}
            storeName={store.name}
            onClose={() => setShowRecorder(false)}
            onComplete={(file, vaultSessionId, targetStoreId) => {
              setShowRecorder(false);
              setTranscribeFlow({ file, title: file.name, vaultSessionId, storeId: targetStoreId || storeId, isNewRecording: true });
              transcribeFlowOpenRef.current = true;
            }}
            onUploaded={(entry, vaultSessionId, targetStoreId, deferredTranscriptionRunId) => {
              const destination = targetStoreId || storeId;
              const archivePending = entry.metadata?.audioArchiveStatus === 'pending';
              const liveTranscriptReady = entry.metadata?.liveTranscriptStatus === 'completed'
                && Boolean(entry.metadata?.liveTranscript?.trim());
              const followUp = decideUploadedRecordingFollowUp(
                archivePending,
                liveTranscriptReady,
                deferredTranscriptionRunId,
              );
              setShowRecorder(false);
              recordingVaultByEntryIdRef.current.set(entry.id, vaultSessionId);
              if (destination === storeId) {
                setEntries(prev => [entry, ...prev.filter(item => item.id !== entry.id)]);
                setSelectedEntryId(entry.id);
              } else {
                navigate({ pathname: '/document-store', search: withDocumentStoreEntry('', destination, entry.id) });
              }
              if (!archivePending) {
                recordingVaultByEntryIdRef.current.delete(entry.id);
                void vaultDeleteSession(vaultSessionId);
              }
              if (archivePending) {
                toast.info(
                  '录音已安全保存',
                  liveTranscriptReady
                    ? '实时原文已保存，音频正在后台补充云端归档'
                    : '音频已进入耐久队列，云端恢复后将自动归档并转录',
                );
              }
              if (followUp.kind === 'watch-deferred-run') {
                recordingRunSourceRef.current.set(followUp.runId, { entryId: entry.id, vaultSessionId });
                if (!archivePending) {
                  toast.info(
                    '录音已安全保存',
                    '完整音频正在后台转录，完成后会通知你',
                  );
                }
                watchBackgroundTranscription(followUp.runId, true);
                return;
              }
              if (followUp.kind === 'wait-for-archive') return;
              setTranscribeFlow({
                entryId: entry.id,
                title: entry.title,
                vaultSessionId,
                storeId: destination,
                isNewRecording: true,
              });
              transcribeFlowOpenRef.current = true;
            }}
            onServerCompletionDeferred={() => {
              setShowRecorder(false);
              toast.info(
                '录音已转入后台确认',
                '前台等待已结束，本地保险文件仍保留；下次进入会优先恢复同一服务端会话',
              );
              setTimeout(() => { void loadEntries(); }, 5000);
              setTimeout(() => { void loadEntries(); }, 15000);
            }}
            onPickFile={(targetStoreId) => {
              setShowRecorder(false);
              audioUploadStoreRef.current = targetStoreId || storeId;
              audioInputRef.current?.click();
            }}
          />
        )}
      </AnimatePresence>

      {/* 录音转录全链路：上传音频 → 可编辑原文 → 默认保存；整理仅在用户主动选择后执行 */}
      <AnimatePresence>
        {transcribeFlow && (
          <TranscribeFlowDrawer
            storeId={transcribeFlow.storeId || storeId}
            file={transcribeFlow.file}
            entryId={transcribeFlow.entryId}
            entryTitle={transcribeFlow.title}
            initialStyle={transcribeFlow.style}
            restyleRun={transcribeFlow.restyleRun}
            folders={(transcribeFlow.storeId || storeId) === storeId
              ? entries.filter(e => e.isFolder).map(f => ({ id: f.id, title: f.title }))
              : undefined}
            onMoveNote={(transcribeFlow.storeId || storeId) === storeId ? async (noteId, folderId) => {
              const res = await moveDocumentEntry(noteId, folderId);
              if (!res.success) {
                toast.error('归档失败', res.error?.message);
                throw new Error(res.error?.message ?? 'move failed');
              }
              setEntries(prev => prev.map(e => e.id === noteId ? { ...e, parentId: folderId ?? undefined } : e));
            } : undefined}
            onClose={() => {
              setTranscribeFlow(null);
              transcribeFlowOpenRef.current = false;
              // 「后台运行」：run 仍在途 → 页面接手看护（轮询到终态刷新列表）
              if (transcribeRunRef.current) {
                const runId = transcribeRunRef.current;
                const source = latestTranscribeSourceRef.current;
                bindBackgroundTranscriptionSource(recordingRunSourceRef.current, runId, source);
                watchBackgroundTranscription(runId);
              }
            }}
            onEntryCreated={(entry) => {
              if ((transcribeFlow.storeId || storeId) === storeId) setEntries(prev => [entry, ...prev]);
              const source = {
                entryId: entry.id,
                ...(transcribeFlow?.vaultSessionId ? { vaultSessionId: transcribeFlow.vaultSessionId } : {}),
              };
              latestTranscribeSourceRef.current = source;
              if (transcribeRunRef.current) {
                bindBackgroundTranscriptionSource(
                  recordingRunSourceRef.current,
                  transcribeRunRef.current,
                  source,
                );
              }
              // 录音已成功上传到服务端 → 本机保险箱使命完成，清除该会话
              if (transcribeFlow?.vaultSessionId) void vaultDeleteSession(transcribeFlow.vaultSessionId);
            }}
            onEditNote={(noteId) => {
              setSelectedEntryId(noteId);
              setAutoEditEntryId(noteId);
            }}
            onDone={(entryId) => {
              // 转录结果原地写回源音频：始终停留在同一个文档，不跳到新建笔记。
              const targetStoreId = transcribeFlow.storeId || storeId;
              if (targetStoreId === storeId) {
                setSelectedEntryId(entryId);
                void loadEntries();
                setTimeout(() => { void loadEntries(); }, 1500);
              } else {
                navigate({ pathname: '/document-store', search: withDocumentStoreEntry('', targetStoreId, entryId) });
              }
            }}
            onOpenEntry={(id) => setSelectedEntryId(id)}
            onRunTracking={(rid) => {
              transcribeRunRef.current = rid;
              const source = latestTranscribeSourceRef.current;
              bindBackgroundTranscriptionSource(recordingRunSourceRef.current, rid, source);
              // 上传期间点「后台运行」→ 抽屉已关、runId 迟到：此刻直接接手看护
              if (rid && !transcribeFlowOpenRef.current) watchBackgroundTranscription(rid);
            }}
            onDiscardEntry={transcribeFlow.isNewRecording ? async (entryId) => {
              const res = await deleteDocumentEntry(entryId);
              if (!res.success) throw new Error(res.error?.message ?? '取消失败');
              if ((transcribeFlow.storeId || storeId) === storeId) {
                setEntries(prev => prev.filter(entry => entry.id !== entryId));
              }
              toast.success('已取消本次录音');
            } : undefined}
          />
        )}
      </AnimatePresence>

      {/* 上传进度卡：大文件不再"卡住没反馈"——文件名 + 实时百分比 + 第 n/共 m */}
      {uploadProgress && (
        <div
          className="fixed left-1/2 z-[70] w-[min(360px,88vw)] -translate-x-1/2 rounded-[14px] px-4 py-3"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--mobile-tab-height, 0px) + 20px)',
            background: 'var(--bg-card, rgba(20,20,24,0.95))',
            border: '1px solid var(--border-faint)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
          }}>
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px]">
            <span className="truncate font-semibold text-token-primary">正在上传 {uploadProgress.name}</span>
            <span className="shrink-0 tabular-nums text-token-muted">
              {uploadProgress.total > 1 ? `${uploadProgress.index}/${uploadProgress.total} · ` : ''}{uploadProgress.percent}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{ width: `${uploadProgress.percent}%`, background: 'linear-gradient(90deg, rgba(59,130,246,0.95), rgba(99,102,241,0.95))' }}
            />
          </div>
        </div>
      )}

      {/* 文档再加工：右下角常驻任务 pill —— 关抽屉后仍可见，点击重新展开。
          bottom 抬高避让右下角调色盘 FAB（CreatePaletteFab，56px + 边距） */}
      {storeRuns.length > 0 && (
        <div className="fixed right-5 z-40 flex flex-col gap-2" style={{ maxWidth: '300px', bottom: '96px' }}>
          {storeRuns.map((r) => {
            const isRunning = r.status === 'streaming';
            const accent = r.status === 'done'
              ? 'rgba(74,222,128,0.95)'
              : r.status === 'failed'
                ? 'rgba(248,113,113,0.95)'
                : 'rgba(96,165,250,0.95)';
            return (
              <div
                key={r.runId}
                className="surface-popover flex items-center gap-2.5 rounded-[12px] border border-token-subtle px-3 py-2.5 cursor-pointer"
                title="点击展开查看进度"
                onClick={() => setReprocessTarget({ id: r.sourceEntryId, title: r.sourceTitle })}
              >
                <div className="bg-token-nested flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px]"
                  style={{ color: accent }}>
                  {r.status === 'done'
                    ? <CheckCircle2 size={14} />
                    : r.status === 'failed'
                      ? <AlertCircle size={14} />
                      : <MapSpinner size={14} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold text-token-primary">{r.sourceTitle}</p>
                  <p className="truncate text-[10px] text-token-muted">
                    {isRunning
                      ? `${r.phase} · ${Math.round(r.progress)}%`
                      : r.status === 'done' ? '加工完成' : '加工失败'}
                  </p>
                </div>
                {isRunning ? (
                  <Wand2 size={12} className="flex-shrink-0 text-token-muted" />
                ) : (
                  <button
                    className="hover-bg-soft flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[6px] text-token-muted"
                    title="移除"
                    onClick={(e) => { e.stopPropagation(); dismissRun(r.runId); }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 右上角「运行中的智能体」入口：关掉抽屉/刷新后仍可见，点击重开抽屉恢复短视频任务进度。
          始终挂载（Host 轮询不能因开抽屉而停），仅在抽屉打开时隐藏浮层避免遮挡。 */}
      <ShortVideoRunIndicator
        storeId={storeId}
        hidden={!!reprocessTarget}
        onOpenRun={(r) => {
          // 把被点击的 run 设为当前活跃 run，抽屉以 short-video 模式打开后会据此恢复轮询
          saveActiveShortVideoRun(r.storeId, r.runId);
          setReprocessTarget({ mode: 'short-video', title: '短视频解析' });
        }}
        onRunCompleted={() => {
          // 后台 run 跑完（抽屉关着/刷新后）→ 刷新知识库列表，让新入库的视频/文字条目出现
          void loadEntries();
          setTimeout(() => { void loadEntries(); }, 1500);
        }}
      />

      {/* 文档再加工对话抽屉 */}
      <AnimatePresence>
        {reprocessTarget && (
          <ReprocessChatDrawer
            key={`${reprocessTarget.mode ?? 'document'}:${reprocessTarget.id ?? 'tool'}:${reprocessTarget.initialInput ?? ''}`}
            entryId={reprocessTarget.id}
            entryTitle={reprocessTarget.title}
            storeId={storeId}
            initialMode={reprocessTarget.mode ?? 'document'}
            initialInput={reprocessTarget.initialInput}
            onClose={() => setReprocessTarget(null)}
            onApplied={handleReprocessApplied}
            onStoreChanged={() => {
              void loadEntries();
              setTimeout(() => { void loadEntries(); }, 1500);
            }}
            onOpenEntry={(target) => {
              setSelectedEntryId(target.id);
              setReprocessTarget({
                id: target.id,
                title: target.title,
                mode: 'document',
                initialInput: target.initialInput,
              });
            }}
          />
        )}
      </AnimatePresence>

      {/* 访客记录抽屉（批次 C） */}
      {showViewers && (
        <ViewersDrawer
          storeId={storeId}
          storeName={store.name}
          onClose={() => setShowViewers(false)}
          // 单库内点击文档排行/流水 → 直接在本库打开该文档
          onOpenDocument={(_sid, entryId) => { setShowViewers(false); setSelectedEntryId(entryId); }}
        />
      )}

    </div>
  );
}

// ── 订阅源对话框（支持 URL 订阅 + GitHub 目录同步）──
function SubscribeDialog({ storeId, onClose, onCreated }: {
  storeId: string;
  onClose: () => void;
  onCreated: (entry: DocumentEntry) => void;
}) {
  const [mode, setMode] = useState<'url' | 'github'>('url');
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [interval, setInterval] = useState(60);
  const [githubInterval, setGithubInterval] = useState(1440);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setLoading(true);
    setError('');

    if (mode === 'github') {
      if (!githubUrl.trim()) { setError('GitHub 地址不能为空'); setLoading(false); return; }
      const res = await addGitHubSubscription(storeId, {
        githubUrl: githubUrl.trim(),
        title: title.trim() || undefined,
        syncIntervalMinutes: githubInterval,
      });
      if (res.success) {
        toast.success('GitHub 目录订阅已添加', '后台将立即开始首次同步');
        onCreated(res.data);
      } else {
        setError(res.error?.message ?? '创建失败');
      }
    } else {
      if (!title.trim()) { setError('标题不能为空'); setLoading(false); return; }
      if (!sourceUrl.trim()) { setError('源地址不能为空'); setLoading(false); return; }
      const res = await addSubscription(storeId, {
        title: title.trim(),
        sourceUrl: sourceUrl.trim(),
        syncIntervalMinutes: interval,
      });
      if (res.success) {
        toast.success('订阅添加成功', '后台将按设定间隔自动拉取内容');
        onCreated(res.data);
      } else {
        setError(res.error?.message ?? '创建失败');
      }
    }
    setLoading(false);
  };

  const accentColor = mode === 'github' ? '130,80,223' : '234,179,8';

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover w-[560px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: `rgba(${accentColor},0.08)`, border: `1px solid rgba(${accentColor},0.12)` }}>
              {mode === 'github' ? <Github size={15} style={{ color: `rgba(${accentColor},0.85)` }} /> : <Rss size={15} style={{ color: `rgba(${accentColor},0.85)` }} />}
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>添加订阅源</span>
          </div>
          <button onClick={onClose}
            className="hover-bg-soft w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 模式切换 */}
        <div className="flex gap-2 mb-4">
          {([['url', 'URL 订阅', Rss], ['github', 'GitHub 目录', Github]] as const).map(([m, label, Icon]) => (
            <button key={m} onClick={() => { setMode(m); setError(''); }}
              className="flex-1 py-2 rounded-[10px] text-[12px] font-semibold cursor-pointer flex items-center justify-center gap-1.5 transition-all duration-200"
              style={{
                background: mode === m ? `rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.1)` : 'var(--bg-nested)',
                border: mode === m ? `1px solid rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.2)` : '1px solid var(--border-subtle)',
                color: mode === m ? `rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.9)` : 'var(--text-muted)',
              }}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        <div className="space-y-4 mb-4">
          {mode === 'github' ? (
            <>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>GitHub 目录地址</label>
                <input value={githubUrl} onChange={e => setGithubUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/tree/main/doc"
                  className="prd-field w-full h-9 px-3 rounded-[10px] text-[13px] outline-none" />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  自动同步目录下所有 .md 文件，支持增量更新（SHA 去重）
                </p>
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>标题（可选，默认用仓库名）</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="如：项目文档"
                  className="prd-field w-full h-9 px-3 rounded-[10px] text-[13px] outline-none" />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>同步间隔</label>
                <div className="flex gap-2">
                  {[60, 360, 720, 1440].map(m => (
                    <button key={m} onClick={() => setGithubInterval(m)}
                      className="flex-1 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200"
                      style={{
                        background: githubInterval === m ? 'rgba(130,80,223,0.1)' : 'var(--bg-nested)',
                        border: githubInterval === m ? '1px solid rgba(130,80,223,0.2)' : '1px solid var(--border-subtle)',
                        color: githubInterval === m ? 'rgba(130,80,223,0.9)' : 'var(--text-muted)',
                      }}>
                      {m < 1440 ? `${m / 60}小时` : '每天'}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>标题</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="如：React 官方博客"
                  className="prd-field w-full h-9 px-3 rounded-[10px] text-[13px] outline-none" />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>源地址（RSS / 网页 URL）</label>
                <input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://example.com/feed.xml"
                  className="prd-field w-full h-9 px-3 rounded-[10px] text-[13px] outline-none" />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>同步间隔</label>
                <div className="flex gap-2">
                  {[15, 60, 360, 1440].map(m => (
                    <button key={m} onClick={() => setInterval(m)}
                      className="flex-1 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200"
                      style={{
                        background: interval === m ? 'rgba(234,179,8,0.1)' : 'var(--bg-nested)',
                        border: interval === m ? '1px solid rgba(234,179,8,0.2)' : '1px solid var(--border-subtle)',
                        color: interval === m ? 'rgba(234,179,8,0.9)' : 'var(--text-muted)',
                      }}>
                      {m < 60 ? `${m}分钟` : m < 1440 ? `${m / 60}小时` : '每天'}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {error && <p className="text-[12px] mb-3" style={{ color: 'rgba(239,68,68,0.9)' }}>{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleCreate} disabled={loading}>
            {loading ? '添加中…' : mode === 'github' ? '添加 GitHub 同步' : '添加订阅'}
          </Button>
        </div>
      </div>
    </div>
  );
}

type StoreTab = 'mine' | 'team' | 'recent' | 'favorites' | 'likes' | 'sync';

/**
 * 「最近」等不走库列表管线的 tab 的占位空列表。
 * 必须是模块级常量：写成行内 `[]` 每次渲染都是新引用，
 * 会让下游 useMemo 的依赖每帧都变（eslint react-hooks/exhaustive-deps 会直接报出来）。
 */
const EMPTY_STORE_LIST: DocumentStoreWithPreview[] = [];

type StoreSort = 'updated-desc' | 'created-desc' | 'name-asc' | 'docs-desc';
const SORT_OPTIONS: { key: StoreSort; label: string }[] = [
  { key: 'updated-desc', label: '最近更新' },
  { key: 'created-desc', label: '最近创建' },
  { key: 'name-asc', label: '名称 A→Z' },
  { key: 'docs-desc', label: '文章数最多' },
];

// ── 主页面 ──
export function DocumentStorePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const initialDeepLinkRef = useRef(parseDocumentStoreDeepLink(location.search));
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);
  // 团队 id → 团队名（团队空间「全部」聚合视图给卡片标归属团队用）
  const myTeams = useTeamStore((s) => s.teams);
  const teamNameMap = useMemo(
    () => new Map(myTeams.map((t) => [t.team.id, t.team.name])),
    [myTeams],
  );
  const [tab, setTab] = useState<StoreTab>(() => {
    const saved = sessionStorage.getItem('doc-store-tab') as StoreTab | null;
    return saved === 'team' || saved === 'recent' || saved === 'favorites' || saved === 'likes' || saved === 'sync' ? saved : 'mine';
  });
  const [stores, setStores] = useState<DocumentStoreWithPreview[]>([]);
  const [favorites, setFavorites] = useState<InteractionStoreCard[]>([]);
  const [likes, setLikes] = useState<InteractionStoreCard[]>([]);
  const [recentEntries, setRecentEntries] = useState<RecentDocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // 我的 / 团队 作用域（默认我的；仅 mine 标签生效）
  const [teamScope, setTeamScope] = useState<TeamScope>(() => useTeamStore.getState().getScope('document-store'));
  const [showCreate, setShowCreate] = useState(false);
  const [showSendToPeer, setShowSendToPeer] = useState(false);
  /** 「接入 AI」：当场签发一个 document-store:write 长效 Key（谁需要谁签发） */
  const [showOpenApi, setShowOpenApi] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: string; name: string; tags: string[] } | null>(null);
  const [shareTeamTarget, setShareTeamTarget] = useState<{ id: string; name: string; teamIds: string[] } | null>(null);
  // 置顶：用户级，服务端持久化（跨设备/重登录保持）。openCardMenuId = 当前展开「更多」菜单的卡片 id。
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [openCardMenuId, setOpenCardMenuId] = useState<string | null>(null);
  // 当前展开卡片「更多」菜单的触发按钮元素，供 AnchoredMenu 定位（列表里无法为每张卡片建独立 ref）
  const [cardMenuAnchor, setCardMenuAnchor] = useState<HTMLElement | null>(null);
  // 卡片右键菜单（与三点「更多」同源的操作集，外加 打开/置顶）
  const [cardCtxMenu, setCardCtxMenu] = useState<{ x: number; y: number; storeId: string } | null>(null);
  // 切 tab 时列表重挂载，旧锚点失效：复位卡片菜单，避免 stale anchor 自动开 / 首点只关（Bugbot）
  useEffect(() => { setOpenCardMenuId(null); setCardMenuAnchor(null); setCardCtxMenu(null); }, [tab]);
  // 使用 storeId 而不是 store 对象，这样刷新后可以从 URL 或 sessionStorage 恢复
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(() => {
    return initialDeepLinkRef.current.storeId ?? sessionStorage.getItem('doc-store-selected-id');
  });
  // 当前文档与 store 一起构成可刷新、可复制、可前进后退的知识库深链。
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(() => {
    return initialDeepLinkRef.current.storeId ? initialDeepLinkRef.current.entryId : null;
  });
  // 外层「+」FAB：动作先选库，选中后进库自动触发同款动作（与库内 FAB 出一样的结果）
  const [storePickerAction, setStorePickerAction] = useState<DocumentStoreDetailAction | null>(null);
  const [detailInitialAction, setDetailInitialAction] = useState<DetailInitialActionRequest | null>(null);
  const detailInitialActionSequenceRef = useRef(0);
  const [quickCaptureResolving, setQuickCaptureResolving] = useState(
    () => hasQuickRecordRequest(location.search),
  );
  type QuickCaptureResponse = Awaited<ReturnType<typeof getOrCreateQuickCaptureStore>>;
  const quickCaptureRequestRef = useRef<QuickCaptureRequestHolder<QuickCaptureResponse>>({ current: null });
  const cdsImportRequestRef = useRef<string | null>(null);
  const tutorialRouteRequestRef = useRef<string | null>(null);

  /*
   * `?store=X&record=1`：直接在 X 库里开录音（结果页左栏那颗「新录音」走这条）。
   * 与 quickRecord 不同，它不去创建快捷库——用户是在某个库里点的，就录进那个库。
   * 消费一次就把参数抹掉，否则返回这一页会再弹一次录音面板。
   */
  const recordInStoreConsumedRef = useRef(false);
  useEffect(() => {
    if (recordInStoreConsumedRef.current) return;
    if (!hasRecordInStoreRequest(location.search)) return;
    const target = initialDeepLinkRef.current.storeId ?? selectedStoreId;
    if (!target) return;
    recordInStoreConsumedRef.current = true;
    setDetailInitialAction({
      id: ++detailInitialActionSequenceRef.current,
      storeId: target,
      action: 'record',
    });
    navigate({
      pathname: location.pathname,
      search: withoutRecordInStoreRequest(location.search),
      hash: location.hash,
    }, { replace: true });
  }, [location.search, location.pathname, location.hash, navigate, selectedStoreId]);

  // 列表 -> 知识库阅读器是全屏级切换，必须进浏览器历史：右滑/浏览器返回 = 关阅读器回列表。
  // ?store= 同时承担深链（首页「继续上次」回跳）：hook 的 onRestore 直接恢复，不再消费后抹掉。
  useHistoryBackedView({
    param: 'store',
    value: selectedStoreId,
    onExit: () => {
      setSelectedStoreId(null);
      setPendingEntryId(null);
    },
    onRestore: (id) => {
      const deepLink = parseDocumentStoreDeepLink(window.location.search);
      setSelectedStoreId(id);
      setPendingEntryId(deepLink.storeId === id ? deepLink.entryId : null);
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tutorialRoute = params.get('tutorialRoute');
    if (!tutorialRoute || tutorialRouteRequestRef.current === tutorialRoute) return;
    tutorialRouteRequestRef.current = tutorialRoute;
    let alive = true;
    void resolveTutorialLinkRoute(tutorialRoute).then(result => {
      if (!alive) return;
      if (!result.success) {
        toast.error('没有找到关联教程', result.error?.message ?? '当前页面尚未建立教程关系');
        params.delete('tutorialRoute');
        navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '', hash: location.hash }, { replace: true });
        return;
      }
      // 深链带了 tutorialSourceId 就打开那一章；控制台侧传的是教程 sourceId，
      // 而 `entry` 是 Mongo 文档 id，必须在这里按 sourceId 换算成 entryId。
      // 此前无条件取 tutorials[0]，于是标着第 15 / 19 章的链接统统打开第一章（Codex P2）。
      const wantedSourceId = params.get('tutorialSourceId');
      const matched = wantedSourceId
        ? result.data.tutorials.find(item => item.sourceId === wantedSourceId)
        : undefined;
      const targetEntryId = matched?.entryId ?? result.data.tutorials[0]?.entryId;
      setSelectedStoreId(result.data.storeId);
      setPendingEntryId(targetEntryId ?? null);
      params.delete('tutorialRoute');
      params.delete('tutorialSourceId');
      params.set('tutorialLinks', '1');
      params.set('store', result.data.storeId);
      if (targetEntryId) params.set('entry', targetEntryId);
      navigate({ pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash }, { replace: true });
    });
    return () => { alive = false; };
  }, [location.hash, location.pathname, location.search, navigate]);

  // 深链 ?tab=xxx：清空详情视图 + 切到该 tab，
  // 这样从任意位置（含某个知识库详情内）打开教程都能落到目标页签，再把 query 抹掉避免重复触发。
  useEffect(() => {
    const t = new URLSearchParams(location.search).get('tab');
    const valid: StoreTab[] = ['mine', 'team', 'recent', 'favorites', 'likes', 'sync'];
    if (t && (valid as string[]).includes(t)) {
      setTab(t as StoreTab);
      const deepLink = parseDocumentStoreDeepLink(location.search);
      if (!deepLink.storeId) setSelectedStoreId(null);
      navigate({
        pathname: location.pathname,
        search: withoutDocumentStoreTabRequest(location.search),
        hash: location.hash,
      }, { replace: true });
      return;
    }
    if (location.hash === '#guide-list') {
      setSelectedStoreId(null);
      setTab('mine');
      navigate(location.pathname, { replace: true });
    }
  }, [location.search, location.hash, location.pathname, navigate]);

  // 右下角悬浮「+」双击快捷录音：服务端幂等找到或创建快捷知识库，进入后复用详情页同一录音状态机。
  // quickRecord 是一次性意图，消费后从 URL 删除，避免刷新页面再次自动打开麦克风。
  useEffect(() => {
    if (!hasQuickRecordRequest(location.search)) {
      setQuickCaptureResolving(false);
      return;
    }
    setQuickCaptureResolving(true);
    let alive = true;

    // StrictMode 会先清理再重跑 effect；两个 effect 共享同一个请求，但各自订阅结果。
    // 这样第一次订阅失效后，第二次仍能消费服务端已经返回的快捷知识库。
    void getSharedQuickCaptureRequest(quickCaptureRequestRef.current, getOrCreateQuickCaptureStore)
      .then((res) => {
        if (!alive) return;
        if (!res.success) {
          toast.error('快捷录音启动失败', res.error?.message ?? '无法准备快捷知识库');
          setQuickCaptureResolving(false);
          navigate({
            pathname: location.pathname,
            search: withoutQuickRecordRequest(location.search),
            hash: location.hash,
          }, { replace: true });
          return;
        }

        setPendingEntryId(null);
        setDetailInitialAction({
          id: ++detailInitialActionSequenceRef.current,
          storeId: res.data.id,
          action: 'record',
        });
        setSelectedStoreId(res.data.id);
        // navigate 会先触发本 effect 的 cleanup；若只依赖 finally，alive 已变为 false，
        // 页面会永久停在“正在打开快捷录音”。在改变 URL 前先结束准备态。
        setQuickCaptureResolving(false);
        navigate({
          pathname: location.pathname,
          search: withDocumentStoreEntry(withoutQuickRecordRequest(location.search), res.data.id, null),
          hash: location.hash,
        }, { replace: true });
      })
      .catch(() => {
        if (!alive) return;
        toast.error('快捷录音启动失败', '无法准备快捷知识库，请稍后重试');
        navigate({
          pathname: location.pathname,
          search: withoutQuickRecordRequest(location.search),
          hash: location.hash,
        }, { replace: true });
      })
      .finally(() => {
        if (alive) setQuickCaptureResolving(false);
      });

    return () => { alive = false; };
  }, [location.hash, location.pathname, location.search, navigate]);

  // 同一知识库内若 URL 的 entry 发生变化，需要单独恢复选中文档。
  useEffect(() => {
    const deepLink = parseDocumentStoreDeepLink(location.search);
    if (deepLink.storeId === selectedStoreId) setPendingEntryId(deepLink.entryId);
  }, [location.search, selectedStoreId]);

  // store 被 history hook 清除后同步清掉孤立 entry，避免列表页残留不可恢复的半条深链。
  useEffect(() => {
    const nextSearch = withoutOrphanedDocumentStoreEntry(location.search);
    if (nextSearch === location.search) return;
    navigate({ pathname: location.pathname, search: nextSearch, hash: location.hash }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  // 置顶 ID 服务端加载（跨设备/重登录保持）
  useEffect(() => {
    let alive = true;
    getUserPreferences().then(res => {
      if (alive && res.success) setPinnedIds(new Set(res.data.documentStorePinnedIds ?? []));
    });
    return () => { alive = false; };
  }, []);

  // 置顶写入串行化：每次点击只更新本地态 + 记下「最新目标列表」，由 flushPins 串行落库
  // （一次仅一个在途请求，期间多次点击合并为最后一次）。这样服务端最终持久化的一定是最新一次选择，
  // 不会因请求乱序（[A] 晚于 [A,B] 到达）丢掉后点的项；失败则从服务端拉权威值纠正，
  // 避免「陈旧回滚丢新选择」（Codex: Serialize pin preference writes）。
  const pinInFlightRef = useRef(false);
  const pinPendingRef = useRef<string[] | null>(null);
  const flushPins = useCallback(async () => {
    if (pinInFlightRef.current || pinPendingRef.current == null) return;
    const ids = pinPendingRef.current;
    pinPendingRef.current = null;
    pinInFlightRef.current = true;
    const res = await updateDocumentStorePins(ids);
    pinInFlightRef.current = false;
    if (!res.success) {
      toast.error('置顶保存失败', res.error?.message);
      // 失败时若用户在途又点了（pinPendingRef 有更新意图），优先把最新意图发出去——
      // 不能在这里 return 不发，否则那次点击的 flushPins 早因 inFlight 而 bail，最新选择会一直不落库（Codex）。
      // 也不能用服务端旧值覆盖用户的新选择，故仅在无 pending 时才拉权威值纠正。
      if (pinPendingRef.current != null) { void flushPins(); return; }
      const r = await getUserPreferences();
      if (r.success) setPinnedIds(new Set(r.data.documentStorePinnedIds ?? []));
      return;
    }
    if (pinPendingRef.current != null) void flushPins(); // 在途期间又有点击，继续发最新
  }, []);
  // 置顶/取消置顶后的「去哪了」反馈（2026-07-16 用户反馈：库多时不知道操作的是哪个、挪去了哪）：
  // 1) 卡片包 motion.div layout → 重排时 FLIP 位移动画，卡片肉眼可见地滑到新位置；
  // 2) 落点外圈琥珀描边 1.6s 渐隐（kb-card-flash）；
  // 3) 平滑跟随滚动到卡片新位置（block:nearest，已在视口内则不动）。
  const [movedStoreId, setMovedStoreId] = useState<string | null>(null);
  const movedTimerRef = useRef<number | null>(null);
  const markMoved = useCallback((storeId: string) => {
    setMovedStoreId(null); // 先清空再下一帧置回，保证连续点同一张卡也能重放闪烁动画
    requestAnimationFrame(() => setMovedStoreId(storeId));
    if (movedTimerRef.current) window.clearTimeout(movedTimerRef.current);
    movedTimerRef.current = window.setTimeout(() => setMovedStoreId(null), 1700);
    window.setTimeout(() => {
      document.querySelector(`[data-store-card="${storeId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 120);
  }, []);
  useEffect(() => () => { if (movedTimerRef.current) window.clearTimeout(movedTimerRef.current); }, []);

  const handleTogglePin = useCallback((storeId: string) => {
    setPinnedIds(prev => {
      const next = new Set(prev);
      if (next.has(storeId)) next.delete(storeId); else next.add(storeId);
      pinPendingRef.current = [...next];
      void flushPins();
      return next;
    });
    markMoved(storeId);
  }, [flushPins, markMoved]);

  const handleSystemShareStore = useCallback(async (storeId: string, name: string) => {
    const url = `${window.location.origin}/library/${storeId}`;
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
    };
    try {
      if (nav.share) {
        await nav.share({ title: name, text: `知识库：${name}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success('链接已复制', '当前浏览器不支持系统分享');
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      try {
        await navigator.clipboard.writeText(url);
        toast.success('链接已复制');
      } catch {
        toast.error('分享失败', '系统分享和复制链接都未成功，请稍后重试');
      }
    }
  }, []);

  // 删除知识库：三点「更多」与右键菜单共用同一条确认 + 删除路径
  const handleDeleteStore = useCallback(async (s: { id: string; name: string; documentCount?: number }) => {
    const entryCount = s.documentCount ?? 0;
    const confirmed = await systemDialog.confirm({
      title: '确认删除知识库',
      message: `删除「${s.name}」将永久清除：\n  · ${entryCount} 个文档条目\n  · 所有订阅同步日志\n  · 所有附件文件与解析正文\n  · 所有点赞 / 收藏 / 分享链接\n\n此操作不可恢复。`,
      tone: 'danger',
      confirmText: '永久删除',
      cancelText: '取消',
    });
    if (!confirmed) return;
    const res = await deleteDocumentStore(s.id);
    if (res.success) {
      setStores(prev => prev.filter(x => x.id !== s.id));
      toast.success('知识库已删除', '关联数据已全部清理');
    } else {
      toast.error('删除失败', res.error?.message);
    }
  }, []);

  // 卡片「更多」菜单点外关闭由 AnchoredMenu 自身处理（菜单已 portal 到 body）

  // 第二排：搜索 + 排序（sessionStorage 持久化；CLAUDE.md no-localStorage 规则）
  const [search, setSearch] = useState<string>(() => sessionStorage.getItem('doc-store-search') ?? '');
  const [sortKey, setSortKey] = useState<StoreSort>(() => {
    const saved = sessionStorage.getItem('doc-store-sort') as StoreSort | null;
    return saved && SORT_OPTIONS.some(o => o.key === saved) ? saved : 'updated-desc';
  });
  const [sortOpen, setSortOpen] = useState(false);
  const sortWrapRef = useRef<HTMLDivElement | null>(null);

  // 标签筛选（多选，sessionStorage 持久化）
  const [tagFilter, setTagFilter] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem('doc-store-tag-filter');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  });
  const [tagOpen, setTagOpen] = useState(false);
  const tagWrapRef = useRef<HTMLDivElement | null>(null);
  const [tagQuery, setTagQuery] = useState('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);

  useEffect(() => { sessionStorage.setItem('doc-store-search', search); }, [search]);
  useEffect(() => { sessionStorage.setItem('doc-store-sort', sortKey); }, [sortKey]);
  useEffect(() => { sessionStorage.setItem('doc-store-tag-filter', JSON.stringify(tagFilter)); }, [tagFilter]);
  useEffect(() => {
    if (!sortOpen) return;
    const onDown = (e: MouseEvent) => {
      if (sortWrapRef.current && !sortWrapRef.current.contains(e.target as Node)) setSortOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sortOpen]);
  useEffect(() => {
    if (!tagOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tagWrapRef.current && !tagWrapRef.current.contains(e.target as Node)) setTagOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tagOpen]);

  // 吸顶工具栏滚动感知:未滚动时保持透明(顶部不再压一块"黑黑的"底),
  // 滚动后才亮出模糊底防止卡片透字(2026-07-08 用户反馈"顶部反复改,
  // 加了黑底在顶部就黑黑的"——标准解法是 scroll-aware header)。
  const [listScrolled, setListScrolled] = useState(false);

  // 防 stale 响应:tab/teamId/筛选 快速切换时,旧请求回填会覆盖新数据。
  // 用单调递增序号锁住"只有最新一次请求才能 setState"。
  // 三个加载器共用同一个序号,跨 tab 切换也能互相失效(例如 mine→收藏 时未完成的 loadStores 会被废弃)。
  const listFetchSeq = useRef(0);
  const loadStores = useCallback(async (scope: 'mine' | 'team', teamId: string | null) => {
    const mySeq = ++listFetchSeq.current;
    setLoading(true);
    // pageSize=500：搜索/标签/排序由前端做,需要拿到全量数据(实际用户 KB 数远低于此天花板)。
    // 真正越过 500 时需要后端 search/sort 端点支持,届时再切到分页+服务端筛选。
    const res = await listDocumentStoresWithPreview(1, 500, { scope, teamId });
    if (listFetchSeq.current !== mySeq) return; // 已被更新的请求超车,丢弃
    if (res.success) {
      setStores(res.data.items);
    } else {
      // 失败也必须清空,否则上一个 tab/team 的数据会"卡"在屏上让用户误判
      setStores([]);
      toast.error('加载失败', res.error?.message);
    }
    setLoading(false);
  }, []);

  const loadFavorites = useCallback(async () => {
    const mySeq = ++listFetchSeq.current;
    setLoading(true);
    const res = await listMyFavoriteDocumentStores();
    if (listFetchSeq.current !== mySeq) return;
    if (res.success) {
      setFavorites(res.data.items);
    } else {
      setFavorites([]);
      toast.error('加载收藏失败', res.error?.message);
    }
    setLoading(false);
  }, []);

  const loadRecent = useCallback(async () => {
    const mySeq = ++listFetchSeq.current;
    setLoading(true);
    const res = await listRecentDocumentEntries(50);
    if (listFetchSeq.current !== mySeq) return;
    if (res.success) {
      setRecentEntries(res.data.items);
    } else {
      // 与其他 loader 同口径：失败必须清空，否则上一个 tab 的数据卡在屏上让人误判
      setRecentEntries([]);
      toast.error('加载最近内容失败', res.error?.message);
    }
    setLoading(false);
  }, []);

  const loadLikes = useCallback(async () => {
    const mySeq = ++listFetchSeq.current;
    setLoading(true);
    const res = await listMyLikedDocumentStores();
    if (listFetchSeq.current !== mySeq) return;
    if (res.success) {
      setLikes(res.data.items);
    } else {
      setLikes([]);
      toast.error('加载点赞失败', res.error?.message);
    }
    setLoading(false);
  }, []);

  // CDS 验收中心的一键保存深链。写入动作始终在 MAP 当前登录态内执行：
  // CDS 只传报告范围和来源地址，后端再用已授权的「系统互联」记录匹配来源，拒绝任意 URL。
  useEffect(() => {
    const deepLink = parseCdsReportImportDeepLink(location.search);
    if (!deepLink) return;
    const { reportId, projectId, sourceBaseUrl } = deepLink;
    const requestKey = `${sourceBaseUrl}|${projectId ?? ''}|${reportId}`;
    if (cdsImportRequestRef.current === requestKey) return;
    cdsImportRequestRef.current = requestKey;

    const cleanSearch = () => withoutCdsReportImportDeepLink(location.search);
    if (!sourceBaseUrl) {
      toast.error('保存失败', '缺少 CDS 来源地址，请从验收中心重新发起');
      navigate({ pathname: location.pathname, search: cleanSearch(), hash: location.hash }, { replace: true });
      return;
    }

    toast.info('正在保存验收报告', 'MAP 正在从已授权的 CDS 连接拉取报告与截图');
    void importCdsAcceptanceReport({ reportId, projectId, sourceBaseUrl }).then((res) => {
      if (!res.success) {
        toast.error('保存到知识库失败', res.error?.message ?? '请检查系统互联中的 CDS 连接');
        navigate({ pathname: location.pathname, search: cleanSearch(), hash: location.hash }, { replace: true });
        return;
      }
      const result = res.data;
      if (result.failed > 0) {
        toast.error('报告同步未完成', result.messages[0] ?? `${result.failed} 份报告导入失败`);
        navigate({ pathname: location.pathname, search: cleanSearch(), hash: location.hash }, { replace: true });
        return;
      }
      toast.success('已保存到我的知识库', `${result.storeName}：新增 ${result.imported}，更新 ${result.updated}，已存在 ${result.skipped}`);
      setTab('mine');
      setSelectedStoreId(result.storeId);
      void loadStores('mine', null);
      navigate({
        pathname: location.pathname,
        search: withDocumentStoreEntry(cleanSearch(), result.storeId, null),
        hash: location.hash,
      }, { replace: true });
    });
  }, [loadStores, location.hash, location.pathname, location.search, navigate]);

  // 顶部 tab 与 teamScope 双向绑定：mine → 个人作用域，team → 共享作用域
  // 注意：mine 分支不写 useTeamStore，以保留上次选中的 teamId 记忆，方便往返切换
  useEffect(() => {
    if (tab === 'mine' && teamScope.scope !== 'mine') {
      setTeamScope({ scope: 'mine', teamId: null });
    } else if (tab === 'team' && teamScope.scope !== 'team') {
      // 切到团队空间：若已记忆过 teamId 则恢复，否则等用户在下拉里选/新建
      const remembered = useTeamStore.getState().getScope('document-store');
      const nextTeamId = remembered.scope === 'team' ? remembered.teamId : null;
      setTeamScope({ scope: 'team', teamId: nextTeamId });
      useTeamStore.getState().setScope('document-store', 'team', nextTeamId);
    }
  }, [tab, teamScope.scope]);

  useEffect(() => {
    if (tab === 'mine') {
      // 直接传 scope='mine'，不依赖 teamScope 闭包，避免切 tab 同帧 teamScope 还没同步的 race
      loadStores('mine', null);
    } else if (tab === 'team') {
      // 切到 team tab 时 teamScope 还未被 scope-sync effect 更新到记忆值,
      // 这里直接读 useTeamStore 兜底取记忆 teamId,避免"刚切过来闪一下未选 team 空态"。
      // teamId 为 null = 「全部」聚合视图（我加入的所有团队），由后端 AnyIn 聚合查询支撑
      const remembered = useTeamStore.getState().getScope('document-store');
      const effectiveTeamId = teamScope.teamId
        ?? (remembered.scope === 'team' ? remembered.teamId : null);
      loadStores('team', effectiveTeamId);
    } else if (tab === 'recent') {
      loadRecent();
    } else if (tab === 'favorites') {
      loadFavorites();
    } else if (tab === 'likes') {
      loadLikes();
    } else {
      ++listFetchSeq.current;
      setLoading(false);
    }
  }, [tab, teamScope.teamId, loadStores, loadFavorites, loadLikes, loadRecent]);

  // 持久化选中的 storeId / tab 到 sessionStorage
  useEffect(() => {
    if (selectedStoreId) {
      sessionStorage.setItem('doc-store-selected-id', selectedStoreId);
    } else {
      sessionStorage.removeItem('doc-store-selected-id');
    }
  }, [selectedStoreId]);

  useEffect(() => {
    sessionStorage.setItem('doc-store-tab', tab);
  }, [tab]);

  // 账号级访客总计（仅「我的空间」：访客/停留是「谁看了我的库」，只有 owner 才有意义）
  const [accountSummary, setAccountSummary] = useState<DocumentStoreAccountSummary | null>(null);
  useEffect(() => {
    if (tab !== 'mine') return;
    let cancelled = false;
    (async () => {
      const res = await getStoresAnalyticsSummary();
      if (!cancelled && res.success) setAccountSummary(res.data);
    })();
    return () => { cancelled = true; };
  }, [tab]);

  // 列表页「统计」入口：打开账号级访客报表抽屉（聚合全部知识库）
  const [showAccountViewers, setShowAccountViewers] = useState(false);
  // 从账号统计点击文档跳转时，待打开的 entryId（store 切换后由 StoreDetailView 消费）
  const openDocument = useCallback((sid: string, entryId: string) => {
    setShowAccountViewers(false);
    setPendingEntryId(entryId);
    setSelectedStoreId(sid);
  }, []);
  const openStore = useCallback((sid: string) => {
    setShowAccountViewers(false);
    setPendingEntryId(null);
    setSelectedStoreId(sid);
  }, []);
  /**
   * 「最近」点一条直接落到那篇内容本身：storeId 决定进哪个库，entryId 决定打开哪篇。
   * 与 openStore 同一条路径（StoreDetailView 的 initialEntryId），不另建第二套打开逻辑。
   */
  const openRecentEntry = useCallback((entry: RecentDocumentEntry) => {
    setShowAccountViewers(false);
    setPendingEntryId(entry.id);
    setSelectedStoreId(entry.storeId);
  }, []);

  const tabs: { key: StoreTab; label: string; icon: typeof Library; dataTourId?: string }[] = [
    { key: 'mine', label: '我的空间', icon: Library },
    { key: 'team', label: '团队空间', icon: Users },
    // 「最近」在收藏左侧：用户找的是「我刚存进来的那篇」，按库分组的卡片答不了这个问题
    { key: 'recent', label: '最近', icon: Clock },
    { key: 'favorites', label: '我的收藏', icon: Bookmark },
    { key: 'likes', label: '我的点赞', icon: Heart },
  ];

  const isStoreTab = tab === 'mine' || tab === 'team';
  // 「最近」渲染的是文档条目而不是库卡片，走独立分支，不进这条库列表管线
  const rawList: InteractionStoreCard[] | DocumentStoreWithPreview[] =
    isStoreTab ? stores : tab === 'favorites' ? favorites : tab === 'likes' ? likes : EMPTY_STORE_LIST;

  // 搜索 + 标签 + 排序（仅 store tab 生效；收藏/点赞页签不参与本页 toolbar 状态以避免混淆）
  const currentList = useMemo(() => {
    if (!isStoreTab) return rawList;
    const kw = search.trim().toLowerCase();
    let filtered = rawList as DocumentStoreWithPreview[];
    if (kw) {
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(kw) || (s.tags ?? []).some(t => t.toLowerCase().includes(kw)),
      );
    }
    if (tagFilter.length > 0) {
      // 多选标签为"任一匹配"(OR)
      const want = new Set(tagFilter);
      filtered = filtered.filter(s => (s.tags ?? []).some(t => want.has(t)));
    }
    const cmp = (a: DocumentStoreWithPreview, b: DocumentStoreWithPreview) => {
      // 置顶优先：被置顶的库永远排在最前（不受当前排序键影响）
      const pa = pinnedIds.has(a.id) ? 1 : 0;
      const pb = pinnedIds.has(b.id) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      switch (sortKey) {
        case 'updated-desc': return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
        case 'created-desc': return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
        case 'name-asc': return a.name.localeCompare(b.name, 'zh-CN');
        case 'docs-desc': return (b.documentCount ?? 0) - (a.documentCount ?? 0);
      }
    };
    return [...filtered].sort(cmp);
  }, [rawList, isStoreTab, search, sortKey, tagFilter, pinnedIds]);

  // 所有可用标签 + 各自的库数量（基于未筛选原始列表，避免筛选后标签消失抖动）
  const tagStats = useMemo(() => {
    if (!isStoreTab) return [] as { tag: string; count: number }[];
    const map = new Map<string, number>();
    for (const s of stores as DocumentStoreWithPreview[]) {
      for (const t of s.tags ?? []) {
        map.set(t, (map.get(t) ?? 0) + 1);
      }
    }
    return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }, [stores, isStoreTab]);

  const visibleTagStats = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    return q ? tagStats.filter(s => s.tag.toLowerCase().includes(q)) : tagStats;
  }, [tagStats, tagQuery]);

  // 空间详情视图（仅 mine 标签下可进入编辑视图）—— 早返回必须放在所有 hook 之后
  if (quickCaptureResolving) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6" style={{ background: 'var(--bg-primary)' }}>
        <div className="flex max-w-[320px] flex-col items-center text-center">
          <div
            className="mb-5 flex h-16 w-16 items-center justify-center rounded-[20px]"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
            <MapSpinner size={24} />
          </div>
          <p className="text-[16px] font-semibold text-token-primary">正在打开快捷录音</p>
          <p className="mt-2 text-[12px] leading-relaxed text-token-muted">
            正在准备你的快捷知识库，完成后会自动开始录音
          </p>
        </div>
      </div>
    );
  }

  if (selectedStoreId) {
    return <StoreDetailView
      storeId={selectedStoreId}
      key={selectedStoreId}
      initialEntryId={pendingEntryId ?? undefined}
      initialAction={detailInitialActionForStore(detailInitialAction, selectedStoreId)}
      onInitialActionConsumed={(requestId) => {
        setDetailInitialAction(current => consumeDetailInitialAction(current, requestId));
      }}
      onBack={() => {
        setSelectedStoreId(null);
        setPendingEntryId(null);
        setDetailInitialAction(null);
        // 按当前 tab 重新拉对应列表,避免从收藏/点赞返回时仍刷 stores
        if (tab === 'mine') loadStores('mine', null);
        else if (tab === 'team') {
          if (teamScope.teamId) loadStores('team', teamScope.teamId);
          else { ++listFetchSeq.current; setStores([]); setLoading(false); }
        }
        else if (tab === 'recent') loadRecent();
        else if (tab === 'favorites') loadFavorites();
        else if (tab === 'likes') loadLikes();
        else setLoading(false);
      }}
      onOpenLibrary={(id) => navigate(`/library/${id}`)}
      onOpenLegacySyncPanel={() => {
        setSelectedStoreId(null);
        setPendingEntryId(null);
        setTab('sync');
      }}
    />;
  }

  // 统计概览（基于未筛选的原始列表，反映"我拥有/我看到的"全量）
  const totalStores = isStoreTab ? (stores as DocumentStoreWithPreview[]).length : 0;
  const totalDocs = isStoreTab
    ? (stores as DocumentStoreWithPreview[]).reduce((sum, s) => sum + (s.documentCount ?? 0), 0)
    : 0;
  const activeSortLabel = SORT_OPTIONS.find(o => o.key === sortKey)?.label ?? '最近更新';
  const activeStoreTabLabel = tabs.find(t => t.key === tab)?.label ?? '知识库';
  const activeTeamLabel = tab === 'team'
    ? (teamScope.teamId
        ? (useTeamStore.getState().teams.find(t => t.team.id === teamScope.teamId)?.team.name ?? '团队空间')
        : '全部团队')
    : activeStoreTabLabel;
  const mobileFilterCount = [
    tab === 'team' && teamScope.teamId,
    tagFilter.length > 0,
    sortKey !== 'updated-desc',
  ].filter(Boolean).length;

  const isEmpty = currentList.length === 0;
  // 「已置顶 / 其他」分区：有置顶时给两组各一条小节标题，置顶后卡片滑进「已置顶」区，
  // 落点一目了然（currentList 已保证置顶排最前，仅 store tab 参与置顶排序）
  const pinnedCount = isStoreTab
    ? (currentList as DocumentStoreWithPreview[]).filter(x => pinnedIds.has(x.id)).length
    : 0;
  const showPinnedSections = pinnedCount > 0 && pinnedCount < currentList.length;
  const sectionHeader = (label: string, count: number, pinned: boolean) => (
    <div className="col-span-full flex items-center gap-2 min-w-0" style={{ marginBottom: -6 }}>
      {pinned && <Pin size={11} style={{ color: 'rgba(234,179,8,0.9)', fill: 'rgba(234,179,8,0.9)' }} />}
      <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
        {label} · {count}
      </span>
      <span className="flex-1 h-px" style={{ background: 'var(--border-faint, rgba(148,163,184,0.16))' }} />
    </div>
  );
  // 区分三种空态：1) 筛选有但被过滤掉了；2) 真·空（onboarding 引导）；3) 团队空间未选 team
  // 必须确认原始数据(stores)有内容才算"被筛选掉",否则 mine/team 真空态会被误判为"筛选无结果"
  const isFilteredOut = isEmpty && isStoreTab
    && (stores as DocumentStoreWithPreview[]).length > 0
    && (search.trim().length > 0 || tagFilter.length > 0);

  // 空间列表视图
  return (
    <div
      className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5"
      onScroll={(e) => {
        const scrolled = e.currentTarget.scrollTop > 4;
        if (scrolled !== listScrolled) setListScrolled(scrolled);
      }}
    >
      {/* 顶部 tab + 工具栏：滚动时整体悬浮（sticky）— 知识库多时菜单不消失
          -mb-5 + pb-5 用于"吃掉"父级 gap-5 间距，避免卡片从间隙缝隙里穿过。
          滚动感知：顶部保持透明（不压黑底），滚动后才亮出模糊底防透字 */}
      <div
        data-tour-id="library-tabs"
        className="sticky top-0 z-20 flex flex-col gap-3 pb-5 -mb-5"
        style={listScrolled ? {
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-primary, #121218) 82%, transparent) 0%, color-mix(in srgb, var(--bg-primary, #121218) 58%, transparent) 74%, transparent 100%)',
          backdropFilter: 'blur(12px) saturate(130%)',
          WebkitBackdropFilter: 'blur(12px) saturate(130%)',
        } : undefined}
      >
        {/* 顶部第一排：左上角空间切换（我的空间 / 团队空间 / 我的收藏 / 我的点赞） */}
        <TabBar
          items={tabs.map(t => ({
            key: t.key,
            label: t.label,
            icon: <t.icon size={12} />,
            dataTourId: t.dataTourId,
          }))}
          activeKey={tab}
          onChange={(k) => {
            const next = k as StoreTab;
            if (next === tab) return;
            // 同步清空 + 进入 loading,避免本帧仍渲染上一 tab 的卡片让用户误点。
            // 真实数据由 useEffect 异步拉取覆盖。
            ++listFetchSeq.current; // 作废任何 in-flight 请求
            const goingToStores = next === 'mine' || next === 'team';
            if (goingToStores) setStores([]);
            else if (next === 'favorites') setFavorites([]);
            else setLikes([]);
            setLoading(true);
            // 切 tab 时退出详情视图：否则详情视图早返回会挡在前面。
            setSelectedStoreId(null);
            setTab(next);
          }}
          variant="gold"
        />

      {/* 第二排：按顶部 tab 联动的工具栏
          - 我的空间 / 团队空间：统计 + 搜索 + 排序 + 新建知识库（团队空间多一个 TeamScopeBar）
          - 收藏 / 点赞：不显示 */}
      {isStoreTab && (
        <div
          data-tour-id="library-toolbar"
          className={isMobile
            ? 'px-5 flex flex-col gap-2 pb-1'
            : 'surface-nav-bar flex items-center gap-2 flex-wrap'}
          style={isMobile ? { scrollbarWidth: 'none' } : { overflow: 'visible' }}
        >
          {tab === 'team' && !isMobile && (
            <TeamScopeBar
              moduleKey="document-store"
              value={teamScope}
              onChange={setTeamScope}
              hideScopeToggle
            />
          )}
          {/* 统计概览 */}
          {/* 功能区：库数 / 文章数（左侧） */}
          <span data-tour-id="library-stats" className={isMobile ? 'hidden' : 'text-[12px] tabular-nums whitespace-nowrap flex-none'} style={{ color: 'var(--text-muted)' }}>
            共 <strong style={{ color: 'var(--text-primary)' }}>{totalStores}</strong> 个知识库
            <span className="opacity-50 mx-1.5">·</span>
            <strong style={{ color: 'var(--text-primary)' }}>{totalDocs}</strong> 篇文章
          </span>

          {/* 搜索 */}
          <div className={isMobile ? 'flex items-center gap-2' : 'contents'}>
          <div className={isMobile ? 'relative min-w-0 flex-1' : 'relative flex-none'}>
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            <input
              data-tour-id="library-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setSearch(''); }}
              placeholder="按名称或标签筛选…"
              className={isMobile
                ? 'h-10 pl-8 pr-8 rounded-[12px] text-[14px] outline-none w-full'
                : 'h-8 pl-7 pr-7 rounded-[8px] text-[12px] outline-none w-[200px] focus:w-[260px] transition-all'}
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="hover-bg-soft absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full flex items-center justify-center transition-colors"
                title="清除搜索"
                style={{ color: 'var(--text-muted)' }}
              >
                <X size={10} />
              </button>
            )}
          </div>
          {isMobile && (
            <button
              type="button"
              data-tour-id="library-mobile-filter"
              onClick={() => setShowMobileFilters(true)}
              className="h-10 px-3 rounded-[12px] inline-flex items-center gap-1.5 shrink-0"
              style={{
                background: mobileFilterCount > 0 ? 'var(--selection-bg)' : 'var(--bg-input)',
                border: `1px solid ${mobileFilterCount > 0 ? 'var(--selection-border)' : 'var(--border-subtle)'}`,
                color: mobileFilterCount > 0 ? 'var(--selection-text)' : 'var(--text-primary)',
              }}
            >
              <SlidersHorizontal size={15} />
              <span className="text-[13px] font-semibold">筛选</span>
              {mobileFilterCount > 0 && <span className="text-[12px] tabular-nums">{mobileFilterCount}</span>}
            </button>
          )}
          </div>

          {isMobile && (
            <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px]" style={{ color: 'var(--text-muted)' }}>
              <span className="truncate">{activeTeamLabel}</span>
              <span className="opacity-45">·</span>
              <span>{activeSortLabel}</span>
              <span className="opacity-45">·</span>
              <span>{totalStores} 个知识库</span>
              {tagFilter.length > 0 && (
                <>
                  <span className="opacity-45">·</span>
                  <span className="truncate">标签 {tagFilter.length}</span>
                </>
              )}
            </div>
          )}

          {/* 标签筛选（多选；激活后用主题色高亮 + 数字徽章） */}
          {!isMobile && <div className="relative flex-none" ref={tagWrapRef}>
            <button
              type="button"
              data-tour-id="library-tag-filter"
              onClick={() => setTagOpen(o => !o)}
              disabled={tagStats.length === 0}
              className={`h-8 px-2.5 rounded-[8px] text-[12px] flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${tagFilter.length > 0 ? 'hover:brightness-110' : 'hover-bg-soft'}`}
              style={tagFilter.length > 0
                ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
                : { border: '1px solid var(--border-default, rgba(148,163,184,0.24))', color: 'var(--text-muted)' }}
              title={tagStats.length === 0 ? '当前没有可用的标签' : '按标签筛选'}
            >
              <Tag size={12} />
              <span>标签</span>
              {tagFilter.length > 0 && (
                <span
                  className="ml-0.5 h-4 min-w-[16px] px-1 rounded-full text-[10px] font-semibold flex items-center justify-center"
                  style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
                >
                  {tagFilter.length}
                </span>
              )}
            </button>
            {tagOpen && (
              <div
                className="surface-popover absolute right-0 top-[36px] z-[120] w-[260px] rounded-[10px] overflow-hidden"
              >
                {/* 标签搜索 */}
                <div className="border-b border-token-subtle p-2">
                  <div className="relative">
                    <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
                    <input
                      autoFocus
                      value={tagQuery}
                      onChange={(e) => setTagQuery(e.target.value)}
                      placeholder="搜索标签"
                      className="prd-field w-full h-7 pl-7 pr-2 rounded-[6px] text-[12px] outline-none"
                    />
                  </div>
                </div>
                {/* 标签列表 */}
                <div className="max-h-[280px] overflow-auto py-1" style={{ overscrollBehavior: 'contain' }}>
                  {visibleTagStats.length === 0 ? (
                    <p className="px-3 py-3 text-[12px] text-center" style={{ color: 'var(--text-muted)' }}>
                      {tagQuery ? '无匹配标签' : '暂无标签'}
                    </p>
                  ) : visibleTagStats.map(({ tag, count }) => {
                    const active = tagFilter.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          setTagFilter(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
                        }}
                        className="hover-bg-soft w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between transition-colors"
                        style={{ color: active ? 'var(--selection-text)' : 'var(--text-primary)' }}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-3.5 h-3.5 rounded-[3px] flex items-center justify-center flex-shrink-0"
                            style={active
                              ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)' }
                              : { background: 'transparent', border: '1px solid var(--border-subtle)' }}
                          >
                            {active && <Check size={9} style={{ color: 'var(--selection-text)' }} />}
                          </span>
                          <span className="truncate">{tag}</span>
                        </span>
                        <span className="text-[10px] tabular-nums flex-shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {/* 底部操作行 */}
                {tagFilter.length > 0 && (
                  <div className="border-t border-token-subtle p-2 flex items-center justify-between">
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      已选 {tagFilter.length} 个
                    </span>
                    <button
                      type="button"
                      onClick={() => setTagFilter([])}
                      className="hover-bg-soft text-[11px] px-2 h-6 rounded-[6px] transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      清除全部
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>}

          {/* 排序（带高亮 active 状态，让用户一眼知道当前排序规则） */}
          {!isMobile && <div className="relative flex-none" ref={sortWrapRef}>
            <button
              type="button"
              data-tour-id="library-sort"
              onClick={() => setSortOpen(o => !o)}
              className="h-8 px-2.5 rounded-[8px] text-[12px] flex items-center gap-1.5 transition-all hover:brightness-110"
              style={{
                background: 'var(--selection-bg)',
                border: '1px solid var(--selection-border)',
                color: 'var(--selection-text)',
              }}
              title="排序方式"
            >
              <ArrowUpDown size={12} />
              <span>{activeSortLabel}</span>
            </button>
            {sortOpen && (
              <div
                className="surface-popover absolute right-0 top-[36px] z-[120] min-w-[160px] rounded-[10px] py-1"
              >
                {SORT_OPTIONS.map(opt => {
                  const active = opt.key === sortKey;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => { setSortKey(opt.key); setSortOpen(false); }}
                      className="hover-bg-soft w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between transition-colors"
                      style={{ color: active ? 'var(--selection-text)' : 'var(--text-primary)' }}
                    >
                      <span>{opt.label}</span>
                      {active && <Check size={12} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>}

          <span className={isMobile ? 'hidden' : 'flex-1'} />
          {/* 统计区：账号级访客总计（右侧）。数字 count-up 缓动 + 整段淡入，避免突然蹦出。 */}
          {!isMobile && tab === 'mine' && accountSummary && (
            <FadeIn>
              <span className="text-[12px] tabular-nums whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                <AnimatedStat value={accountSummary.totalViews} format={formatCountCompact} /> 次访问
                <span className="opacity-50 mx-1.5">·</span>
                <AnimatedStat value={accountSummary.uniqueVisitors} format={formatCountCompact} /> 访客
                <span className="opacity-50 mx-1.5">·</span>
                停留 <AnimatedStat value={accountSummary.totalDurationMs} format={formatDwellCompact} />
              </span>
            </FadeIn>
          )}
          {/* 统计按钮：再往右，打开全部知识库的访客统计报表（区别于知识库内的单库统计） */}
          {!isMobile && tab === 'mine' && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setShowAccountViewers(true)}
              title="查看全部知识库的访客统计报表（趋势 / 时段 / 排行 / 停留）"
            >
              <BarChart3 size={13} /> 统计
            </Button>
          )}
          {!isMobile && tab === 'mine' && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setShowSendToPeer(true)}
              title="一次选多个知识库，批量同步到另一个 MAP 节点（如正式环境）；单库同步请进库内右上角「同步」。对端节点由管理员预先在「设置 → 系统互联」配好"
            >
              <ArrowLeftRight size={13} /> 批量同步
            </Button>
          )}
          {!isMobile && tab === 'mine' && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setShowOpenApi(true)}
              title="当场签发一个长效 API Key（已预选「写入文档空间」权限），让外部 AI / Agent 以你的身份操作知识库"
            >
              <KeyRound size={13} /> 接入 AI
            </Button>
          )}
          {!isMobile && (
            <Button
              variant="primary"
              size="xs"
              data-tour-id="document-store-create"
              onClick={() => setShowCreate(true)}
              disabled={tab === 'team' && !teamScope.teamId}
              title={tab === 'team' && !teamScope.teamId
                ? '请先在上方选择或新建团队空间,新建的知识库会自动分享到所选团队空间'
                : tab === 'team' ? '新建后自动分享到当前团队空间' : undefined}
            >
              <Plus size={13} /> 新建知识库
            </Button>
          )}
        </div>
      )}
      </div>

      {isMobile && isStoreTab && (
        <MobileBottomSheet
          open={showMobileFilters}
          onClose={() => setShowMobileFilters(false)}
          title="筛选与操作"
          note={`${activeTeamLabel} · ${totalStores} 个知识库 · ${totalDocs} 篇文章`}
        >
          <div className="px-5 pb-4 space-y-5">
            {tab === 'team' && (
              <section className="space-y-2">
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>团队范围</div>
                <div className="surface-inset rounded-[14px] p-2">
                  <TeamScopeBar
                    moduleKey="document-store"
                    value={teamScope}
                    onChange={setTeamScope}
                    hideScopeToggle
                  />
                </div>
              </section>
            )}

            <section className="space-y-2">
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>排序</div>
              <div className="flex flex-wrap gap-2">
                {SORT_OPTIONS.map((opt) => {
                  const active = opt.key === sortKey;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setSortKey(opt.key)}
                      className="h-8 px-3 rounded-full text-[13px] inline-flex items-center gap-1.5"
                      style={active
                        ? { background: 'var(--selection-bg)', color: 'var(--selection-text)', border: '1px solid var(--selection-border)' }
                        : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                    >
                      {active && <Check size={12} />}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </section>

            {tagStats.length > 0 && (
              <section className="space-y-2">
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>标签</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setTagFilter([])}
                    className="h-8 px-3 rounded-full text-[13px]"
                    style={tagFilter.length === 0
                      ? { background: 'var(--selection-bg)', color: 'var(--selection-text)', border: '1px solid var(--selection-border)' }
                      : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                  >
                    全部标签
                  </button>
                  {tagStats.map(({ tag, count }) => {
                    const active = tagFilter.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          setTagFilter(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
                        }}
                        className="h-8 px-3 rounded-full text-[13px]"
                        style={active
                          ? { background: 'var(--selection-bg)', color: 'var(--selection-text)', border: '1px solid var(--selection-border)' }
                          : { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
                      >
                        {tag} ({count})
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {tab === 'mine' && (
              <section className="space-y-2">
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>更多操作</div>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowMobileFilters(false); setShowAccountViewers(true); }}
                    className="surface-action hover-bg-soft h-16 rounded-[14px] flex flex-col items-center justify-center gap-1 text-token-primary"
                  >
                    <BarChart3 size={17} />
                    <span className="text-[12px]">统计</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowMobileFilters(false); setShowSendToPeer(true); }}
                    className="surface-action hover-bg-soft h-16 rounded-[14px] flex flex-col items-center justify-center gap-1 text-token-primary"
                  >
                    <ArrowLeftRight size={17} />
                    <span className="text-[12px]">批量同步</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowMobileFilters(false); setShowOpenApi(true); }}
                    className="surface-action hover-bg-soft h-16 rounded-[14px] flex flex-col items-center justify-center gap-1 text-token-primary"
                  >
                    <KeyRound size={17} />
                    <span className="text-[12px]">接入 AI</span>
                  </button>
                </div>
              </section>
            )}
          </div>
        </MobileBottomSheet>
      )}

      {/* 旧移动端「新建」MobileFab 已下线（2026-07-13）：它只开新建库弹窗，与下方统一
          CreatePaletteFab 撞位且内容不一致——内外「+」必须点开显示一致的新增菜单。 */}

      <div className="px-5 pb-6 w-full">
        {tab === 'sync' ? (
          <SyncManagerPanel />
        ) : loading ? (
          <MapSectionLoader text="加载中..." />
        ) : tab === 'recent' ? (
          /* 「最近」：跨库的内容时间线（自带空态引导，不落到下面的库列表管线） */
          <RecentEntriesList items={recentEntries} onOpen={openRecentEntry} />
        ) : isFilteredOut ? (
          /* 筛选无结果 */
          <div className="flex flex-col items-center justify-center py-16">
            <Search size={36} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 14 }} />
            <p className="text-[13px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {search.trim() && tagFilter.length > 0
                ? `没有同时匹配「${search}」和所选标签的知识库`
                : search.trim()
                  ? `没有匹配「${search}」的知识库`
                  : `没有匹配所选标签（${tagFilter.length} 个）的知识库`}
            </p>
            <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
              换个条件，或清除筛选看全部
            </p>
            <Button variant="ghost" size="xs" onClick={() => { setSearch(''); setTagFilter([]); }}>
              <X size={12} /> 清除筛选
            </Button>
          </div>
        ) : isEmpty && isStoreTab ? (
          /* 我的空间 / 团队空间 空状态引导 */
          <div className="flex flex-col items-center justify-center py-16">
            <Library size={48} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 20 }} />
            <p className="text-[16px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {tab === 'team' ? '团队空间' : '我的空间'}
            </p>
            <p className="text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
              集中存储文档，作为 AI 涌现探索的种子来源
            </p>
            <p className="text-[11px] mb-6 max-w-[400px] text-center leading-[1.6]" style={{ color: 'var(--text-muted)' }}>
              上传任何文档（产品文档、需求方案、竞品分析…），然后一键启动涌现探索
            </p>

            {/* 三步引导 */}
            <div className="grid grid-cols-3 gap-4 mb-8 max-w-[560px] w-full">
              {DOCUMENT_STORE_EMPTY_ACTIONS.map(s => {
                const Icon = DOCUMENT_STORE_EMPTY_ACTION_ICONS[s.key];
                return (
                  <button
                    key={s.key}
                    type="button"
                    className="surface-inset rounded-[12px] p-4 flex flex-col items-center text-center transition-colors hover:bg-[var(--bg-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
                    onClick={() => {
                      if (s.key === 'emergence') {
                        navigate('/emergence');
                        return;
                      }
                      if (s.key === 'upload') {
                        toast.info('先创建知识库', '创建后进入知识库详情页即可上传文档');
                      }
                      setShowCreate(true);
                    }}
                  >
                    <div className="w-8 h-8 rounded-full flex items-center justify-center mb-2.5"
                      style={{ background: 'var(--selection-icon-bg)', border: '1px solid var(--selection-border)' }}>
                      <Icon size={14} style={{ color: 'var(--selection-text)' }} />
                    </div>
                    <p className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{s.title}</p>
                    <p className="text-[11px] leading-[1.5]" style={{ color: 'var(--text-muted)' }}>{s.desc}</p>
                  </button>
                );
              })}
            </div>

            {tab === 'mine' ? (
              <Button variant="primary" size="md" onClick={() => setShowCreate(true)}>
                <Plus size={15} /> 创建第一个知识库
              </Button>
            ) : (
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {teamScope.teamId
                  ? '当前团队空间还没有任何知识库，从「我的空间」把知识库分享过来吧'
                  : '你加入的团队空间还没有任何知识库，从「我的空间」把知识库分享过来吧'}
              </p>
            )}
          </div>
        ) : isEmpty ? (
          /* 收藏 / 点赞 空状态 */
          <div className="flex flex-col items-center justify-center py-16">
            {tab === 'favorites'
              ? <Bookmark size={40} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 16 }} />
              : <Heart size={40} style={{ color: 'var(--text-muted)', opacity: 0.3, marginBottom: 16 }} />}
            <p className="text-[13px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              {tab === 'favorites' ? '还没有收藏' : '还没有点赞'}
            </p>
            <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
              去智识殿堂发现感兴趣的知识库吧
            </p>
            <Button variant="ghost" size="xs" onClick={() => navigate('/library')}>
              <Globe size={12} /> 浏览智识殿堂
            </Button>
          </div>
        ) : (
          /* 空间列表 - 增大卡片高度，显示文档预览 */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-stretch">
            {(currentList as (DocumentStoreWithPreview | InteractionStoreCard)[]).map((s, idx) => {
              const isInteraction = !isStoreTab;
              // 只有 owner 才能见 编辑/分享/删除 入口。
              // 团队空间下其他成员分享进来的库 ownerId !== 当前用户 → 隐藏破坏性按钮(后端也会拒)
              const canManage = isStoreTab
                && currentUserId != null
                && (s as DocumentStoreWithPreview).ownerId === currentUserId;
              const ownerName = isInteraction ? (s as InteractionStoreCard).ownerName : undefined;
              const isOwnInteraction = isInteraction && (s as InteractionStoreCard).isOwner;
              // 按库 id 稳定取色（复刻设计稿图1的多彩图标）
              const ICON_PALETTE: [string, string][] = [
                ['#3ecf8e', '#27a06b'], ['#5b8cff', '#3a6fe0'], ['#f5a623', '#d98314'],
                ['#ff6b9c', '#e0467a'], ['#7c5cff', '#5b3fd0'], ['#26c0c0', '#159191'],
              ];
              const ci = Math.abs([...s.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0)) % ICON_PALETTE.length;
              const [c1, c2] = ICON_PALETTE[ci];
              const category = s.tags?.[0];
              const CatIcon = iconForStore(s as DocumentStoreWithPreview);
              const isPinned = pinnedIds.has(s.id);
              const isFresh = isUpdatedToday(s.updatedAt);
              // 团队空间（尤其「全部」聚合视图）：标出这个库共享到了哪个团队，否则分不清归属
              const teamNames = tab === 'team'
                ? ((s as DocumentStoreWithPreview).sharedTeamIds ?? [])
                    .map(id => teamNameMap.get(id))
                    .filter((n): n is string => Boolean(n))
                : [];
              const teamLabel = teamNames.length > 0
                ? `${teamNames[0]}${teamNames.length > 1 ? ` +${teamNames.length - 1}` : ''}`
                : undefined;
              const cardMenuOpen = openCardMenuId === s.id;
              // 动作按钮 hover 才显现（触屏无 hover → 常显）；已置顶图钉 / 打开中的菜单按钮保持常显
              const hoverReveal = isMobile ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity';
              // 头像文件名字段名因来源而异：我的/团队列表是 ownerAvatarFileName，收藏/点赞列表是 ownerAvatar
              const ownerAvatarFileName = (s as DocumentStoreWithPreview).ownerAvatarFileName
                ?? (s as InteractionStoreCard).ownerAvatar;
              const hasOwner = Boolean((s as DocumentStoreWithPreview).ownerName || ownerName);
              return (
                <Fragment key={s.id}>
                {showPinnedSections && idx === 0 && sectionHeader('已置顶', pinnedCount, true)}
                {showPinnedSections && idx === pinnedCount && sectionHeader('其他', currentList.length - pinnedCount, false)}
                {/* motion.div layout：置顶/排序变化时 FLIP 位移动画，卡片肉眼可见地滑到新位置 */}
                <motion.div
                  layout
                  data-store-card={s.id}
                  className="h-full min-w-0"
                  transition={{ layout: { type: 'spring', stiffness: 360, damping: 34 } }}
                >
                <GlassCard animated interactive padding="none"
                  className={`group kb-store-card flex flex-col h-full ${movedStoreId === s.id ? 'kb-card-flash' : ''}`}
                  onClick={() => {
                    // 团队共享的库:成员也能写(后端 CanWriteStore = owner OR IsTeamShared),
                    // 所以 store tab 全部进 StoreDetailView。收藏/点赞:owner 进编辑,其他人走只读 library。
                    if (isStoreTab || isOwnInteraction) {
                      setSelectedStoreId(s.id);
                    } else {
                      navigate(`/library/${s.id}`);
                    }
                  }}>
                  <div className="p-4 pb-2 flex-1 flex flex-col"
                    onContextMenu={(e) => {
                      // 右键 = 与三点「更多」同源的完整操作菜单（Finder/Notion 惯例）
                      e.preventDefault();
                      setCardCtxMenu({ x: e.clientX, y: e.clientY, storeId: s.id });
                    }}>
                    <div className="flex items-start gap-2.5 mb-2">
                      {/* 类别图标：按模板/标签反映知识库类别（验收→清单、周报→报纸、教程→学士帽…） */}
                      <div className="w-10 h-10 rounded-[11px] flex items-center justify-center flex-shrink-0"
                        style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, boxShadow: `0 4px 12px -4px ${c1}99` }}>
                        <CatIcon size={18} style={{ color: '#fff' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="min-w-0 truncate text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {s.name}
                        </h3>
                        {/* 副标题：分类 · N 篇文章 · 体量（状态徽标移到右上角与置顶/更多同一排对齐） */}
                        <p className="text-[11px] truncate mt-0.5 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                          <span
                            className="truncate"
                            title={teamNames.length > 1 ? `共享到：${teamNames.join('、')}` : undefined}
                          >
                            {teamLabel ? `${teamLabel} · ` : category ? `${category} · ` : ownerName ? `@${ownerName} · ` : ''}{s.documentCount} 篇文章
                          </span>
                          <span aria-hidden>·</span>
                          <StoreSizeBadge storeId={s.id} variant="compact" />
                        </p>
                      </div>
                      {/* 右上角：状态与动作分离（Notion/Drive 惯例）——
                          状态（NEW / 已分享 / 同步）常显且安静；动作（置顶 / 更多）hover 才显现，
                          触屏常显。已置顶的图钉是状态，保持常显。 */}
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        {isFresh && (
                          <span
                            className="inline-flex items-center flex-shrink-0 px-1.5 rounded-full text-[9px] font-bold"
                            style={{ height: 16, lineHeight: '16px', background: 'rgba(34,197,94,0.12)', letterSpacing: '0.3px' }}
                            title={`今天有更新：${new Date(s.updatedAt).toLocaleString('zh-CN')}`}
                          >
                            <ShinyText text="NEW" speed={2.4} color="rgba(74,222,128,0.95)" shineColor="rgba(255,255,255,0.95)" spread={120} />
                          </span>
                        )}
                        {s.hasActiveShare && (
                          <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center"
                            style={{ color: 'rgba(234,179,8,0.9)' }}
                            title="该知识库已对外分享" aria-label="已分享">
                            <Share2 size={13} />
                          </span>
                        )}
                        <PeerSyncBadge store={s as DocumentStoreWithPreview} compact />
                        <button
                          className={`h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer hover-bg-soft ${isPinned ? '' : hoverReveal}`}
                          title={isPinned ? '取消置顶' : '置顶到最前'}
                          aria-label={isPinned ? '取消置顶' : '置顶'}
                          onClick={(e) => { e.stopPropagation(); handleTogglePin(s.id); }}
                          style={{ color: isPinned ? 'rgba(234,179,8,0.98)' : 'var(--text-muted)' }}>
                          <Pin size={13} style={{ fill: isPinned ? 'rgba(234,179,8,0.95)' : 'none' }} />
                        </button>
                        {canManage && (
                          <div className="relative">
                            <button
                              className={`h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer hover-bg-soft ${cardMenuOpen ? '' : hoverReveal}`}
                              title="更多操作（也可直接右键卡片）"
                              onClick={(e) => { e.stopPropagation(); setCardMenuAnchor(e.currentTarget); setOpenCardMenuId(cardMenuOpen ? null : s.id); }}
                              style={{ color: 'var(--text-muted)' }}>
                              <MoreHorizontal size={15} />
                            </button>
                            {/* createPortal 到 body，避免被卡片 / 网格的 overflow 裁掉。见 AnchoredMenu */}
                            <AnchoredMenu open={cardMenuOpen} onClose={() => setOpenCardMenuId(null)} anchorEl={cardMenuAnchor} minWidth={148}>
                                <MoreItem icon={<Users size={14} />} label="分享到团队" onClick={() => {
                                  setOpenCardMenuId(null);
                                  setShareTeamTarget({ id: s.id, name: s.name, teamIds: (s as DocumentStoreWithPreview).sharedTeamIds ?? [] });
                                }} />
                                <MoreItem icon={<Share2 size={14} />} label="分享到其他应用" onClick={() => {
                                  setOpenCardMenuId(null);
                                  void handleSystemShareStore(s.id, s.name);
                                }} />
                                <MoreItem icon={<Pencil size={14} />} label="编辑名称与标签" onClick={() => {
                                  setOpenCardMenuId(null);
                                  setEditTarget({ id: s.id, name: s.name, tags: s.tags ?? [] });
                                }} />
                                <MoreItem icon={<Trash2 size={14} />} label="删除知识库" onClick={() => {
                                  setOpenCardMenuId(null);
                                  void handleDeleteStore(s);
                                }} />
                            </AnchoredMenu>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 描述（整卡宽，复刻设计稿图1） */}
                    {s.description && (
                      <p className="text-[12px] mt-2 line-clamp-1" style={{ color: 'var(--text-secondary)' }}>
                        {s.description}
                      </p>
                    )}

                    {/* 最近文档预览列表 — 文章迷你目录（序号 + 标题 + 更多计数） */}
                    <div className="flex-1 mt-2.5 min-h-[88px]">
                      {(s.recentEntries?.length ?? 0) > 0 ? (
                        <div className="surface-inset rounded-[9px] overflow-hidden">
                          {s.recentEntries.slice(0, 3).map((entry, idx) => (
                            <div key={entry.id}
                              className={`flex items-center gap-2 px-2.5 py-1.5 transition-colors hover:bg-[var(--bg-card-hover)] ${idx === 0 ? '' : 'border-t border-token-subtle'}`}>
                              <span className="text-[10px] w-3.5 text-center flex-shrink-0 tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                {idx + 1}
                              </span>
                              <FileText size={12} className="flex-shrink-0" style={{ color: 'rgba(59,130,246,0.6)' }} />
                              <span className="min-w-0 text-[11.5px] truncate" style={{ color: 'var(--text-secondary)' }}>
                                {entry.title}
                              </span>
                              {(entry.tags?.length ?? 0) > 0 && (
                                <span className="hidden xl:flex items-center gap-1 flex-shrink-0">
                                  {entry.tags!.slice(0, 2).map(t => (
                                    <span key={t}
                                      className="inline-flex items-center h-[15px] px-1.5 rounded-[4px] text-[9px] font-medium max-w-[68px] truncate"
                                      style={{ background: 'rgba(59,130,246,0.1)', color: 'var(--accent-fg-blue)' }}>
                                      {t}
                                    </span>
                                  ))}
                                </span>
                              )}
                              <span className="flex-1" />
                              <span className="text-[10px] flex-shrink-0 tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                <RelativeTime value={entry.updatedAt} refreshIntervalMs={0} />
                              </span>
                            </div>
                          ))}
                          {(s.recentEntries?.length ?? 0) >= 3 && s.documentCount > (s.recentEntries?.length ?? 0) && (
                            <div className="flex items-center justify-center border-t border-token-subtle px-2.5 py-1.5 text-[10.5px] text-token-muted">
                              + 还有 {s.documentCount - (s.recentEntries?.length ?? 0)} 篇
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="surface-inset flex min-h-[88px] h-full items-center justify-center rounded-[9px] border-dashed">
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>知识库暂无内容</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-2.5 border-t border-token-subtle pt-3">
                      <div className="flex items-center gap-3.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <span className="inline-flex items-center gap-1" title="文档数">
                          <FileText size={11} /> {s.documentCount}
                        </span>
                        <span className="inline-flex items-center gap-1" title="浏览">
                          <Eye size={11} /> {s.viewCount ?? 0}
                        </span>
                        <span className="inline-flex items-center gap-1" title="点赞">
                          <Heart size={11} /> {s.likeCount ?? 0}
                        </span>
                      </div>
                      {/* 右下角：相对修改时间 + 贡献者头像（两者都保留，不再二选一） */}
                      <div className="flex items-center gap-2">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          <RelativeTime value={s.updatedAt} refreshIntervalMs={0} />
                        </span>
                        {hasOwner ? (
                          <UserAvatar
                            src={resolveAvatarUrl({ avatarFileName: ownerAvatarFileName })}
                            className="w-6 h-6 rounded-full"
                            style={{ border: '2px solid var(--bg-card, #1b1b1e)' }}
                          />
                        ) : (
                          <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-token-primary"
                            style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, border: '2px solid var(--bg-card, #1b1b1e)' }}>
                            {s.name.trim().charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </GlassCard>
                </motion.div>
                </Fragment>
              );
            })}
          </div>
        )}

        {/* 团队空间：团队共享的网页托管站点（默认「全部」聚合，团队以标签展示在卡上） */}
        {tab === 'team' && !loading && (
          <TeamWebPagesSection key={teamScope.teamId ?? '__all__'} teamId={teamScope.teamId} />
        )}
      </div>

      {/* 卡片右键菜单：与三点「更多」同一套操作，另加 打开 / 置顶（Finder/Notion 惯例） */}
      {cardCtxMenu && (() => {
        const s = (currentList as (DocumentStoreWithPreview | InteractionStoreCard)[])
          .find(x => x.id === cardCtxMenu.storeId);
        if (!s) return null;
        const isInteraction = !isStoreTab;
        const isOwnInteraction = isInteraction && (s as InteractionStoreCard).isOwner;
        const canManage = isStoreTab && currentUserId != null
          && (s as DocumentStoreWithPreview).ownerId === currentUserId;
        const isPinned = pinnedIds.has(s.id);
        const closeThen = (fn: () => void) => () => { setCardCtxMenu(null); fn(); };
        return (
          <StoreContextMenu x={cardCtxMenu.x} y={cardCtxMenu.y} onClose={() => setCardCtxMenu(null)}>
            <MoreItem icon={<BookOpen size={14} />} label="打开知识库" onClick={closeThen(() => {
              if (isStoreTab || isOwnInteraction) setSelectedStoreId(s.id);
              else navigate(`/library/${s.id}`);
            })} />
            <MoreItem icon={<Pin size={14} />} label={isPinned ? '取消置顶' : '置顶到最前'}
              onClick={closeThen(() => handleTogglePin(s.id))} />
            {canManage && (
              <>
                <div className="my-1 border-t border-token-subtle" />
                <MoreItem icon={<Users size={14} />} label="分享到团队" onClick={closeThen(() => {
                  setShareTeamTarget({ id: s.id, name: s.name, teamIds: (s as DocumentStoreWithPreview).sharedTeamIds ?? [] });
                })} />
                <MoreItem icon={<Share2 size={14} />} label="分享到其他应用" onClick={closeThen(() => {
                  void handleSystemShareStore(s.id, s.name);
                })} />
                <MoreItem icon={<Pencil size={14} />} label="编辑名称与标签" onClick={closeThen(() => {
                  setEditTarget({ id: s.id, name: s.name, tags: s.tags ?? [] });
                })} />
                <div className="my-1 border-t border-token-subtle" />
                <MoreItem icon={<Trash2 size={14} />} label="删除知识库" onClick={closeThen(() => {
                  void handleDeleteStore(s);
                })} />
              </>
            )}
          </StoreContextMenu>
        );
      })()}

      {/* 账号级访客统计抽屉（列表页「统计」入口，聚合全部知识库） */}
      {showAccountViewers && (
        <ViewersDrawer
          scope="account"
          onClose={() => setShowAccountViewers(false)}
          onOpenDocument={openDocument}
          onOpenStore={openStore}
        />
      )}

      {showCreate && (
        <CreateStoreDialog
          onClose={() => setShowCreate(false)}
          onCreated={async (s) => {
            // 团队空间下创建:自动 share 到当前选中的 team,避免新建后"消失"
            // (后端 createDocumentStore 不接受 teamId)。
            // 在 share 完成前先把创建态"锁住":snapshot 当前 tab/teamId,
            // 避免 await 期间用户切 tab 导致 onBack 刷错列表。
            if (tab === 'team' && teamScope.teamId) {
              const res = await setStoreTeams(s.id, [teamScope.teamId]);
              if (!res.success) toast.error('已创建,但分享到团队空间失败', res.error?.message);
            } else if (tab === 'team') {
              // 「全部」聚合视图下无明确目标团队：建到我的空间并提示手动分享
              toast.success('已创建到我的空间', '当前是「全部」视图，未自动分享到团队，可在卡片上点「分享到团队空间」');
            }
            setShowCreate(false);
            setSelectedStoreId(s.id);
          }}
        />
      )}

      {showSendToPeer && (
        <SendToPeerDialog
          resourceType="document-store"
          onClose={() => setShowSendToPeer(false)}
          onDone={() => { if (tab === 'mine') loadStores('mine', null); }}
        />
      )}

      {showOpenApi && <ConnectAiDialog onClose={() => setShowOpenApi(false)} />}

      {editTarget && (
        <EditStoreDialog
          storeId={editTarget.id}
          initialName={editTarget.name}
          initialTags={editTarget.tags}
          onClose={() => setEditTarget(null)}
          onSaved={(patch) => {
            setStores(prev => prev.map(x => x.id === editTarget.id ? { ...x, name: patch.name, tags: patch.tags } : x));
          }}
        />
      )}

      {shareTeamTarget && (
        <ShareToTeamDialog
          title={`分享「${shareTeamTarget.name}」到团队空间`}
          initialTeamIds={shareTeamTarget.teamIds}
          onConfirm={async (teamIds) => {
            await setStoreTeams(shareTeamTarget.id, teamIds);
            setStores(prev => prev.map(x => x.id === shareTeamTarget.id ? { ...x, sharedTeamIds: teamIds } : x));
            setShareTeamTarget(null);
          }}
          onClose={() => setShareTeamTarget(null)}
        />
      )}

      {/* 外层「+」FAB：与库内 FAB 同款动作、出一样的结果，只多一步"归属到哪个知识库"。
          新建知识库也归入同一入口（与工具栏按钮同源 setShowCreate，不再是两套按钮）。 */}
      <CreatePaletteFab
        onDoubleActivation={() => navigate('/document-store?quickRecord=1')}
        actions={[
          {
            key: 'store', label: '新建知识库', icon: Library, hue: 'rgba(234,179,8,0.92)',
            onClick: () => {
              if (tab === 'team' && !teamScope.teamId) {
                toast.error('请先选择团队空间', '新建的知识库会自动分享到所选团队空间');
                return;
              }
              setShowCreate(true);
            },
          },
          { key: 'doc', label: '写文章', icon: FilePlus, onClick: () => setStorePickerAction('doc') },
          { key: 'audio', label: '录音转笔记', icon: AudioLines, hue: 'rgba(34,197,94,0.92)', onClick: () => setStorePickerAction('record') },
          {
            key: 'import-group', label: '上传与导入', icon: Upload, hue: 'rgba(14,165,233,0.92)',
            children: [
              { key: 'upload', label: '上传文件', icon: FileUp, onClick: () => setStorePickerAction('upload') },
              { key: 'video', label: '解析短视频', icon: Video, hue: 'rgba(168,85,247,0.92)', onClick: () => setStorePickerAction('video') },
            ],
          },
        ]}
      />

      {/* 选库弹窗：外层动作先选"归属到哪个知识库"，选中后进库自动触发 */}
      {storePickerAction && (
        <StorePickerDialog
          actionLabel={{ doc: '写文章', record: '录音转笔记', upload: '上传文件', video: '解析短视频' }[storePickerAction]}
          // 团队 tab 下列团队库、我的 tab 下列个人库——否则团队 tab 用外层「+」只能落到个人库（Codex P2）
          scope={tab === 'team' ? 'team' : 'mine'}
          teamId={tab === 'team' ? teamScope.teamId : null}
          onPick={(storeId) => {
            setDetailInitialAction({
              id: ++detailInitialActionSequenceRef.current,
              storeId,
              action: storePickerAction,
            });
            setStorePickerAction(null);
            setSelectedStoreId(storeId);
          }}
          onCreateNew={() => {
            setStorePickerAction(null);
            setShowCreate(true);
          }}
          onClose={() => setStorePickerAction(null)}
        />
      )}
    </div>
  );
}

/**
 * 选库弹窗：外层「+」动作的"归属到哪个知识库"一步。
 * 按当前 tab 作用域列可写库（个人 / 团队），支持按名称过滤；没有库时引导先新建。
 */
function StorePickerDialog({ actionLabel, scope, teamId, onPick, onCreateNew, onClose }: {
  actionLabel: string;
  scope: 'mine' | 'team';
  teamId: string | null;
  onPick: (storeId: string) => void;
  onCreateNew: () => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<DocumentStoreWithPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    void listDocumentStoresWithPreview(1, 500, { scope, teamId }).then((res) => {
      if (res.success) setItems(res.data.items);
      setLoading(false);
    });
  }, [scope, teamId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = q.trim()
    ? items.filter(s => s.name.toLowerCase().includes(q.trim().toLowerCase()))
    : items;

  const dialog = (
    <div
      className="surface-backdrop fixed inset-0 z-[110] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="surface-popover flex flex-col rounded-[16px]"
        style={{ width: 'min(420px, 92vw)', maxHeight: '70vh' }}>
        <div className="shrink-0 px-4 pt-4 pb-3">
          <div className="flex items-center justify-between">
            <p className="text-[14px] font-semibold text-token-primary">{actionLabel}：放进哪个知识库？</p>
            <button
              onClick={onClose}
              className="hover-bg-soft flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted">
              <X size={14} />
            </button>
          </div>
          {items.length > 5 && (
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="按名称过滤…"
              autoFocus
              className="mt-2.5 w-full rounded-[10px] px-3 py-2 text-[12px] text-token-primary outline-none"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
            />
          )}
        </div>
        <div className="flex-1 px-2 pb-2" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading ? (
            <div className="flex items-center justify-center py-10"><MapSpinner size={15} /></div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-[12px] text-token-muted">{items.length === 0 ? '还没有知识库' : '没有匹配的知识库'}</p>
              {items.length === 0 && (
                <Button variant="primary" size="sm" onClick={onCreateNew}><Plus size={13} /> 先新建一个</Button>
              )}
            </div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => onPick(s.id)}
                className="hover-bg-soft flex w-full cursor-pointer items-center justify-between gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Library size={14} className="shrink-0 text-token-muted" />
                  <span className="truncate text-[13px] text-token-primary">{s.name}</span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-token-muted">{s.documentCount} 篇</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(dialog, document.body);
}
