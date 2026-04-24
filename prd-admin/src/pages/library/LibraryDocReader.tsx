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
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import GithubSlugger from 'github-slugger';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { toast } from '@/lib/toast';
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
  Maximize2,
  Minimize2,
} from 'lucide-react';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import type { FilePreviewKind } from '@/lib/fileTypeRegistry';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useViewTracking } from '@/lib/useViewTracking';

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

// 链接类型判定结果
type ResolvedLink =
  | { kind: 'anchor'; hash: string }                             // 页内锚点
  | { kind: 'entry'; entryId: string; hash?: string }            // 同知识库内的文档引用
  | { kind: 'route'; path: string }                              // 其他 SPA 路由（/library/xxx、/... 等）
  | { kind: 'external'; href: string }                           // 外链（新标签页）
  | { kind: 'unresolved'; href: string };                        // 相对路径但在 entries 里找不到

/**
 * 尝试把相对路径的 "文档名" 映射到知识库里的某个 entry。
 * 支持的匹配规则（按优先级）：
 *   1. entry.title 完全等于 name（含或不含 .md）
 *   2. entry.metadata.github_path 末段等于 name
 *   3. entry.title 去掉扩展名后等于 name 去掉扩展名
 * 找不到返回 undefined。
 */
function findEntryByRelativeName(
  name: string,
  entries: DocumentEntry[],
): DocumentEntry | undefined {
  const cleaned = name.trim().replace(/^\.\//, '');
  if (!cleaned) return undefined;
  const withMd = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;
  const withoutMd = cleaned.replace(/\.md$/i, '');

  // 规则 1：title 直接等于
  let hit = entries.find(
    (e) => !e.isFolder && (e.title === cleaned || e.title === withMd || e.title === withoutMd),
  );
  if (hit) return hit;

  // 规则 2：github_path 末段等于
  hit = entries.find((e) => {
    if (e.isFolder) return false;
    const ghPath = e.metadata?.github_path;
    if (!ghPath) return false;
    const base = ghPath.split('/').pop() ?? '';
    return base === cleaned || base === withMd;
  });
  if (hit) return hit;

  // 规则 3：去扩展名比对 title
  hit = entries.find((e) => {
    if (e.isFolder) return false;
    const titleBase = e.title.replace(/\.[^.]+$/, '');
    return titleBase === withoutMd;
  });
  return hit;
}

/**
 * 根据 href 判断应该怎么处理这个链接。
 *
 * - `#xxx`                 → 页内锚点
 * - `https://foo.bar/...`  → 外链
 * - `/library/...`         → SPA 路由（走 react-router navigate）
 * - `design.visual-agent`  → 相对文档引用，尝试在 entries 里找，找不到就算 unresolved
 * - `./design.visual-agent.md` 同上
 * - `/some/absolute/path`  → 如果是站内路由白名单就走 route，否则 unresolved（防止误跳 /library/{name}）
 */
function resolveLink(
  href: string | undefined,
  entries: DocumentEntry[],
): ResolvedLink {
  if (!href) return { kind: 'external', href: '' };

  // 页内锚点
  if (href.startsWith('#')) return { kind: 'anchor', hash: href.slice(1) };

  // 协议开头 → 判断同源还是外链
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.origin !== window.location.origin) {
        return { kind: 'external', href };
      }
      // 同源绝对 URL：按路由处理，保留 hash
      return { kind: 'route', path: url.pathname + url.search + url.hash };
    } catch {
      return { kind: 'external', href };
    }
  }

  // 绝对路径 /library/xxx 或其他 SPA 路由：允许
  if (href.startsWith('/') && !href.startsWith('//')) {
    return { kind: 'route', path: href };
  }

  // 相对路径：只能是"同知识库内的文档引用"。从 href 里把纯文档名抠出来（去掉 query 和 hash）
  const qMark = href.indexOf('?');
  const hMark = href.indexOf('#');
  const firstSep = [qMark, hMark].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? href.length;
  const namePart = href.slice(0, firstSep);
  const hashPart = hMark >= 0 ? href.slice(hMark + 1) : undefined;

  const hit = findEntryByRelativeName(namePart, entries);
  if (hit) {
    return { kind: 'entry', entryId: hit.id, hash: hashPart };
  }

  return { kind: 'unresolved', href };
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
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | undefined>(primaryEntryId);
  const [preview, setPreview] = useState<LibraryDocReaderPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [useContentTitle, setUseContentTitle] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const contentScrollRef = useRef<HTMLDivElement>(null);

  const pinnedSet = useMemo(() => new Set(pinnedEntryIds), [pinnedEntryIds]);

  // 批次 C：智识殿堂访问埋点（只对非文件夹的选中条目生效）
  const trackedEntryId = useMemo(() => {
    if (!selectedId) return null;
    const e = entries.find(x => x.id === selectedId);
    return e && !e.isFolder ? selectedId : null;
  }, [selectedId, entries]);
  useViewTracking(trackedEntryId);

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

  // 全屏时锁定 body 滚动 + 监听 ESC 退出
  useEffect(() => {
    if (!fullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

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

  // 切换选中文档时，默认清除 URL 上的旧 hash（避免旧 hash 把新文档 scroll 到错的位置）。
  // 来自相对路径文档引用（带 hash 的跳转）时，调用方会在切换后自行 replaceState 新 hash。
  const handleSelectEntry = useCallback((id: string, keepHash = false) => {
    setSelectedId(id);
    if (!keepHash && window.location.hash) {
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
      className="flex overflow-hidden relative"
      style={{
        background: '#FFFBF0',
        borderRadius: fullscreen ? 0 : 24,
        border: fullscreen ? 'none' : '4px solid #1E1B4B',
        boxShadow: fullscreen ? 'none' : '8px 8px 0 #1E1B4B',
        fontFamily: "'Nunito', system-ui, sans-serif",
        ...(fullscreen
          ? {
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: '100vw',
              height: '100vh',
              zIndex: 9999,
            }
          : {
              height: '100%',
            }),
      }}
    >
      {/* 右上角浮动按钮：全屏 / 退出全屏 */}
      <button
        onClick={() => setFullscreen((f) => !f)}
        title={fullscreen ? '退出全屏 (ESC)' : '全屏阅读'}
        aria-label={fullscreen ? '退出全屏' : '全屏阅读'}
        className="absolute hover:-translate-y-0.5 transition-transform cursor-pointer"
        style={{
          top: 14,
          right: 14,
          zIndex: 30,
          width: 40,
          height: 40,
          borderRadius: 12,
          background: '#FFFFFF',
          border: '3px solid #1E1B4B',
          boxShadow: '0 3px 0 #1E1B4B',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {fullscreen ? (
          <Minimize2 size={16} strokeWidth={2.8} style={{ color: '#1E1B4B' }} />
        ) : (
          <Maximize2 size={16} strokeWidth={2.8} style={{ color: '#1E1B4B' }} />
        )}
      </button>

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
            entries={entries}
            onSelectEntry={handleSelectEntry}
            navigate={navigate}
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
  entries,
  onSelectEntry,
  navigate,
}: {
  entry?: DocumentEntry;
  preview: LibraryDocReaderPreview | null;
  entries: DocumentEntry[];
  onSelectEntry: (id: string) => void;
  navigate: ReturnType<typeof useNavigate>;
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
        <ClayMarkdown
          content={text}
          entries={entries}
          onSelectEntry={onSelectEntry}
          navigate={navigate}
        />
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

function ClayMarkdown({
  content,
  entries,
  onSelectEntry,
  navigate,
}: {
  content: string;
  entries: DocumentEntry[];
  onSelectEntry: (id: string) => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
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
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
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
            const resolved = resolveLink(href, entries);

            // 外链：新标签页
            if (resolved.kind === 'external') {
              return (
                <a
                  href={resolved.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold underline decoration-[2px] underline-offset-4"
                  style={{ color: '#F97316' }}
                >
                  {children}
                </a>
              );
            }

            // 找不到目标的相对路径：灰显 + 禁用点击 + tooltip
            if (resolved.kind === 'unresolved') {
              return (
                <span
                  className="font-bold decoration-[2px] underline-offset-4"
                  style={{
                    color: '#94A3B8',
                    textDecoration: 'line-through wavy',
                    cursor: 'not-allowed',
                  }}
                  title={`未在本知识库中找到该文档：${resolved.href}`}
                  onClick={(e) => {
                    e.preventDefault();
                    toast.warning('链接无效', `未找到文档：${resolved.href}`);
                  }}
                >
                  {children}
                </span>
              );
            }

            return (
              <a
                href={href}
                className="font-bold underline decoration-[2px] underline-offset-4"
                style={{ color: '#F97316' }}
                onClick={(e) => {
                  e.preventDefault();
                  if (resolved.kind === 'anchor') {
                    // 页内锚点：scroll 到对应 heading
                    const id = decodeURIComponent(resolved.hash);
                    const target = document.getElementById(id);
                    if (target) {
                      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      window.history.replaceState(
                        null,
                        '',
                        `${window.location.pathname}${window.location.search}#${id}`,
                      );
                    } else {
                      toast.warning('未找到章节', `#${id}`);
                    }
                  } else if (resolved.kind === 'entry') {
                    // 相对路径命中知识库内的文档：先写 hash，再切换 entry，避免 handleSelectEntry 把 hash 清掉
                    if (resolved.hash) {
                      window.history.replaceState(
                        null,
                        '',
                        `${window.location.pathname}${window.location.search}#${resolved.hash}`,
                      );
                      onSelectEntry(resolved.entryId);
                    } else {
                      onSelectEntry(resolved.entryId);
                    }
                  } else if (resolved.kind === 'route') {
                    // 站内其他路由（如 /library/{其他知识库 ID}）：react-router 导航
                    navigate(resolved.path);
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
            const text = String(children ?? '').replace(/\n$/, '');
            // 块级判断：有 language- 类名 或 内容包含换行（兼容未指定语言的 fenced code block）
            const isBlock = !!match || text.includes('\n');
            if (!isBlock) {
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
            // 块级且指定了语言 → 走 Prism 高亮
            if (match) {
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
                    {text}
                  </SyntaxHighlighter>
                </div>
              );
            }
            // 块级但无语言 → 纯 <pre><code>，避免 Prism 对 ASCII 框图加 token 背景
            return (
              <div
                className="my-4 rounded-2xl overflow-x-auto"
                style={{
                  background: '#FFFFFF',
                  border: '3px solid #1E1B4B',
                  boxShadow: '4px 4px 0 #1E1B4B',
                }}
              >
                <pre
                  style={{
                    margin: 0,
                    padding: '16px',
                    fontSize: '13px',
                    lineHeight: 1.6,
                    color: '#1E1B4B',
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    background: 'transparent',
                    whiteSpace: 'pre',
                  }}
                >
                  {text}
                </pre>
              </div>
            );
          },
          pre: ({ children }) => <>{children}</>,
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
