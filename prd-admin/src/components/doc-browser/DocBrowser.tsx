import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  FileText, File, FolderOpen, FolderClosed, Star, Rss, Github,
  Loader2, Search, ChevronRight, ChevronDown, Plus, Pin, PinOff,
  FileSearch, ToggleLeft, ToggleRight, Trash2, FilePlus, FolderPlus,
  Upload, Link, LayoutTemplate, Bot, Pencil, Save, X,
} from 'lucide-react';

// ── 类型 ──

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
  loadContent: (entryId: string) => Promise<string | null>;
  onSearch?: (keyword: string, searchContent: boolean) => Promise<DocBrowserEntry[] | null>;
  emptyState?: React.ReactNode;
  loading?: boolean;
};

// ── 文件图标 ──

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
  if (entry.contentType?.startsWith('text/')) return <FileText size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
  return <File size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
}

// ── 获取文档显示标题 ──
function getDisplayTitle(entry: DocBrowserEntry, useContentTitle: boolean, contentFirstLines: Map<string, string>): string {
  if (entry.isFolder) return entry.title;
  if (!useContentTitle) return entry.title;
  const firstLine = contentFirstLines.get(entry.id);
  if (firstLine) return firstLine;
  return entry.title;
}

// ── 右键菜单 ──
function ContextMenu({ x, y, entry, isPrimary, isPinned, onSetPrimary, onTogglePin, onDelete, onClose }: {
  x: number;
  y: number;
  entry: DocBrowserEntry;
  isPrimary: boolean;
  isPinned: boolean;
  onSetPrimary?: (entryId: string) => void;
  onTogglePin?: (entryId: string, pin: boolean) => void;
  onDelete?: (entryId: string) => void;
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

  return (
    <div ref={menuRef} className="fixed z-50 min-w-[160px] py-1 rounded-[10px]"
      style={{
        left: x, top: y,
        background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
        border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 12px 32px -8px rgba(0,0,0,0.5)',
      }}>
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
  return (
    <div className="prose-invert max-w-none text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-[22px] font-bold mt-6 mb-3 pb-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}>{children}</h1>,
          h2: ({ children }) => <h2 className="text-[18px] font-bold mt-5 mb-2.5 pb-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', color: 'var(--text-primary)' }}>{children}</h2>,
          h3: ({ children }) => <h3 className="text-[15px] font-semibold mt-4 mb-2" style={{ color: 'var(--text-primary)' }}>{children}</h3>,
          h4: ({ children }) => <h4 className="text-[14px] font-semibold mt-3 mb-1.5" style={{ color: 'var(--text-primary)' }}>{children}</h4>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.78))' }}>{children}</p>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: 'rgba(96,165,250,0.9)' }}>{children}</a>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-0.5" style={{ color: 'var(--text-secondary)' }}>{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-0.5" style={{ color: 'var(--text-secondary)' }}>{children}</ol>,
          li: ({ children }) => <li className="text-[13px]">{children}</li>,
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
  emptyState,
  loading,
}: DocBrowserProps) {
  const [search, setSearch] = useState('');
  const [searchContent, setSearchContent] = useState(false);
  const [searchResults, setSearchResults] = useState<DocBrowserEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [content, setContent] = useState<string | null>(null);
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
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

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
    setContent(null);
    try {
      const text = await loadContent(entryId);
      setContent(text);
      setLoadedEntryId(entryId);
    } catch {
      setContent(null);
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
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
      </div>
    );
  }

  if (entries.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="flex-1 min-h-0 flex gap-0 rounded-[12px] overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.12)', minHeight: 'calc(100vh - 160px)' }}>

      {/* 左侧：文件树 */}
      <div className="w-[260px] min-w-[220px] max-w-[320px] flex flex-col border-r"
        style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.01)' }}>

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
                <Loader2 size={10} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin" style={{ color: 'var(--text-muted)' }} />
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
              {/* 编辑/保存按钮 */}
              {onSaveContent && !entries.find(e => e.id === selectedEntryId)?.isFolder && (
                <div className="ml-auto flex items-center gap-1.5">
                  {editMode ? (
                    <>
                      <button
                        onClick={async () => {
                          if (!selectedEntryId) return;
                          setSaving(true);
                          try {
                            await onSaveContent(selectedEntryId, editContent);
                            setContent(editContent);
                            setEditMode(false);
                          } finally {
                            setSaving(false);
                          }
                        }}
                        disabled={saving}
                        className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                        style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: 'rgba(34,197,94,0.9)' }}>
                        {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
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
                      onClick={() => { setEditContent(content ?? ''); setEditMode(true); }}
                      className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                      style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)', color: 'rgba(59,130,246,0.9)' }}>
                      <Pencil size={11} /> 编辑
                    </button>
                  )}
                </div>
              )}
            </div>
            {/* 内容区 */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {contentLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                </div>
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
              ) : content ? (
                <MarkdownViewer content={content} />
              ) : (
                <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {entries.find(e => e.id === selectedEntryId)?.isFolder
                    ? '请选择文件夹中的文件查看内容'
                    : '无文本内容（可能是二进制文件）'}
                </div>
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
          onDelete={onDeleteEntry ? (entryId) => {
            if (confirm(`确定删除「${contextMenu.entry.title}」？${contextMenu.entry.isFolder ? '(仅删除文件夹本身)' : ''}`)) {
              onDeleteEntry(entryId);
            }
          } : undefined}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
