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
          code({ inline, className: codeClassName, children, ...props }: any) {
            const text = childrenToText(children);
            const m = /language-(\w+)/.exec(codeClassName || '');
            const lang = (m?.[1] || '').toLowerCase();

            if (!inline && lang === 'mermaid') {
              return <MermaidBlock chart={text} />;
            }

            if (inline) {
              return (
                <code className={codeClassName} {...props}>
                  {text}
                </code>
              );
            }

            return (
              // 注意：放在 prose 容器内时，typography 会给 pre 强行设置“深色背景 + 浅色字”。
              // 我们这里自定义了浅色背景，因此必须用 not-prose 脱离 typography 的 pre 样式，避免白天模式“浅底浅字”看不清。
              <div className="not-prose">
                <pre className="overflow-x-auto rounded-md border border-border bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 p-3">
                  <code className="whitespace-pre">{text}</code>
                </pre>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
