import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy } from 'lucide-react';

interface MarkdownContentProps {
  content: string;
  /** text size class, default text-[13px] */
  className?: string;
}

/**
 * Shared Markdown renderer — GFM tables, code highlighting, lists, headings.
 * Extracted from ToolDetail's AssistantMarkdown for reuse across pages.
 */
export const MarkdownContent = memo(function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={className ?? 'text-[13px] leading-relaxed'} style={{ color: 'var(--text-primary)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          code({ className: cn, children, ...props }) {
            const match = /language-(\w+)/.exec(cn || '');
            const codeStr = String(children ?? '').replace(/\n$/, '');
            // 块级判断：有 language- 类名 或 内容含换行（兼容未指定语言的 fenced block）
            const isBlock = !!match || codeStr.includes('\n');
            if (!isBlock) {
              return (
                <code className="px-1 py-0.5 rounded text-xs" style={{ background: 'rgba(255,255,255,0.1)' }} {...props}>
                  {children}
                </code>
              );
            }
            // 块级且指定语言 → Prism 高亮
            if (match) {
              return (
                <div className="relative group/code my-2">
                  <div className="flex items-center justify-between px-3 py-1 rounded-t-lg text-[10px]"
                    style={{ background: 'rgba(0,0,0,0.5)', color: 'var(--text-muted)' }}>
                    <span>{match[1]}</span>
                    <button
                      onClick={() => navigator.clipboard.writeText(codeStr)}
                      className="opacity-0 group-hover/code:opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 transition-all"
                    >
                      <Copy size={10} /> 复制
                    </button>
                  </div>
                  <SyntaxHighlighter
                    style={oneDark}
                    language={match[1]}
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      borderTopLeftRadius: 0, borderTopRightRadius: 0,
                      borderBottomLeftRadius: '0.5rem', borderBottomRightRadius: '0.5rem',
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
          p({ children }) { return <p className="mb-2 last:mb-0">{children}</p>; },
          ul({ children }) { return <ul className="list-disc pl-4 mb-2">{children}</ul>; },
          ol({ children }) { return <ol className="list-decimal pl-4 mb-2">{children}</ol>; },
          li({ children }) { return <li className="mb-0.5">{children}</li>; },
          h1({ children }) { return <h1 className="text-base font-bold mb-2 mt-3">{children}</h1>; },
          h2({ children }) { return <h2 className="text-sm font-bold mb-1.5 mt-2.5">{children}</h2>; },
          h3({ children }) { return <h3 className="text-sm font-semibold mb-1 mt-2">{children}</h3>; },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 pl-3 my-2"
                style={{ borderColor: 'rgba(255,255,255,0.2)', color: 'var(--text-secondary)' }}>
                {children}
              </blockquote>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="text-xs border-collapse w-full" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return <th className="border px-2 py-1 text-left font-semibold"
              style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)' }}>{children}</th>;
          },
          td({ children }) {
            return <td className="border px-2 py-1" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>{children}</td>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
