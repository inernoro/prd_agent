import { useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import MermaidBlock from './MermaidBlock';
import GithubSlugger from 'github-slugger';
import type { DocCitation } from '../../types';
import CitationChip from '../Chat/CitationChip';
import AsyncIconButton from '../ui/AsyncIconButton';
import { copyImageFromUrl, copyText, tableElementToMarkdown } from '../../lib/clipboard';

function CopySvg({ className }: { className?: string }) {
  return (
    <svg className={className || 'w-4 h-4'} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h6a2 2 0 002-2M8 5a2 2 0 012-2h6a2 2 0 012 2v11a2 2 0 01-2 2h-1" />
    </svg>
  );
}

function TableWithCopy({ children, ...props }: any) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  return (
    <div className="relative group overflow-x-auto">
      <AsyncIconButton
        title="复制表格"
        onAction={async () => {
          const el = tableRef.current;
          const md = el ? tableElementToMarkdown(el) : '';
          if (!md) return;
          await copyText(md);
        }}
        icon={<CopySvg />}
        className="absolute top-2 right-2 z-10 inline-flex items-center justify-center w-8 h-8 rounded-md ui-glass-panel text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"
      />
      <table ref={tableRef} {...props}>
        {children}
      </table>
    </div>
  );
}

function ImageWithCopy({ src, alt, ...props }: any) {
  const safeSrc = String(src || '').trim();
  return (
    <span className="relative inline-block max-w-full group">
      {safeSrc ? (
        <AsyncIconButton
          title="复制图片"
          onAction={async () => {
            await copyImageFromUrl(safeSrc);
          }}
          icon={<CopySvg />}
          className="absolute top-2 right-2 z-10 inline-flex items-center justify-center w-8 h-8 rounded-md ui-glass-panel text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"
        />
      ) : null}
      <img src={src} alt={alt} {...props} className={`max-w-full ${props?.className || ''}`.trim()} />
    </span>
  );
}

function childrenToText(children: any): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (typeof children === 'object' && 'props' in children) return childrenToText((children as any).props?.children);
  return '';
}

function normalizeHeadingText(raw: string) {
  let s = String(raw || '');
  // Trim trailing hashes: "Title ###" -> "Title"
  s = s.replace(/\s+#+\s*$/, '').trim();
  // Collapse inner whitespace
  s = s.replace(/\s+/g, ' ');
  return s;
}

export type MarkdownRendererProps = {
  content: string;
  className?: string;
  /**
   * 仅用于应用内“伪链接”（例如 citations），避免在桌面端触发外部跳转。
   * 返回 true 表示已消费该点击（不会继续默认行为）。
   */
  onInternalLinkClick?: (href: string) => boolean | void;
  citations?: DocCitation[] | null;
  onOpenCitation?: (citationIdx: number) => void;
};

function parseCitationIdx(href: string) {
  const h = String(href || '');
  if (!h.startsWith('prd-citation:') && !h.startsWith('prd-citation://')) return null;
  const idxStr = h.replace('prd-citation://', 'prd-citation:').slice('prd-citation:'.length);
  const idx = Number(idxStr);
  return Number.isFinite(idx) ? idx : null;
}

function tokenizeForMatch(raw: string) {
  const s = String(raw || '');
  const out = new Set<string>();
  const cjk = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const en = s.match(/[A-Za-z]{3,}/g) || [];
  const nums = s.match(/\d+(?:\.\d+){0,3}/g) || [];
  [...cjk, ...en, ...nums].forEach((t) => {
    const k = String(t).trim().toLowerCase();
    if (k.length >= 2) out.add(k.length > 24 ? k.slice(0, 24) : k);
  });
  return out;
}

function scoreOverlap(a: Set<string>, b: Set<string>) {
  let score = 0;
  a.forEach((k) => {
    if (!b.has(k)) return;
    score += Math.min(6, k.length);
  });
  return score;
}

export default function MarkdownRenderer({ content, className, onInternalLinkClick, citations, onOpenCitation }: MarkdownRendererProps) {
  // slugger 需要在一次渲染周期内保持状态，用于处理重名标题的去重（a、a-1、a-2...）
  const slugger = useMemo(() => new GithubSlugger(), [content]);
  const citationList = useMemo(() => (Array.isArray(citations) ? citations.slice(0, 30) : []), [citations]);
  const citationTokens = useMemo(() => citationList.map((c) => tokenizeForMatch(`${c?.headingTitle || ''} ${c?.excerpt || ''}`)), [citationList]);

  const matchCitationsForBlock = (blockText: string) => {
    if (!citationList.length) return [];
    const t = String(blockText || '').trim();
    if (!t) return [];
    if (t.length < 10) return [];
    const bt = tokenizeForMatch(t);
    if (bt.size === 0) return [];
    const scored = citationTokens
      .map((ct, idx) => ({ idx, score: scoreOverlap(bt, ct) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => x.idx);
    return scored;
  };

  const headingComponents = useMemo(() => {
    const make = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => {
      return ({ children }: any) => {
        const text = normalizeHeadingText(childrenToText(children));
        const id = text ? slugger.slug(text) : undefined;
        return (
          <Tag id={id}>
            {children}
          </Tag>
        );
      };
    };

    return {
      h1: make('h1'),
      h2: make('h2'),
      h3: make('h3'),
      h4: make('h4'),
      h5: make('h5'),
      h6: make('h6'),
    };
  }, [slugger]);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          ...headingComponents,
          p({ children }: any) {
            const text = childrenToText(children);
            const matched = matchCitationsForBlock(text);
            return (
              <p>
                {children}
                {matched.length > 0 && onOpenCitation ? (
                  <CitationChip citations={citationList} matchedIndices={matched} onOpen={onOpenCitation} />
                ) : null}
              </p>
            );
          },
          li({ children }: any) {
            const text = childrenToText(children);
            const matched = matchCitationsForBlock(text);
            return (
              <li>
                {children}
                {matched.length > 0 && onOpenCitation ? (
                  <CitationChip citations={citationList} matchedIndices={matched} onOpen={onOpenCitation} />
                ) : null}
              </li>
            );
          },
          blockquote({ children }: any) {
            const text = childrenToText(children);
            const matched = matchCitationsForBlock(text);
            return (
              <blockquote>
                {children}
                {matched.length > 0 && onOpenCitation ? (
                  <CitationChip citations={citationList} matchedIndices={matched} onOpen={onOpenCitation} />
                ) : null}
              </blockquote>
            );
          },
          a({ href, children, ...props }: any) {
            const h = String(href || '');
            const isInternal = !!h && (
              h.startsWith('prd-citation:') ||
              h.startsWith('prd-citation://') ||
              h.startsWith('prd-nav:') ||
              h.startsWith('prd-nav://')
            );
            if (isInternal) {
              const { title: rawTitle, href: _hrefIgnored, ...rest } = (props as any) || {};
              const isCitation = h.startsWith('prd-citation:') || h.startsWith('prd-citation://');
              const idx = isCitation ? parseCitationIdx(h) : null;
              // 旧逻辑：如果 markdown 自带 title，则仍可显示（用于 prd-nav）
              // citations 已不再通过 markdown link 注入，所以这里仅做兜底
              const mapped = (idx != null && idx >= 0 && idx < citationList.length)
                ? String(`${citationList[idx]?.headingTitle || ''} ${citationList[idx]?.excerpt || ''}` || '').trim()
                : '';
              const t = String(rawTitle || '').trim() || mapped;
              const showPopover = isCitation && !!t;
              return (
                <span className={showPopover ? 'relative inline-flex group' : 'inline-flex'}>
                  <button
                    type="button"
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-5 ui-chip text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary-400/30"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      try {
                        const consumed = onInternalLinkClick?.(h);
                        if (consumed === true) return;
                      } catch {
                        // ignore
                      }
                    }}
                    // 避免系统默认 tooltip 与自定义浮层叠加
                    title={undefined}
                    {...rest}
                  >
                    {children}
                  </button>
                  {showPopover ? (
                    <span
                      className="pointer-events-none absolute z-20 left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover:block group-focus-within:block"
                      aria-hidden="true"
                    >
                      <span className="block max-w-[320px] rounded-lg border border-border bg-surface-light/95 dark:bg-surface-dark/95 shadow-xl px-3 py-2 text-xs text-text-primary">
                        <span className="block line-clamp-6 whitespace-pre-wrap break-words">{t}</span>
                      </span>
                    </span>
                  ) : null}
                </span>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 text-primary-600 dark:text-primary-300 hover:text-primary-700 dark:hover:text-primary-200"
                {...props}
              >
                {children}
              </a>
            );
          },
          pre({ children }: any) {
            // react-markdown 的 codeBlock 通常是：<pre><code class="language-xxx">...</code></pre>
            // 我们需要：
            // 1) mermaid：直接渲染图，不要保留外层 pre（否则会出现不合法嵌套/样式问题）
            // 2) 其它：统一在这里加 not-prose + 代码块样式（避免在 code renderer 里返回 <div>/<pre> 导致嵌套错误）
            const child = Array.isArray(children) ? children[0] : children;
            const codeClassName = child?.props?.className || '';
            const m = /language-(\w+)/.exec(codeClassName);
            const lang = (m?.[1] || '').toLowerCase();
            if (lang === 'mermaid') {
              const text = childrenToText(child?.props?.children);
              return <MermaidBlock chart={text} />;
            }
            const codeText = childrenToText(child?.props?.children);
            return (
              <div className="not-prose relative group">
                <AsyncIconButton
                  title="复制代码"
                  onAction={async () => {
                    if (!codeText) return;
                    await copyText(codeText);
                  }}
                  icon={<CopySvg />}
                  className="absolute top-2 right-2 z-10 inline-flex items-center justify-center w-8 h-8 rounded-md ui-glass-panel text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"
                />
                <pre
                  className="overflow-x-auto rounded-md border border-border bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 p-3"
                  style={{ fontFamily: 'var(--font-mono)', fontVariantLigatures: 'none' }}
                >
                  {children}
                </pre>
              </div>
            );
          },
          code({ inline, className: codeClassName, children, ...props }: any) {
            const text = childrenToText(children);
            if (inline) {
              return (
                <code className={codeClassName} {...props}>
                  {text}
                </code>
              );
            }

            // 块级 code：外层 <pre> 由 pre renderer 负责包裹/样式
            return (
              <code className={`whitespace-pre ${codeClassName || ''}`.trim()} {...props}>
                {text}
              </code>
            );
          },
          table({ children, ...props }: any) {
            return <TableWithCopy {...props}>{children}</TableWithCopy>;
          },
          img({ src, alt, ...props }: any) {
            return <ImageWithCopy src={src} alt={alt} {...props} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
