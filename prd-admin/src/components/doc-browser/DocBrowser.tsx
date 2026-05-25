import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FilePreview } from '@/components/file-preview';
import {
  FolderOpen, FolderClosed, Star, Rss, Github,
  Search, ChevronRight, ChevronDown, Plus, Pin, PinOff,
  ToggleLeft, ToggleRight, Trash2, FilePlus, FolderPlus,
  Upload, Link, LayoutTemplate, Bot, Pencil, Save, X,
  Sparkles, Wand2, Tags, Replace, BookOpen, Settings, Share2,
} from 'lucide-react';
import { parseFrontmatter } from '@/lib/frontmatter';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { motion } from 'motion/react';
import ShinyText from '@/components/reactbits/ShinyText';
import { systemDialog } from '@/lib/systemDialog';
import { useViewTracking } from '@/lib/useViewTracking';
import { useContentSelection, type ContentSelectionInfo } from '@/lib/useContentSelection';
import { MessageSquareText, MessageSquarePlus } from 'lucide-react';
import { InlineCommentDrawer, type PendingSelection } from '@/pages/document-store/InlineCommentDrawer';
import { DocToc } from './DocToc';

// ── 类型 ──

export type EntryPreview = {
  /** 文本内容（Markdown/纯文本/提取后的 Office 文本） */
  text: string | null;
  /** 二进制文件 URL（图片/视频/音频/PDF 等） */
  fileUrl: string | null;
  /** MIME 类型 */
  contentType: string;
};

export type DocBrowserEntry = {
  id: string;
  title: string;
  parentId?: string;
  isFolder: boolean;
  sourceType: string;
  contentType: string;
  fileSize: number;
  tags?: string[];
  updatedAt?: string;
  updatedByName?: string;
  summary?: string;
  syncStatus?: string;
  /** 是否暂停（订阅类型） */
  isPaused?: boolean;
  /** 最近一次"内容真正发生变化"的时间，用于显示 (new) 徽标 */
  lastChangedAt?: string;
  metadata?: Record<string, string>;
};

export type DocBrowserProps = {
  entries: DocBrowserEntry[];
  primaryEntryId?: string;
  pinnedEntryIds?: string[];
  selectedEntryId?: string;
  onSelectEntry: (entryId: string) => void;
  onSetPrimary?: (entryId: string) => void;
  onTogglePin?: (entryId: string, pin: boolean) => void;
  onDeleteEntry?: (entryId: string) => void;
  onUpdateEntryTags?: (entryId: string, tags: string[]) => Promise<void>;
  /** 重命名条目（修改 title）。提供时右键菜单会出现"重命名"项。 */
  onRenameEntry?: (entryId: string, newTitle: string) => Promise<void>;
  onMoveEntry?: (entryId: string, targetFolderId: string | null) => void;
  onSaveContent?: (entryId: string, content: string) => Promise<void>;
  onCreateFolder?: (name: string, parentId?: string) => Promise<void>;
  onCreateDocument?: () => void;
  onUploadFile?: () => void;
  /**
   * 加载文档预览数据。
   * 返回包含文本内容 + 二进制文件 URL + MIME 类型的对象，
   * 由 DocBrowser 根据 fileTypeRegistry 的 preview 字段选择渲染方式。
   */
  loadContent: (entryId: string) => Promise<EntryPreview | null>;
  onSearch?: (keyword: string, searchContent: boolean) => Promise<DocBrowserEntry[] | null>;
  /** 点击订阅条目右侧的状态徽标时触发，用于打开订阅详情面板 */
  onOpenSubscription?: (entryId: string) => void;
  /** 点击"生成字幕"时触发（仅 audio/video/image entries 显示） */
  onGenerateSubtitle?: (entryId: string) => void;
  /** 点击"再加工"时触发（仅 text entries 显示） */
  onReprocess?: (entryId: string) => void;
  /** 点击"分享"时触发（仅文档条目显示），分享单篇文档 */
  onShareEntry?: (entryId: string) => void;
  /** 指定后：当该 entry 被选中且内容加载完成时自动进入编辑态（新建文档免再点一次「编辑」） */
  autoEditEntryId?: string;
  /** autoEdit 已被消费的回调（清除一次性标记） */
  onAutoEditConsumed?: () => void;
  /** 点击"替换文件"时触发（仅文件条目显示）。原地替换内容，保留 Id/标签/主文档。 */
  onReplaceFile?: (entryId: string) => void;
  /** 正在再加工的源文档 → 进度(0-100)。提供时对应行显示"加工中 N%"chip。 */
  reprocessingMap?: Record<string, number>;
  /** 已被「单篇分享」的文档 id 集合。命中的行显示黄色"已分享"标识（点击可查看/复制链接）。 */
  sharedEntryIds?: Set<string>;
  emptyState?: React.ReactNode;
  loading?: boolean;
};

// ── (new) 徽标判定：lastChangedAt 在 24 小时以内 ──
function isRecentlyChanged(iso?: string): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 24 * 60 * 60 * 1000;
}

// ── 文件图标（所有类型映射通过 FILE_TYPE_REGISTRY 注册表） ──

function EntryIcon({ entry, isPrimary, isPinned, isOpen }: { entry: DocBrowserEntry; isPrimary: boolean; isPinned: boolean; isOpen?: boolean }) {
  if (entry.isFolder) {
    return isOpen
      ? <FolderOpen size={14} style={{ color: 'rgba(234,179,8,0.7)' }} />
      : <FolderClosed size={14} style={{ color: 'rgba(234,179,8,0.6)' }} />;
  }
  if (isPrimary) return <Star size={14} style={{ color: 'rgba(234,179,8,0.85)' }} />;
  if (isPinned) return <Pin size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
  if (entry.sourceType === 'github_directory') return <Github size={14} style={{ color: 'rgba(130,80,223,0.7)' }} />;
  if (entry.sourceType === 'subscription') return <Rss size={14} style={{ color: 'rgba(234,179,8,0.7)' }} />;

  // 通过注册表按文件名/MIME 类型查找对应图标
  const cfg = getFileTypeConfig(entry.title, entry.contentType);
  const Icon = cfg.icon;
  return <Icon size={14} style={{ color: cfg.color }} />;
}

// ── 获取文档显示标题 ──
function getDisplayTitle(entry: DocBrowserEntry, useContentTitle: boolean, contentFirstLines: Map<string, string>): string {
  if (entry.isFolder) return entry.title;
  if (!useContentTitle) return entry.title;
  const firstLine = contentFirstLines.get(entry.id);
  if (firstLine) return firstLine;
  return entry.title;
}

// ── 判断 entry 可以发起的 Agent 操作 ──
function canGenerateSubtitle(entry: DocBrowserEntry): boolean {
  if (entry.isFolder) return false;
  const ct = (entry.contentType ?? '').toLowerCase();
  return ct.startsWith('audio/') || ct.startsWith('video/') || ct.startsWith('image/');
}

function canReprocess(entry: DocBrowserEntry): boolean {
  if (entry.isFolder) return false;
  // Reference 类条目（如"转存自网页托管"）只在 metadata 里存了 sourceUrl，
  // 本地既无 documentId 也无 attachmentId，后端 ContentReprocessProcessor
  // 在读 sourceContent 时拿不到正文会抛 "源文档无正文可供再加工"。
  // 既然必失败，直接在 UI 隐藏入口，避免误触 + 浪费一次 Run。
  if ((entry.sourceType ?? '') === 'reference' && entry.metadata?.sourceUrl) return false;
  const ct = (entry.contentType ?? '').toLowerCase();
  // 文字类（markdown / 字幕 / 纯文本 / JSON / YAML 等）才能再加工
  return ct.startsWith('text/') || ct.includes('markdown') || ct === '';
}

function formatMetaTime(iso?: string): string {
  if (!iso) return '未知时间';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── 右键/⋯ 菜单 ──
function ContextMenu({
  x, y, entry, isPrimary, isPinned,
  onSetPrimary, onTogglePin, onDelete, onEditTags, onRename,
  onGenerateSubtitle, onReprocess, onShareEntry, onReplaceFile,
  onClose,
}: {
  x: number;
  y: number;
  entry: DocBrowserEntry;
  isPrimary: boolean;
  isPinned: boolean;
  onSetPrimary?: (entryId: string) => void;
  onTogglePin?: (entryId: string, pin: boolean) => void;
  onDelete?: (entryId: string) => void;
  onEditTags?: (entry: DocBrowserEntry) => void;
  onRename?: (entry: DocBrowserEntry) => void;
  onGenerateSubtitle?: (entryId: string) => void;
  onReprocess?: (entryId: string) => void;
  onShareEntry?: (entryId: string) => void;
  onReplaceFile?: (entryId: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const showSubtitle = canGenerateSubtitle(entry) && !!onGenerateSubtitle;
  const showReprocess = canReprocess(entry) && !!onReprocess;
  const showShare = !entry.isFolder && !!onShareEntry;

  return (
    <div ref={menuRef} className="surface-popover fixed z-50 min-w-[170px] rounded-[10px] py-1" style={{ left: x, top: y }}>
      {showSubtitle && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-accent transition-colors hover:bg-white/6"
          onClick={() => { onGenerateSubtitle!(entry.id); onClose(); }}>
          <Sparkles size={12} />
          生成字幕
        </button>
      )}
      {showReprocess && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-accent transition-colors hover:bg-white/6"
          onClick={() => { onReprocess!(entry.id); onClose(); }}>
          <Wand2 size={12} />
          再加工
        </button>
      )}
      {showShare && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-accent transition-colors hover:bg-white/6"
          onClick={() => { onShareEntry!(entry.id); onClose(); }}>
          <Share2 size={12} />
          分享
        </button>
      )}
      {(showSubtitle || showReprocess || showShare) && (
        <div className="my-1 border-t border-token-subtle" />
      )}
      {onRename && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onRename(entry); onClose(); }}>
          <Pencil size={12} />
          重命名
        </button>
      )}
      {!entry.isFolder && onTogglePin && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onTogglePin(entry.id, !isPinned); onClose(); }}>
          {isPinned ? <PinOff size={12} /> : <Pin size={12} />}
          {isPinned ? '取消置顶' : '置顶文档'}
        </button>
      )}
      {!entry.isFolder && onEditTags && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onEditTags(entry); onClose(); }}>
          <Tags size={12} />
          打标签
        </button>
      )}
      {!entry.isFolder && onSetPrimary && !isPrimary && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onSetPrimary(entry.id); onClose(); }}>
          <Star size={12} />
          设为主文档
        </button>
      )}
      {!entry.isFolder
        && entry.sourceType !== 'subscription'
        && entry.sourceType !== 'github_directory'
        && onReplaceFile && (
        <button
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
          onClick={() => { onReplaceFile(entry.id); onClose(); }}>
          <Replace size={12} />
          替换文件
        </button>
      )}
      {onDelete && (
        <>
          <div className="my-1 border-t border-token-subtle" />
          <button
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-error transition-colors hover:bg-white/6"
            onClick={() => { onDelete(entry.id); onClose(); }}>
            <Trash2 size={12} />
            删除
          </button>
        </>
      )}
    </div>
  );
}

function EntryTagEditor({
  entry,
  onClose,
  onSave,
}: {
  entry: DocBrowserEntry;
  onClose: () => void;
  onSave: (tags: string[]) => Promise<void>;
}) {
  const [tags, setTags] = useState<string[]>(entry.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addTag = useCallback((raw: string) => {
    const trimmed = raw.trim().replace(/^#/, '');
    if (!trimmed) return;
    if (trimmed.length > 20) { setError('单个标签最多 20 个字'); return; }
    if (tags.includes(trimmed)) { setTagInput(''); return; }
    if (tags.length >= 10) { setError('最多 10 个标签'); return; }
    setError('');
    setTags(prev => [...prev, trimmed]);
    setTagInput('');
  }, [tags]);

  const removeTag = useCallback((target: string) => {
    setTags(prev => prev.filter(tag => tag !== target));
    setError('');
  }, []);

  const handleTagKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }, [addTag, removeTag, tagInput, tags]);

  const handleSave = useCallback(async () => {
    const pending = tagInput.trim().replace(/^#/, '');
    if (pending.length > 20) { setError('单个标签最多 20 个字'); return; }
    const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    if (finalTags.length > 10) { setError('最多 10 个标签'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(finalTags);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [onClose, onSave, tagInput, tags]);

  return (
    <div className="surface-backdrop fixed inset-0 z-[60] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover w-[440px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Tags size={14} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-token-primary">
                文档标签
              </div>
              <div className="truncate text-[11px] text-token-muted">
                {entry.title}
              </div>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">
            标签 <span className="text-[10px] text-token-muted">（回车或逗号分隔，最多 10 个）</span>
          </label>
          <div
            className="prd-field flex min-h-9 flex-wrap items-center gap-1.5 rounded-[10px] px-2 py-1.5">
            {tags.map(tag => (
              <span key={tag}
                className="surface-action-accent inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium">
                # {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="ml-0.5 flex cursor-pointer items-center justify-center"
                  title="移除">
                  <X size={10} />
                </button>
              </span>
            ))}
            <input
              autoFocus
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={tags.length === 0 ? '如：架构、需求、API' : ''}
              className="h-6 min-w-[80px] flex-1 bg-transparent text-[12px] text-token-primary outline-none"
            />
          </div>
        </div>

        {error && <p className="mb-3 text-[12px] text-token-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="surface-action h-8 cursor-pointer rounded-[8px] px-3 text-[12px] font-semibold">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="surface-action-accent h-8 cursor-pointer rounded-[8px] px-3 text-[12px] font-semibold disabled:opacity-60">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 重命名条目对话框 ──

function EntryRenameDialog({
  entry,
  onClose,
  onSave,
}: {
  entry: DocBrowserEntry;
  onClose: () => void;
  onSave: (newTitle: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(entry.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 打开后聚焦并选中整个标题，方便直接覆盖输入
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => window.clearTimeout(t);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) { setError('标题不能为空'); return; }
    if (trimmed === entry.title) { onClose(); return; }
    if (trimmed.length > 200) { setError('标题不超过 200 字'); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [entry.title, onClose, onSave, title]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [handleSave, onClose]);

  return (
    <div className="surface-backdrop fixed inset-0 z-[60] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover w-[440px] max-w-[92vw] rounded-[16px] p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <Pencil size={14} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-token-primary">重命名</div>
              <div className="truncate text-[11px] text-token-muted">{entry.title}</div>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">新标题</label>
          <div className="prd-field flex items-center rounded-[10px] px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (error) setError(''); }}
              onKeyDown={handleKeyDown}
              maxLength={200}
              placeholder="输入新标题"
              className="h-6 w-full bg-transparent text-[13px] text-token-primary outline-none"
            />
          </div>
          {error && <p className="mt-1.5 text-[11px]" style={{ color: '#ef4444' }}>{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose}
            className="h-8 px-4 rounded-[8px] text-[12px] text-token-secondary transition-colors duration-200 hover:bg-white/6">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="h-8 px-4 rounded-[8px] text-[12px] font-medium surface-action-primary inline-flex items-center gap-1.5 disabled:opacity-50">
            {saving ? <MapSpinner size={12} /> : <Save size={12} />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 树节点递归组件 ──

function TreeNode({
  entry,
  childrenMap,
  depth,
  selectedEntryId,
  primaryEntryId,
  pinnedEntryIds,
  folderPrimaryMap,
  expandedFolders,
  useContentTitle,
  showUpdatedTime,
  contentFirstLines,
  contentMatchIds,
  reprocessingMap,
  sharedEntryIds,
  onToggleFolder,
  onSelectEntry,
  onContextMenu,
  onShareEntry,
  onMoveEntry,
  onOpenSubscription,
}: {
  entry: DocBrowserEntry;
  childrenMap: Map<string, DocBrowserEntry[]>;
  depth: number;
  selectedEntryId?: string;
  primaryEntryId?: string;
  pinnedEntryIds: Set<string>;
  folderPrimaryMap: Map<string, string>;
  expandedFolders: Set<string>;
  useContentTitle: boolean;
  showUpdatedTime: boolean;
  contentFirstLines: Map<string, string>;
  contentMatchIds: Set<string>;
  reprocessingMap?: Record<string, number>;
  sharedEntryIds?: Set<string>;
  onToggleFolder: (id: string) => void;
  onSelectEntry: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: DocBrowserEntry) => void;
  onShareEntry?: (entryId: string) => void;
  onMoveEntry?: (entryId: string, targetFolderId: string | null) => void;
  onOpenSubscription?: (entryId: string) => void;
}) {
  const isFolder = entry.isFolder;
  const isOpen = expandedFolders.has(entry.id);
  const isSelected = entry.id === selectedEntryId;
  const isPrimary = entry.id === primaryEntryId || (entry.parentId ? folderPrimaryMap.get(entry.parentId) === entry.id : false);
  const isPinned = pinnedEntryIds.has(entry.id);
  const children = childrenMap.get(entry.id) ?? [];
  const displayTitle = getDisplayTitle(entry, useContentTitle, contentFirstLines);
  const reprocessing = !isFolder ? reprocessingMap?.[entry.id] : undefined;
  const isShared = !isFolder && (sharedEntryIds?.has(entry.id) ?? false);
  const [dragOver, setDragOver] = useState(false);

  return (
    <>
      <button
        onClick={() => {
          if (isFolder) onToggleFolder(entry.id);
          else onSelectEntry(entry.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, entry);
        }}
        draggable={!isFolder}
        onDragStart={(e) => {
          if (isFolder) return;
          e.dataTransfer.setData('text/plain', entry.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          setDragOver(false);
          const draggedId = e.dataTransfer.getData('text/plain');
          if (draggedId && draggedId !== entry.id && onMoveEntry) {
            onMoveEntry(draggedId, entry.id);
          }
        }}
        className={`relative w-full flex items-center gap-2 text-left cursor-pointer transition-all duration-150 group ${isFolder ? 'py-[7px]' : 'py-[6px] hover-bg-soft'}`}
        style={{
          // 整块圆角高亮：左右留 6px 内缩，hover/选中不贴边
          paddingLeft: `${10 + depth * 14}px`,
          paddingRight: '10px',
          marginLeft: '6px',
          marginRight: '6px',
          borderRadius: '9px',
          // 仅在拖拽/选中时显式给背景，未高亮时留空让 hover-bg-soft 类的 :hover 生效
          background: dragOver
            ? 'var(--accent-soft, rgba(99,102,241,0.14))'
            : (isSelected && !isFolder
                ? 'var(--accent-soft, rgba(99,102,241,0.10))'
                : undefined),
          outline: dragOver ? '1px dashed var(--accent-primary, var(--accent-gold))' : 'none',
          // 文件夹「章节分组」标题：上方单条细分隔线 + 克制留白，更接近文档站目录观感
          ...(isFolder
            ? {
                marginTop: depth === 0 ? '8px' : '4px',
                borderTop: '1px solid var(--border-faint)',
                borderRadius: 0,
              }
            : {}),
        }}
        title={isFolder ? '点击展开/折叠（可拖拽文件到此）' : isPrimary ? '主文档' : '右键打开菜单'}
      >
        {/* 选中态：圆角块内侧细 accent 条（不贴边、不粗方） */}
        {isSelected && !isFolder && (
          <span
            aria-hidden
            className="absolute left-[3px] top-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: '3px',
              height: '60%',
              background: 'var(--accent-primary, var(--accent-gold))',
              opacity: 0.85,
            }}
          />
        )}
        <EntryIcon entry={entry} isPrimary={isPrimary} isPinned={isPinned} isOpen={isOpen} />

        <span className="flex-1 truncate"
          style={{
            color: isFolder
              ? 'var(--text-muted)'
              : (isSelected ? 'var(--text-primary)' : 'var(--text-secondary)'),
            fontWeight: isFolder ? 600 : (isSelected ? 500 : 400),
            fontSize: isFolder ? '10.5px' : '12px',
            letterSpacing: isFolder ? '0.06em' : 'normal',
            textTransform: isFolder ? 'uppercase' : 'none',
          }}>
          {displayTitle}
        </span>

        {/* 已分享：黄色标识，点击打开分享弹窗查看/复制链接（不只是撤销） */}
        {isShared && (
          <span
            onClick={onShareEntry ? (e) => { e.stopPropagation(); onShareEntry(entry.id); } : undefined}
            className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-bold cursor-pointer"
            style={{
              background: 'rgba(234,179,8,0.14)',
              color: 'rgba(234,179,8,0.95)',
              border: '1px solid rgba(234,179,8,0.32)',
            }}
            title="已分享 · 点击查看或复制链接"
          >
            <Share2 size={9} /> 已分享
          </span>
        )}

        {/* 再加工进行中：源文档行显示"加工中 N%"——关闭抽屉后仍可见 */}
        {reprocessing !== undefined && (
          <span
            className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-semibold"
            style={{
              background: 'rgba(59,130,246,0.12)',
              color: 'rgba(96,165,250,0.95)',
              border: '1px solid rgba(59,130,246,0.25)',
            }}
            title="正在再加工"
          >
            <MapSpinner size={9} />
            加工中 {Math.round(reprocessing)}%
          </span>
        )}

        {!isFolder && (entry.tags?.length ?? 0) > 0 && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{
              background: 'rgba(168,85,247,0.08)',
              color: 'rgba(216,180,254,0.9)',
              border: '1px solid rgba(168,85,247,0.16)',
            }}
            title={(entry.tags ?? []).map(tag => `#${tag}`).join(' ')}
          >
            #{entry.tags![0]}
            {(entry.tags?.length ?? 0) > 1 ? ` +${entry.tags!.length - 1}` : ''}
          </span>
        )}

        {/* 更新时间副标题：由"显示设置 → 显示更新时间"开关控制，默认关 */}
        {!isFolder && showUpdatedTime && entry.updatedAt && (
          <RelativeTime
            value={entry.updatedAt}
            refreshIntervalMs={0}
            className="text-[9.5px] tabular-nums flex-shrink-0 text-token-muted"
            title={`最后更新：${new Date(entry.updatedAt).toLocaleString('zh-CN')}${entry.updatedByName ? ` · ${entry.updatedByName}` : ''}`}
          />
        )}

        {/* 内容命中标记：标题未含关键词但因正文命中被返回 */}
        {!isFolder && contentMatchIds.has(entry.id) && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-faint)',
              letterSpacing: '0.2px',
              lineHeight: 1.4,
            }}
            title="该文件因正文内容命中而被搜出（标题未含关键词）"
          >
            内容包含
          </span>
        )}

        {/* (new) 徽标：lastChangedAt 在 24 小时以内 — ShinyText 流光（reactbits） */}
        {!isFolder && isRecentlyChanged(entry.lastChangedAt) && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-bold"
            style={{
              background: 'rgba(34,197,94,0.12)',
              border: '1px solid rgba(34,197,94,0.25)',
              letterSpacing: '0.3px',
              lineHeight: 1.4,
            }}
            title={`最近更新: ${entry.lastChangedAt ? new Date(entry.lastChangedAt).toLocaleString('zh-CN') : ''}`}
          >
            <ShinyText text="NEW" speed={2.4} color="rgba(74,222,128,0.95)" shineColor="rgba(255,255,255,0.95)" spread={120} />
          </span>
        )}

        {/* 订阅状态徽标：点击打开订阅详情面板 */}
        {!isFolder && entry.sourceType === 'subscription' && onOpenSubscription && (
          <span
            onClick={(e) => { e.stopPropagation(); onOpenSubscription(entry.id); }}
            className="flex-shrink-0 cursor-pointer"
            title={
              entry.isPaused ? '订阅已暂停（点击查看详情）'
              : entry.syncStatus === 'syncing' ? '同步中（点击查看详情）'
              : entry.syncStatus === 'error' ? '同步出错（点击查看详情）'
              : '订阅源（点击查看详情）'
            }
          >
            <span
              className="block w-1.5 h-1.5 rounded-full"
              style={{
                background: entry.isPaused ? 'rgba(148,163,184,0.7)'
                  : entry.syncStatus === 'syncing' ? 'rgba(96,165,250,0.85)'
                  : entry.syncStatus === 'error' ? 'rgba(248,113,113,0.85)'
                  : 'rgba(74,222,128,0.85)',
                boxShadow: entry.syncStatus === 'syncing' ? '0 0 6px rgba(96,165,250,0.6)' : 'none',
              }}
            />
          </span>
        )}

        {isPrimary && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{ background: 'rgba(234,179,8,0.1)', color: 'rgba(234,179,8,0.8)' }}>
            README
          </span>
        )}

        {isPinned && !isPrimary && (
          <Pin size={10} className="flex-shrink-0" style={{ color: 'rgba(59,130,246,0.5)' }} />
        )}

        {/* F3：文件夹章节——右侧文件计数 + 折叠箭头（文档站目录习惯：箭头在右） */}
        {isFolder && (
          <span className="flex items-center gap-1.5 flex-shrink-0">
            <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
              {children.length}
            </span>
            {isOpen
              ? <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />
              : <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />}
          </span>
        )}
      </button>

      {/* 子节点 */}
      {isFolder && isOpen && children.map(child => (
        <TreeNode
          key={child.id}
          entry={child}
          childrenMap={childrenMap}
          depth={depth + 1}
          selectedEntryId={selectedEntryId}
          primaryEntryId={primaryEntryId}
          pinnedEntryIds={pinnedEntryIds}
          folderPrimaryMap={folderPrimaryMap}
          expandedFolders={expandedFolders}
          useContentTitle={useContentTitle}
          showUpdatedTime={showUpdatedTime}
          contentFirstLines={contentFirstLines}
          contentMatchIds={contentMatchIds}
          reprocessingMap={reprocessingMap}
          sharedEntryIds={sharedEntryIds}
          onToggleFolder={onToggleFolder}
          onSelectEntry={onSelectEntry}
          onContextMenu={onContextMenu}
          onShareEntry={onShareEntry}
          onMoveEntry={onMoveEntry}
          onOpenSubscription={onOpenSubscription}
        />
      ))}
    </>
  );
}

// ── 面包屑 ──

function Breadcrumbs({ entryId, entries }: { entryId: string; entries: DocBrowserEntry[] }) {
  const entryMap = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);

  const path = useMemo(() => {
    const result: DocBrowserEntry[] = [];
    let current = entryMap.get(entryId);
    if (!current) return result;
    result.unshift(current);
    while (current?.parentId) {
      const parent = entryMap.get(current.parentId);
      if (!parent) break;
      result.unshift(parent);
      current = parent;
    }
    return result;
  }, [entryId, entryMap]);

  if (path.length <= 1) {
    return (
      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {path[0]?.title ?? ''}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1 text-[13px] min-w-0">
      {path.map((entry, i) => (
        <span key={entry.id} className="flex items-center gap-1 min-w-0">
          {i > 0 && <ChevronRight size={11} className="flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
          <span
            className={i === path.length - 1 ? 'font-medium truncate' : 'truncate'}
            style={{ color: i === path.length - 1 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            {entry.title}
          </span>
        </span>
      ))}
    </div>
  );
}

// ── DocBrowser 主组件 ──

export function DocBrowser({
  entries,
  primaryEntryId,
  pinnedEntryIds: pinnedIds = [],
  selectedEntryId,
  onSelectEntry,
  onSetPrimary,
  onTogglePin,
  onDeleteEntry,
  onUpdateEntryTags,
  onRenameEntry,
  onMoveEntry,
  onSaveContent,
  loadContent,
  onCreateFolder,
  onCreateDocument,
  onUploadFile,
  onSearch,
  onOpenSubscription,
  onGenerateSubtitle,
  onReprocess,
  onShareEntry,
  autoEditEntryId,
  onAutoEditConsumed,
  onReplaceFile,
  reprocessingMap,
  sharedEntryIds,
  emptyState,
  loading,
}: DocBrowserProps) {
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<DocBrowserEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<EntryPreview | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  // 内容加载缓存键：以 entryId + updatedAt 组合作内容版本，替换文件后 updatedAt 变化即触发重载
  const [loadedContentKey, setLoadedContentKey] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [useContentTitle, setUseContentTitle] = useState(true);
  const [showUpdatedTime, setShowUpdatedTime] = useState<boolean>(
    () => sessionStorage.getItem('doc-browser-show-updated-time') === '1',
  );
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const [contentFirstLines, setContentFirstLines] = useState<Map<string, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DocBrowserEntry } | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [tagEditEntry, setTagEditEntry] = useState<DocBrowserEntry | null>(null);
  const [renameEntry, setRenameEntry] = useState<DocBrowserEntry | null>(null);
  // 左侧面板宽度（可拖拽调整，sessionStorage 持久化）
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = sessionStorage.getItem('doc-browser-sidebar-width');
    return saved ? parseInt(saved, 10) : 280;
  });
  const [resizing, setResizing] = useState(false);
  // 侧栏 DOM 引用 + 拖拽起始时量出的真实左边界，避免用写死偏移导致"不跟手/跳动"
  const sidebarRef = useRef<HTMLDivElement>(null);
  const resizeBaseLeftRef = useRef(0);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 搜索请求序号：异步响应回来时只有仍是最新一次搜索才采纳，丢弃陈旧响应
  const searchSeqRef = useRef(0);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  // 批次 C：只对选中的非文件夹条目埋点
  const trackedEntryId = useMemo(() => {
    if (!selectedEntryId) return null;
    const e = entries.find(x => x.id === selectedEntryId);
    return e && !e.isFolder ? selectedEntryId : null;
  }, [selectedEntryId, entries]);
  useViewTracking(trackedEntryId);

  // 批次 D：划词评论
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const [inlineCommentsOpen, setInlineCommentsOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  // 选区 offset 必须基于"实际渲染的正文"解析：文本类预览渲染的是
  // parseFrontmatter(text).body（已剥 frontmatter），若把含 frontmatter 的
  // 原文喂给 useContentSelection，选中同时出现在 frontmatter 的文字（如标题）
  // 会先匹配到 frontmatter 块，导致 offset/上下文错位、评论锚点定位错误。
  // 与 tocContent / MarkdownViewer 共用 parseFrontmatter（SSOT）。
  const selectionRawContent = useMemo(() => {
    const text = preview?.text;
    if (!text) return text ?? undefined;
    const e = entries.find(x => x.id === selectedEntryId);
    if (!e || e.isFolder) return text;
    const cfg = getFileTypeConfig(e.title, e.contentType);
    return cfg.preview === 'text' ? parseFrontmatter(text).body : text;
  }, [preview, entries, selectedEntryId]);
  const { selection: liveSelection, clear: clearLiveSelection } = useContentSelection(
    contentAreaRef,
    selectionRawContent,
    Boolean(selectedEntryId && !contentLoading && !editMode),
  );
  const trackedEntryForComments = useMemo(() => {
    if (!selectedEntryId) return null;
    const e = entries.find(x => x.id === selectedEntryId);
    return e && !e.isFolder ? e : null;
  }, [selectedEntryId, entries]);

  // F1：仅当当前预览是文本类（Markdown/提取文本）时，给右侧 TOC 提供正文
  const tocContent = useMemo(() => {
    if (!selectedEntryId) return null;
    const e = entries.find(x => x.id === selectedEntryId);
    if (!e || e.isFolder) return null;
    const text = preview?.text;
    if (!text) return null;
    const cfg = getFileTypeConfig(e.title, e.contentType);
    // 与 MarkdownViewer 一致：剥掉 frontmatter，TOC 不把 ---/title: 当标题
    return cfg.preview === 'text' ? parseFrontmatter(text).body : null;
  }, [selectedEntryId, entries, preview]);

  // 拖拽调整宽度
  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: MouseEvent) => {
      // 以拖拽开始时量出的侧栏真实左边界为基准，宽度 = 鼠标 X - 左边界，1:1 跟手
      const newWidth = Math.min(560, Math.max(200, e.clientX - resizeBaseLeftRef.current));
      setSidebarWidth(newWidth);
    };
    const handleUp = () => {
      setResizing(false);
      sessionStorage.setItem('doc-browser-sidebar-width', String(sidebarWidthRef.current));
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing]);

  // 从 entries 的 metadata 中构建每个文件夹的主文档映射
  const folderPrimaryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      if (e.isFolder && e.metadata?.primaryChildId) {
        map.set(e.id, e.metadata.primaryChildId);
      }
    }
    return map;
  }, [entries]);

  // 构建树结构
  const { rootEntries, childrenMap, fileCount } = useMemo(() => {
    // 移除对 'github_directory' 的硬编码过滤，使订阅文件夹与文件可以在树结构中正常显示。
    const cMap = new Map<string, DocBrowserEntry[]>();
    const roots: DocBrowserEntry[] = [];

    for (const e of entries) {
      if (!e.parentId) {
        roots.push(e);
      } else {
        const siblings = cMap.get(e.parentId) ?? [];
        siblings.push(e);
        cMap.set(e.parentId, siblings);
      }
    }

    // 排序：置顶优先 → 文件夹优先 → 主文档优先 → 按标题
    const sortFn = (a: DocBrowserEntry, b: DocBrowserEntry) => {
      const aPinned = pinnedSet.has(a.id) || a.id === primaryEntryId;
      const bPinned = pinnedSet.has(b.id) || b.id === primaryEntryId;
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (a.id === primaryEntryId) return -1;
      if (b.id === primaryEntryId) return 1;
      return a.title.localeCompare(b.title);
    };
    roots.sort(sortFn);
    for (const [, children] of cMap) children.sort(sortFn);

    const fCount = entries.filter(e => !e.isFolder).length;

    return { rootEntries: roots, childrenMap: cMap, fileCount: fCount };
  }, [entries, primaryEntryId, pinnedSet]);

  // 从 summary 提取显示标题：优先 YAML frontmatter 的 title（去引号），
  // 没有 frontmatter / 没有 title 时回退到 frontmatter 之后的首个正文标题，
  // 再不行回退到首个非空行（去掉行首 # 号）。与正文渲染共用 parseFrontmatter。
  useEffect(() => {
    const lines = new Map<string, string>();
    for (const e of entries) {
      if (e.isFolder || !e.summary) continue;
      const { title, body } = parseFrontmatter(e.summary);
      let display = (title ?? '').trim();
      if (!display) {
        const firstLine = body.split('\n').find(l => l.trim());
        if (firstLine) display = firstLine.replace(/^#+\s*/, '').trim();
      }
      if (display) lines.set(e.id, display);
    }
    setContentFirstLines(lines);
  }, [entries]);

  // 添加菜单 click outside
  useEffect(() => {
    if (!showAddMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setShowAddMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAddMenu]);

  // 显示设置菜单 click outside
  useEffect(() => {
    if (!showSettingsMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) setShowSettingsMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSettingsMenu]);

  // 搜索过滤（本地 title 搜索 + 可选后端内容搜索）
  const { filteredRoots, filteredChildrenMap } = useMemo(() => {
    if (!search.trim() || searchResults !== null) {
      // 使用后端搜索结果或不搜索
      if (searchResults !== null) {
        // 后端搜索结果扁平展示
        return { filteredRoots: searchResults, filteredChildrenMap: new Map() };
      }
      return { filteredRoots: rootEntries, filteredChildrenMap: childrenMap };
    }

    // 本地搜索（title + summary + 正文第一行）
    const kw = search.toLowerCase();
    const matchIds = new Set<string>();
    const entryMap = new Map(entries.map(e => [e.id, e]));
    for (const e of entries) {
      const titleMatch = e.title.toLowerCase().includes(kw);
      const summaryMatch = e.summary?.toLowerCase().includes(kw) ?? false;
      const firstLineMatch = contentFirstLines.get(e.id)?.toLowerCase().includes(kw) ?? false;
      if (titleMatch || summaryMatch || firstLineMatch) {
        matchIds.add(e.id);
        let cur = e;
        while (cur.parentId) {
          matchIds.add(cur.parentId);
          const parent = entryMap.get(cur.parentId);
          if (!parent) break;
          cur = parent;
        }
      }
    }

    const fRoots = rootEntries.filter(e => matchIds.has(e.id));
    const fMap = new Map<string, DocBrowserEntry[]>();
    for (const [parentId, children] of childrenMap) {
      const filtered = children.filter(e => matchIds.has(e.id));
      if (filtered.length > 0) fMap.set(parentId, filtered);
    }

    return { filteredRoots: fRoots, filteredChildrenMap: fMap };
  }, [search, searchResults, rootEntries, childrenMap, entries, contentFirstLines]);

  // 内容命中标记：搜索时若条目在结果中但关键词不在标题里 → 标「（内容包含）」
  const contentMatchIds = useMemo(() => {
    const ids = new Set<string>();
    const kw = search.trim().toLowerCase();
    if (!kw) return ids;
    // 后端搜索模式：searchResults 已是扁平的全部命中条目。
    // 本地搜索模式（searchResults === null）：filteredRoots 只含根级条目，
    // 文件夹内嵌套文件不在其中——必须并入 filteredChildrenMap 各 value 数组，
    // 否则展开的子文件永远拿不到「内容包含」标记（Bugbot-L）。
    let list: DocBrowserEntry[];
    if (searchResults !== null) {
      list = searchResults;
    } else {
      list = [...filteredRoots];
      for (const children of filteredChildrenMap.values()) list.push(...children);
    }
    for (const e of list) {
      if (e.isFolder) continue;
      const titleHit = (e.title ?? '').toLowerCase().includes(kw);
      const contentTitleHit = (contentFirstLines.get(e.id) ?? '').toLowerCase().includes(kw);
      if (!titleHit && !contentTitleHit) ids.add(e.id);
    }
    return ids;
  }, [search, searchResults, filteredRoots, filteredChildrenMap, contentFirstLines]);

  // 搜索处理（防抖 + 永远同时搜标题+内容，走后端；onSearch 内部会先 rebuildContentIndex）
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setSearchResults(null);

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    const trimmed = value.trim();
    // 每次输入变化都推进序号：在途响应回来时若序号已变即视为陈旧并丢弃
    const reqId = ++searchSeqRef.current;

    if (trimmed && onSearch) {
      setSearching(true);
      searchTimerRef.current = setTimeout(async () => {
        try {
          const results = await onSearch(trimmed, true);
          // 仅当这仍是最新一次搜索才采纳，否则丢弃陈旧响应
          if (reqId !== searchSeqRef.current) return;
          setSearchResults(results);
        } catch {
          if (reqId !== searchSeqRef.current) return;
          setSearchResults(null);
        } finally {
          // 仅最新请求负责收起 spinner：陈旧响应不动它（更新的在途请求会收），
          // 但 onSearch 抛错时最新请求也必须解除 loading，避免 spinner 永久卡住。
          if (reqId === searchSeqRef.current) setSearching(false);
        }
      }, 400);
    } else {
      // 搜索框被清空：立即回到本地全量树，并让任何在途响应作废
      setSearchResults(null);
      setSearching(false);
    }
  }, [onSearch]);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // 搜索时自动展开所有文件夹（后端结果为扁平列表时无需展开，但展开无副作用）
  useEffect(() => {
    if (search.trim()) {
      const allFolderIds = entries.filter(e => e.isFolder).map(e => e.id);
      setExpandedFolders(new Set(allFolderIds));
    }
  }, [search, entries]);

  // 加载内容
  // contentKey = `${entryId}:${updatedAt}`：替换文件后后端会更新 updatedAt，
  // 缓存键随之变化，命中失败 → 重新拉取新正文（修复"替换后预览不刷新"）
  const loadEntryContent = useCallback(async (entryId: string, contentKey: string) => {
    if (contentKey === loadedContentKey) return;
    setContentLoading(true);
    setPreview(null);
    try {
      const data = await loadContent(entryId);
      setPreview(data);
      setLoadedContentKey(contentKey);
    } catch {
      setPreview(null);
    }
    setContentLoading(false);
  }, [loadContent, loadedContentKey]);

  useEffect(() => {
    if (selectedEntryId) {
      const entry = entries.find(e => e.id === selectedEntryId);
      if (entry && !entry.isFolder) {
        loadEntryContent(selectedEntryId, `${selectedEntryId}:${entry.updatedAt ?? ''}`);
      }
    }
  }, [selectedEntryId, loadEntryContent, entries]);

  // 新建文档默认进入编辑态：autoEditEntryId 命中且内容加载完成后自动开编辑（一次性）
  useEffect(() => {
    if (!autoEditEntryId || selectedEntryId !== autoEditEntryId || contentLoading) return;
    // 必须确认当前 preview 已是该 entry 的内容，否则会把上一篇的旧正文带进新文档
    // （selectedEntryId 刚切换那一帧 contentLoading 仍为 false，preview 还是旧的）——Bugbot 报告
    if (!loadedContentKey || !loadedContentKey.startsWith(autoEditEntryId + ':')) return;
    const entry = entries.find(e => e.id === autoEditEntryId);
    if (!entry || entry.isFolder) return;
    const cfg = getFileTypeConfig(entry.title, entry.contentType);
    if (cfg.editable && onSaveContent) {
      setEditContent(preview?.text ?? '');
      setEditMode(true);
    }
    onAutoEditConsumed?.();
  }, [autoEditEntryId, selectedEntryId, contentLoading, loadedContentKey, preview, entries, onSaveContent, onAutoEditConsumed]);

  // 内容版本键变化时强制退出编辑态：
  // loadedContentKey = `${entryId}:${updatedAt}`。当"同一个 entry"的 updatedAt
  // 变了（左侧右键"替换文件"覆盖当前选中文档 / 外部更新），loadEntryContent
  // 已重新拉取新正文，但 editMode/editContent 仍持有替换前的旧文本，此时若用户
  // 点保存会把旧文本写回覆盖刚解析的新文档 → 替换像丢数据。这里在"同 entry 内容
  // 换了版本"时清掉编辑态，回到新内容预览。
  // 只针对"同 entry 且 key 真的变了"生效：首次加载（prev=null）、切换到不同
  // entry 都不处理（切文件本就保留既有行为，用户正常进入/中途编辑不受影响）。
  const prevLoadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevLoadedKeyRef.current;
    const cur = loadedContentKey;
    prevLoadedKeyRef.current = cur;
    if (!prev || !cur || prev === cur) return;
    const prevEntryId = prev.slice(0, prev.indexOf(':'));
    const curEntryId = cur.slice(0, cur.indexOf(':'));
    // 不同 entry = 切换文件，沿用既有行为，不在此处干预
    if (prevEntryId !== curEntryId) return;
    // 同一 entry 但版本键变了 = 内容被替换/外部更新，退出编辑态避免旧文本覆盖
    setEditMode(false);
    setEditContent('');
  }, [loadedContentKey]);

  // 自动选中主文档 + 展开其父文件夹链
  useEffect(() => {
    if (!selectedEntryId && primaryEntryId && entries.some(e => e.id === primaryEntryId)) {
      onSelectEntry(primaryEntryId);
      const entryMap = new Map(entries.map(e => [e.id, e]));
      const toExpand = new Set<string>();
      let cur = entryMap.get(primaryEntryId);
      while (cur?.parentId) {
        toExpand.add(cur.parentId);
        cur = entryMap.get(cur.parentId);
      }
      if (toExpand.size > 0) {
        setExpandedFolders(prev => new Set([...prev, ...toExpand]));
      }
    }
  }, [primaryEntryId, entries, selectedEntryId, onSelectEntry]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !onCreateFolder) return;
    await onCreateFolder(newFolderName.trim());
    setNewFolderName('');
    setCreatingFolder(false);
  }, [newFolderName, onCreateFolder]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: DocBrowserEntry) => {
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ minHeight: 0, height: '100%' }}>
        <MapSectionLoader />
      </div>
    );
  }

  if (entries.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="surface-inset flex flex-1 gap-0 overflow-hidden rounded-[12px]" style={{ minHeight: 0 }}>

      {/* 左侧：文件树（液态玻璃效果 + 可拖拽调整宽度） */}
      <div ref={sidebarRef} className="bg-token-nested relative flex flex-shrink-0 flex-col border-r border-token-subtle"
        style={{
          width: `${sidebarWidth}px`,
          minHeight: 0,
        }}>

        {/* 标题显示切换 + 搜索 + 新建文件夹 */}
        <div className="surface-panel-header space-y-2.5 px-3 py-3">
          {/* 标题模式切换（正文标题/文件名）+ 显示设置 */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setUseContentTitle(!useContentTitle)}
              className="flex cursor-pointer items-center gap-1 rounded-[7px] px-1.5 py-0.5 text-[10px] text-token-muted transition-colors hover-bg-soft"
              title={useContentTitle ? '当前：显示正文第一行为标题' : '当前：显示文件名为标题'}>
              {useContentTitle ? <ToggleRight size={12} className="text-token-accent" /> : <ToggleLeft size={12} />}
              {useContentTitle ? '正文标题' : '文件名'}
            </button>
            <div ref={settingsMenuRef} className="relative">
              <button
                onClick={() => setShowSettingsMenu(v => !v)}
                className="flex cursor-pointer items-center gap-1 rounded-[7px] px-1.5 py-0.5 text-[10px] text-token-muted transition-colors hover-bg-soft"
                title="显示设置">
                <Settings size={11} className={showUpdatedTime ? 'text-token-accent' : ''} />
                显示
              </button>
              {showSettingsMenu && (
                <div className="surface-popover absolute right-0 top-[26px] z-50 min-w-[180px] rounded-[10px] p-2">
                  <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] text-token-secondary transition-colors hover:bg-white/6">
                    <input
                      type="checkbox"
                      checked={showUpdatedTime}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setShowUpdatedTime(next);
                        sessionStorage.setItem('doc-browser-show-updated-time', next ? '1' : '0');
                      }}
                      className="h-3 w-3 cursor-pointer accent-current"
                    />
                    显示更新时间
                  </label>
                  <div className="px-2 py-1 text-[10px] text-token-muted">
                    显示每条目最后变更时间，鼠标悬停查看精确时间和作者。
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
              <input
                value={search} onChange={e => handleSearchChange(e.target.value)}
                placeholder="搜索标题或内容…"
                className="h-8 w-full rounded-[9px] pl-8 pr-3 text-[11.5px] outline-none transition-colors"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-faint)',
                  color: 'var(--text-primary)',
                }}
              />
              {searching && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                  <MapSpinner size={12} />
                </span>
              )}
            </div>
            <div ref={addMenuRef} className="relative">
              <button
                onClick={() => setShowAddMenu(v => !v)}
                className="surface-action flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] transition-colors"
                title="新建"
              >
                <Plus size={12} />
              </button>
              {showAddMenu && (
                <div className="surface-popover absolute right-0 top-[30px] z-50 min-w-[180px] rounded-[10px] py-1">
                  {/* 可用操作 */}
                  {onCreateDocument && (
                    <button
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
                      onClick={() => { onCreateDocument(); setShowAddMenu(false); }}>
                      <FilePlus size={12} className="text-token-accent" />
                      文档
                    </button>
                  )}
                  {onUploadFile && (
                    <button
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
                      onClick={() => { onUploadFile(); setShowAddMenu(false); }}>
                      <Upload size={12} className="text-token-accent" />
                      上传文件
                    </button>
                  )}
                  {onCreateFolder && (
                    <button
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-secondary transition-colors hover:bg-white/6"
                      onClick={() => { setCreatingFolder(true); setShowAddMenu(false); }}>
                      <FolderPlus size={12} className="text-token-warning" />
                      新建文件夹
                    </button>
                  )}
                  {/* 分隔线 */}
                  <div className="my-1 border-t border-token-subtle" />
                  {/* 尚未实现：置灰 */}
                  <button
                    className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-muted opacity-40"
                    disabled
                    title="暂未实现">
                    <LayoutTemplate size={12} />
                    从模板新建
                  </button>
                  <button
                    className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-muted opacity-40"
                    disabled
                    title="暂未实现">
                    <Bot size={12} />
                    AI 帮你写
                  </button>
                  <button
                    className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-[12px] text-token-muted opacity-40"
                    disabled
                    title="暂未实现">
                    <Link size={12} />
                    添加链接
                  </button>
                </div>
              )}
            </div>
          </div>
          {creatingFolder && (
            <div className="flex gap-1.5">
              <input
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
                placeholder="文件夹名称..."
                autoFocus
                className="flex-1 h-7 px-2.5 rounded-[8px] text-[11px] outline-none"
                style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.15)', color: 'var(--text-primary)' }}
              />
              <button onClick={handleCreateFolder}
                className="h-7 px-2.5 rounded-[8px] text-[10px] font-semibold cursor-pointer"
                style={{ background: 'rgba(234,179,8,0.1)', color: 'rgba(234,179,8,0.9)', border: '1px solid rgba(234,179,8,0.15)' }}>
                创建
              </button>
            </div>
          )}
        </div>

        {/* 文件树 */}
        <div
          className="flex-1 py-1"
          style={{ minHeight: 0, overflowY: 'auto' }}
        >
          {filteredRoots.length === 0 ? (
            <div className="px-3 py-10 flex flex-col items-center gap-3 text-center">
              {search ? (
                <>
                  <div className="h-10 w-10 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <Search size={18} style={{ color: 'var(--text-muted)' }} />
                  </div>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {searching ? '搜索中...' : '无匹配文件'}
                  </p>
                </>
              ) : (
                <>
                  {/* 空状态引导 — 符合 guided-exploration.md 原则 */}
                  <div className="h-12 w-12 rounded-[14px] flex items-center justify-center relative"
                    style={{
                      background: 'linear-gradient(135deg, rgba(168,85,247,0.12), rgba(59,130,246,0.10))',
                      border: '1px solid rgba(168,85,247,0.18)',
                    }}>
                    <FolderPlus size={20} style={{ color: 'rgba(216,180,254,0.95)' }} />
                  </div>
                  <div className="space-y-1">
                    <p className="text-[12px] font-semibold text-token-primary">
                      还是空的
                    </p>
                    <p className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: '220px' }}>
                      把音频/视频/PDF 拖到这里,或点击下方按钮添加第一个文档
                    </p>
                  </div>
                  {(onUploadFile || onCreateDocument) && (
                    <div className="flex items-center gap-1.5 mt-1">
                      {onUploadFile && (
                        <button onClick={onUploadFile}
                          className="text-[10.5px] px-2.5 py-1 rounded-[8px] cursor-pointer transition-all"
                          style={{
                            background: 'rgba(168,85,247,0.14)',
                            border: '1px solid rgba(168,85,247,0.25)',
                            color: 'rgba(216,180,254,0.95)',
                          }}>
                          上传文件
                        </button>
                      )}
                      {onCreateDocument && (
                        <button onClick={onCreateDocument}
                          className="text-[10.5px] px-2.5 py-1 rounded-[8px] cursor-pointer text-token-muted hover:text-token-primary"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          新建文档
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : filteredRoots.map((entry, idx) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, delay: Math.min(idx * 0.018, 0.5), ease: [0.25, 0.1, 0.25, 1] }}
            >
            <TreeNode
              entry={entry}
              childrenMap={search.trim() && searchResults !== null ? new Map() : (search.trim() ? filteredChildrenMap : childrenMap)}
              depth={0}
              selectedEntryId={selectedEntryId}
              primaryEntryId={primaryEntryId}
              pinnedEntryIds={pinnedSet}
              folderPrimaryMap={folderPrimaryMap}
              expandedFolders={expandedFolders}
              useContentTitle={useContentTitle}
              showUpdatedTime={showUpdatedTime}
              contentFirstLines={contentFirstLines}
              contentMatchIds={contentMatchIds}
              reprocessingMap={reprocessingMap}
              sharedEntryIds={sharedEntryIds}
              onToggleFolder={toggleFolder}
              onSelectEntry={onSelectEntry}
              onContextMenu={handleContextMenu}
              onShareEntry={onShareEntry}
              onMoveEntry={onMoveEntry}
              onOpenSubscription={onOpenSubscription}
            />
            </motion.div>
          ))}
        </div>
        {/* 根级放置区域 - 允许拖到根级别 */}
        {onMoveEntry && (
          <div
            className="h-2"
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => {
              e.preventDefault();
              const draggedId = e.dataTransfer.getData('text/plain');
              if (draggedId) onMoveEntry(draggedId, null);
            }}
          />
        )}

        {/* 底部统计 */}
        <div
          className="flex items-center gap-1.5 px-3.5 py-2.5 text-[10px]"
          style={{ borderTop: '1px solid var(--border-faint)', color: 'var(--text-muted)' }}
        >
          <FolderOpen size={11} style={{ opacity: 0.7 }} />
          <span className="tabular-nums">{fileCount}</span>
          <span style={{ opacity: 0.8 }}>个文件</span>
        </div>

        {/* 拖拽调整宽度的把手 */}
        <div
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize group/resize"
          onMouseDown={(e) => {
            e.preventDefault();
            resizeBaseLeftRef.current = sidebarRef.current?.getBoundingClientRect().left ?? 0;
            setResizing(true);
          }}
          style={{ zIndex: 10 }}
        >
          <div
            className="absolute top-0 left-0 h-full transition-all duration-150"
            style={{
              width: resizing ? '2px' : '1px',
              background: resizing ? 'rgba(59,130,246,0.6)' : 'transparent',
            }}
          />
          <div className="absolute top-0 left-0 h-full w-1 group-hover/resize:bg-[rgba(59,130,246,0.3)] transition-colors duration-150" />
        </div>
      </div>

      {/* 右侧：文档预览 */}
      <div
        className="flex-1 min-w-0 flex flex-col overflow-hidden"
        style={{ minHeight: 0 }}
      >
        {selectedEntryId ? (
          <>
            {/* 面包屑导航 header */}
            <div className="flex items-center gap-2 px-5 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <Breadcrumbs entryId={selectedEntryId} entries={entries} />
              {selectedEntryId === primaryEntryId && (
                <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: 'rgba(234,179,8,0.08)', color: 'rgba(234,179,8,0.8)', border: '1px solid rgba(234,179,8,0.12)' }}>
                  README
                </span>
              )}
              {pinnedSet.has(selectedEntryId) && selectedEntryId !== primaryEntryId && (
                <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: 'rgba(59,130,246,0.08)', color: 'rgba(59,130,246,0.8)', border: '1px solid rgba(59,130,246,0.12)' }}>
                  置顶
                </span>
              )}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder || (sel.tags?.length ?? 0) === 0) return null;
                return (
                  <>
                    {sel.tags!.slice(0, 4).map(tag => (
                      <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{
                          background: 'rgba(168,85,247,0.08)',
                          color: 'rgba(216,180,254,0.92)',
                          border: '1px solid rgba(168,85,247,0.16)',
                        }}>
                        #{tag}
                      </span>
                    ))}
                    {sel.tags!.length > 4 && (
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        +{sel.tags!.length - 4}
                      </span>
                    )}
                  </>
                );
              })()}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder) return null;
                // 「更新于」用 updatedAt（所有本地变更都会刷新它）；lastChangedAt 仅供 new 徽标，
                // 避免浏览器内保存只 patch updatedAt 而 lastChangedAt 滞后导致显示陈旧
                return (
                  <div className="ml-auto flex items-center gap-3 min-w-0">
                    <span
                      className="text-[10px] whitespace-nowrap"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      更新于 <RelativeTime value={sel.updatedAt} fallback="未知时间" title={`最后更新时间：${formatMetaTime(sel.updatedAt)}`} />
                    </span>
                    {/* 作者未知时不显示「更新者 未知用户」，减少噪音 */}
                    {sel.updatedByName && (
                      <span
                        className="text-[10px] truncate max-w-[160px]"
                        style={{ color: 'var(--text-muted)' }}
                        title={`更新者：${sel.updatedByName}`}
                      >
                        更新者 {sel.updatedByName}
                      </span>
                    )}
                  </div>
                );
              })()}
              {/* 当前文件最近更新徽标 + 订阅来源版本信息（git 类订阅独有） */}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder) return null;
                const recentlyChanged = isRecentlyChanged(sel.lastChangedAt);
                const isSubscription = sel.sourceType === 'subscription';
                const githubSha = sel.metadata?.github_sha;
                if (!recentlyChanged && !isSubscription) return null;
                return (
                  <>
                    {recentlyChanged && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 font-bold"
                        style={{
                          background: 'rgba(34,197,94,0.1)',
                          color: 'rgba(74,222,128,0.95)',
                          border: '1px solid rgba(34,197,94,0.25)',
                          letterSpacing: '0.3px',
                        }}
                        title={sel.lastChangedAt ? `最近更新: ${new Date(sel.lastChangedAt).toLocaleString('zh-CN')}` : ''}
                      >
                        new
                      </span>
                    )}
                    {isSubscription && onOpenSubscription && (
                      <button
                        onClick={() => onOpenSubscription(sel.id)}
                        className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                        style={{
                          background: 'rgba(59,130,246,0.08)',
                          border: '1px solid rgba(59,130,246,0.18)',
                          color: 'rgba(96,165,250,0.95)',
                        }}
                        title={githubSha ? `GitHub 版本 ${githubSha.slice(0, 7)}（点击查看同步详情）` : '查看订阅同步详情'}
                      >
                        {githubSha ? `#${githubSha.slice(0, 7)}` : '订阅信息'}
                      </button>
                    )}
                  </>
                );
              })()}
              {/* 知识库 Agent 按钮：生成字幕 / 再加工 */}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder) return null;
                const showSubtitle = canGenerateSubtitle(sel) && !!onGenerateSubtitle;
                const showReprocess = canReprocess(sel) && !!onReprocess;
                if (!showSubtitle && !showReprocess) return null;
                return (
                  <>
                    {showSubtitle && (
                      <button
                        onClick={() => onGenerateSubtitle!(sel.id)}
                        className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                        style={{
                          background: 'rgba(168,85,247,0.1)',
                          border: '1px solid rgba(168,85,247,0.22)',
                          color: 'rgba(216,180,254,0.95)',
                        }}
                        title="一键生成字幕"
                      >
                        <Sparkles size={11} /> 生成字幕
                      </button>
                    )}
                    {showReprocess && (
                      <button
                        onClick={() => onReprocess!(sel.id)}
                        className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                        style={{
                          background: 'rgba(59,130,246,0.08)',
                          border: '1px solid rgba(59,130,246,0.18)',
                          color: 'rgba(96,165,250,0.95)',
                        }}
                        title="按模板再加工文档"
                      >
                        <Wand2 size={11} /> 再加工
                      </button>
                    )}
                  </>
                );
              })()}
              {/* 批次 D：划词评论开关按钮 */}
              {trackedEntryForComments && (
                <button
                  onClick={() => setInlineCommentsOpen(true)}
                  className="h-6 px-2 rounded-[8px] text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors flex-shrink-0"
                  style={{
                    background: 'rgba(168,85,247,0.08)',
                    border: '1px solid rgba(168,85,247,0.18)',
                    color: 'rgba(216,180,254,0.95)',
                  }}
                  title="查看或添加划词评论"
                >
                  <MessageSquareText size={11} /> 评论
                </button>
              )}
              {/* 编辑/保存按钮（仅对可编辑类型显示） */}
              {(() => {
                const sel = entries.find(e => e.id === selectedEntryId);
                if (!sel || sel.isFolder || !onSaveContent) return null;
                const cfg = getFileTypeConfig(sel.title, sel.contentType);
                if (!cfg.editable) return null;
                return (
                  <div className="flex items-center gap-1.5">
                    {editMode ? (
                      <>
                        <button
                          onClick={async () => {
                            if (!selectedEntryId) return;
                            setSaving(true);
                            try {
                              await onSaveContent(selectedEntryId, editContent);
                              setPreview(prev => prev ? { ...prev, text: editContent } : prev);
                              setEditMode(false);
                            } finally {
                              setSaving(false);
                            }
                          }}
                          disabled={saving}
                          className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                          style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: 'rgba(34,197,94,0.9)' }}>
                          {saving ? <MapSpinner size={12} color="rgba(34,197,94,0.9)" /> : <Save size={11} />}
                          保存
                        </button>
                        <button
                          onClick={() => setEditMode(false)}
                          className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}>
                          <X size={11} /> 取消
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => { setEditContent(preview?.text ?? ''); setEditMode(true); }}
                        className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                        style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)', color: 'rgba(59,130,246,0.9)' }}>
                        <Pencil size={11} /> 编辑
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
            {/* 内容区 + 右侧本页章节导航（F1） */}
            <div className="flex-1 flex min-w-0" style={{ minHeight: 0 }}>
              <div
                ref={contentAreaRef}
                className="flex-1 min-w-0 px-6 py-4 relative"
                style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
              >
                {contentLoading ? (
                  <MapSectionLoader text="加载文档内容…" />
                ) : editMode ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    spellCheck={false}
                    className="w-full h-full min-h-[400px] resize-none outline-none text-[13px] font-mono leading-relaxed"
                    style={{
                      background: 'rgba(0,0,0,0.2)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      color: 'var(--text-primary)',
                    }}
                    placeholder="在此编辑文档内容..."
                  />
                ) : preview ? (
                  <FilePreview
                    entry={entries.find(e => e.id === selectedEntryId)}
                    preview={preview}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 gap-2">
                    <FolderOpen size={48} className="opacity-20 mb-2" />
                    <p className="text-[13px]">{entries.find(e => e.id === selectedEntryId)?.isFolder ? '这是一个目录' : '无法预览该文件'}</p>
                  </div>
                )}
                {/* 划词选中时的浮层"添加评论"按钮 */}
                {liveSelection && !editMode && (
                  <SelectionActionPopover
                    selection={liveSelection}
                    onAddComment={() => {
                      setPendingSelection({
                        selectedText: liveSelection.selectedText,
                        contextBefore: liveSelection.contextBefore,
                        contextAfter: liveSelection.contextAfter,
                        startOffset: liveSelection.startOffset,
                        endOffset: liveSelection.endOffset,
                      });
                      setInlineCommentsOpen(true);
                      clearLiveSelection();
                      window.getSelection()?.removeAllRanges();
                    }}
                  />
                )}
              </div>
              {/* F1：本页章节导航——仅文本类预览且非编辑态显示，无标题时组件自身返回 null */}
              {!contentLoading && !editMode && tocContent && (
                <DocToc content={tocContent} scrollContainerRef={contentAreaRef} />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <BookOpen size={34} className="mx-auto mb-3" style={{ color: 'rgba(255,255,255,0.10)' }} />
              <p className="text-[13px] mb-1" style={{ color: 'var(--text-muted)' }}>
                选择左侧文件查看内容
              </p>
              <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
                右键文件可置顶或设为主文档
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          isPrimary={contextMenu.entry.id === primaryEntryId || (contextMenu.entry.parentId ? folderPrimaryMap.get(contextMenu.entry.parentId) === contextMenu.entry.id : false)}
          isPinned={pinnedSet.has(contextMenu.entry.id)}
          onSetPrimary={onSetPrimary}
          onTogglePin={onTogglePin}
          onDelete={onDeleteEntry ? async (entryId) => {
            const target = contextMenu.entry;
            const isFolder = target.isFolder;
            const isGithub = target.sourceType === 'github_directory';
            const isSubscription = target.sourceType === 'subscription' || isGithub;
            const consequence = isGithub
              ? '所有同步来的子文档、解析正文、附件、同步日志'
              : isFolder
                ? '文件夹下所有子文档、解析正文、附件、同步日志'
                : isSubscription
                  ? '解析正文、同步日志'
                  : '解析正文、附件文件';
            const confirmed = await systemDialog.confirm({
              title: `确认删除${isFolder ? '文件夹' : '文档'}`,
              message: `删除「${target.title}」将永久清除：\n  · ${consequence}\n\n此操作不可恢复。`,
              tone: 'danger',
              confirmText: '永久删除',
              cancelText: '取消',
            });
            if (confirmed) onDeleteEntry(entryId);
          } : undefined}
          onEditTags={onUpdateEntryTags ? (entry) => setTagEditEntry(entry) : undefined}
          onRename={onRenameEntry ? (entry) => setRenameEntry(entry) : undefined}
          onGenerateSubtitle={onGenerateSubtitle}
          onReprocess={onReprocess}
          onShareEntry={onShareEntry}
          onReplaceFile={onReplaceFile}
          onClose={() => setContextMenu(null)}
        />
      )}

      {tagEditEntry && onUpdateEntryTags && (
        <EntryTagEditor
          entry={tagEditEntry}
          onClose={() => setTagEditEntry(null)}
          onSave={async (tags) => {
            await onUpdateEntryTags(tagEditEntry.id, tags);
          }}
        />
      )}

      {renameEntry && onRenameEntry && (
        <EntryRenameDialog
          entry={renameEntry}
          onClose={() => setRenameEntry(null)}
          onSave={async (newTitle) => {
            await onRenameEntry(renameEntry.id, newTitle);
          }}
        />
      )}

      {/* 批次 D：划词评论抽屉 */}
      {inlineCommentsOpen && trackedEntryForComments && (
        <InlineCommentDrawer
          entryId={trackedEntryForComments.id}
          entryTitle={trackedEntryForComments.title}
          pendingSelection={pendingSelection}
          onClearPending={() => setPendingSelection(null)}
          onLocate={(text) => {
            // 在 content area 的 DOM 里查找文本并 scroll / 高亮
            scrollToTextInContainer(contentAreaRef.current, text);
          }}
          onClose={() => {
            setInlineCommentsOpen(false);
            setPendingSelection(null);
          }}
        />
      )}
    </div>
  );
}

// ── 批次 D：划词选中时的浮层按钮 ──

function SelectionActionPopover({
  selection,
  onAddComment,
}: {
  selection: ContentSelectionInfo;
  onAddComment: () => void;
}) {
  // 浮层定位：选中区上方；跨出视口时转到下方
  const top = Math.max(8, selection.rect.top - 38);
  const left = Math.max(8, Math.min(window.innerWidth - 140, selection.rect.left + selection.rect.width / 2 - 60));
  return (
    <div
      className="fixed z-40 h-8 px-3 rounded-[10px] flex items-center gap-1.5 cursor-pointer transition-all"
      style={{
        top,
        left,
        background: 'rgba(20,20,30,0.92)',
        border: '1px solid rgba(168,85,247,0.4)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(12px)',
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAddComment}
    >
      <MessageSquarePlus size={13} style={{ color: 'rgba(216,180,254,0.95)' }} />
      <span className="text-[11px] font-semibold" style={{ color: 'rgba(216,180,254,0.95)' }}>
        添加评论
      </span>
    </div>
  );
}

/**
 * 批次 D：在容器 DOM 里查找指定文本并 scroll + 闪烁高亮。
 * 使用 TreeWalker 遍历所有 text node，找到第一处匹配即停。
 */
function scrollToTextInContainer(container: HTMLElement | null, text: string) {
  if (!container || !text) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textContent = node.textContent ?? '';
    const idx = textContent.indexOf(text);
    if (idx >= 0) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const el = (node.parentElement ?? container) as HTMLElement;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 闪烁高亮：短暂添加一个 class
      const originalBg = el.style.backgroundColor;
      const originalTransition = el.style.transition;
      el.style.transition = 'background-color 0.6s';
      el.style.backgroundColor = 'rgba(168,85,247,0.22)';
      window.setTimeout(() => {
        el.style.backgroundColor = originalBg;
        window.setTimeout(() => { el.style.transition = originalTransition; }, 600);
      }, 1200);
      return;
    }
  }
}
