import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeSanitize from 'rehype-sanitize';
import { AS_TYPE, AS_SPACE } from '@/lib/appStoreTokens';

/**
 * 精读稿的 markdown 渲染。
 *
 * 为什么不直接用 `AskMarkdown`：那个渲染器服务于聊天气泡，把 h1/h2/h3 全压成 `<strong>`
 * —— 一段对话里出现一个大标题是噪音，所以那样做是对的。精读稿不是气泡，它是一篇一两千字的
 * 文章，靠「这本书在说什么 / 怎么用在我们身上 / 我们在哪儿栽过」三个二级标题分段，
 * 标题层级塌成粗体之后读者就分不清哪里是分段、哪里只是句子里的强调。
 *
 * 安全取舍与 AskMarkdown 一致：不挂 rehypeRaw。这段文本来自模型，让它输出的 HTML 真的
 * 渲染成 HTML，等于把提示词注入升级成 XSS。
 *
 * 字号一律取 `appStoreTokens` 的档位，不自己造中间值（同 AS_TYPE 顶部那段纪律）。
 * 唯一的偏离是正文行高：`heroSubtitle` 的 1.3 是给一两行副标题排的，成篇读会挤成一坨，
 * 长文按 1.8 排 —— 和 `AS_TYPE.quote` 对 groupTitle 做的是同一种偏离。
 */
export const DigestMarkdown = memo(function DigestMarkdown({ content }: { content: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--text-secondary)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          h1: ({ children }) => (
            <h2 style={{ margin: `${AS_SPACE.titleGap}px 0 0`, ...asType(AS_TYPE.sectionTitle), color: 'var(--text-primary)', textWrap: 'pretty' }}>
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h2 style={{ margin: `${AS_SPACE.titleGap}px 0 0`, ...asType(AS_TYPE.groupTitle), color: 'var(--text-primary)', textWrap: 'pretty' }}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ margin: '4px 0 0', ...asType(AS_TYPE.itemTitle), color: 'var(--text-primary)', textWrap: 'pretty' }}>
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p style={{ margin: 0, ...asType(AS_TYPE.heroSubtitle), lineHeight: 1.8, textWrap: 'pretty' }}>{children}</p>
          ),
          ul: ({ children }) => (
            <ul style={{ margin: 0, paddingLeft: 20, listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: 0, paddingLeft: 20, listStyle: 'decimal', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</ol>
          ),
          li: ({ children }) => (
            <li style={{ margin: 0, ...asType(AS_TYPE.heroSubtitle), lineHeight: 1.8 }}>{children}</li>
          ),
          strong: ({ children }) => <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{children}</strong>,
          em: ({ children }) => <em style={{ fontStyle: 'normal', color: 'var(--text-primary)' }}>{children}</em>,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: 0,
                paddingLeft: 12,
                borderLeft: '2px solid var(--border-default)',
                color: 'var(--text-muted)',
              }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code
              style={{
                padding: '1px 5px',
                borderRadius: 4,
                background: 'var(--nested-block-bg)',
                fontSize: '0.9em',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
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
                padding: 12,
                borderRadius: AS_SPACE.iconRadius,
                background: 'var(--nested-block-bg)',
                overflowX: 'auto',
                fontSize: 12,
              }}
            >
              {children}
            </pre>
          ),
          hr: () => <hr style={{ margin: 0, border: 0, borderTop: '1px solid var(--border-faint)' }} />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** 档位对象 → CSSProperties。与 mobile/parts.tsx 的 asStyle 同形，这里不跨目录反向依赖它。 */
function asType(t: { fontSize: number; fontWeight: number; letterSpacing?: string; lineHeight?: number }) {
  return {
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    letterSpacing: t.letterSpacing,
    lineHeight: t.lineHeight,
  } as const;
}
