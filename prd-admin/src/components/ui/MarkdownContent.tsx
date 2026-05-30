import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy } from 'lucide-react';
import { MermaidDiagram } from '@/components/ui/MermaidDiagram';

interface MarkdownContentProps {
  content: string;
  /** text size class, default text-[13px] */
  className?: string;
  /**
   * 排版变体：
   * - `compact`（默认）：紧凑型，用于聊天气泡 / 任务面板等高密度场景
   * - `reading`：长文阅读型，放大标题层级、舒展段距、启用紫色调表格/引用/代码样式，用于知识库 / 周报等
   */
  variant?: 'compact' | 'reading';
}

/**
 * Shared Markdown renderer — GFM tables, code highlighting, lists, headings.
 * Extracted from ToolDetail's AssistantMarkdown for reuse across pages.
 */
export const MarkdownContent = memo(function MarkdownContent({ content, className, variant = 'compact' }: MarkdownContentProps) {
  const isReading = variant === 'reading';
  const wrapperClass = isReading
    ? `${className ?? 'text-[14.5px] leading-[1.85]'} markdown-reading`
    : (className ?? 'text-[13px] leading-relaxed');
  return (
    <div className={wrapperClass} style={{ color: 'var(--text-primary)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          code({ className: cn, children, ...props }) {
            const match = /language-(\w+)/.exec(cn || '');
            const codeStr = String(children ?? '').replace(/\n$/, '');
            // 块级判断：有 language- 类名 或 内容含换行（兼容未指定语言的 fenced block）
            const isBlock = !!match || codeStr.includes('\n');
            if (!isBlock) {
              if (isReading) {
                return (
                  <code
                    className="px-1.5 py-[1px] rounded text-[0.88em] font-mono"
                    style={{
                      background: 'rgba(168,85,247,0.10)',
                      color: '#e9d5ff',
                      border: '1px solid rgba(168,85,247,0.18)',
                    }}
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return (
                <code className="px-1 py-0.5 rounded text-xs" style={{ background: 'rgba(255,255,255,0.1)' }} {...props}>
                  {children}
                </code>
              );
            }
            // 块级且指定语言
            if (match) {
              // Mermaid 图表：交给 MermaidDiagram 组件渲染
              if (match[1].toLowerCase() === 'mermaid') {
                return <MermaidDiagram code={codeStr} />;
              }
              return (
                <div
                  className={`relative group/code ${isReading ? 'my-6' : 'my-2'}`}
                  style={isReading ? {
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '10px',
                    overflow: 'hidden',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                  } : undefined}
                >
                  <div
                    className={`flex items-center justify-between ${isReading ? 'px-3.5 py-2 text-[11px]' : 'px-3 py-1 rounded-t-lg text-[10px]'}`}
                    style={isReading ? {
                      background: 'rgba(255,255,255,0.035)',
                      color: 'var(--text-muted)',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                    } : { background: 'rgba(0,0,0,0.5)', color: 'var(--text-muted)' }}
                  >
                    <span style={isReading ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '0.02em' } : undefined}>
                      {match[1]}
                    </span>
                    <button
                      onClick={() => navigator.clipboard.writeText(codeStr)}
                      className="opacity-0 group-hover/code:opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 transition-all"
                    >
                      <Copy size={isReading ? 11 : 10} /> 复制
                    </button>
                  </div>
                  <SyntaxHighlighter
                    style={oneDark}
                    language={match[1]}
                    PreTag="div"
                    customStyle={isReading ? {
                      margin: 0,
                      borderRadius: 0,
                      fontSize: '0.82rem',
                      lineHeight: 1.7,
                      padding: '14px 16px',
                    } : {
                      margin: 0,
                      borderTopLeftRadius: 0,
                      borderTopRightRadius: 0,
                      borderBottomLeftRadius: '0.5rem',
                      borderBottomRightRadius: '0.5rem',
                      fontSize: '0.75rem',
                    }}
                  >
                    {codeStr}
                  </SyntaxHighlighter>
                </div>
              );
            }
            // 块级但无语言 → 纯 <pre>，避免 Prism token 背景污染 ASCII 框图
            return (
              <pre
                className="my-2 rounded-lg overflow-x-auto"
                style={{
                  margin: '0.5rem 0',
                  padding: '12px 14px',
                  fontSize: '0.75rem',
                  lineHeight: 1.6,
                  background: 'rgba(0,0,0,0.3)',
                  color: 'var(--text-primary)',
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  whiteSpace: 'pre',
                }}
              >
                {codeStr}
              </pre>
            );
          },
          pre({ children }) { return <>{children}</>; },
          p({ children }) {
            return isReading
              ? <p className="mb-4 last:mb-0">{children}</p>
              : <p className="mb-2 last:mb-0">{children}</p>;
          },
          ul({ children }) {
            return isReading
              ? <ul className="list-disc pl-6 mb-5 space-y-1.5 marker:text-purple-300/50">{children}</ul>
              : <ul className="list-disc pl-4 mb-2">{children}</ul>;
          },
          ol({ children }) {
            return isReading
              ? <ol className="list-decimal pl-6 mb-5 space-y-1.5 marker:text-purple-300/60">{children}</ol>
              : <ol className="list-decimal pl-4 mb-2">{children}</ol>;
          },
          li({ children }) {
            return isReading
              ? <li className="leading-[1.8] pl-1">{children}</li>
              : <li className="mb-0.5">{children}</li>;
          },
          h1({ children }) {
            return isReading ? (
              <h1
                className="text-[22px] font-semibold tracking-tight mt-9 mb-5 pb-3 first:mt-0"
                style={{
                  color: 'var(--text-primary)',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  letterSpacing: '-0.005em',
                }}
              >
                {children}
              </h1>
            ) : (
              <h1 className="text-base font-bold mb-2 mt-3">{children}</h1>
            );
          },
          h2({ children }) {
            return isReading ? (
              <h2
                className="text-[18px] font-semibold tracking-tight mt-8 mb-3 first:mt-0"
                style={{ color: 'var(--text-primary)', letterSpacing: '-0.005em' }}
              >
                {children}
              </h2>
            ) : (
              <h2 className="text-sm font-bold mb-1.5 mt-2.5">{children}</h2>
            );
          },
          h3({ children }) {
            return isReading ? (
              <h3
                className="text-[15.5px] font-semibold mt-6 mb-2 first:mt-0"
                style={{ color: 'var(--text-primary)' }}
              >
                {children}
              </h3>
            ) : (
              <h3 className="text-sm font-semibold mb-1 mt-2">{children}</h3>
            );
          },
          h4({ children }) {
            return isReading ? (
              <h4
                className="text-[11.5px] font-semibold uppercase mt-5 mb-2"
                style={{ color: 'var(--text-secondary)', letterSpacing: '0.06em' }}
              >
                {children}
              </h4>
            ) : (
              <h4 className="text-sm font-semibold mb-1 mt-2">{children}</h4>
            );
          },
          img({ src, alt }) {
            return (
              <img
                src={typeof src === 'string' ? src : undefined}
                alt={alt ?? ''}
                loading="lazy"
                className={isReading ? 'my-4 rounded-lg' : 'my-2 rounded-md'}
                style={{
                  maxWidth: '100%',
                  height: 'auto',
                  display: 'block',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              />
            );
          },
          hr() {
            return isReading ? (
              <hr
                className="my-8 border-0"
                style={{
                  height: '1px',
                  background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.14) 50%, transparent 100%)',
                }}
              />
            ) : (
              <hr className="my-3" style={{ borderColor: 'rgba(255,255,255,0.08)' }} />
            );
          },
          a({ children, href }) {
            return isReading ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="transition-colors"
                style={{
                  color: '#c4b5fd',
                  textDecoration: 'underline',
                  textDecorationColor: 'rgba(196,181,253,0.35)',
                  textUnderlineOffset: '3px',
                  textDecorationThickness: '1px',
                }}
              >
                {children}
              </a>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener" style={{ color: '#c4b5fd', textDecoration: 'underline' }}>
                {children}
              </a>
            );
          },
          blockquote({ children }) {
            return isReading ? (
              <blockquote
                className="my-5 py-2.5 px-4 rounded-r-md italic"
                style={{
                  borderLeft: '3px solid rgba(168,85,247,0.55)',
                  background: 'rgba(168,85,247,0.06)',
                  color: 'var(--text-secondary)',
                }}
              >
                {children}
              </blockquote>
            ) : (
              <blockquote
                className="border-l-2 pl-3 my-2"
                style={{ borderColor: 'rgba(255,255,255,0.2)', color: 'var(--text-secondary)' }}
              >
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return isReading ? (
              <div
                className="overflow-x-auto my-5 rounded-lg"
                style={{ border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <table
                  className="text-[13px] w-full border-collapse"
                  style={{ borderSpacing: 0 }}
                >
                  {children}
                </table>
              </div>
            ) : (
              <div className="overflow-x-auto my-2">
                <table className="text-xs border-collapse w-full" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
                  {children}
                </table>
              </div>
            );
          },
          thead({ children }) {
            return isReading ? (
              <thead style={{ background: 'rgba(255,255,255,0.035)' }}>{children}</thead>
            ) : (
              <thead>{children}</thead>
            );
          },
          tr({ children }) {
            return isReading ? (
              <tr className="markdown-reading-row transition-colors">{children}</tr>
            ) : (
              <tr>{children}</tr>
            );
          },
          th({ children }) {
            return isReading ? (
              <th
                className="px-3.5 py-2.5 text-left text-[11.5px] font-semibold uppercase"
                style={{
                  color: 'var(--text-secondary)',
                  letterSpacing: '0.04em',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                {children}
              </th>
            ) : (
              <th
                className="border px-2 py-1 text-left font-semibold"
                style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)' }}
              >
                {children}
              </th>
            );
          },
          td({ children }) {
            return isReading ? (
              <td
                className="px-3.5 py-2.5"
                style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
              >
                {children}
              </td>
            ) : (
              <td className="border px-2 py-1" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
                {children}
              </td>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
