import { memo, useId, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// remark 已给脚注加上每条回答独立的安全前缀；再加一次会使 href 和 id 不匹配。
// 不启用 rehypeRaw，保留其余默认过滤规则。
const citationSchema = { ...defaultSchema, clobberPrefix: '' };

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
export const AskMarkdown = memo(function AskMarkdown({ content }: { content: string }) {
  const instanceId = useId();
  const prefix = `ask-${instanceId.replace(/[^a-zA-Z0-9-]/g, '')}-`;
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} className="ask-md" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: '引用原文', footnoteBackLabel: '返回正文' }}
        rehypePlugins={[[rehypeSanitize, citationSchema]]}
        components={{
          p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc' }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: 0, paddingLeft: 18, listStyle: 'decimal' }}>{children}</ol>,
          li: ({ id, children }) => <li id={id} style={{ margin: '2px 0' }}>{children}</li>,
          strong: ({ children }) => <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{children}</strong>,
          a: ({ href, id, children, node }) => (
            <a
              id={id}
              href={href}
              target={href?.startsWith('#') ? undefined : '_blank'}
              rel={href?.startsWith('#') ? undefined : 'noopener noreferrer'}
              aria-describedby={node?.properties.dataFootnoteRef ? `${prefix}footnote-label` : undefined}
              aria-label={node?.properties.dataFootnoteBackref ? '返回正文' : undefined}
              onClick={href?.startsWith('#') ? (event) => {
                // HashRouter 的 hash 不能被脚注改写；只在当前回答中找对应锚点。
                event.preventDefault();
                const target = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[id]') ?? [])
                  .find((element) => `#${element.id}` === href);
                target?.scrollIntoView({ block: 'nearest' });
                if (target) {
                  target.setAttribute('tabindex', '-1');
                  target.focus({ preventScroll: true });
                }
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
          h2: ({ id, children }) => (
            <h2
              id={id === 'footnote-label' ? `${prefix}footnote-label` : id}
              style={{ margin: 0, fontSize: '1em', color: 'var(--text-primary)', fontWeight: 600 }}
            >{children}</h2>
          ),
          h3: ({ children }) => <strong style={{ color: 'var(--text-primary)' }}>{children}</strong>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
