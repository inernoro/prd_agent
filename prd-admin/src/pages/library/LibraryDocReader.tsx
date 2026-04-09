/**
 * LibraryDocReader — 智识殿堂专属文档阅读器（claymorphism 风格）
 *
 * 独立于 DocBrowser（DocBrowser 是原系统的深色组件，不复用）。
 * 专门为「智识殿堂」的阅读体验设计：
 *  - 左侧：厚边框白色卡片的文件树（克莱风格）
 *  - 右侧：MarkdownViewer 用浅色 prose 样式
 *  - 图片/视频/音频/PDF 预览
 *
 * 只读，没有编辑/上传/删除/拖拽等写操作。
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import GithubSlugger from 'github-slugger';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  FolderOpen,
  FolderClosed,
  Star,
  Pin,
  ChevronRight,
  ChevronDown,
  BookOpen,
  Search,
  Type,
  FileText,
} from 'lucide-react';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import type { FilePreviewKind } from '@/lib/fileTypeRegistry';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

// ── slug 辅助 ──
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
  return String(raw || '')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 判断 href 类型，决定点击行为
type LinkKind = 'anchor' | 'internal' | 'external';
function classifyHref(href: string | undefined): LinkKind {
  if (!href) return 'external';
  if (href.startsWith('#')) return 'anchor';
  // 相对路径 或 同源绝对路径 视为站内链接
  if (href.startsWith('/') && !href.startsWith('//')) return 'internal';
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin === window.location.origin) return 'internal';
  } catch { /* 非法 URL，按外链处理 */ }
  return 'external';
}

export type LibraryDocReaderPreview = {
  text: string | null;
  fileUrl: string | null;
  contentType: string;
};

type Props = {
  entries: DocumentEntry[];
  primaryEntryId?: string;
  pinnedEntryIds?: string[];
  loadContent: (entryId: string) => Promise<LibraryDocReaderPreview | null>;
};

export function LibraryDocReader({
  entries,
  primaryEntryId,
  pinnedEntryIds = [],
  loadContent,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | undefined>(primaryEntryId);
  const [preview, setPreview] = useState<LibraryDocReaderPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [useContentTitle, setUseContentTitle] = useState(true);
  const contentScrollRef = useRef<HTMLDivElement>(null);

  const pinnedSet = useMemo(() => new Set(pinnedEntryIds), [pinnedEntryIds]);

  // 从 entry.summary 提取正文第一行作为"正文标题"
  const contentFirstLines = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      if (e.isFolder || !e.summary) continue;
      const line = e.summary.split('\n').find((l) => l.trim());
      if (line) map.set(e.id, line.replace(/^#+\s*/, '').trim());
    }
    return map;
  }, [entries]);

  const getDisplayTitle = useCallback(
    (entry: DocumentEntry): string => {
      if (entry.isFolder) return entry.title;
      if (!useContentTitle) return entry.title;
      return contentFirstLines.get(entry.id) ?? entry.title;
    },
    [useContentTitle, contentFirstLines],
  );

  // 构建树（过滤掉 github_directory）
  const { roots, childrenMap } = useMemo(() => {
    const visible = entries.filter((e) => e.sourceType !== 'github_directory');
    const cMap = new Map<string, DocumentEntry[]>();
    const rs: DocumentEntry[] = [];
    for (const e of visible) {
      if (!e.parentId) {
        rs.push(e);
      } else {
        const arr = cMap.get(e.parentId) ?? [];
        arr.push(e);
        cMap.set(e.parentId, arr);
      }
    }
    const sortFn = (a: DocumentEntry, b: DocumentEntry) => {
      if (a.id === primaryEntryId) return -1;
      if (b.id === primaryEntryId) return 1;
      const ap = pinnedSet.has(a.id), bp = pinnedSet.has(b.id);
      if (ap !== bp) return ap ? -1 : 1;
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.title.localeCompare(b.title);
    };
    rs.sort(sortFn);
    for (const [, arr] of cMap) arr.sort(sortFn);
    return { roots: rs, childrenMap: cMap };
  }, [entries, primaryEntryId, pinnedSet]);

  // 搜索过滤：匹配标题 + 正文第一行（只隐藏未命中的文件，祖先文件夹保留）
  const { filteredRoots, filteredChildrenMap } = useMemo(() => {
    if (!search.trim()) return { filteredRoots: roots, filteredChildrenMap: childrenMap };
    const kw = search.toLowerCase();
    const entryMap = new Map(entries.map((e) => [e.id, e]));
    const matchIds = new Set<string>();
    for (const e of entries) {
      if (e.sourceType === 'github_directory' || e.isFolder) continue;
      const titleMatch = e.title.toLowerCase().includes(kw);
      const firstLineMatch = contentFirstLines.get(e.id)?.toLowerCase().includes(kw) ?? false;
      const summaryMatch = e.summary?.toLowerCase().includes(kw) ?? false;
      if (titleMatch || firstLineMatch || summaryMatch) {
        matchIds.add(e.id);
        let cur = entryMap.get(e.parentId ?? '');
        while (cur) {
          matchIds.add(cur.id);
          cur = entryMap.get(cur.parentId ?? '');
        }
      }
    }
    const fRoots = roots.filter((e) => matchIds.has(e.id));
    const fMap = new Map<string, DocumentEntry[]>();
    for (const [parentId, kids] of childrenMap) {
      const kept = kids.filter((k) => matchIds.has(k.id));
      if (kept.length > 0) fMap.set(parentId, kept);
    }
    return { filteredRoots: fRoots, filteredChildrenMap: fMap };
  }, [search, roots, childrenMap, entries, contentFirstLines]);

  // 初始默认展开根级所有文件夹 + 主文档的父链
  useEffect(() => {
    const toOpen = new Set<string>();
    // 展开所有根级文件夹
    for (const r of roots) {
      if (r.isFolder) toOpen.add(r.id);
    }
    // 展开主文档所在的祖先链
    if (primaryEntryId) {
      const entryMap = new Map(entries.map((e) => [e.id, e]));
      let cur = entryMap.get(primaryEntryId);
      while (cur?.parentId) {
        toOpen.add(cur.parentId);
        cur = entryMap.get(cur.parentId);
      }
    }
    setExpanded(toOpen);
    if (primaryEntryId && !selectedId) setSelectedId(primaryEntryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryEntryId, roots.length]);

  // 搜索时自动展开所有文件夹
  useEffect(() => {
    if (search.trim()) {
      const allFolderIds = entries.filter((e) => e.isFolder).map((e) => e.id);
      setExpanded(new Set(allFolderIds));
    }
  }, [search, entries]);

  // 加载内容
  useEffect(() => {
    if (!selectedId || selectedId === loadedId) return;
    const entry = entries.find((e) => e.id === selectedId);
    if (!entry || entry.isFolder) return;
    setLoading(true);
    setPreview(null);
    loadContent(selectedId)
      .then((p) => {
        setPreview(p);
        setLoadedId(selectedId);
      })
      .finally(() => setLoading(false));
  }, [selectedId, loadContent, loadedId, entries]);

  // 内容加载完成后，若 URL 带 hash 则 scroll 到对应 heading
  useEffect(() => {
    if (loading || !preview?.text) return;
    const rawHash = window.location.hash;
    if (!rawHash || rawHash.length < 2) return;
    const id = decodeURIComponent(rawHash.slice(1));
    // 等一轮 markdown 渲染完成
    const timer = window.setTimeout(() => {
      const target = document.getElementById(id);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [loading, preview?.text, loadedId]);

  // 监听 hashchange：用户点文档内的锚点链接时，SPA 内 scroll
  useEffect(() => {
    const onHashChange = () => {
      const rawHash = window.location.hash;
      if (!rawHash || rawHash.length < 2) return;
      const id = decodeURIComponent(rawHash.slice(1));
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // 切换选中文档时，清除 URL 上的旧 hash（避免旧 hash 把新文档 scroll 到错的位置）
  const handleSelectEntry = useCallback((id: string) => {
    setSelectedId(id);
    if (window.location.hash) {
      const { pathname, search } = window.location;
      window.history.replaceState(null, '', pathname + search);
    }
  }, []);

  const toggleFolder = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div
      className="flex h-full overflow-hidden"
      style={{
        background: '#FFFBF0',
        borderRadius: 24,
        border: '4px solid #1E1B4B',
        boxShadow: '8px 8px 0 #1E1B4B',
        fontFamily: "'Nunito', system-ui, sans-serif",
      }}
    >
      {/* 左侧文件树 */}
      <div
        className="w-[300px] flex-shrink-0 flex flex-col overflow-hidden"
        style={{
          background: '#FEF3C7',
          borderRight: '3px solid #1E1B4B',
        }}
      >
        <div
          className="px-4 py-4 flex items-center gap-2"
          style={{ borderBottom: '3px dashed #F59E0B' }}
        >
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              background: '#FFFFFF',
              border: '2.5px solid #1E1B4B',
              boxShadow: '0 3px 0 #1E1B4B',
            }}
          >
            <BookOpen size={17} style={{ color: '#F59E0B' }} strokeWidth={2.8} />
          </div>
          <div
            className="text-[14px] font-bold flex-1"
            style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
          >
            书册目录
          </div>
          {/* 标题模式切换：文件名 ↔ 正文第一行 */}
          <button
            onClick={() => setUseContentTitle((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg cursor-pointer transition-all active:translate-y-0.5"
            style={{
              background: '#FFFFFF',
              border: '2px solid #1E1B4B',
              boxShadow: '0 2px 0 #1E1B4B',
              color: '#78350F',
            }}
            title={useContentTitle ? '当前：正文标题，点击切换文件名' : '当前：文件名，点击切换正文标题'}
          >
            {useContentTitle ? <FileText size={11} strokeWidth={2.8} /> : <Type size={11} strokeWidth={2.8} />}
            {useContentTitle ? '正文' : '文件'}
          </button>
        </div>

        {/* 搜索框 */}
        <div
          className="px-3 py-3"
          style={{ borderBottom: '3px dashed #F59E0B' }}
        >
          <div className="relative">
            <Search
              size={13}
              strokeWidth={3}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: '#78350F' }}
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题或正文..."
              className="w-full h-9 pl-8 pr-3 rounded-xl text-[12px] font-bold outline-none"
              style={{
                background: '#FFFFFF',
                border: '2.5px solid #1E1B4B',
                boxShadow: '0 3px 0 #1E1B4B',
                color: '#1E1B4B',
              }}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-3 px-2">
          {filteredRoots.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] font-semibold" style={{ color: '#78350F' }}>
              {search.trim() ? '没有找到匹配的文档' : '这本藏书还是空白的...'}
            </div>
          ) : (
            filteredRoots.map((entry) => (
              <TreeNode
                key={entry.id}
                entry={entry}
                childrenMap={search.trim() ? filteredChildrenMap : childrenMap}
                depth={0}
                selectedId={selectedId}
                primaryEntryId={primaryEntryId}
                pinnedSet={pinnedSet}
                expanded={expanded}
                getDisplayTitle={getDisplayTitle}
                onToggle={toggleFolder}
                onSelect={handleSelectEntry}
              />
            ))
          )}
        </div>
      </div>

      {/* 右侧内容区 */}
      <div ref={contentScrollRef} className="flex-1 min-w-0 overflow-y-auto">
        {!selectedId ? (
          <EmptyRight />
        ) : loading ? (
          <div className="flex items-center justify-center h-full">
            <MapSectionLoader text="翻开书页..." />
          </div>
        ) : (
          <ContentArea
            entry={entries.find((e) => e.id === selectedId)}
            preview={preview}
          />
        )}
      </div>
    </div>
  );
}

// ── TreeNode ──

function TreeNode({
  entry,
  childrenMap,
  depth,
  selectedId,
  primaryEntryId,
  pinnedSet,
  expanded,
  getDisplayTitle,
  onToggle,
  onSelect,
}: {
  entry: DocumentEntry;
  childrenMap: Map<string, DocumentEntry[]>;
  depth: number;
  selectedId?: string;
  primaryEntryId?: string;
  pinnedSet: Set<string>;
  expanded: Set<string>;
  getDisplayTitle: (entry: DocumentEntry) => string;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const isFolder = entry.isFolder;
  const isOpen = expanded.has(entry.id);
  const isSelected = entry.id === selectedId;
  const isPrimary = entry.id === primaryEntryId;
  const isPinned = pinnedSet.has(entry.id);
  const children = childrenMap.get(entry.id) ?? [];

  const cfg = !isFolder ? getFileTypeConfig(entry.title, entry.contentType) : null;
  const FileIcon = cfg?.icon;

  return (
    <>
      <button
        onClick={() => (isFolder ? onToggle(entry.id) : onSelect(entry.id))}
        className="w-full text-left flex items-center gap-1.5 py-2 transition-all active:translate-y-0.5"
        style={{
          paddingLeft: `${8 + depth * 14}px`,
          paddingRight: 8,
          marginBottom: 3,
          borderRadius: 10,
          background: isSelected && !isFolder ? '#FFFFFF' : 'transparent',
          border: isSelected && !isFolder ? '2.5px solid #1E1B4B' : '2.5px solid transparent',
          boxShadow: isSelected && !isFolder ? '0 3px 0 #1E1B4B' : 'none',
          cursor: 'pointer',
        }}
      >
        {isFolder ? (
          <span className="flex-shrink-0 w-4 flex items-center justify-center">
            {isOpen ? (
              <ChevronDown size={12} strokeWidth={3} style={{ color: '#78350F' }} />
            ) : (
              <ChevronRight size={12} strokeWidth={3} style={{ color: '#78350F' }} />
            )}
          </span>
        ) : null}

        {isFolder ? (
          isOpen ? (
            <FolderOpen size={15} strokeWidth={2.5} style={{ color: '#F59E0B' }} />
          ) : (
            <FolderClosed size={15} strokeWidth={2.5} style={{ color: '#F59E0B' }} />
          )
        ) : isPrimary ? (
          <Star size={14} strokeWidth={2.5} fill="#F59E0B" style={{ color: '#F59E0B' }} />
        ) : isPinned ? (
          <Pin size={14} strokeWidth={2.5} style={{ color: '#3B82F6' }} />
        ) : FileIcon ? (
          <FileIcon size={14} strokeWidth={2.5} style={{ color: cfg!.color }} />
        ) : null}

        <span
          className="flex-1 truncate text-[12px]"
          style={{
            color: '#1E1B4B',
            fontWeight: isFolder ? 700 : isSelected ? 700 : 500,
          }}
        >
          {getDisplayTitle(entry)}
        </span>

        {isPrimary && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-bold"
            style={{
              background: '#FEF3C7',
              border: '1.5px solid #F59E0B',
              color: '#78350F',
            }}
          >
            主
          </span>
        )}
        {isPinned && !isPrimary && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-bold"
            style={{
              background: '#DBEAFE',
              border: '1.5px solid #3B82F6',
              color: '#1E3A8A',
            }}
          >
            置顶
          </span>
        )}
      </button>

      {isFolder && isOpen &&
        children.map((child) => (
          <TreeNode
            key={child.id}
            entry={child}
            childrenMap={childrenMap}
            depth={depth + 1}
            selectedId={selectedId}
            primaryEntryId={primaryEntryId}
            pinnedSet={pinnedSet}
            expanded={expanded}
            getDisplayTitle={getDisplayTitle}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

// ── 内容区（支持 text/image/video/audio/pdf） ──

function ContentArea({
  entry,
  preview,
}: {
  entry?: DocumentEntry;
  preview: LibraryDocReaderPreview | null;
}) {
  if (!entry) return <EmptyRight />;
  if (entry.isFolder) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-[14px] font-semibold" style={{ color: '#78350F' }}>
          点击左侧的文档开始阅读 📖
        </p>
      </div>
    );
  }

  const cfg = getFileTypeConfig(entry.title, entry.contentType);
  const kind: FilePreviewKind = cfg.preview;
  const text = preview?.text ?? null;
  const fileUrl = preview?.fileUrl ?? null;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* 标题 */}
      <div className="mb-6 pb-4" style={{ borderBottom: '3px dashed #F59E0B' }}>
        <h1
          className="text-[32px] font-bold leading-tight"
          style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
        >
          {entry.title}
        </h1>
      </div>

      {kind === 'image' && fileUrl ? (
        <div className="flex justify-center py-4">
          <img
            src={fileUrl}
            alt={entry.title}
            className="max-w-full rounded-3xl"
            style={{
              border: '4px solid #1E1B4B',
              boxShadow: '6px 6px 0 #1E1B4B',
              maxHeight: '70vh',
            }}
          />
        </div>
      ) : kind === 'video' && fileUrl ? (
        <div className="flex justify-center py-4">
          <video
            src={fileUrl}
            controls
            className="max-w-full rounded-3xl"
            style={{ border: '4px solid #1E1B4B', boxShadow: '6px 6px 0 #1E1B4B' }}
          />
        </div>
      ) : kind === 'audio' && fileUrl ? (
        <div className="py-4">
          <audio src={fileUrl} controls className="w-full" />
        </div>
      ) : kind === 'pdf' && fileUrl ? (
        <iframe
          src={fileUrl}
          title={entry.title}
          className="w-full rounded-3xl"
          style={{
            height: 'calc(100vh - 320px)',
            border: '4px solid #1E1B4B',
            boxShadow: '6px 6px 0 #1E1B4B',
          }}
        />
      ) : text ? (
        <ClayMarkdown content={text} />
      ) : fileUrl ? (
        <div className="text-center py-16">
          <cfg.icon
            size={48}
            strokeWidth={2.5}
            style={{ color: cfg.color, margin: '0 auto 16px' }}
          />
          <p className="text-[14px] font-semibold mb-4" style={{ color: '#1E1B4B' }}>
            {cfg.label} 文件不支持在线预览
          </p>
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block px-6 py-3 rounded-2xl text-[13px] font-bold transition-all active:translate-y-1"
            style={{
              background: '#F97316',
              border: '3px solid #1E1B4B',
              boxShadow: '0 4px 0 #1E1B4B',
              color: '#FFFFFF',
            }}
          >
            下载文件
          </a>
        </div>
      ) : (
        <div className="text-center py-16">
          <p className="text-[14px] font-semibold" style={{ color: '#78350F' }}>
            这一页还是空白的...
          </p>
        </div>
      )}
    </div>
  );
}

function EmptyRight() {
  return (
    <div className="h-full flex flex-col items-center justify-center p-8">
      <div
        className="w-20 h-20 rounded-3xl flex items-center justify-center mb-5"
        style={{
          background: '#FEF3C7',
          border: '3px solid #1E1B4B',
          boxShadow: '0 5px 0 #1E1B4B',
        }}
      >
        <BookOpen size={32} strokeWidth={2.5} style={{ color: '#F59E0B' }} />
      </div>
      <p
        className="text-[18px] font-bold mb-2"
        style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
      >
        翻开一本书开始阅读
      </p>
      <p className="text-[13px] font-semibold" style={{ color: '#78350F' }}>
        从左侧目录选择一篇文档
      </p>
    </div>
  );
}

// ── Markdown Viewer with claymorphism-compatible light theme ──

function ClayMarkdown({ content }: { content: string }) {
  // 为每次渲染创建新 slugger（确保同一标题首次出现得到干净 slug）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slugger = useMemo(() => new GithubSlugger(), [content]);

  // heading 组件生成带 id 的标签，与 PrdPreviewPage 的策略一致
  const headingComponents = useMemo(() => {
    const makeHeading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => {
      return ({ children }: { children?: React.ReactNode }) => {
        const text = normalizeHeadingText(childrenToText(children));
        const id = text ? slugger.slug(text) : undefined;
        const baseStyle: React.CSSProperties = { color: '#1E1B4B' };
        if (Tag === 'h1') {
          return (
            <h1
              id={id}
              className="text-[28px] font-bold mt-8 mb-4 pb-3 scroll-mt-24"
              style={{
                ...baseStyle,
                fontFamily: "'Fredoka', sans-serif",
                borderBottom: '3px dashed #F59E0B',
              }}
            >
              {children}
            </h1>
          );
        }
        if (Tag === 'h2') {
          return (
            <h2
              id={id}
              className="text-[22px] font-bold mt-6 mb-3 scroll-mt-24"
              style={{ ...baseStyle, fontFamily: "'Fredoka', sans-serif" }}
            >
              {children}
            </h2>
          );
        }
        if (Tag === 'h3') {
          return (
            <h3
              id={id}
              className="text-[18px] font-bold mt-5 mb-2 scroll-mt-24"
              style={{ ...baseStyle, fontFamily: "'Fredoka', sans-serif" }}
            >
              {children}
            </h3>
          );
        }
        if (Tag === 'h4') {
          return (
            <h4 id={id} className="text-[16px] font-bold mt-4 mb-2 scroll-mt-24" style={baseStyle}>
              {children}
            </h4>
          );
        }
        if (Tag === 'h5') {
          return (
            <h5 id={id} className="text-[15px] font-bold mt-3 mb-1.5 scroll-mt-24" style={baseStyle}>
              {children}
            </h5>
          );
        }
        return (
          <h6 id={id} className="text-[14px] font-bold mt-3 mb-1.5 scroll-mt-24" style={baseStyle}>
            {children}
          </h6>
        );
      };
    };
    return {
      h1: makeHeading('h1'),
      h2: makeHeading('h2'),
      h3: makeHeading('h3'),
      h4: makeHeading('h4'),
      h5: makeHeading('h5'),
      h6: makeHeading('h6'),
    };
  }, [slugger]);

  return (
    <div
      className="max-w-none text-[14px] leading-[1.8]"
      style={{ color: '#1E1B4B', fontFamily: "'Nunito', system-ui, sans-serif" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          ...headingComponents,
          p: ({ children }) => (
            <p
              className="my-3 whitespace-pre-wrap break-words"
              style={{ color: '#334155' }}
            >
              {children}
            </p>
          ),
          a: ({ href, children }) => {
            const kind = classifyHref(href);
            // 外链：新标签页
            if (kind === 'external') {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold underline decoration-[2px] underline-offset-4"
                  style={{ color: '#F97316' }}
                >
                  {children}
                </a>
              );
            }
            // 锚点 / 站内链接：拦截默认行为，SPA 内 scroll 或 history.pushState
            return (
              <a
                href={href}
                className="font-bold underline decoration-[2px] underline-offset-4"
                style={{ color: '#F97316' }}
                onClick={(e) => {
                  if (!href) return;
                  e.preventDefault();
                  if (kind === 'anchor') {
                    const id = decodeURIComponent(href.slice(1));
                    const target = document.getElementById(id);
                    if (target) {
                      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      // 更新 URL hash 但不触发 hashchange 副作用
                      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${id}`);
                    }
                  } else {
                    // 站内链接：使用 pushState（整站无 Router ref 时至少 SPA 内不会丢状态）
                    window.history.pushState(null, '', href);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }
                }}
              >
                {children}
              </a>
            );
          },
          ul: ({ children, className }) => {
            // 任务列表（GFM）：ul 会带 "contains-task-list" class
            const isTaskList = className?.includes('contains-task-list');
            return (
              <ul
                className={`${isTaskList ? 'list-none pl-2' : 'list-disc pl-6'} my-3 space-y-1`}
                style={{ color: '#334155' }}
              >
                {children}
              </ul>
            );
          },
          ol: ({ children }) => (
            <ol
              className="list-decimal pl-6 my-3 space-y-1"
              style={{ color: '#334155' }}
            >
              {children}
            </ol>
          ),
          li: ({ children, className }) => {
            const isTaskItem = className?.includes('task-list-item');
            return (
              <li className={`text-[14px] font-medium ${isTaskItem ? 'flex items-start gap-2' : ''}`}>
                {children}
              </li>
            );
          },
          blockquote: ({ children }) => (
            <blockquote
              className="my-4 pl-5 py-3 pr-4 rounded-r-2xl"
              style={{
                borderLeft: '5px solid #F59E0B',
                background: '#FEF3C7',
                color: '#78350F',
                fontStyle: 'italic',
              }}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div
              className="my-5 overflow-x-auto rounded-2xl"
              style={{
                background: '#FFFFFF',
                border: '3px solid #1E1B4B',
                boxShadow: '4px 4px 0 #1E1B4B',
              }}
            >
              <table className="w-full text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th
              className="px-4 py-3 text-left font-bold"
              style={{
                background: '#FEF3C7',
                borderBottom: '2px solid #1E1B4B',
                color: '#1E1B4B',
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className="px-4 py-2.5"
              style={{
                borderBottom: '1px dashed #E5E7EB',
                color: '#334155',
              }}
            >
              {children}
            </td>
          ),
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const inline = !match;
            if (inline) {
              return (
                <code
                  className="px-2 py-0.5 rounded-lg text-[13px] font-mono font-semibold"
                  style={{
                    background: '#FEF3C7',
                    border: '1.5px solid #F59E0B',
                    color: '#78350F',
                  }}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <div
                className="my-4 rounded-2xl overflow-hidden"
                style={{
                  background: '#FFFFFF',
                  border: '3px solid #1E1B4B',
                  boxShadow: '4px 4px 0 #1E1B4B',
                }}
              >
                <SyntaxHighlighter
                  style={oneLight}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    padding: '16px',
                    fontSize: '13px',
                    background: 'transparent',
                    border: 'none',
                  }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            );
          },
          hr: () => (
            <hr
              className="my-6"
              style={{ border: 'none', borderTop: '3px dashed #F59E0B' }}
            />
          ),
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt || ''}
              className="max-w-full rounded-2xl my-4"
              style={{
                border: '3px solid #1E1B4B',
                boxShadow: '4px 4px 0 #1E1B4B',
                maxHeight: 500,
              }}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
