import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import MermaidBlock from './MermaidBlock';
import GithubSlugger from 'github-slugger';

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
};

export default function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  // slugger 需要在一次渲染周期内保持状态，用于处理重名标题的去重（a、a-1、a-2...）
  const slugger = useMemo(() => new GithubSlugger(), [content]);

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
            return (
              <div className="not-prose">
                <pre className="overflow-x-auto rounded-md border border-border bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 p-3">
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
