import { useState, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  FileText, File, FolderOpen, Star, Rss, Github,
  Loader2, Search, ChevronRight,
} from 'lucide-react';

// ── 类型 ──

export type DocBrowserEntry = {
  id: string;
  title: string;
  sourceType: string;
  contentType: string;
  fileSize: number;
  summary?: string;
  syncStatus?: string;
  metadata?: Record<string, string>;
};

export type DocBrowserProps = {
  /** 文件列表 */
  entries: DocBrowserEntry[];
  /** 主文档 ID */
  primaryEntryId?: string;
  /** 当前选中的条目 ID */
  selectedEntryId?: string;
  /** 选中条目回调 */
  onSelectEntry: (entryId: string) => void;
  /** 设为主文档回调 */
  onSetPrimary?: (entryId: string) => void;
  /** 加载文档内容的函数 */
  loadContent: (entryId: string) => Promise<string | null>;
  /** 列表头部额外操作区 */
  listActions?: React.ReactNode;
  /** 空状态引导 */
  emptyState?: React.ReactNode;
  /** 是否正在加载条目列表 */
  loading?: boolean;
};

// ── 文件图标 ──

function EntryIcon({ entry, isPrimary }: { entry: DocBrowserEntry; isPrimary: boolean }) {
  if (isPrimary) return <Star size={14} style={{ color: 'rgba(234,179,8,0.85)' }} />;
  if (entry.sourceType === 'github_directory') return <Github size={14} style={{ color: 'rgba(130,80,223,0.7)' }} />;
  if (entry.sourceType === 'subscription') return <Rss size={14} style={{ color: 'rgba(234,179,8,0.7)' }} />;
  if (entry.contentType?.startsWith('text/')) return <FileText size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
  return <File size={14} style={{ color: 'rgba(59,130,246,0.7)' }} />;
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
  listActions,
  emptyState,
  loading,
}: DocBrowserProps) {
  const [search, setSearch] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [loadedEntryId, setLoadedEntryId] = useState<string | null>(null);

  // 过滤条目（排除 github_directory 父条目）
  const filteredEntries = useMemo(() => {
    let list = entries.filter(e => e.sourceType !== 'github_directory');
    if (search.trim()) {
      const kw = search.toLowerCase();
      list = list.filter(e => e.title.toLowerCase().includes(kw));
    }
    // 主文档置顶
    if (primaryEntryId) {
      list.sort((a, b) => {
        if (a.id === primaryEntryId) return -1;
        if (b.id === primaryEntryId) return 1;
        return 0;
      });
    }
    return list;
  }, [entries, search, primaryEntryId]);

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

  // 自动加载选中条目
  useEffect(() => {
    if (selectedEntryId) {
      loadEntryContent(selectedEntryId);
    }
  }, [selectedEntryId, loadEntryContent]);

  // 自动选中主文档
  useEffect(() => {
    if (!selectedEntryId && primaryEntryId && entries.some(e => e.id === primaryEntryId)) {
      onSelectEntry(primaryEntryId);
    }
  }, [primaryEntryId, entries, selectedEntryId, onSelectEntry]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
      </div>
    );
  }

  if (entries.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="flex-1 min-h-0 flex gap-0 rounded-[12px] overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.12)' }}>

      {/* 左侧：文件列表 */}
      <div className="w-[260px] min-w-[220px] max-w-[320px] flex flex-col border-r"
        style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.01)' }}>

        {/* 搜索 + 操作 */}
        <div className="p-2.5 space-y-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="搜索文件..."
              className="w-full h-7 pl-7 pr-2.5 rounded-[8px] text-[11px] outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}
            />
          </div>
          {listActions && <div className="flex gap-1.5">{listActions}</div>}
        </div>

        {/* 文件列表 */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredEntries.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {search ? '无匹配文件' : '暂无文档'}
            </div>
          ) : filteredEntries.map(entry => {
            const isPrimary = entry.id === primaryEntryId;
            const isSelected = entry.id === selectedEntryId;
            return (
              <button
                key={entry.id}
                onClick={() => onSelectEntry(entry.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (onSetPrimary && !isPrimary) onSetPrimary(entry.id);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer transition-all duration-150 group"
                style={{
                  background: isSelected ? 'rgba(59,130,246,0.08)' : 'transparent',
                  borderLeft: isSelected ? '2px solid rgba(59,130,246,0.6)' : '2px solid transparent',
                }}
                title={isPrimary ? '主文档' : '右键设为主文档'}
              >
                <EntryIcon entry={entry} isPrimary={isPrimary} />
                <span className="flex-1 truncate text-[12px]"
                  style={{ color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                  {entry.title}
                </span>
                {isPrimary && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0"
                    style={{ background: 'rgba(234,179,8,0.1)', color: 'rgba(234,179,8,0.8)' }}>
                    README
                  </span>
                )}
                {!isPrimary && onSetPrimary && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onSetPrimary(entry.id); }}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded cursor-pointer"
                    title="设为主文档"
                  >
                    <Star size={11} style={{ color: 'var(--text-muted)' }} />
                  </button>
                )}
              </button>
            );
          })}
        </div>

        {/* 底部统计 */}
        <div className="px-3 py-2 text-[10px]" style={{ borderTop: '1px solid rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}>
          <FolderOpen size={10} className="inline mr-1" />
          {filteredEntries.length} 个文件
        </div>
      </div>

      {/* 右侧：文档预览 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {selectedEntryId ? (
          <>
            {/* 文件名 header */}
            <div className="flex items-center gap-2 px-5 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {entries.find(e => e.id === selectedEntryId)?.title ?? ''}
              </span>
              {selectedEntryId === primaryEntryId && (
                <span className="text-[10px] px-2 py-0.5 rounded-full"
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
                  无文本内容（可能是二进制文件）
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
