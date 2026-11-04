import { memo, useCallback, useId, useMemo, useRef, type ReactNode } from 'react';
import { BookOpen, ChevronRight } from 'lucide-react';
import { AskCitationBadge } from './AskCitationBadge';
import { citationReferences, rehypeAskCitations } from './citationNodes';
import { AskCitationNote } from './AskCitationNote';
import './askCitations.css';
import ReactMarkdown, { type Components } from 'react-markdown';
import { rehypeStreamingText, StreamingMarkdownSpan } from '@/components/streaming/rehypeStreamingText';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// remark 已给脚注加上每条回答独立的安全前缀；再加一次会使 href 和 id 不匹配。
// 不启用 rehypeRaw，保留其余默认过滤规则。
const citationSchema = { ...defaultSchema, clobberPrefix: '' };

function AskMarkdownTable({ children }: { children?: ReactNode }) {
  return <div className="ask-md-table-scroll" role="region" aria-label="回答表格，可横向滚动" tabIndex={0}>
    <table>{children}</table>
  </div>;
}

/**
 * 提问答案的 markdown 渲染。
 *
 * 由 review 第一轮（#1358）抓出：`StreamingText` 只有同时拿到 `markdown` 和
 * `renderMarkdown` 才会在流结束后切到 markdown 视图，之前只传了前者，于是完成后的
 * 答案一直走纯文本渲染，`**加粗**`、列表、链接全部以原始语法裸露在气泡里。
 *
 * 为什么不用 `MarkdownViewer`：那是文档阅读器，带 KaTeX、Mermaid、Prism 高亮、
 * 双链预处理。分享页是**匿名公开页面**，把这几个库拉进它的首屏 chunk 不划算，
 * 而提问答案的形态是散文 + 列表 + 链接 + 行内代码，用不到那些。
 *
 * 安全上不放行原始 HTML（不挂 rehypeRaw）：这段文本来自模型，而模型的输入里有
 * 用户上传的网页正文——等于间接可控。渲染成 HTML 会把提示词注入变成 XSS。
 */
export const AskMarkdown = memo(function AskMarkdown({ content, sourceTitle = '本页原文', streaming = false }: { content: string; sourceTitle?: string; streaming?: boolean }) {
  const instanceId = useId();
  const prefix = `ask-${instanceId.replace(/[^a-zA-Z0-9-]/g, '')}-`;
  const rootRef = useRef<HTMLDivElement>(null);
  const notes = useMemo(() => new Map<string, string>(), []);
  const navigateCitation = useCallback((href: string) => {
    // 脚注只在当前回答内定位，不改写 HashRouter；先展开再定位，避免焦点落入隐藏内容。
    let target = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[id]') ?? [])
      .find((element) => `#${element.id}` === href);
    target = target?.closest('[data-citation-badge]')?.querySelector<HTMLAnchorElement>('a') ?? target;
    const citations = target?.closest<HTMLDetailsElement>('details.ask-citations');
    if (citations) citations.open = true;
    target?.scrollIntoView({ block: 'nearest' });
    if (target) {
      if (target.tagName !== 'A') target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  }, []);
  const components = useMemo<Components>(() => ({
    span: StreamingMarkdownSpan,
    table: AskMarkdownTable,
    p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
    ul: ({ children }) => <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc' }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: 0, paddingLeft: 18, listStyle: 'decimal' }}>{children}</ol>,
    li: ({ id, children, node }) => id?.startsWith(`${prefix}fn-`) && node
      ? <AskCitationNote id={id} node={node} prefix={prefix} onNavigate={navigateCitation}>{children}</AskCitationNote>
      : <li id={id} style={{ margin: '2px 0' }}>{children}</li>,
    section: ({ children, node }) => {
      if (node?.properties.dataFootnotes === undefined) return <section>{children}</section>;
      const list = node.children.find((child) => child.type === 'element' && child.tagName === 'ol');
      const count = list?.type === 'element' ? list.children.filter((child) => child.type === 'element' && child.tagName === 'li').length : 0;
      return <details className="ask-citations">
        <summary><BookOpen size={12} aria-hidden="true" /><span>引用 · {count}</span><ChevronRight size={12} className="ask-citations-chevron" aria-hidden="true" /></summary>
        <div className="ask-citations-list" style={{ maxHeight: 'min(220px, 32dvh)', minHeight: 0, overflowY: 'auto' }}>{children}</div>
      </details>;
    },
    sup: ({ children, node }) => {
      const references = node ? citationReferences(node) : [];
      return references.length ? <AskCitationBadge references={references} notes={notes} sourceTitle={sourceTitle} /> : <sup>{children}</sup>;
    },
    strong: ({ children }) => <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{children}</strong>,
    a: ({ href, id, children, node }) => node?.properties.dataFootnoteBackref !== undefined ? null : (
      <a
        id={id}
        href={href}
        target={href?.startsWith('#') ? undefined : '_blank'}
        rel={href?.startsWith('#') ? undefined : 'noopener noreferrer'}
        onClick={href?.startsWith('#') ? (event) => {
          event.preventDefault();
          navigateCitation(href);
        } : undefined}
        style={{ color: 'var(--accent-primary)' }}
      >
        {children}
      </a>
    ),
    code: ({ children }) => (
      <code
        style={{
          padding: '1px 5px',
          borderRadius: 4,
          background: 'var(--nested-block-bg)',
          fontSize: '0.92em',
          wordBreak: 'break-all',
        }}
      >
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre
        style={{
          margin: 0,
          padding: 10,
          borderRadius: 8,
          background: 'var(--nested-block-bg)',
          overflowX: 'auto',
          fontSize: 12,
        }}
      >
        {children}
      </pre>
    ),
    blockquote: ({ children }) => (
      <blockquote
        style={{
          margin: 0,
          paddingLeft: 10,
          borderLeft: '2px solid var(--border-default)',
          color: 'var(--text-muted)',
        }}
      >
        {children}
      </blockquote>
    ),
    h1: ({ children }) => <strong style={{ color: 'var(--text-primary)' }}>{children}</strong>,
    h2: ({ id, children }) => id === 'footnote-label'
      ? <h2 id={`${prefix}footnote-label`} className="sr-only">{children}</h2> : (
      <h2
        id={id}
        style={{ margin: 0, fontSize: '1em', color: 'var(--text-primary)', fontWeight: 600 }}
      >{children}</h2>
    ),
    h3: ({ children }) => <strong style={{ color: 'var(--text-primary)' }}>{children}</strong>,
  }), [navigateCitation, notes, prefix, sourceTitle]);
  return (
    <div ref={rootRef} className="ask-md" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: '引用原文', footnoteBackLabel: '返回正文' }}
        rehypePlugins={[[rehypeSanitize, citationSchema], [rehypeAskCitations, { notes }], [rehypeStreamingText, { streaming }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
