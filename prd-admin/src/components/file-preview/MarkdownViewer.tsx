import { useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import 'katex/dist/katex.min.css';
import GithubSlugger from 'github-slugger';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { parseFrontmatter } from '@/lib/frontmatter';
// SSOT：与 TOC（markdownToc.ts）共用同一套「标题文本 → slug」规则，
// 保证目录点击能精确跳到带内嵌 HTML 的标题（rehypeRaw 渲染后）。
import { headingTextToSlug } from '@/lib/markdownToc';

// ── Markdown heading slug 辅助 ──
function childrenToText(children: unknown): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (typeof children === 'object' && children !== null && 'props' in children) {
    const props = (children as { props?: { children?: unknown } }).props;
    return childrenToText(props?.children);
  }
  return '';
}

// 允许文档正文里内嵌的 HTML（div/span/strong 等）携带 class/id，
// 同时经过 rehype-sanitize 过滤掉 script / on* 事件，防止 XSS。
// KaTeX 输出的 math 标签也一并放行。
//
// 安全取舍（Bugbot-3）：不再放行任意元素的内联 style。
// 知识库可"发布到智识殿堂"被匿名公开访问，配合 rehypeRaw，
// 通配放行 style 会让上传文档能用 position:fixed 做全页 UI 钓鱼、
// background-image:url(...) 做数据外带，削弱 sanitize 的 XSS 防护。
// 代价：内嵌 <div style="margin:..."> 之类只丢内联间距，标签本身仍渲染成元素
//（"裸标签当文本显示"的诉求已由 rehypeRaw 解决，不依赖 inline style）。
//
// 安全取舍（Codex-J）：同理不再放行任意元素的 className。
// 上传 markdown 内嵌 HTML 可携带本应用 Tailwind/工具类（如 fixed inset-0、
// 高 z-index、背景类）穿过 sanitizer，在已发布文档里覆盖/伪装应用 UI，
// 与内联 style 是同源的 UI 钓鱼面。仅保留 id（标题锚点等）。
// KaTeX 输出的 class 不经此 schema：rehype 顺序为
// [rehypeRaw, rehypeSanitize, rehypeKatex]，rehypeKatex 在 sanitize 之后运行，
// 故移除 className 放行不影响数学公式渲染；正文 markdown 的 class 由
// React 组件 renderer 赋予（不经 raw+sanitize 链），同样不受影响。
const docSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'id'],
    math: ['xmlns'],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
    'mfrac', 'msqrt', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'mtext', 'annotation',
  ],
};

export function MarkdownViewer({ content }: { content: string }) {
  // 剥离首个 YAML frontmatter 块，避免 ---/title:/description: 被当正文渲染。
  // 与左侧标题提取共用 parseFrontmatter（SSOT）。
  const body = useMemo(() => parseFrontmatter(content).body, [content]);
  // 每次 body 变化都重建 slugger，确保同名 heading 得到稳定干净的 slug
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slugger = useMemo(() => new GithubSlugger(), [body]);
  // GithubSlugger 有状态（记录已用过的 slug 以去重）。MarkdownViewer 在 body 不变的
  // 重渲染（开评论抽屉/划词选区/父级 state 变化）下会复用同一 memo 实例，若不重置，
  // 第二次渲染的 heading id 会漂移成 name-1/name-2，而 TOC 侧每次用全新 slugger 解析，
  // 导致重渲染后锚点失配。每次渲染前 reset，保证两侧字面始终一致（SSOT）。
  slugger.reset();
  const mkHeading = useCallback(
    (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ children }: { children?: React.ReactNode }) => {
      // childrenToText 拿到的是渲染后纯文本（HTML 标签已成元素、实体已解码），
      // 走 rendered 路径（alreadyRendered=true）：跳过剥标签/解实体，
      // 否则 `Use <T> generics` 里的 <T> 会被标签正则误删，与 TOC 不一致。
      const { id: slugId } = headingTextToSlug(childrenToText(children), slugger, { alreadyRendered: true });
      const id = slugId || undefined;
      // F2：借鉴文档站的标题节奏——上间距明显大于下间距，层级清晰
      const classesByTag: Record<string, string> = {
        h1: 'text-[24px] font-bold mt-8 mb-4 pb-2.5 leading-tight scroll-mt-24',
        h2: 'text-[19px] font-bold mt-9 mb-3 pb-2 leading-snug scroll-mt-24',
        h3: 'text-[16px] font-semibold mt-7 mb-2.5 leading-snug scroll-mt-24',
        h4: 'text-[14px] font-semibold mt-5 mb-2 scroll-mt-24',
        h5: 'text-[13px] font-semibold mt-4 mb-1.5 scroll-mt-24',
        h6: 'text-[12px] font-semibold mt-4 mb-1.5 scroll-mt-24',
      };
      const style: React.CSSProperties =
        Tag === 'h1'
          ? { borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }
          : Tag === 'h2'
            ? { borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }
            : { color: 'var(--text-primary)' };
      return <Tag id={id} className={classesByTag[Tag]} style={style}>{children}</Tag>;
    },
    [slugger],
  );
  return (
    // F2：文档站观感——更大行距、克制的最大宽度（长行不利阅读）、底部留白
    <div
      className="prose-invert text-[14px]"
      style={{ lineHeight: 1.78, maxWidth: '860px', paddingBottom: '96px' }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, docSanitizeSchema], rehypeKatex]}
        components={{
          h1: mkHeading('h1'),
          h2: mkHeading('h2'),
          h3: mkHeading('h3'),
          h4: mkHeading('h4'),
          h5: mkHeading('h5'),
          h6: mkHeading('h6'),
          p: ({ children }) => <p className="my-3.5 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.78))' }}>{children}</p>,
          a: ({ href, children }) => {
            // 锚点 → SPA 内 scroll，不新开标签页
            if (href && href.startsWith('#')) {
              return (
                <a href={href} className="underline underline-offset-2" style={{ color: 'rgba(96,165,250,0.9)' }}
                  onClick={(e) => {
                    e.preventDefault();
                    const id = decodeURIComponent(href.slice(1));
                    const target = document.getElementById(id);
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}>
                  {children}
                </a>
              );
            }
            return <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: 'rgba(96,165,250,0.9)' }}>{children}</a>;
          },
          ul: ({ children, className }) => {
            const isTaskList = className?.includes('contains-task-list');
            return (
              <ul className={`${isTaskList ? 'list-none pl-2' : 'list-disc pl-6'} my-3.5 space-y-1.5`} style={{ color: 'var(--text-secondary)' }}>
                {children}
              </ul>
            );
          },
          ol: ({ children }) => <ol className="list-decimal pl-6 my-3.5 space-y-1.5" style={{ color: 'var(--text-secondary)' }}>{children}</ol>,
          li: ({ children, className }) => {
            const isTaskItem = className?.includes('task-list-item');
            return <li className={`text-[14px] leading-relaxed ${isTaskItem ? 'flex items-start gap-2' : ''}`}>{children}</li>;
          },
          blockquote: ({ children }) => (
            <blockquote
              className="my-4 pl-4 pr-3 py-2 rounded-r-[6px]"
              style={{
                borderLeft: '3px solid var(--accent-primary, var(--accent-gold))',
                background: 'var(--bg-input-hover)',
                color: 'var(--text-muted)',
              }}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border-subtle)' }}>
              <table className="w-full text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="px-3 py-2 text-left font-semibold" style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)' }}>{children}</th>,
          td: ({ children }) => <td className="px-3 py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', color: 'var(--text-secondary)' }}>{children}</td>,
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const text = String(children ?? '').replace(/\n$/, '');
            // 块级判断：有 language- 类名 或 内容包含换行（兼容未指定语言的 fenced code block）
            const isBlock = !!match || text.includes('\n');
            if (!isBlock) {
              return <code className="px-1.5 py-0.5 rounded text-[12px]" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(248,113,113,0.9)' }} {...props}>{children}</code>;
            }
            // 块级且指定了语言 → Prism 高亮
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{
                    margin: '18px 0', borderRadius: '10px', fontSize: '12px',
                    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.04)',
                  }}
                >
                  {text}
                </SyntaxHighlighter>
              );
            }
            // 块级但无语言 → 纯 <pre>，避免 Prism token 背景污染 ASCII 框图
            return (
              <pre
                style={{
                  margin: '18px 0',
                  padding: '14px 16px',
                  borderRadius: '10px',
                  fontSize: '12px',
                  lineHeight: 1.6,
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.85)',
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  whiteSpace: 'pre',
                  overflowX: 'auto',
                }}
              >
                {text}
              </pre>
            );
          },
          pre: ({ children }) => <>{children}</>,
          hr: () => <hr className="my-7" style={{ borderColor: 'var(--border-subtle)' }} />,
          img: ({ src, alt }) => (
            <img src={src} alt={alt || ''} className="max-w-full rounded-lg my-3" style={{ maxHeight: '400px', border: '1px solid rgba(255,255,255,0.06)' }} />
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownViewer;
