import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * PR 审查面板专用的 markdown 渲染器，深色主题 + 紧凑间距。
 *
 * 存在理由：项目里已有 ReactMarkdown 散落的用法（SubmissionDetailModal 等），
 * 但 PR 审查面板的字号/颜色/间距需求和它们都不同：
 * - 一句话摘要用于 card 标题，字号偏大 + 白色
 * - 关键改动 bullet 行内嵌套，需要紧凑
 * - 完整 markdown body 放在折叠区/弹窗，需要可读性高
 * 所以这里暴露 `variant` 选项按场景切换尺寸。
 */
interface Props {
  children: string;
  /** inline: 用于单行场景（card 标题、bullet 内容），禁用段落空隙 */
  variant?: 'inline' | 'block';
  className?: string;
}

export function PrMarkdown({ children, variant = 'block', className }: Props) {
  const isInline = variant === 'inline';
  return (
    <div
      className={[
        'pr-markdown',
        isInline ? 'pr-markdown-inline' : 'pr-markdown-block',
        className ?? '',
      ].join(' ')}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // inline code：高亮的等宽字体，不换行
          code({ className: cls, children: c, ...props }) {
            const isBlock = /language-/.test(cls ?? '');
            if (isBlock) {
              return (
                <pre className="bg-black/50 border border-white/10 rounded-lg p-3 text-[11px] text-white/85 font-mono whitespace-pre-wrap break-words overflow-x-auto my-2">
                  <code {...props}>{c}</code>
                </pre>
              );
            }
            return (
              <code
                className="px-1 py-0.5 rounded bg-white/10 text-[0.85em] text-sky-200 font-mono break-words"
                {...props}
              >
                {c}
              </code>
            );
          },
          // 链接：sky 色 + 新窗口
          a({ href, children: c, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-300 underline decoration-sky-300/30 hover:decoration-sky-300 break-words"
                {...props}
              >
                {c}
              </a>
            );
          },
          // 列表：紧凑缩进
          ul({ children: c }) {
            return <ul className={isInline ? 'inline' : 'list-disc pl-4 space-y-1 my-1'}>{c}</ul>;
          },
          ol({ children: c }) {
            return (
              <ol className={isInline ? 'inline' : 'list-decimal pl-4 space-y-1 my-1'}>{c}</ol>
            );
          },
          // 段落：inline 模式合并成 span
          p({ children: c }) {
            if (isInline) return <>{c}</>;
            return <p className="leading-relaxed my-1.5">{c}</p>;
          },
          // 标题：block 模式保留小一级
          h1({ children: c }) {
            return <h3 className="text-sm font-semibold text-white mt-3 mb-1.5">{c}</h3>;
          },
          h2({ children: c }) {
            return <h4 className="text-xs font-semibold text-white/90 mt-2 mb-1">{c}</h4>;
          },
          h3({ children: c }) {
            return <h5 className="text-xs font-semibold text-white/80 mt-2 mb-1">{c}</h5>;
          },
          // 强调
          strong({ children: c }) {
            return <strong className="text-white font-semibold">{c}</strong>;
          },
          em({ children: c }) {
            return <em className="italic text-white/90">{c}</em>;
          },
          // blockquote
          blockquote({ children: c }) {
            return (
              <blockquote className="border-l-2 border-sky-400/50 pl-3 my-2 text-white/70 italic">
                {c}
              </blockquote>
            );
          },
          // 表格
          table({ children: c }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="w-full border-collapse text-[11px]">{c}</table>
              </div>
            );
          },
          th({ children: c }) {
            return (
              <th className="border border-white/10 bg-white/5 px-2 py-1 text-left text-white/80 font-semibold">
                {c}
              </th>
            );
          },
          td({ children: c }) {
            return <td className="border border-white/10 px-2 py-1 text-white/75">{c}</td>;
          },
          hr() {
            return <hr className="my-3 border-white/10" />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
