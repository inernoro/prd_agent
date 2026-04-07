import { useState, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  FileText, File, FolderOpen, FolderClosed, Star, Rss, Github,
  Loader2, Search, ChevronRight, ChevronDown, Plus,
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
  selectedEntryId?: string;
  onSelectEntry: (entryId: string) => void;
  onSetPrimary?: (entryId: string) => void;
  loadContent: (entryId: string) => Promise<string | null>;
  onCreateFolder?: (name: string, parentId?: string) => Promise<void>;
  emptyState?: React.ReactNode;
  loading?: boolean;
};

// ── 文件图标 ──

function EntryIcon({ entry, isPrimary, isOpen }: { entry: DocBrowserEntry; isPrimary: boolean; isOpen?: boolean }) {
  if (entry.isFolder) {
    return isOpen
      ? <FolderOpen size={14} style={{ color: 'rgba(234,179,8,0.7)' }} />
      : <FolderClosed size={14} style={{ color: 'rgba(234,179,8,0.6)' }} />;
  }
  if (isPrimary) return <Star size={14} style={{ color: 'rgba(234,179,8,0.85)' }} />;
  if (entry.sourceType === 'github_directory') return <Github size={14} style={{ color: 'rgba(130,80,223,0.7)' }} />;
  if (entry.sourceType === 'subscription') return <Rss size={14} style={{ color: 'rgba(234,179,8,0.7)' }} />;
  if (entry.contentType?.startsWith('text/')) return <FileText size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
  return <File size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
}

// ── 树节点递归组件 ──

function TreeNode({
  entry,
  childrenMap,
  depth,
  selectedEntryId,
  primaryEntryId,
  expandedFolders,
  onToggleFolder,
  onSelectEntry,
  onSetPrimary,
}: {
  entry: DocBrowserEntry;
  childrenMap: Map<string, DocBrowserEntry[]>;
  depth: number;
  selectedEntryId?: string;
  primaryEntryId?: string;
  expandedFolders: Set<string>;
  onToggleFolder: (id: string) => void;
  onSelectEntry: (id: string) => void;
  onSetPrimary?: (id: string) => void;
}) {
  const isFolder = entry.isFolder;
  const isOpen = expandedFolders.has(entry.id);
  const isSelected = entry.id === selectedEntryId;
  const isPrimary = entry.id === primaryEntryId;
  const children = childrenMap.get(entry.id) ?? [];

  return (
    <>
      <button
        onClick={() => {
          if (isFolder) onToggleFolder(entry.id);
          else onSelectEntry(entry.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!isFolder && onSetPrimary && !isPrimary) onSetPrimary(entry.id);
        }}
        className="w-full flex items-center gap-1.5 py-[5px] text-left cursor-pointer transition-all duration-100 group"
        style={{
          paddingLeft: `${12 + depth * 16}px`,
          paddingRight: '8px',
          background: isSelected && !isFolder ? 'rgba(59,130,246,0.08)' : 'transparent',
          borderLeft: isSelected && !isFolder ? '2px solid rgba(59,130,246,0.6)' : '2px solid transparent',
        }}
        title={isFolder ? '点击展开/折叠' : isPrimary ? '主文档' : '右键设为主文档'}
      >
        {/* 展开/折叠箭头 */}
        {isFolder ? (
          <span className="w-3.5 flex-shrink-0 flex items-center justify-center">
            {isOpen ? <ChevronDown size={11} style={{ color: 'var(--text-muted)' }} />
                    : <ChevronRight size={11} style={{ color: 'var(--text-muted)' }} />}
          </span>
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        <EntryIcon entry={entry} isPrimary={isPrimary} isOpen={isOpen} />

        <span className="flex-1 truncate text-[12px]"
          style={{
            color: isSelected && !isFolder ? 'var(--text-primary)' : 'var(--text-secondary, rgba(255,255,255,0.7))',
            fontWeight: isFolder ? 500 : 400,
          }}>
          {entry.title}
        </span>

        {isPrimary && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{ background: 'rgba(234,179,8,0.1)', color: 'rgba(234,179,8,0.8)' }}>
            README
          </span>
        )}

        {!isFolder && !isPrimary && onSetPrimary && (
          <button
            onClick={(e) => { e.stopPropagation(); onSetPrimary(entry.id); }}
            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded cursor-pointer"
            title="设为主文档"
          >
            <Star size={11} style={{ color: 'var(--text-muted)' }} />
          </button>
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
          expandedFolders={expandedFolders}
          onToggleFolder={onToggleFolder}
          onSelectEntry={onSelectEntry}
          onSetPrimary={onSetPrimary}
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
  selectedEntryId,
  onSelectEntry,
  onSetPrimary,
  loadContent,
  onCreateFolder,
  emptyState,
  loading,
}: DocBrowserProps) {
  const [search, setSearch] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [loadedEntryId, setLoadedEntryId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // 构建树结构
  const { rootEntries, childrenMap, fileCount } = useMemo(() => {
    // 排除 github_directory 类型（父目录条目）
    const visible = entries.filter(e => e.sourceType !== 'github_directory');
    const cMap = new Map<string, DocBrowserEntry[]>();
    const roots: DocBrowserEntry[] = [];

    // 按 parentId 分组
    for (const e of visible) {
      if (!e.parentId) {
        roots.push(e);
      } else {
        const siblings = cMap.get(e.parentId) ?? [];
        siblings.push(e);
        cMap.set(e.parentId, siblings);
      }
    }

    // 排序：文件夹优先，然后按标题
    const sortFn = (a: DocBrowserEntry, b: DocBrowserEntry) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (a.id === primaryEntryId) return -1;
      if (b.id === primaryEntryId) return 1;
      return a.title.localeCompare(b.title);
    };
    roots.sort(sortFn);
    for (const [, children] of cMap) children.sort(sortFn);

    const fCount = visible.filter(e => !e.isFolder).length;

    return { rootEntries: roots, childrenMap: cMap, fileCount: fCount };
  }, [entries, primaryEntryId]);

  // 搜索过滤（搜索时展开所有层级显示匹配项）
  const { filteredRoots, filteredChildrenMap } = useMemo(() => {
    if (!search.trim()) return { filteredRoots: rootEntries, filteredChildrenMap: childrenMap };

    const kw = search.toLowerCase();
    const matchIds = new Set<string>();

    // 标记匹配的条目及其所有祖先
    const entryMap = new Map(entries.map(e => [e.id, e]));
    for (const e of entries) {
      if (e.title.toLowerCase().includes(kw) && e.sourceType !== 'github_directory') {
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
  }, [search, rootEntries, childrenMap, entries]);

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
    if (search.trim()) {
      const allFolderIds = entries.filter(e => e.isFolder).map(e => e.id);
      setExpandedFolders(new Set(allFolderIds));
    }
  }, [search, entries]);

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
      // 展开主文档的父文件夹链
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

        {/* 搜索 + 新建文件夹 */}
        <div className="p-2.5 space-y-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="搜索文件..."
                className="w-full h-7 pl-7 pr-2.5 rounded-[8px] text-[11px] outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}
              />
            </div>
            {onCreateFolder && (
              <button
                onClick={() => setCreatingFolder(!creatingFolder)}
                className="h-7 w-7 flex items-center justify-center rounded-[8px] cursor-pointer transition-colors"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                title="新建文件夹"
              >
                <Plus size={12} />
              </button>
            )}
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
              {search ? '无匹配文件' : '暂无文档'}
            </div>
          ) : filteredRoots.map(entry => (
            <TreeNode
              key={entry.id}
              entry={entry}
              childrenMap={search.trim() ? filteredChildrenMap : childrenMap}
              depth={0}
              selectedEntryId={selectedEntryId}
              primaryEntryId={primaryEntryId}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              onSelectEntry={onSelectEntry}
              onSetPrimary={onSetPrimary}
            />
          ))}
        </div>

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
            </div>
            {/* 内容区 */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {contentLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                </div>
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
                {primaryEntryId ? '' : '右键或点击 ☆ 设为主文档'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
