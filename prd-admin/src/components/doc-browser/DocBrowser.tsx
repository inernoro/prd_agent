import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import GithubSlugger from 'github-slugger';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// ── Markdown heading slug 辅助 ──
function childrenToText(children: unknown): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (typeof children === 'object' && children !== null && 'props' in children) {
    const props = (children as { props?: { children?: unknown } }).props;
    return childrenToText(props?.children);
  }
  return '';
}
function normalizeHeadingText(raw: string): string {
  return String(raw || '').replace(/\s+#+\s*$/, '').replace(/\s+/g, ' ').trim();
}
import {
  FileText, FolderOpen, FolderClosed, Star, Rss, Github,
  Search, ChevronRight, ChevronDown, Plus, Pin, PinOff,
  FileSearch, ToggleLeft, ToggleRight, Trash2, FilePlus, FolderPlus,
  Upload, Link, LayoutTemplate, Bot, Pencil, Save, X,
  Sparkles, Wand2,
} from 'lucide-react';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import type { FilePreviewKind } from '@/lib/fileTypeRegistry';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { systemDialog } from '@/lib/systemDialog';
import { useViewTracking } from '@/lib/useViewTracking';
import { useContentSelection, type ContentSelectionInfo } from '@/lib/useContentSelection';
import { MessageSquareText, MessageSquarePlus } from 'lucide-react';
import { InlineCommentDrawer, type PendingSelection } from '@/pages/document-store/InlineCommentDrawer';

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
  const ct = (entry.contentType ?? '').toLowerCase();
  // 文字类（markdown / 字幕 / 纯文本 / JSON / YAML 等）才能再加工
  return ct.startsWith('text/') || ct.includes('markdown') || ct === '';
}

// ── 右键/⋯ 菜单 ──
function ContextMenu({
  x, y, entry, isPrimary, isPinned,
  onSetPrimary, onTogglePin, onDelete,
  onGenerateSubtitle, onReprocess,
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
  onGenerateSubtitle?: (entryId: string) => void;
  onReprocess?: (entryId: string) => void;
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

  return (
    <div ref={menuRef} className="fixed z-50 min-w-[170px] py-1 rounded-[10px]"
      style={{
        left: x, top: y,
        background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
        border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
      }}>
      {showSubtitle && (
        <button
          className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
          style={{ color: 'rgba(216,180,254,0.95)' }}
          onClick={() => { onGenerateSubtitle!(entry.id); onClose(); }}>
          <Sparkles size={12} />
          生成字幕
        </button>
      )}
      {showReprocess && (
        <button
          className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
          style={{ color: 'rgba(96,165,250,0.95)' }}
          onClick={() => { onReprocess!(entry.id); onClose(); }}>
          <Wand2 size={12} />
          再加工
        </button>
      )}
      {(showSubtitle || showReprocess) && (
        <div className="my-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />
      )}
      {!entry.isFolder && onTogglePin && (
        <button
          className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
          style={{ color: 'var(--text-secondary)' }}
          onClick={() => { onTogglePin(entry.id, !isPinned); onClose(); }}>
          {isPinned ? <PinOff size={12} /> : <Pin size={12} />}
          {isPinned ? '取消置顶' : '置顶文档'}
        </button>
      )}
      {!entry.isFolder && onSetPrimary && !isPrimary && (
        <button
          className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
          style={{ color: 'var(--text-secondary)' }}
          onClick={() => { onSetPrimary(entry.id); onClose(); }}>
          <Star size={12} />
          设为主文档
        </button>
      )}
      {onDelete && (
        <>
          <div className="my-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />
          <button
            className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
            style={{ color: 'rgba(239,68,68,0.8)' }}
            onClick={() => { onDelete(entry.id); onClose(); }}>
            <Trash2 size={12} />
            删除
          </button>
        </>
      )}
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
  contentFirstLines,
  onToggleFolder,
  onSelectEntry,
  onContextMenu,
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
  contentFirstLines: Map<string, string>;
  onToggleFolder: (id: string) => void;
  onSelectEntry: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: DocBrowserEntry) => void;
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
        className="w-full flex items-center gap-1.5 py-[5px] text-left cursor-pointer transition-all duration-100 group"
        style={{
          paddingLeft: `${8 + depth * 16}px`,
          paddingRight: '8px',
          background: dragOver ? 'rgba(59,130,246,0.12)' : (isSelected && !isFolder ? 'rgba(59,130,246,0.08)' : 'transparent'),
          borderLeft: isSelected && !isFolder ? '2px solid rgba(59,130,246,0.6)' : '2px solid transparent',
          outline: dragOver ? '1px dashed rgba(59,130,246,0.4)' : 'none',
        }}
        title={isFolder ? '点击展开/折叠（可拖拽文件到此）' : isPrimary ? '主文档' : '右键打开菜单'}
      >
        {/* 展开/折叠箭头（仅文件夹显示，非文件夹不占位） */}
        {isFolder && (
          <span className="w-3.5 flex-shrink-0 flex items-center justify-center">
            {isOpen ? <ChevronDown size={11} style={{ color: 'var(--text-muted)' }} />
                    : <ChevronRight size={11} style={{ color: 'var(--text-muted)' }} />}
          </span>
        )}

        <EntryIcon entry={entry} isPrimary={isPrimary} isPinned={isPinned} isOpen={isOpen} />

        <span className="flex-1 truncate text-[12px]"
          style={{
            color: isSelected && !isFolder ? 'var(--text-primary)' : 'var(--text-secondary, rgba(255,255,255,0.7))',
            fontWeight: isFolder ? 500 : 400,
          }}>
          {displayTitle}
        </span>

        {/* (new) 徽标：lastChangedAt 在 24 小时以内 */}
        {!isFolder && isRecentlyChanged(entry.lastChangedAt) && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-bold"
            style={{
              background: 'rgba(34,197,94,0.12)',
              color: 'rgba(74,222,128,0.95)',
              border: '1px solid rgba(34,197,94,0.25)',
              letterSpacing: '0.3px',
            }}
            title={`最近更新: ${entry.lastChangedAt ? new Date(entry.lastChangedAt).toLocaleString('zh-CN') : ''}`}
          >
            new
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

        {isFolder && (
          <span className="text-[10px] opacity-0 group-hover:opacity-50 flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}>
            {children.length}
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
          contentFirstLines={contentFirstLines}
          onToggleFolder={onToggleFolder}
          onSelectEntry={onSelectEntry}
          onContextMenu={onContextMenu}
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

// ── Markdown 渲染器 ──

function MarkdownViewer({ content }: { content: string }) {
  // 每次 content 变化都重建 slugger，确保同名 heading 得到稳定干净的 slug
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slugger = useMemo(() => new GithubSlugger(), [content]);
  const mkHeading = useCallback(
    (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ children }: { children?: React.ReactNode }) => {
      const text = normalizeHeadingText(childrenToText(children));
      const id = text ? slugger.slug(text) : undefined;
      const classesByTag: Record<string, string> = {
        h1: 'text-[22px] font-bold mt-6 mb-3 pb-2 scroll-mt-24',
        h2: 'text-[18px] font-bold mt-5 mb-2.5 pb-1.5 scroll-mt-24',
        h3: 'text-[15px] font-semibold mt-4 mb-2 scroll-mt-24',
        h4: 'text-[14px] font-semibold mt-3 mb-1.5 scroll-mt-24',
        h5: 'text-[13px] font-semibold mt-3 mb-1 scroll-mt-24',
        h6: 'text-[12px] font-semibold mt-2 mb-1 scroll-mt-24',
      };
      const style: React.CSSProperties =
        Tag === 'h1'
          ? { borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }
          : Tag === 'h2'
            ? { borderBottom: '1px solid rgba(255,255,255,0.04)', color: 'var(--text-primary)' }
            : { color: 'var(--text-primary)' };
      return <Tag id={id} className={classesByTag[Tag]} style={style}>{children}</Tag>;
    },
    [slugger],
  );
  return (
    <div className="prose-invert max-w-none text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: mkHeading('h1'),
          h2: mkHeading('h2'),
          h3: mkHeading('h3'),
          h4: mkHeading('h4'),
          h5: mkHeading('h5'),
          h6: mkHeading('h6'),
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.78))' }}>{children}</p>,
          a: ({ href, children }) => {
            // 锚点 → SPA 内 scroll，不新开标签页
            if (href && href.startsWith('#')) {
              return (
                <a href={href} className="underline underline-offset-2" style={{ color: 'rgba(96,165,250,0.9)' }}
                  onClick={(e) => {
                    e.preventDefault();
                    const id = decodeURIComponent(href.slice(1));
                    const target = document.getElementById(id);
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}>
                  {children}
                </a>
              );
            }
            return <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: 'rgba(96,165,250,0.9)' }}>{children}</a>;
          },
          ul: ({ children, className }) => {
            const isTaskList = className?.includes('contains-task-list');
            return (
              <ul className={`${isTaskList ? 'list-none pl-2' : 'list-disc pl-5'} my-2 space-y-0.5`} style={{ color: 'var(--text-secondary)' }}>
                {children}
              </ul>
            );
          },
          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-0.5" style={{ color: 'var(--text-secondary)' }}>{children}</ol>,
          li: ({ children, className }) => {
            const isTaskItem = className?.includes('task-list-item');
            return <li className={`text-[13px] ${isTaskItem ? 'flex items-start gap-2' : ''}`}>{children}</li>;
          },
          blockquote: ({ children }) => (
            <blockquote className="my-3 pl-3 py-1" style={{ borderLeft: '3px solid rgba(96,165,250,0.3)', color: 'var(--text-muted)' }}>{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
              <table className="w-full text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="px-3 py-2 text-left font-semibold" style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}>{children}</th>,
          td: ({ children }) => <td className="px-3 py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', color: 'var(--text-secondary)' }}>{children}</td>,
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const inline = !match;
            if (inline) {
              return <code className="px-1.5 py-0.5 rounded text-[12px]" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(248,113,113,0.9)' }} {...props}>{children}</code>;
            }
            return (
              <SyntaxHighlighter
                style={oneDark}
                language={match[1]}
                PreTag="div"
                customStyle={{
                  margin: '12px 0', borderRadius: '10px', fontSize: '12px',
                  background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.04)',
                }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            );
          },
          hr: () => <hr className="my-4" style={{ borderColor: 'rgba(255,255,255,0.06)' }} />,
          img: ({ src, alt }) => (
            <img src={src} alt={alt || ''} className="max-w-full rounded-lg my-3" style={{ maxHeight: '400px', border: '1px solid rgba(255,255,255,0.06)' }} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ── 文件预览组件（按 fileTypeRegistry.preview 字段路由到不同渲染器） ──

function FilePreview({ entry, preview }: { entry?: DocBrowserEntry; preview: EntryPreview | null }) {
  if (!entry) {
    return (
      <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        请选择文件
      </div>
    );
  }
  if (entry.isFolder) {
    return (
      <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        请选择文件夹中的文件查看内容
      </div>
    );
  }

  const cfg = getFileTypeConfig(entry.title, entry.contentType);
  const kind: FilePreviewKind = cfg.preview;
  const fileUrl = preview?.fileUrl ?? null;
  const text = preview?.text ?? null;

  // 图片预览
  if (kind === 'image' && fileUrl) {
    return (
      <div className="flex items-center justify-center py-4">
        <img
          src={fileUrl}
          alt={entry.title}
          className="max-w-full max-h-[80vh] rounded-lg"
          style={{ border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}
        />
      </div>
    );
  }

  // 视频预览
  if (kind === 'video' && fileUrl) {
    return (
      <div className="flex items-center justify-center py-4">
        <video
          src={fileUrl}
          controls
          className="max-w-full max-h-[80vh] rounded-lg"
          style={{ border: '1px solid rgba(255,255,255,0.06)' }}
        />
      </div>
    );
  }

  // 音频预览
  if (kind === 'audio' && fileUrl) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <cfg.icon size={48} style={{ color: cfg.color }} />
        <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entry.title}</p>
        <audio src={fileUrl} controls className="w-[400px] max-w-full" />
      </div>
    );
  }

  // PDF 预览（iframe 嵌入，浏览器原生支持）
  if (kind === 'pdf' && fileUrl) {
    return (
      <iframe
        src={fileUrl}
        title={entry.title}
        className="w-full rounded-lg"
        style={{ height: 'calc(100vh - 220px)', border: '1px solid rgba(255,255,255,0.06)' }}
      />
    );
  }

  // 文本预览（Markdown / 提取后的 Office 文本 / 代码）
  if (kind === 'text' && text) {
    return <MarkdownViewer content={text} />;
  }

  // 兜底：有 fileUrl 但无可用预览方式 → 显示下载链接
  if (fileUrl) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <cfg.icon size={48} style={{ color: cfg.color }} />
        <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entry.title}</p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{cfg.label} 文件不支持在线预览</p>
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={entry.title}
          className="h-8 px-4 rounded-[8px] text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
          style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: 'rgba(59,130,246,0.9)' }}
        >
          下载文件
        </a>
      </div>
    );
  }

  // 完全无内容
  return (
    <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
      暂无可预览的内容
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
  emptyState,
  loading,
}: DocBrowserProps) {
  const [search, setSearch] = useState('');
  const [searchContent, setSearchContent] = useState(false);
  const [searchResults, setSearchResults] = useState<DocBrowserEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<EntryPreview | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [loadedEntryId, setLoadedEntryId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [useContentTitle, setUseContentTitle] = useState(true);
  const [contentFirstLines, setContentFirstLines] = useState<Map<string, string>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DocBrowserEntry } | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  // 左侧面板宽度（可拖拽调整，sessionStorage 持久化）
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = sessionStorage.getItem('doc-browser-sidebar-width');
    return saved ? parseInt(saved, 10) : 280;
  });
  const [resizing, setResizing] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const { selection: liveSelection, clear: clearLiveSelection } = useContentSelection(
    contentAreaRef,
    preview?.text,
    Boolean(selectedEntryId && !contentLoading && !editMode),
  );
  const trackedEntryForComments = useMemo(() => {
    if (!selectedEntryId) return null;
    const e = entries.find(x => x.id === selectedEntryId);
    return e && !e.isFolder ? e : null;
  }, [selectedEntryId, entries]);

  // 拖拽调整宽度
  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: MouseEvent) => {
      const newWidth = Math.min(560, Math.max(200, e.clientX - 20));
      setSidebarWidth(newWidth);
    };
    const handleUp = () => {
      setResizing(false);
      sessionStorage.setItem('doc-browser-sidebar-width', String(sidebarWidth));
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
  }, [resizing, sidebarWidth]);

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
    const visible = entries.filter(e => e.sourceType !== 'github_directory');
    const cMap = new Map<string, DocBrowserEntry[]>();
    const roots: DocBrowserEntry[] = [];

    for (const e of visible) {
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

    const fCount = visible.filter(e => !e.isFolder).length;

    return { rootEntries: roots, childrenMap: cMap, fileCount: fCount };
  }, [entries, primaryEntryId, pinnedSet]);

  // 从 summary 中提取第一行作为标题（去掉 # 号）
  useEffect(() => {
    const lines = new Map<string, string>();
    for (const e of entries) {
      if (e.isFolder || !e.summary) continue;
      const firstLine = e.summary.split('\n').find(l => l.trim());
      if (firstLine) {
        lines.set(e.id, firstLine.replace(/^#+\s*/, '').trim());
      }
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

  // 搜索过滤（本地 title 搜索 + 可选后端内容搜索）
  const { filteredRoots, filteredChildrenMap } = useMemo(() => {
    if (!search.trim() || searchResults !== null) {
      // 使用后端搜索结果或不搜索
      if (searchResults !== null) {
        // 后端搜索结果扁平展示
        const resultEntries = searchResults.filter(e => e.sourceType !== 'github_directory');
        return { filteredRoots: resultEntries, filteredChildrenMap: new Map() };
      }
      return { filteredRoots: rootEntries, filteredChildrenMap: childrenMap };
    }

    // 本地搜索（title + summary + 正文第一行）
    const kw = search.toLowerCase();
    const matchIds = new Set<string>();
    const entryMap = new Map(entries.map(e => [e.id, e]));
    for (const e of entries) {
      if (e.sourceType === 'github_directory') continue;
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

  // 搜索处理（防抖 + 内容搜索走后端）
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setSearchResults(null);

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (value.trim() && searchContent && onSearch) {
      setSearching(true);
      searchTimerRef.current = setTimeout(async () => {
        const results = await onSearch(value.trim(), true);
        setSearchResults(results);
        setSearching(false);
      }, 400);
    } else {
      setSearching(false);
    }
  }, [searchContent, onSearch]);

  // 切换内容搜索时重新触发
  const handleToggleContentSearch = useCallback(() => {
    const newVal = !searchContent;
    setSearchContent(newVal);
    if (search.trim() && newVal && onSearch) {
      setSearching(true);
      setSearchResults(null);
      onSearch(search.trim(), true).then(results => {
        setSearchResults(results);
        setSearching(false);
      });
    } else {
      setSearchResults(null);
      setSearching(false);
    }
  }, [searchContent, search, onSearch]);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // 搜索时自动展开所有文件夹
  useEffect(() => {
    if (search.trim() && !searchContent) {
      const allFolderIds = entries.filter(e => e.isFolder).map(e => e.id);
      setExpandedFolders(new Set(allFolderIds));
    }
  }, [search, entries, searchContent]);

  // 加载内容
  const loadEntryContent = useCallback(async (entryId: string) => {
    if (entryId === loadedEntryId) return;
    setContentLoading(true);
    setPreview(null);
    try {
      const data = await loadContent(entryId);
      setPreview(data);
      setLoadedEntryId(entryId);
    } catch {
      setPreview(null);
    }
    setContentLoading(false);
  }, [loadContent, loadedEntryId]);

  useEffect(() => {
    if (selectedEntryId) {
      const entry = entries.find(e => e.id === selectedEntryId);
      if (entry && !entry.isFolder) loadEntryContent(selectedEntryId);
    }
  }, [selectedEntryId, loadEntryContent, entries]);

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
      <div className="flex-1 flex items-center justify-center" style={{ minHeight: 'calc(100vh - 160px)' }}>
        <MapSectionLoader />
      </div>
    );
  }

  if (entries.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="flex-1 min-h-0 flex gap-0 rounded-[12px] overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.12)', minHeight: 'calc(100vh - 160px)' }}>

      {/* 左侧：文件树（液态玻璃效果 + 可拖拽调整宽度） */}
      <div className="flex flex-col flex-shrink-0 relative"
        style={{
          width: `${sidebarWidth}px`,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 100%)',
          backdropFilter: 'blur(40px) saturate(180%)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.04), 0 4px 20px -8px rgba(0,0,0,0.3)',
        }}>

        {/* 标题显示切换 + 搜索 + 新建文件夹 */}
        <div className="p-2.5 space-y-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          {/* 标题模式切换 */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setUseContentTitle(!useContentTitle)}
              className="flex items-center gap-1 text-[10px] cursor-pointer transition-colors px-1.5 py-0.5 rounded-[6px] hover:bg-white/4"
              style={{ color: 'var(--text-muted)' }}
              title={useContentTitle ? '当前：显示正文第一行为标题' : '当前：显示文件名为标题'}>
              {useContentTitle ? <ToggleRight size={12} style={{ color: 'rgba(59,130,246,0.7)' }} /> : <ToggleLeft size={12} />}
              {useContentTitle ? '正文标题' : '文件名'}
            </button>
            {onSearch && (
              <button
                onClick={handleToggleContentSearch}
                className="flex items-center gap-1 text-[10px] cursor-pointer transition-colors px-1.5 py-0.5 rounded-[6px] hover:bg-white/4"
                style={{ color: searchContent ? 'rgba(59,130,246,0.8)' : 'var(--text-muted)' }}
                title={searchContent ? '内容搜索已启用' : '点击启用内容搜索'}>
                <FileSearch size={11} />
                {searchContent ? '内容搜索' : '标题搜索'}
              </button>
            )}
          </div>

          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={search} onChange={e => handleSearchChange(e.target.value)}
                placeholder={searchContent ? '搜索文件内容...' : '搜索文件...'}
                className="w-full h-7 pl-7 pr-2.5 rounded-[8px] text-[11px] outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}
              />
              {searching && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
                  <MapSpinner size={12} />
                </span>
              )}
            </div>
            <div ref={addMenuRef} className="relative">
              <button
                onClick={() => setShowAddMenu(v => !v)}
                className="h-7 w-7 flex items-center justify-center rounded-[8px] cursor-pointer transition-colors"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                title="新建"
              >
                <Plus size={12} />
              </button>
              {showAddMenu && (
                <div className="absolute right-0 top-[30px] z-50 min-w-[180px] py-1 rounded-[10px]"
                  style={{
                    background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    backdropFilter: 'blur(40px) saturate(180%)',
                    boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
                  }}>
                  {/* 可用操作 */}
                  {onCreateDocument && (
                    <button
                      className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
                      style={{ color: 'var(--text-secondary)' }}
                      onClick={() => { onCreateDocument(); setShowAddMenu(false); }}>
                      <FilePlus size={12} style={{ color: 'rgba(59,130,246,0.8)' }} />
                      文档
                    </button>
                  )}
                  {onUploadFile && (
                    <button
                      className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
                      style={{ color: 'var(--text-secondary)' }}
                      onClick={() => { onUploadFile(); setShowAddMenu(false); }}>
                      <Upload size={12} style={{ color: 'rgba(59,130,246,0.8)' }} />
                      上传文件
                    </button>
                  )}
                  {onCreateFolder && (
                    <button
                      className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer transition-colors hover:bg-white/6"
                      style={{ color: 'var(--text-secondary)' }}
                      onClick={() => { setCreatingFolder(true); setShowAddMenu(false); }}>
                      <FolderPlus size={12} style={{ color: 'rgba(234,179,8,0.8)' }} />
                      新建文件夹
                    </button>
                  )}
                  {/* 分隔线 */}
                  <div className="my-1" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />
                  {/* 尚未实现：置灰 */}
                  <button
                    className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-not-allowed"
                    style={{ color: 'var(--text-muted)', opacity: 0.4 }}
                    disabled
                    title="暂未实现">
                    <LayoutTemplate size={12} />
                    从模板新建
                  </button>
                  <button
                    className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-not-allowed"
                    style={{ color: 'var(--text-muted)', opacity: 0.4 }}
                    disabled
                    title="暂未实现">
                    <Bot size={12} />
                    AI 帮你写
                  </button>
                  <button
                    className="w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-not-allowed"
                    style={{ color: 'var(--text-muted)', opacity: 0.4 }}
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
        <div className="flex-1 overflow-y-auto py-1">
          {filteredRoots.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {search ? (searching ? '搜索中...' : '无匹配文件') : '暂无文档'}
            </div>
          ) : filteredRoots.map(entry => (
            <TreeNode
              key={entry.id}
              entry={entry}
              childrenMap={search.trim() && searchResults !== null ? new Map() : (search.trim() ? filteredChildrenMap : childrenMap)}
              depth={0}
              selectedEntryId={selectedEntryId}
              primaryEntryId={primaryEntryId}
              pinnedEntryIds={pinnedSet}
              folderPrimaryMap={folderPrimaryMap}
              expandedFolders={expandedFolders}
              useContentTitle={useContentTitle}
              contentFirstLines={contentFirstLines}
              onToggleFolder={toggleFolder}
              onSelectEntry={onSelectEntry}
              onContextMenu={handleContextMenu}
              onMoveEntry={onMoveEntry}
              onOpenSubscription={onOpenSubscription}
            />
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
        <div className="px-3 py-2 text-[10px]" style={{ borderTop: '1px solid rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}>
          <FolderOpen size={10} className="inline mr-1" />
          {fileCount} 个文件
        </div>

        {/* 拖拽调整宽度的把手 */}
        <div
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize group/resize"
          onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
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
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
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
                  <div className="ml-auto flex items-center gap-1.5">
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
            {/* 内容区 */}
            <div ref={contentAreaRef} className="flex-1 overflow-y-auto px-6 py-4 relative">
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
              ) : (
                <FilePreview
                  entry={entries.find(e => e.id === selectedEntryId)}
                  preview={preview}
                />
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
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FileText size={32} className="mx-auto mb-3" style={{ color: 'rgba(255,255,255,0.08)' }} />
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
          onGenerateSubtitle={onGenerateSubtitle}
          onReprocess={onReprocess}
          onClose={() => setContextMenu(null)}
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
