import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Library,
  Plus,
  Upload,
  ArrowLeft,
  X,
  Rss,
  Github,
  Sparkle,
  Trash2,
  FileText,
  Share2,
  Globe,
  Lock as GlobeLock,
  Copy,
  Link as LinkIcon,
  Calendar,
  Eye,
  Pencil,
  Heart,
  Bookmark,
  Users,
  ArrowUpRight,
  Wand2,
  CheckCircle2,
  AlertCircle,
  Search,
  ArrowUpDown,
  Check,
  Tag,
  BarChart3,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { TeamScopeBar, type TeamScope } from '@/components/team/TeamScopeBar';
import { useTeamStore } from '@/stores/teamStore';
import { useAuthStore } from '@/stores/authStore';
import { AnimatePresence } from 'motion/react';
import CountUp from '@/components/reactbits/CountUp';
import {
  listDocumentStoresWithPreview,
  createDocumentStore,
  deleteDocumentStore,
  listDocumentEntries,
  uploadDocumentFile,
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
  updateDocumentContent,
  setFolderPrimaryChild,
  rebuildContentIndex,
  addDocumentEntry,
  updateDocumentEntry,
  updateDocumentStore,
  createDocStoreShareLink,
  listDocStoreShareLinks,
  revokeDocStoreShareLink,
  listMyFavoriteDocumentStores,
  listMyLikedDocumentStores,
  setStoreTeams,
  getStoresAnalyticsSummary,
} from '@/services';
import { ShareToTeamDialog } from '@/components/team/ShareToTeamDialog';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { resolveAvatarUrl } from '@/lib/avatar';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import { DocEmptyState } from '@/components/doc-browser/DocEmptyState';
import type {
  DocumentStore,
  DocumentStoreWithPreview,
  DocumentEntry,
  DocumentStoreShareLink,
  InteractionStoreCard,
  DocumentStoreAccountSummary,
} from '@/services/contracts/documentStore';
import type { DocBrowserEntry, EntryPreview } from '@/components/doc-browser/DocBrowser';
import { ACCEPTANCE_TEMPLATE_KEY } from '@/lib/acceptanceVerdictRegistry';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { SubscriptionDetailDrawer } from './SubscriptionDetailDrawer';
import { SubtitleGenerationDrawer } from './SubtitleGenerationDrawer';
import { ReprocessChatDrawer } from './ReprocessChatDrawer';
import { ViewersDrawer } from './ViewersDrawer';
import { useReprocessRunStore, selectStreamingByEntry } from '@/stores/reprocessRunStore';

const ACCEPT_TYPES = '.md,.txt,.pdf,.doc,.docx,.json,.yaml,.yml,.csv';

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
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6 disabled:opacity-40 disabled:cursor-not-allowed">
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
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6">
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

// ── 分享对话框（创建短链 + 列表 + 撤销） ──
function ShareDialog({ storeId, storeName, isPublic, entryId, entryTitle, onClose }: {
  storeId: string;
  storeName: string;
  isPublic: boolean;
  /** 非空 = 分享单篇文档而非整库 */
  entryId?: string;
  entryTitle?: string;
  onClose: () => void;
}) {
  const isDocShare = Boolean(entryId);
  const [links, setLinks] = useState<DocumentStoreShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(0);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    const res = await listDocStoreShareLinks(storeId);
    if (res.success) setLinks(res.data.items);
    setLoading(false);
  }, [storeId]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const handleCreate = async () => {
    setCreating(true);
    const res = await createDocStoreShareLink(storeId, { title: title.trim() || undefined, expiresInDays, entryId });
    if (res.success) {
      setLinks(prev => [res.data, ...prev]);
      setTitle('');
      toast.success('分享链接已创建', '快去复制吧');
    } else {
      toast.error('创建失败', res.error?.message);
    }
    setCreating(false);
  };

  const handleRevoke = async (linkId: string) => {
    if (!confirm('确认撤销此分享链接？已访问的用户无法再次打开。')) return;
    const res = await revokeDocStoreShareLink(linkId);
    if (res.success) {
      setLinks(prev => prev.map(l => l.id === linkId ? { ...l, isRevoked: true } : l));
      toast.success('已撤销');
    }
  };

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/s/lib/${token}`;
    navigator.clipboard.writeText(url).then(() => toast.success('链接已复制'));
  };

  const directLink = `${window.location.origin}/library/${storeId}`;

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover flex max-h-[85vh] w-[640px] max-w-[92vw] flex-col rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Share2 size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">
              {isDocShare ? `分享文档「${entryTitle ?? ''}」` : `分享「${storeName}」`}
            </span>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        {/* 公开访问直链（整库公开时；单篇分享不适用） */}
        {isPublic && !isDocShare && (
          <div className="surface-inset mb-5 rounded-[12px] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Globe size={12} className="text-token-accent" />
              <span className="text-[12px] font-semibold text-token-accent">
                公开访问链接
              </span>
            </div>
            <p className="mb-3 text-[11px] text-token-muted">
              已发布到智识殿堂，任何人都可以通过此链接访问
            </p>
            <div className="flex items-center gap-2">
              <input value={directLink} readOnly
                className="prd-field h-8 flex-1 rounded-[8px] px-3 font-mono text-[11px] outline-none" />
              <button
                onClick={() => navigator.clipboard.writeText(directLink).then(() => toast.success('已复制'))}
                className="surface-action-accent flex h-8 cursor-pointer items-center gap-1 rounded-[8px] px-3 text-[11px] font-semibold">
                <Copy size={11} /> 复制
              </button>
            </div>
          </div>
        )}

        {/* 创建分享链接 */}
        <div className="mb-5">
          <div className="mb-3 text-[12px] font-semibold text-token-primary">
            创建分享短链
          </div>
          <div className="space-y-2">
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="自定义标题（可选）"
              className="prd-field h-9 w-full rounded-[10px] px-3 text-[12px] outline-none" />
            <div className="flex gap-2">
              <select value={expiresInDays} onChange={e => setExpiresInDays(Number(e.target.value))}
                className="prd-field h-9 flex-1 cursor-pointer rounded-[10px] px-3 text-[12px] outline-none">
                <option value={0}>永不过期</option>
                <option value={1}>1 天后过期</option>
                <option value={7}>7 天后过期</option>
                <option value={30}>30 天后过期</option>
                <option value={90}>90 天后过期</option>
              </select>
              <Button variant="primary" size="xs" onClick={handleCreate} disabled={creating}>
                {creating ? <MapSpinner size={12} /> : <LinkIcon size={12} />}
                {creating ? '创建中…' : '生成链接'}
              </Button>
            </div>
          </div>
        </div>

        {/* 分享链接列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="sticky top-0 mb-3 py-1 text-[12px] font-semibold text-token-primary">
            已有分享链接 ({links.filter(l => !l.isRevoked).length})
          </div>
          {loading ? (
            <div className="flex justify-center py-6"><MapSpinner size={14} /></div>
          ) : links.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-token-muted">
              暂无分享链接，创建一个开始分享吧
            </p>
          ) : (
            <div className="space-y-2">
              {links.map(link => {
                const fullUrl = `${window.location.origin}/s/lib/${link.token}`;
                return (
                  <div
                    key={link.id}
                    className={`surface-row rounded-[10px] p-3 ${link.isRevoked ? 'opacity-60' : ''}`}
                    style={link.isRevoked ? undefined : {
                      // 已分享出去 = 标黄（左侧黄条 + 淡黄底），一眼区分「分享中 / 已撤销」
                      borderLeft: '3px solid rgba(234,179,8,0.85)',
                      background: 'rgba(234,179,8,0.06)',
                    }}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {!link.isRevoked && (
                          <span
                            className="inline-flex items-center gap-1 flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                            style={{ background: 'rgba(234,179,8,0.16)', color: 'rgba(234,179,8,0.95)', border: '1px solid rgba(234,179,8,0.3)' }}>
                            已分享
                          </span>
                        )}
                        <span className="truncate text-[12px] font-semibold text-token-primary">
                          {link.title || (link.entryId ? (link.entryTitle || '文档分享') : '整库分享')}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] text-token-muted flex-shrink-0">
                        <span className="flex items-center gap-1">
                          <Eye size={9} /> {link.viewCount}
                        </span>
                        {link.expiresAt && (
                          <span className="flex items-center gap-1">
                            <Calendar size={9} />
                            {new Date(link.expiresAt).toLocaleDateString()} 过期
                          </span>
                        )}
                      </div>
                    </div>

                    {link.isRevoked ? (
                      // 已撤销：链接失效，明示状态（不再提供复制）
                      <div className="flex items-center gap-2">
                        <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-token-muted line-through">
                          {fullUrl}
                        </span>
                        <span className="text-[11px] font-semibold text-token-error flex-shrink-0">已撤销</span>
                      </div>
                    ) : (
                      // 有效：完整链接直接平铺可选中 + 醒目「复制」，撤销降为次要操作
                      <div className="flex items-center gap-2">
                        <input
                          value={fullUrl}
                          readOnly
                          onFocus={(e) => e.currentTarget.select()}
                          className="prd-field h-8 flex-1 min-w-0 rounded-[8px] px-3 font-mono text-[11px] outline-none"
                        />
                        <button
                          onClick={() => copyLink(link.token)}
                          className="surface-action-accent flex h-8 cursor-pointer items-center gap-1 rounded-[8px] px-3 text-[11px] font-semibold flex-shrink-0">
                          <Copy size={11} /> 复制
                        </button>
                        <button
                          onClick={() => handleRevoke(link.id)}
                          className="flex h-8 cursor-pointer items-center gap-1 rounded-[8px] px-2.5 text-[11px] text-token-muted transition-colors hover:text-token-error flex-shrink-0"
                          title="撤销此分享（撤销后链接立即失效）">
                          <Trash2 size={11} /> 撤销
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 空间详情视图（文档列表 + 上传）──
function StoreDetailView({ storeId, onBack, onOpenLibrary, initialEntryId }: {
  storeId: string;
  onBack: () => void;
  onOpenLibrary: (storeId: string) => void;
  /** 进入时直接打开的文档（从账号统计点击文档跳转而来）；组件按 storeId key 重挂载，挂载时消费一次 */
  initialEntryId?: string;
}) {
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  /** 已被「单篇分享」的文档 id 集合（文件树标黄用） */
  const [sharedEntryIds, setSharedEntryIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(undefined);
  // 从账号统计点击文档跳转而来：挂载时打开指定文档（组件按 storeId key 重挂载，仅消费一次）
  useEffect(() => {
    if (initialEntryId) setSelectedEntryId(initialEntryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showSubscribe, setShowSubscribe] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /** 当前打开的订阅详情 entryId（null = 未打开） */
  const [subscriptionDetailId, setSubscriptionDetailId] = useState<string | null>(null);
  /** 当前打开的字幕生成 Drawer 目标 entry（null = 未打开） */
  const [subtitleTarget, setSubtitleTarget] = useState<{ id: string; title: string } | null>(null);
  /** 当前打开的再加工 Drawer 目标 entry（null = 未打开） */
  const [reprocessTarget, setReprocessTarget] = useState<{ id: string; title: string } | null>(null);
  /** 当前打开的「单篇文档分享」目标（null = 未打开） */
  const [docShareTarget, setDocShareTarget] = useState<{ id: string; title: string } | null>(null);
  /** 新建后需要自动进入编辑态的文档 id（用一次即清） */
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | undefined>(undefined);

  // 文件上传状态
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 替换文件：记录待替换的 entryId + 独立 file input
  const replaceTargetRef = useRef<string | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    loadStore();
    loadEntries();
  }, [loadStore, loadEntries]);

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

  // 文件上传处理
  const handleFiles = useCallback(async (files: File[]) => {
    setUploading(true);
    let successCount = 0;
    for (const file of files) {
      const res = await uploadDocumentFile(storeId, file);
      if (res.success) {
        setEntries(prev => [res.data.entry, ...prev]);
        successCount++;
      } else {
        toast.error(`上传失败: ${file.name}`, res.error?.message);
      }
    }
    if (successCount > 0) {
      toast.success(`上传完成`, `${successCount} 个文件已存储`);
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
    } else {
      toast.error('保存失败', res.error?.message);
      throw new Error(res.error?.message ?? '保存失败');
    }
  }, []);

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    const res = await getDocumentContent(entryId);
    if (!res.success) return null;
    return {
      text: res.data.hasContent ? res.data.content : null,
      fileUrl: res.data.fileUrl,
      contentType: res.data.contentType,
    };
  }, []);

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

  if (!store) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ minHeight: 'calc(100vh - 160px)' }}>
        <MapSpinner size={16} />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden"
      onDragEnter={handleDragEnter} onDragLeave={handleDragLeave}
      onDragOver={handleDragOver} onDrop={handleDrop}>
      <input ref={fileInputRef} type="file" className="hidden" accept={ACCEPT_TYPES} multiple
        onChange={e => { const f = Array.from(e.target.files ?? []); if (f.length) handleFiles(f); e.target.value = ''; }} />
      <input ref={replaceInputRef} type="file" className="hidden" accept={ACCEPT_TYPES}
        onChange={e => { const f = e.target.files?.[0]; if (f) doReplaceFile(f); e.target.value = ''; }} />

      <TabBar
        title={
          <div className="flex items-center gap-2">
            <button onClick={onBack}
              className="cursor-pointer rounded-[8px] px-2 py-1 text-[12px] text-token-muted transition-colors duration-200 hover:bg-white/6">
              <ArrowLeft size={14} />
            </button>
            <Library size={14} className="text-token-muted" />
            <span className="text-[13px] font-semibold text-token-primary">{store.name}</span>
            <span className="text-[11px] text-token-muted tabular-nums">
              <CountUp to={entries.filter(e => e.sourceType !== 'github_directory').length} from={0} duration={0.8} /> 个文档
            </span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* 发布到智识殿堂开关 */}
            {store.isPublic ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onOpenLibrary(store.id)}
                  className="surface-action-accent flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] px-3 text-[11px] font-semibold transition-all"
                  title="已发布到智识殿堂，点击前往公开页"
                >
                  <Globe size={11} />
                  已发布
                  <ArrowUpRight size={11} />
                </button>
                <button
                  onClick={handleTogglePublish}
                  disabled={publishing}
                  className="surface-action flex h-7 cursor-pointer items-center gap-1 rounded-[8px] px-2 text-[11px] font-semibold transition-all disabled:opacity-60"
                  title="取消发布"
                >
                  {publishing ? <MapSpinner size={11} /> : <GlobeLock size={11} />}
                </button>
              </div>
            ) : (
              <button
                onClick={handleTogglePublish}
                disabled={publishing}
                className="surface-action-accent flex h-7 cursor-pointer items-center gap-1.5 rounded-[8px] px-3 text-[11px] font-semibold transition-all disabled:opacity-60"
                title="发布到智识殿堂，让更多人看到"
                data-tour-id="document-store-publish"
              >
                {publishing ? <MapSpinner size={11} /> : <GlobeLock size={11} />}
                发布到智识殿堂
              </button>
            )}
            <Button variant="secondary" size="xs" onClick={() => setShowViewers(true)} title="查看本知识库的访客统计报表">
              <BarChart3 size={13} /> 统计
            </Button>
            <Button variant="secondary" size="xs" onClick={() => setShowShareDialog(true)}>
              <Share2 size={13} /> 分享
            </Button>
            <Button variant="secondary" size="xs" onClick={() => setShowSubscribe(true)}>
              <Rss size={13} /> 添加订阅
            </Button>
            <Button
              variant="primary"
              size="xs"
              data-tour-id="document-upload"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? <MapSpinner size={14} /> : <Upload size={13} />}
              {uploading ? '上传中…' : '上传文档'}
            </Button>
          </div>
        }
      />

      {/* 全局拖拽遮罩 */}
      {dragging && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
          style={{ background: 'rgba(59,130,246,0.05)', border: '3px dashed rgba(59,130,246,0.3)' }}>
          <div className="text-center">
            <Upload size={32} style={{ color: 'rgba(59,130,246,0.6)', margin: '0 auto 8px' }} />
            <p className="text-[14px] font-semibold" style={{ color: 'rgba(59,130,246,0.8)' }}>释放文件到此处上传</p>
          </div>
        </div>
      )}

      {/* 左右分栏文档浏览器 —— 与上方 TabBar 左右边缘对齐（不再额外 px-5 内缩，
          消除左上角空白竖条）；仅留 pt-3 作为与标题栏的视觉间距 */}
      <div className="flex-1 min-h-0 flex flex-col pt-3">
        <DocBrowser
          entries={entries}
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
          /* 验收报告库：最新在前（design.acceptance-kb.md §5.A）；时间默认显示由 DocBrowser 默认值兜底 */
          sortMode={store.templateKey === ACCEPTANCE_TEMPLATE_KEY ? 'created-desc' : 'default'}
          primaryEntryId={store.primaryEntryId}
          pinnedEntryIds={store.pinnedEntryIds ?? []}
          selectedEntryId={selectedEntryId}
          onSelectEntry={setSelectedEntryId}
          onBackToList={() => setSelectedEntryId(undefined)}
          onSetPrimary={handleSetPrimary}
          onTogglePin={handleTogglePin}
          onDeleteEntry={handleDeleteEntry}
          onUpdateEntryTags={handleUpdateEntryTags}
          onRenameEntry={handleRenameEntry}
          onMoveEntry={handleMoveEntry}
          onSaveContent={handleSaveContent}
          loadContent={loadContent}
          onCreateFolder={handleCreateFolder}
          onCreateDocument={handleCreateDocument}
          onUploadFile={() => fileInputRef.current?.click()}
          onSearch={handleSearch}
          onOpenSubscription={(id) => setSubscriptionDetailId(id)}
          onGenerateSubtitle={(id) => {
            const entry = entries.find(e => e.id === id);
            if (entry) setSubtitleTarget({ id, title: entry.title });
          }}
          onReprocess={(id) => {
            const entry = entries.find(e => e.id === id);
            if (entry) setReprocessTarget({ id, title: entry.title });
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
        />
      </div>

      {/* 添加订阅对话框 */}
      {showSubscribe && (
        <SubscribeDialog
          storeId={storeId}
          onClose={() => setShowSubscribe(false)}
          onCreated={(entry) => { setShowSubscribe(false); setEntries(prev => [entry, ...prev]); }}
        />
      )}

      {/* 分享对话框 */}
      {showShareDialog && (
        <ShareDialog
          storeId={storeId}
          storeName={store.name}
          isPublic={store.isPublic}
          onClose={() => setShowShareDialog(false)}
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

      {/* 文档再加工：右下角常驻任务 pill —— 关抽屉后仍可见，点击重新展开 */}
      {storeRuns.length > 0 && (
        <div className="fixed bottom-5 right-5 z-40 flex flex-col gap-2" style={{ maxWidth: '300px' }}>
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
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[8px]"
                  style={{ background: 'rgba(255,255,255,0.05)', color: accent }}>
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
                    className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[6px] text-token-muted hover:bg-white/6"
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

      {/* 文档再加工对话抽屉 */}
      <AnimatePresence>
        {reprocessTarget && (
          <ReprocessChatDrawer
            entryId={reprocessTarget.id}
            entryTitle={reprocessTarget.title}
            storeId={storeId}
            onClose={() => setReprocessTarget(null)}
            onApplied={handleReprocessApplied}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[560px] max-w-[92vw] rounded-[16px] p-6"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5)',
        }}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: `rgba(${accentColor},0.08)`, border: `1px solid rgba(${accentColor},0.12)` }}>
              {mode === 'github' ? <Github size={15} style={{ color: `rgba(${accentColor},0.85)` }} /> : <Rss size={15} style={{ color: `rgba(${accentColor},0.85)` }} />}
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>添加订阅源</span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
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
                background: mode === m ? `rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.1)` : 'rgba(255,255,255,0.02)',
                border: mode === m ? `1px solid rgba(${m === 'github' ? '130,80,223' : '234,179,8'},0.2)` : '1px solid rgba(255,255,255,0.06)',
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
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  自动同步目录下所有 .md 文件，支持增量更新（SHA 去重）
                </p>
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>标题（可选，默认用仓库名）</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="如：项目文档"
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>同步间隔</label>
                <div className="flex gap-2">
                  {[60, 360, 720, 1440].map(m => (
                    <button key={m} onClick={() => setGithubInterval(m)}
                      className="flex-1 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200"
                      style={{
                        background: githubInterval === m ? 'rgba(130,80,223,0.1)' : 'rgba(255,255,255,0.02)',
                        border: githubInterval === m ? '1px solid rgba(130,80,223,0.2)' : '1px solid rgba(255,255,255,0.06)',
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
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>源地址（RSS / 网页 URL）</label>
                <input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} placeholder="https://example.com/feed.xml"
                  className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none"
                  style={{ background: 'var(--input-bg, rgba(255,255,255,0.05))', border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>同步间隔</label>
                <div className="flex gap-2">
                  {[15, 60, 360, 1440].map(m => (
                    <button key={m} onClick={() => setInterval(m)}
                      className="flex-1 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200"
                      style={{
                        background: interval === m ? 'rgba(234,179,8,0.1)' : 'rgba(255,255,255,0.02)',
                        border: interval === m ? '1px solid rgba(234,179,8,0.2)' : '1px solid rgba(255,255,255,0.06)',
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

type StoreTab = 'mine' | 'team' | 'favorites' | 'likes';

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
  const currentUserId = useAuthStore((s) => s.user?.userId ?? null);
  const [tab, setTab] = useState<StoreTab>(() => {
    const saved = sessionStorage.getItem('doc-store-tab') as StoreTab | null;
    return saved === 'team' || saved === 'favorites' || saved === 'likes' ? saved : 'mine';
  });
  const [stores, setStores] = useState<DocumentStoreWithPreview[]>([]);
  const [favorites, setFavorites] = useState<InteractionStoreCard[]>([]);
  const [likes, setLikes] = useState<InteractionStoreCard[]>([]);
  const [loading, setLoading] = useState(true);
  // 我的 / 团队 作用域（默认我的；仅 mine 标签生效）
  const [teamScope, setTeamScope] = useState<TeamScope>(() => useTeamStore.getState().getScope('document-store'));
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: string; name: string; tags: string[] } | null>(null);
  const [shareTeamTarget, setShareTeamTarget] = useState<{ id: string; name: string; teamIds: string[] } | null>(null);
  // 使用 storeId 而不是 store 对象，这样刷新后可以从 URL 或 sessionStorage 恢复
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(() => {
    return sessionStorage.getItem('doc-store-selected-id');
  });

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
      const remembered = useTeamStore.getState().getScope('document-store');
      const effectiveTeamId = teamScope.teamId
        ?? (remembered.scope === 'team' ? remembered.teamId : null);
      if (effectiveTeamId) {
        loadStores('team', effectiveTeamId);
      } else {
        // 团队空间未选具体空间时不拉数据，明确转为空态（而非永远 loading）
        ++listFetchSeq.current; // 让任何 in-flight 请求作废
        setStores([]);
        setLoading(false);
      }
    } else if (tab === 'favorites') {
      loadFavorites();
    } else {
      loadLikes();
    }
  }, [tab, teamScope.teamId, loadStores, loadFavorites, loadLikes]);

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
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
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

  const tabs: { key: StoreTab; label: string; icon: typeof Library }[] = [
    { key: 'mine', label: '我的空间', icon: Library },
    { key: 'team', label: '团队空间', icon: Users },
    { key: 'favorites', label: '我的收藏', icon: Bookmark },
    { key: 'likes', label: '我的点赞', icon: Heart },
  ];

  const isStoreTab = tab === 'mine' || tab === 'team';
  const rawList: InteractionStoreCard[] | DocumentStoreWithPreview[] =
    isStoreTab ? stores : tab === 'favorites' ? favorites : likes;

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
      switch (sortKey) {
        case 'updated-desc': return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
        case 'created-desc': return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
        case 'name-asc': return a.name.localeCompare(b.name, 'zh-CN');
        case 'docs-desc': return (b.documentCount ?? 0) - (a.documentCount ?? 0);
      }
    };
    return [...filtered].sort(cmp);
  }, [rawList, isStoreTab, search, sortKey, tagFilter]);

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
  if (selectedStoreId) {
    return <StoreDetailView storeId={selectedStoreId} key={selectedStoreId} initialEntryId={pendingEntryId ?? undefined} onBack={() => {
      setSelectedStoreId(null);
      setPendingEntryId(null);
      // 按当前 tab 重新拉对应列表,避免从收藏/点赞返回时仍刷 stores
      if (tab === 'mine') loadStores('mine', null);
      else if (tab === 'team') {
        if (teamScope.teamId) loadStores('team', teamScope.teamId);
        else { ++listFetchSeq.current; setStores([]); setLoading(false); }
      }
      else if (tab === 'favorites') loadFavorites();
      else loadLikes();
    }} onOpenLibrary={(id) => navigate(`/library/${id}`)} />;
  }

  // 统计概览（基于未筛选的原始列表，反映"我拥有/我看到的"全量）
  const totalStores = isStoreTab ? (stores as DocumentStoreWithPreview[]).length : 0;
  const totalDocs = isStoreTab
    ? (stores as DocumentStoreWithPreview[]).reduce((sum, s) => sum + (s.documentCount ?? 0), 0)
    : 0;
  const activeSortLabel = SORT_OPTIONS.find(o => o.key === sortKey)?.label ?? '最近更新';

  const isEmpty = currentList.length === 0;
  // 区分三种空态：1) 筛选有但被过滤掉了；2) 真·空（onboarding 引导）；3) 团队空间未选 team
  // 必须确认原始数据(stores)有内容才算"被筛选掉",否则 mine/team 真空态会被误判为"筛选无结果"
  const isFilteredOut = isEmpty && isStoreTab
    && (stores as DocumentStoreWithPreview[]).length > 0
    && (search.trim().length > 0 || tagFilter.length > 0);

  // 空间列表视图
  return (
    <div className="h-full min-h-0 flex flex-col overflow-x-hidden overflow-y-auto gap-5">
      {/* 顶部 tab + 工具栏：滚动时整体悬浮（sticky）— 知识库多时菜单不消失
          -mb-5 + pb-5 用于"吃掉"父级 gap-5 间距，避免卡片从间隙缝隙里穿过 */}
      <div
        data-tour-id="library-tabs"
        className="sticky top-0 z-20 flex flex-col gap-3 pb-5 -mb-5"
        style={{
          background: 'var(--bg-base)',
          backdropFilter: 'saturate(180%) blur(8px)',
          WebkitBackdropFilter: 'saturate(180%) blur(8px)',
        }}
      >
        {/* 顶部第一排：左上角空间切换（我的空间 / 团队空间 / 我的收藏 / 我的点赞） */}
        <TabBar
          items={tabs.map(t => ({
            key: t.key,
            label: t.label,
            icon: <t.icon size={12} />,
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
            setTab(next);
          }}
        />

      {/* 第二排：按顶部 tab 联动的工具栏
          - 我的空间 / 团队空间：统计 + 搜索 + 排序 + 新建知识库（团队空间多一个 TeamScopeBar）
          - 收藏 / 点赞：不显示 */}
      {isStoreTab && (
        <div data-tour-id="library-toolbar" className="px-5 flex items-center gap-2 flex-wrap">
          {tab === 'team' && (
            <TeamScopeBar
              moduleKey="document-store"
              value={teamScope}
              onChange={setTeamScope}
              hideScopeToggle
            />
          )}
          {/* 统计概览 */}
          {/* 功能区：库数 / 文章数（左侧） */}
          <span data-tour-id="library-stats" className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            共 <strong style={{ color: 'var(--text-primary)' }}>{totalStores}</strong> 个知识库
            <span className="opacity-50 mx-1.5">·</span>
            <strong style={{ color: 'var(--text-primary)' }}>{totalDocs}</strong> 篇文章
          </span>

          {/* 搜索 */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
            <input
              data-tour-id="library-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="按名称或标签筛选…"
              className="h-8 pl-7 pr-7 rounded-[8px] text-[12px] outline-none w-[200px] focus:w-[260px] transition-all"
              style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors"
                title="清除搜索"
                style={{ color: 'var(--text-muted)' }}
              >
                <X size={10} />
              </button>
            )}
          </div>

          {/* 标签筛选（多选；激活后用主题色高亮 + 数字徽章） */}
          <div className="relative" ref={tagWrapRef}>
            <button
              type="button"
              data-tour-id="library-tag-filter"
              onClick={() => setTagOpen(o => !o)}
              disabled={tagStats.length === 0}
              className="h-8 px-2.5 rounded-[8px] text-[12px] flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={tagFilter.length > 0
                ? { background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: 'rgba(59,130,246,0.95)' }
                : { background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }}
              title={tagStats.length === 0 ? '当前没有可用的标签' : '按标签筛选'}
            >
              <Tag size={12} />
              <span>标签</span>
              {tagFilter.length > 0 && (
                <span
                  className="ml-0.5 h-4 min-w-[16px] px-1 rounded-full text-[10px] font-semibold flex items-center justify-center"
                  style={{ background: 'rgba(59,130,246,0.25)', color: 'rgba(59,130,246,0.95)' }}
                >
                  {tagFilter.length}
                </span>
              )}
            </button>
            {tagOpen && (
              <div
                className="absolute right-0 top-[36px] z-[120] w-[260px] rounded-[10px] shadow-lg overflow-hidden"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
                }}
              >
                {/* 标签搜索 */}
                <div className="p-2 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <div className="relative">
                    <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
                    <input
                      autoFocus
                      value={tagQuery}
                      onChange={(e) => setTagQuery(e.target.value)}
                      placeholder="搜索标签"
                      className="w-full h-7 pl-7 pr-2 rounded-[6px] text-[12px] outline-none"
                      style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
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
                        className="w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between hover:bg-white/6 transition-colors"
                        style={{ color: active ? 'rgba(59,130,246,0.95)' : 'var(--text-primary)' }}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-3.5 h-3.5 rounded-[3px] flex items-center justify-center flex-shrink-0"
                            style={active
                              ? { background: 'rgba(59,130,246,0.95)', border: '1px solid rgba(59,130,246,0.95)' }
                              : { background: 'transparent', border: '1px solid rgba(255,255,255,0.25)' }}
                          >
                            {active && <Check size={9} style={{ color: '#fff' }} />}
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
                  <div className="p-2 border-t flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      已选 {tagFilter.length} 个
                    </span>
                    <button
                      type="button"
                      onClick={() => setTagFilter([])}
                      className="text-[11px] px-2 h-6 rounded-[6px] hover:bg-white/6 transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      清除全部
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 排序（带高亮 active 状态，让用户一眼知道当前排序规则） */}
          <div className="relative" ref={sortWrapRef}>
            <button
              type="button"
              data-tour-id="library-sort"
              onClick={() => setSortOpen(o => !o)}
              className="h-8 px-2.5 rounded-[8px] text-[12px] flex items-center gap-1.5 transition-colors"
              style={{
                background: 'rgba(59,130,246,0.08)',
                border: '1px solid rgba(59,130,246,0.2)',
                color: 'rgba(59,130,246,0.95)',
              }}
              title="排序方式"
            >
              <ArrowUpDown size={12} />
              <span>{activeSortLabel}</span>
            </button>
            {sortOpen && (
              <div
                className="absolute right-0 top-[36px] z-[120] min-w-[160px] rounded-[10px] py-1 shadow-lg"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
                }}
              >
                {SORT_OPTIONS.map(opt => {
                  const active = opt.key === sortKey;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => { setSortKey(opt.key); setSortOpen(false); }}
                      className="w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between hover:bg-white/6 transition-colors"
                      style={{ color: active ? 'rgba(59,130,246,0.95)' : 'var(--text-primary)' }}
                    >
                      <span>{opt.label}</span>
                      {active && <Check size={12} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <span className="flex-1" />
          {/* 统计区：账号级访客总计（右侧）。数字 count-up 缓动 + 整段淡入，避免突然蹦出。 */}
          {tab === 'mine' && accountSummary && (
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
          {tab === 'mine' && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setShowAccountViewers(true)}
              title="查看全部知识库的访客统计报表（趋势 / 时段 / 排行 / 停留）"
            >
              <BarChart3 size={13} /> 统计
            </Button>
          )}
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
        </div>
      )}
      </div>

      <div className="px-5 pb-6 w-full">
        {loading ? (
          <MapSectionLoader text="加载中..." />
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
              {[
                { icon: Library, title: '创建知识库', desc: '按项目或主题组织文档' },
                { icon: Upload, title: '上传文档', desc: '拖拽文件即可上传' },
                { icon: Sparkle, title: '涌现探索', desc: '从文档出发，发现新可能' },
              ].map(s => (
                <div key={s.title} className="surface-inset rounded-[12px] p-4 flex flex-col items-center text-center">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center mb-2.5"
                    style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.12)' }}>
                    <s.icon size={14} style={{ color: 'rgba(59,130,246,0.85)' }} />
                  </div>
                  <p className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{s.title}</p>
                  <p className="text-[11px] leading-[1.5]" style={{ color: 'var(--text-muted)' }}>{s.desc}</p>
                </div>
              ))}
            </div>

            {tab === 'mine' ? (
              <Button variant="primary" size="md" onClick={() => setShowCreate(true)}>
                <Plus size={15} /> 创建第一个知识库
              </Button>
            ) : (
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {teamScope.teamId
                  ? '当前团队空间还没有任何知识库，从「我的空间」把知识库分享过来吧'
                  : '在上方选择或新建一个团队空间'}
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
            {(currentList as (DocumentStoreWithPreview | InteractionStoreCard)[]).map(s => {
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
              // 头像文件名字段名因来源而异：我的/团队列表是 ownerAvatarFileName，收藏/点赞列表是 ownerAvatar
              const ownerAvatarFileName = (s as DocumentStoreWithPreview).ownerAvatarFileName
                ?? (s as InteractionStoreCard).ownerAvatar;
              const hasOwner = Boolean((s as DocumentStoreWithPreview).ownerName || ownerName);
              return (
                <GlassCard key={s.id} animated interactive padding="none"
                  className="group flex flex-col h-full"
                  onClick={() => {
                    // 团队共享的库:成员也能写(后端 CanWriteStore = owner OR IsTeamShared),
                    // 所以 store tab 全部进 StoreDetailView。收藏/点赞:owner 进编辑,其他人走只读 library。
                    if (isStoreTab || isOwnInteraction) {
                      setSelectedStoreId(s.id);
                    } else {
                      navigate(`/library/${s.id}`);
                    }
                  }}>
                  <div className="p-4 pb-2 flex-1 flex flex-col">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <div className="w-10 h-10 rounded-[11px] flex items-center justify-center flex-shrink-0"
                          style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, boxShadow: `0 4px 12px -4px ${c1}99` }}>
                          <Library size={18} style={{ color: '#fff' }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <h3 className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {s.name}
                            </h3>
                            {s.hasActiveShare && (
                              <span
                                className="inline-flex items-center gap-1 flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                                style={{ background: 'rgba(234,179,8,0.14)', color: 'rgba(234,179,8,0.95)', border: '1px solid rgba(234,179,8,0.32)' }}
                                title="该知识库已对外分享">
                                <Share2 size={9} /> 已分享
                              </span>
                            )}
                          </div>
                          {/* 副标题行：分类(首个标签) · N 篇文章 —— 复刻设计稿图1 */}
                          <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {category ? `${category} · ` : ownerName ? `@${ownerName} · ` : ''}{s.documentCount} 篇文章
                          </p>
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            className="surface-row h-6 w-6 rounded-[6px] flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                            title="分享到团队空间"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShareTeamTarget({ id: s.id, name: s.name, teamIds: (s as DocumentStoreWithPreview).sharedTeamIds ?? [] });
                            }}
                            style={{ color: 'rgba(59,130,246,0.7)' }}>
                            <Users size={11} />
                          </button>
                          <button
                            className="surface-row h-6 w-6 rounded-[6px] flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                            title="编辑名称与标签"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditTarget({ id: s.id, name: s.name, tags: s.tags ?? [] });
                            }}
                            style={{ color: 'rgba(59,130,246,0.7)' }}>
                            <Pencil size={11} />
                          </button>
                          <button
                            className="surface-row h-6 w-6 rounded-[6px] flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                            title="删除知识库"
                            onClick={async (e) => {
                              e.stopPropagation();
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
                            }}
                            style={{ color: 'rgba(239,68,68,0.6)' }}>
                            <Trash2 size={11} />
                          </button>
                        </div>
                      )}
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
                        <div className="rounded-[9px] overflow-hidden"
                          style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          {s.recentEntries.slice(0, 3).map((entry, idx) => (
                            <div key={entry.id}
                              className="flex items-center gap-2 px-2.5 py-1.5 transition-colors hover:bg-white/[0.04]"
                              style={{ borderTop: idx === 0 ? 'none' : '1px solid rgba(255,255,255,0.05)' }}>
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
                                      style={{ background: 'rgba(59,130,246,0.1)', color: 'rgba(59,130,246,0.85)' }}>
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
                            <div className="flex items-center justify-center px-2.5 py-1.5 text-[10.5px]"
                              style={{ borderTop: '1px solid rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
                              + 还有 {s.documentCount - (s.recentEntries?.length ?? 0)} 篇
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-full rounded-[9px]"
                          style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)', minHeight: '88px' }}>
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>知识库暂无内容</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-2.5 pt-3"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
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
                          <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                            style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, border: '2px solid var(--bg-card, #1b1b1e)' }}>
                            {s.name.trim().charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </GlassCard>
              );
            })}
          </div>
        )}
      </div>

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
            }
            setShowCreate(false);
            setSelectedStoreId(s.id);
          }}
        />
      )}

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
    </div>
  );
}
