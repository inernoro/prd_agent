/**
 * 毒舌秘书专用 Markdown 渲染器 — 提升阅读性的排版系统
 *
 * 设计目标：
 *   - 字号层级清晰：H1 18sb / H2 16sb / H3 14sb / body 14 / caption 12
 *   - 行高舒展：lead 1.75；段距 mb-3
 *   - 视觉强调：加粗自动琥珀色，引用块左竖条（emoji 零依赖）
 *   - 列表标号：圆点 → 琥珀填充小方块（与象限色呼应）
 *   - 代码块：暗底等宽 + 顶部小标签（lang）
 *   - 表格：条带交替 + hairline 分隔
 *   - 链接：紫色 + 下划线 hover
 *
 * 复用：PaAssistantChat 主对话 + PaReviewDrawer 复盘 都共用此组件
 *
 * 样式作用域：所有选择器走 `.pa-chat-markdown` 前缀，由 paAgent.css 落实
 */
import { memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ChatMarkdownProps {
  /** Markdown 内容 */
  content: string;
  /** 可选 className 透传 */
  className?: string;
}

export const ChatMarkdown = memo(function ChatMarkdown({ content, className }: ChatMarkdownProps) {
  return (
    <div className={`pa-chat-markdown ${className ?? ''}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 标题层级 — 三档字号 + 上下空间感
          h1: ({ children }) => <h1 className="pa-md-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="pa-md-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="pa-md-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="pa-md-h4">{children}</h4>,

          // 段落 — 14px / line-height 1.75 / mb-3
          p: ({ children }) => <p className="pa-md-p">{children}</p>,

          // 列表 — ul 走琥珀小方块 marker；ol 走数字徽章
          ul: ({ children }) => <ul className="pa-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="pa-md-ol">{children}</ol>,
          li: ({ children }) => <li className="pa-md-li">{children}</li>,

          // 加粗 — 琥珀色高亮（与品牌呼应）
          strong: ({ children }) => <strong className="pa-md-strong">{children}</strong>,
          em: ({ children }) => <em className="pa-md-em">{children}</em>,

          // 引用块 — 左竖条琥珀色 + 斜体 + 米色背景
          blockquote: ({ children }) => <blockquote className="pa-md-blockquote">{children}</blockquote>,

          // 链接 — 紫色 + 下划线 hover + 新窗口
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
              className="pa-md-a"
            >
              {children}
            </a>
          ),

          // 代码 — 行内代码 vs 块代码
          code: (props) => {
            const { className: cn, children, ...rest } = props as { className?: string; children?: ReactNode };
            const isBlock = /language-/.test(cn || '');
            if (isBlock) {
              const lang = (cn || '').replace(/^language-/, '');
              return (
                <span className="pa-md-codeblock">
                  {lang && <span className="pa-md-codeblock-lang">{lang}</span>}
                  <code {...rest} className={cn}>{children}</code>
                </span>
              );
            }
            return <code {...rest} className="pa-md-code-inline">{children}</code>;
          },
          pre: ({ children }) => <pre className="pa-md-pre">{children}</pre>,

          // 表格 — 条带 + hairline 分隔
          table: ({ children }) => (
            <div className="pa-md-table-wrap">
              <table className="pa-md-table">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="pa-md-thead">{children}</thead>,
          tr: ({ children }) => <tr className="pa-md-tr">{children}</tr>,
          th: ({ children }) => <th className="pa-md-th">{children}</th>,
          td: ({ children }) => <td className="pa-md-td">{children}</td>,

          // 分隔线 — 渐隐 hairline
          hr: () => <hr className="pa-md-hr" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
