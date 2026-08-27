import { useCallback, useMemo, useRef, useState, memo, type ReactNode } from 'react';
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
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useDataTheme } from '@/hooks/useDataTheme';
import { parseFrontmatter } from '@/lib/frontmatter';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { MermaidDiagram } from '@/components/ui/MermaidDiagram';
import { UpdateTimeline, parseMermaidTimeline } from '@/components/ui/UpdateTimeline';
import { lookupWikilinkTitle } from '@/lib/wikilinkCache';
// SSOT：与 TOC（markdownToc.ts）共用同一套「标题文本 → slug」规则，
// 保证目录点击能精确跳到带内嵌 HTML 的标题（rehypeRaw 渲染后）。
import { headingTextToSlug } from '@/lib/markdownToc';
import { Copy, Check } from 'lucide-react';

// 代码块复制外壳：hover 显示「复制」按钮，点击写入剪贴板，1.5s 后复位。
// 按钮绝对定位在外层包裹（而非滚动的 pre 内），长代码横向滚动时按钮不跟着跑。
// 外层承担代码块上下外边距，内层块的 margin 归零，保证按钮贴块右上角。
function CodeBlockShell({ text, children }: { text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  }, [text]);
  return (
    <div className="group relative" style={{ margin: '18px 0' }}>
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 inline-flex items-center gap-1 px-1.5 py-1 rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer bg-token-nested border border-token-subtle"
        style={{ zIndex: 1, color: 'var(--text-secondary)', fontSize: 10 }}
        title="复制代码"
        aria-label="复制代码"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? '已复制' : '复制'}
      </button>
      {children}
    </div>
  );
}

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
    // 允许 wikilink: 协议的 href（双链渲染走自定义 a 组件拦截）
    a: [...(defaultSchema.attributes?.a || []), ['href', /^(?:#|https?:|mailto:|wikilink:).+/]],
    math: ['xmlns'],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
    'mfrac', 'msqrt', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'mtext', 'annotation',
  ],
  // 同时把 wikilink 加进协议白名单（双重保险：有些版本走 protocols，有些走 attribute pattern）
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: [
      ...((defaultSchema.protocols as { href?: string[] } | undefined)?.href ?? ['http', 'https', 'mailto']),
      'wikilink',
    ],
  },
};

// 正文渲染的插件链是 SSOT：任何「正文里的某种写法能不能活到渲染」的断言都必须走这两个常量，
// 测试里另抄一条链就会与真实渲染漂移（predicate-and-wiring-discipline.md 形状 3）。
// 划词就地 diff 的 <ins>/<del> 标记正是靠 rehypeRaw + 这份 sanitize 白名单活下来的。
export const DOC_REMARK_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['remarkPlugins'] =
  [remarkGfm, remarkBreaks, remarkMath];
export const DOC_REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] =
  [rehypeRaw, [rehypeSanitize, docSanitizeSchema], rehypeKatex];

/**
 * 把 wiki 链接语法 [[标题]] / [[标题|别名]] 转成标准 markdown 链接 [文本](wikilink:标题)
 * 这样 ReactMarkdown 视为普通链接渲染，由下方 a 组件的自定义 renderer 拦截 wikilink: href
 * 渲染为可点击的双链样式。点击发送 CustomEvent('wikilink:click')，由上层（DocumentStorePage）
 * 监听并跳转到对应 entry。详见 doc/design.knowledge-base.mention-network.md。
 */
function preprocessWikilinks(body: string): string {
  if (!body) return body;
  // 故意不识别嵌套/换行/管道符里的内容，与后端 WikiLinkParser 行为一致。
  // 用 #wikilink/ 前缀 hash 锚（sanitize 永远放行 # 协议），下方 a 组件 renderer
  // 优先匹配此前缀。曾尝试自定义 wikilink: 协议，被 rehypeSanitize 协议白名单剥掉
  // 失败（即使把 wikilink 写进 protocols.href 仍然不稳）。hash 锚最简单可靠。
  return body.replace(/\[\[([^\][|\n]+?)(?:\|([^\]\n]+?))?\]\]/g, (_, title: string, alias?: string) => {
    const display = (alias ?? title).trim();
    const target = title.trim();
    if (!target) return '';
    return `[${display}](#wikilink/${encodeURIComponent(target)})`;
  });
}

function MarkdownViewerBase({ content }: { content: string }) {
  // 代码块配色跟随主题：浅色纸面上再摆一块黑底白字的代码框，是「样式混乱」的头号来源
  // （2026-07-31 用户反馈）。高亮主题也要换，否则 oneDark 的浅色 token 会打在浅底上。
  const theme = useDataTheme();
  // 剥离首个 YAML frontmatter 块，避免 ---/title:/description: 被当正文渲染。
  // 与左侧标题提取共用 parseFrontmatter（SSOT）。
  // 同时把 [[xxx]] 双链预处理成标准 markdown 链接（wikilink: 协议）。
  const body = useMemo(() => preprocessWikilinks(parseFrontmatter(content).body), [content]);

  // 图片 lightbox：点击 markdown 中任意 <img> 打开放大模态，支持 ← → 切换。
  // 注意：不能用"每次渲染重置 ref + img renderer 中 push"的方式收集图片！
  // ReactMarkdown 在 body 不变时会缓存子树，img 自定义 renderer 不会重跑，
  // 重置后的 ref 永远是空数组，导致 lightbox 永远不显示（2026-05-28 用户反馈）。
  // 正确做法：用 useMemo 一次性扫 markdown 源码里的 ![alt](src) 模式，
  // 列表稳定与 body 同生命周期，src 顺序与正文显示顺序一致。
  const imageList = useMemo<{ src: string; alt: string }[]>(() => {
    const list: { src: string; alt: string }[] = [];
    // 标准 markdown 图片语法：![alt](src "title")
    // 容错：alt 可空、src 可带 query、title 部分忽略
    const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      list.push({ alt: m[1] || '', src: m[2] });
    }
    // 兜底：内嵌 HTML <img src="..."> 也扫一遍（rehypeRaw 启用时正文可能直接含 HTML img）
    const htmlRe = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
    while ((m = htmlRe.exec(body)) !== null) {
      const matched = m;
      // 避免与 markdown 语法重复
      if (!list.some(i => i.src === matched[1])) list.push({ src: matched[1], alt: matched[2] || '' });
    }
    return list;
  }, [body]);
  // src → 索引映射，img renderer 内 O(1) 查表
  const imageIndexBySrc = useMemo(() => {
    const map = new Map<string, number>();
    imageList.forEach((it, idx) => map.set(it.src, idx));
    return map;
  }, [imageList]);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  // 每次 body 变化都重建 slugger，确保同名 heading 得到稳定干净的 slug
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const slugger = useMemo(() => new GithubSlugger(), [body]);
  // GithubSlugger 有状态（记录已用过的 slug 以去重）。MarkdownViewer 在 body 不变的
  // 重渲染（开评论抽屉/划词选区/父级 state 变化）下会复用同一 memo 实例，若不重置，
  // 第二次渲染的 heading id 会漂移成 name-1/name-2，而 TOC 侧每次用全新 slugger 解析，
  // 导致重渲染后锚点失配。每次渲染前 reset，保证两侧字面始终一致（SSOT）。
  slugger.reset();
  /**
   * 渲染器身份必须**跨 render 稳定**（2026-08-25）。
   *
   * 这些 renderer 以前是写在 JSX 里的内联箭头函数，每次 render 都是新函数，
   * ReactMarkdown 按元素类型标识对比，于是**每次重渲染都重挂整棵正文 DOM**。
   * 组件靠 memo(content 不变就跳过) 兜住了静态阅读，但只要 content 在变
   *（流式改写逐 token 追加、实时协同）就会每帧重挂：动画无限重启、原生选区被清空、
   * Mermaid/KaTeX 反复初始化。用户的原话是「一闪一闪，就像是老电脑一样」。
   *
   * 稳定做法：把随实例变化的东西（slugger / 图片索引 / 主题）收进一个 ref 包，
   * renderer 读 ctx.current；components 本身 useMemo([], 一次性建好)。
   * ref 在 render 阶段就刷新，而 renderer 是在同一次 commit 里被调用的，读到的必然是新值。
   */
  const ctx = useRef({ slugger, imageIndexBySrc, theme });
  ctx.current.slugger = slugger;
  ctx.current.imageIndexBySrc = imageIndexBySrc;
  ctx.current.theme = theme;

  const components = useMemo<React.ComponentProps<typeof ReactMarkdown>['components']>(() => {
      const mkHeading =
      (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => ({ children }: { children?: React.ReactNode }) => {
        // childrenToText 拿到的是渲染后纯文本（HTML 标签已成元素、实体已解码），
        // 走 rendered 路径（alreadyRendered=true）：跳过剥标签/解实体，
        // 否则 `Use <T> generics` 里的 <T> 会被标签正则误删，与 TOC 不一致。
        const { id: slugId } = headingTextToSlug(childrenToText(children), ctx.current.slugger, { alreadyRendered: true });
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
      };
    return {
            h1: mkHeading('h1'),
            h2: mkHeading('h2'),
            h3: mkHeading('h3'),
            h4: mkHeading('h4'),
            h5: mkHeading('h5'),
            h6: mkHeading('h6'),
            p: ({ children }) => <p className="my-3.5 whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary, var(--text-secondary))' }}>{children}</p>,
            a: ({ href, children }) => {
              // 双链 [[xxx]] → #wikilink/ hash 锚（preprocessWikilinks 转出）。
              // 必须放在通用 # 锚点分支之前，否则会被当成 in-page anchor 处理。
              if (href && href.startsWith('#wikilink/')) {
                const title = decodeURIComponent(href.slice('#wikilink/'.length));
                // 查缓存判断目标是否存在 → 不存在时改用"虚链接"样式（橙色虚线下划线）
                const cached = lookupWikilinkTitle(title);
                const exists = cached !== null;
                return (
                  <a
                    href={href}
                    className={exists ? 'wikilink-anchor' : 'wikilink-anchor wikilink-broken'}
                    data-wikilink={title}
                    style={{
                      color: exists ? 'rgba(124,156,255,0.95)' : 'rgba(255,156,77,0.85)',
                      background: exists ? 'rgba(124,156,255,0.08)' : 'rgba(255,156,77,0.06)',
                      padding: '0 4px',
                      borderRadius: 3,
                      borderBottom: exists
                        ? '1px solid rgba(124,156,255,0.45)'
                        : '1px dashed rgba(255,156,77,0.5)',
                      textDecoration: 'none',
                      cursor: 'pointer',
                    }}
                    title={exists ? undefined : `「${title}」尚不存在`}
                    onMouseEnter={(e) => {
                      document.dispatchEvent(new CustomEvent('wikilink:hover', {
                        detail: { title, x: e.clientX, y: e.clientY, exists },
                      }));
                    }}
                    onMouseLeave={() => {
                      document.dispatchEvent(new CustomEvent('wikilink:unhover'));
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      // 派发到全局，由消费方（DocumentStorePage 等）监听并跳转
                      document.dispatchEvent(new CustomEvent('wikilink:click', { detail: { title } }));
                    }}
                  >
                    {children}
                  </a>
                );
              }
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
                  // 引用块常是「重点原话」，用 muted 会比正文还淡；跟正文同级更好读
                  color: 'var(--text-secondary)',
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
            th: ({ children }) => <th className="px-3 py-2 text-left font-semibold bg-token-nested border-b border-b-token-subtle" style={{ color: 'var(--text-primary)' }}>{children}</th>,
            td: ({ children }) => <td className="px-3 py-1.5 border-b border-b-token-subtle" style={{ color: 'var(--text-secondary)' }}>{children}</td>,
            code: ({ className, children, ...props }) => {
              const match = /language-(\w+)/.exec(className || '');
              const text = String(children ?? '').replace(/\n$/, '');
              // 块级判断：有 language- 类名 或 内容包含换行（兼容未指定语言的 fenced code block）
              const isBlock = !!match || text.includes('\n');
              if (!isBlock) {
                return <code className="px-1.5 py-0.5 rounded text-[12px]" style={{ background: 'var(--code-inline-bg)', color: 'var(--code-inline-text)' }} {...props}>{children}</code>;
              }
              // 块级且指定了语言 → Mermaid 图表交给 MermaidDiagram 渲染，其余走 Prism 高亮
              if (match) {
                if (match[1].toLowerCase() === 'mermaid') {
                  // timeline 类型横向太挤、看不清 → 改用纵向时间线组件；其余 mermaid 图照旧
                  if (parseMermaidTimeline(text)) {
                    return <UpdateTimeline code={text} />;
                  }
                  return <MermaidDiagram code={text} />;
                }
                return (
                  <CodeBlockShell text={text}>
                    <SyntaxHighlighter
                      style={ctx.current.theme === 'light' ? oneLight : oneDark}
                      language={match[1]}
                      PreTag="div"
                      customStyle={{
                        margin: 0, borderRadius: '10px', fontSize: '12px',
                        background: 'var(--code-block-bg)', border: '1px solid var(--code-block-border)',
                      }}
                    >
                      {text}
                    </SyntaxHighlighter>
                  </CodeBlockShell>
                );
              }
              // 块级但无语言 → 纯 <pre>，避免 Prism token 背景污染 ASCII 框图
              return (
                <CodeBlockShell text={text}>
                <pre
                  style={{ margin: 0, padding: '14px 16px', borderRadius: '10px', fontSize: '12px', lineHeight: 1.6, background: 'var(--code-block-bg)', border: '1px solid var(--code-block-border)', color: 'var(--code-block-text)', fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", whiteSpace: 'pre', overflowX: 'auto' }}
                >
                  {text}
                </pre>
                </CodeBlockShell>
              );
            },
            pre: ({ children }) => <>{children}</>,
            hr: () => <hr className="my-7" style={{ borderColor: 'var(--border-subtle)' }} />,
            img: ({ src, alt }) => {
              // 用 useMemo 预扫的 imageList 查索引，避免依赖 renderer 是否重跑
              const myIdx = src ? (ctx.current.imageIndexBySrc.get(src) ?? -1) : -1;
              return (
                <img
                  src={src}
                  alt={alt || ''}
                  className="max-w-full rounded-lg my-3 border border-token-subtle"
                  style={{ maxHeight: '400px', cursor: myIdx >= 0 ? 'zoom-in' : 'default' }}
                  onClick={() => {
                    if (myIdx >= 0) setLightboxIdx(myIdx);
                  }}
                  title={myIdx >= 0 ? '点击放大 · 支持 ← → 切换' : (alt || '')}
                />
              );
            },
    };
    // 依赖必须是空数组——这正是这次修复的全部意义（见上方注释）。
  }, []);

  return (
    // F2：文档站观感——更大行距、自适应宽度（窄屏占满，宽屏给到 1180 上限避免长行不利阅读）、底部留白
    <div
      className="prose-invert text-[14px]"
      style={{
        lineHeight: 1.78,
        maxWidth: 'min(100%, 1180px)',
        paddingBottom: '96px',
        // 显式允许文本选中（划词评论硬依赖）。
        // 修复 2026-05-28 用户反馈："选中的内容会自动消失"——
        // 任何祖先一旦 user-select:none 都会让选区瞬间清空，这里硬复位为 text。
        userSelect: 'text',
        WebkitUserSelect: 'text',
      }}
    >
      <ReactMarkdown
        remarkPlugins={DOC_REMARK_PLUGINS}
        rehypePlugins={DOC_REHYPE_PLUGINS}
        components={components}
      >
        {body}
      </ReactMarkdown>
      {lightboxIdx !== null && imageList.length > 0 && (
        <ImageLightbox
          images={imageList.map((i) => i.src)}
          captions={imageList.map((i) => i.alt)}
          index={Math.min(lightboxIdx, imageList.length - 1)}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}

// memo：content 不变时不再 re-render。
// 关键修复（划词选区"自动撤销"）——本组件给 ReactMarkdown 传的 components 里
// p/a/ul/li/blockquote 等是每次渲染新建的内联函数，父级因 liveSelection 等 state 变化
// 触发 re-render 时，ReactMarkdown 会按新函数标识 remount 整棵正文 DOM，
// 进而把用户正在进行的原生选区清空。memo 让 content 不变时彻底跳过 re-render，
// 正文 DOM 稳定，选区得以保留。
export const MarkdownViewer = memo(MarkdownViewerBase);

export default MarkdownViewer;
