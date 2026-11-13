import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import GithubSlugger from 'github-slugger';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';
import { MermaidDiagram } from '@/components/ui/MermaidDiagram';
import { useDataTheme } from '../hooks/useDataTheme';
import { headingTextToSlug } from '@/lib/markdownToc';

interface RichTextMarkdownContentProps {
  content: string;
  showRealtimeLabel?: boolean;
  imageMaxHeight?: number;
  imageUrls?: string[];
  className?: string;
}

type PreviewImage = {
  url: string;
  alt: string;
};

const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

interface ReportMarkdownNode {
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: ReportMarkdownNode[];
}

/** Slugs restart for each document render; the component prefix isolates reports shown together. */
function reportAnchorPlugin(prefix: string) {
  return () => (tree: unknown) => {
    const slugger = new GithubSlugger();
    const text = (node: ReportMarkdownNode): string => node.value ?? (node.children ?? []).map(text).join('');
    const nodes: ReportMarkdownNode[] = [];
    const collect = (node: ReportMarkdownNode) => { nodes.push(node); node.children?.forEach(collect); };
    collect(tree as ReportMarkdownNode);
    // GFM already emits footnote IDs and ARIA references; keep their graph intact when scoping it.
    const targets = new Map<string, string>();
    for (const node of nodes) {
      const id = node.properties?.id;
      if (typeof id === 'string' && id) targets.set(id, `${prefix}-${id}`);
    }
    for (const node of nodes) {
      let id = typeof node.properties?.id === 'string' ? node.properties.id : undefined;
      if (!id && /^h[1-6]$/.test(node.tagName ?? '')) {
        const slug = headingTextToSlug(text(node), slugger, { alreadyRendered: true }).id || slugger.slug('section');
        id = slug;
        while (targets.has(id)) id = slugger.slug(slug);
        targets.set(id, `${prefix}-${id}`);
      }
      if (id) node.properties = { ...node.properties, id: targets.get(id)! };
    }
    for (const node of nodes) {
      const href = node.tagName === 'a' ? node.properties?.href : undefined;
      if (typeof href === 'string' && href.startsWith('#')) {
        try {
          const fragment = decodeURIComponent(href.slice(1));
          const target = fragment ? targets.get(fragment) : prefix;
          if (target) node.properties!.href = '#' + encodeURIComponent(target);
        } catch { /* Invalid fragments remain inert in the scoped click handler. */ }
      }
      const describedBy = node.properties?.ariaDescribedBy;
      const references = Array.isArray(describedBy) ? describedBy : typeof describedBy === 'string' ? describedBy.split(/\s+/) : [];
      if (references.length) node.properties!.ariaDescribedBy = references.map(id => targets.get(id) ?? id);
    }
  };
}

function extractMarkdownImages(content: string): PreviewImage[] {
  const text = content ?? '';
  const matches = text.matchAll(MARKDOWN_IMAGE_REGEX);
  const images: PreviewImage[] = [];
  for (const m of matches) {
    const src = m[1]?.trim();
    if (!src) continue;
    images.push({ url: src, alt: '周报图片' });
  }
  return images;
}

function ReportImage({ src, alt, maxHeight, onPreview }: {
  src: string; alt: string; maxHeight: number; onPreview: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  src = defaultUrlTransform(src);
  if (!src) return <span role="status">图片地址无效：{alt}。请联系作者更新图片地址。</span>;
  if (failed) return <span className="block my-2 rounded-lg border p-3" role="status" style={{ borderColor: 'var(--border-default)' }}>
    图片加载失败：{alt}。请检查网络后重试，或打开原图检查访问权限。
    <span className="flex flex-wrap gap-3 mt-2">
      <button type="button" className="underline" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重新加载图片</button>
      <a href={src} target="_blank" rel="noopener noreferrer" className="underline">打开原图</a>
    </span>
  </span>;
  return <button type="button" onClick={onPreview} title="点击查看完整图片" className="block max-w-full my-2 cursor-zoom-in">
    <img key={attempt} src={src} alt={alt} onError={() => setFailed(true)}
      style={{ display: 'block', maxWidth: '100%', height: 'auto', maxHeight, objectFit: 'contain', borderRadius: 8 }} />
  </button>;
}

function ReportDiagram({ code }: { code: string }) {
  const [attempt, setAttempt] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const preserveDiagramSize = () => {
      container.current?.querySelectorAll<SVGSVGElement>('.mermaid-render svg').forEach(svg => {
        const width = svg.viewBox?.baseVal.width;
        if (width > 0) {
          // Keep diagram labels readable; the existing chart viewport scrolls horizontally.
          svg.style.width = `${width}px`;
          svg.style.maxWidth = 'none';
          svg.style.flexShrink = '0';
          if (svg.parentElement) svg.parentElement.style.justifyContent = 'flex-start';
        }
      });
    };
    const observer = new MutationObserver(preserveDiagramSize);
    if (container.current) observer.observe(container.current, { childList: true, subtree: true });
    preserveDiagramSize();
    return () => observer.disconnect();
  }, []);
  return <div ref={container}>
    <MermaidDiagram key={attempt} code={code} />
    <details style={{ color: 'var(--text-secondary)', fontSize: '0.875em' }}>
      <summary>图表无法显示？</summary>
      <p>网络问题请重新加载页面；语法问题请作者检查源码后更新报告，源码始终保留。</p>
      <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>重新渲染图表</button>
      <button type="button" className="underline ml-3" onClick={() => window.location.reload()}>重新加载页面</button>
    </details>
  </div>;
}

export function RichTextMarkdownContent({
  content,
  showRealtimeLabel = false,
  imageMaxHeight = 220,
  imageUrls,
  className,
}: RichTextMarkdownContentProps) {
  const anchorPrefix = `report-${useId().replace(/:/g, '')}`;
  const reportRoot = useRef<HTMLDivElement>(null);
  const anchors = useMemo(() => reportAnchorPlugin(anchorPrefix), [anchorPrefix]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const images = useMemo(() => [...extractMarkdownImages(content), ...(imageUrls ?? []).map(url => ({ url, alt: '报告附件图片' }))], [content, imageUrls]);
  const dataTheme = useDataTheme();
  const serifStyle: React.CSSProperties = dataTheme === 'light'
    ? { fontFamily: 'var(--font-serif)', color: 'var(--text-primary)' }
    : {};
  const cellStyle: React.CSSProperties = {
    border: '1px solid var(--border-default)', padding: '8px 12px', minWidth: 120,
    textAlign: 'left', verticalAlign: 'top', overflowWrap: 'anywhere',
  };
  const followAnchor = (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
    if (event.defaultPrevented || !href?.startsWith('#') || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    let id: string;
    try { id = decodeURIComponent(href.slice(1)); } catch { return; }
    const root = reportRoot.current;
    const target = id === anchorPrefix ? root : Array.from(root?.querySelectorAll<HTMLElement>('[id]') ?? []).find(node => node.id === id);
    target?.scrollIntoView({ behavior: 'instant', block: target === root ? 'start' : 'center' });
  };
  return <>
    <div ref={reportRoot} id={anchorPrefix} className={`surface-inset rounded-xl p-3 ${className ?? ''}`.trim()}
      style={{ position: 'relative', minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', color: 'var(--text-primary)' }}>
      {showRealtimeLabel && <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>实时预览</div>}
      <div className="text-[14px] leading-relaxed text-left">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[anchors]} components={{
          p: ({ children }) => <div className="my-2 whitespace-pre-wrap">{children}</div>,
          h1: ({ children, id }) => <h1 id={id} className="text-[20px] font-semibold mt-4 mb-2" style={{ ...serifStyle, scrollMarginTop: '1rem' }}>{children}</h1>,
          h2: ({ children, id, className }) => <h2 id={id} className={`text-[18px] font-semibold mt-4 mb-2 ${className ?? ''}`.trim()} style={{ ...serifStyle, scrollMarginTop: '1rem' }}>{children}</h2>,
          h3: ({ children, id }) => <h3 id={id} className="text-[16px] font-semibold mt-3 mb-2" style={{ ...serifStyle, scrollMarginTop: '1rem' }}>{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-2">{children}</ol>,
          blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid var(--accent-claude)', paddingLeft: 12, margin: '12px 0', color: 'var(--text-secondary)' }}>{children}</blockquote>,
          a: ({ href, children, node: _node, ...props }) => <a {...props} href={href} onClick={event => followAnchor(event, href)} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer"
            style={{ color: 'var(--accent-fg-info)', textDecoration: 'underline', textUnderlineOffset: 3 }}>{children}</a>,
          table: ({ children }) => <div role="region" aria-label="报告表格，可横向滚动查看全部列" tabIndex={0}
            style={{ overflowX: 'auto', maxWidth: '100%', margin: '12px 0' }}>
            <table style={{ borderCollapse: 'collapse', width: 'max-content', minWidth: '100%', fontSize: 'inherit' }}>{children}</table>
          </div>,
          th: ({ children }) => <th scope="col" style={{ ...cellStyle, background: 'var(--nested-block-bg)' }}>{children}</th>,
          td: ({ children }) => <td style={cellStyle}>{children}</td>,
          pre: ({ children }) => <div style={{ overflowX: 'auto', maxWidth: '100%', margin: '12px 0', padding: 12, background: 'var(--nested-block-bg)', borderRadius: 8 }}>{children}</div>,
          code: ({ className: codeClass, children }) => {
            const code = String(children ?? '').replace(/\n$/, '');
            if (/language-mermaid(?:\s|$)/i.test(codeClass ?? '')) return <ReportDiagram code={code} />;
            return <code className={codeClass} style={{ fontFamily: 'ui-monospace, monospace', whiteSpace: codeClass || code.includes('\n') ? 'pre' : 'pre-wrap' }}>{children}</code>;
          },
          img: ({ src, alt }) => {
            if (typeof src !== 'string' || !src) return null;
            return <ReportImage key={src} src={src} alt={alt || '报告图片'} maxHeight={imageMaxHeight} onPreview={() => {
              setPreviewIndex(Math.max(0, images.findIndex(image => image.url === src)));
              setPreviewOpen(true);
            }} />;
          },
        }}>{content?.trim() ? content : '（空）'}</ReactMarkdown>
      </div>
      {imageUrls?.map((src, index) => <ReportImage key={src} src={src} alt={`报告附件图片 ${index + 1}`} maxHeight={imageMaxHeight} onPreview={() => { setPreviewIndex(images.findIndex(image => image.url === src)); setPreviewOpen(true); }} />)}
    </div>
    <ImagePreviewDialog images={images} initialIndex={previewIndex} open={previewOpen} onClose={() => setPreviewOpen(false)} />
  </>;
}
