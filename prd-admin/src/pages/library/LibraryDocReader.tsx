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
import { useState, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  Maximize2,
  Minimize2,
} from 'lucide-react';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import type { FilePreviewKind } from '@/lib/fileTypeRegistry';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

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
  const [fullscreen, setFullscreen] = useState(false);

  const pinnedSet = useMemo(() => new Set(pinnedEntryIds), [pinnedEntryIds]);

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
            className="text-[14px] font-bold"
            style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
          >
            书册目录
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-3 px-2">
          {roots.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] font-semibold" style={{ color: '#78350F' }}>
              这本藏书还是空白的...
            </div>
          ) : (
            roots.map((entry) => (
              <TreeNode
                key={entry.id}
                entry={entry}
                childrenMap={childrenMap}
                depth={0}
                selectedId={selectedId}
                primaryEntryId={primaryEntryId}
                pinnedSet={pinnedSet}
                expanded={expanded}
                onToggle={toggleFolder}
                onSelect={setSelectedId}
              />
            ))
          )}
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
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
          {entry.title}
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
  return (
    <div
      className="max-w-none text-[14px] leading-[1.8]"
      style={{ color: '#1E1B4B', fontFamily: "'Nunito', system-ui, sans-serif" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className="text-[28px] font-bold mt-8 mb-4 pb-3"
              style={{
                fontFamily: "'Fredoka', sans-serif",
                color: '#1E1B4B',
                borderBottom: '3px dashed #F59E0B',
              }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className="text-[22px] font-bold mt-6 mb-3"
              style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className="text-[18px] font-bold mt-5 mb-2"
              style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
            >
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4
              className="text-[16px] font-bold mt-4 mb-2"
              style={{ color: '#1E1B4B' }}
            >
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p
              className="my-3 whitespace-pre-wrap break-words"
              style={{ color: '#334155' }}
            >
              {children}
            </p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline decoration-[2px] underline-offset-4"
              style={{ color: '#F97316' }}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul
              className="list-disc pl-6 my-3 space-y-1"
              style={{ color: '#334155' }}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className="list-decimal pl-6 my-3 space-y-1"
              style={{ color: '#334155' }}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-[14px] font-medium">{children}</li>
          ),
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
