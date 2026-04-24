import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';
import { useDataTheme } from '../hooks/useDataTheme';

interface RichTextMarkdownContentProps {
  content: string;
  showRealtimeLabel?: boolean;
  imageMaxHeight?: number;
  className?: string;
}

type PreviewImage = {
  url: string;
  alt: string;
};

const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

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

export function RichTextMarkdownContent({
  content,
  showRealtimeLabel = false,
  imageMaxHeight = 220,
  className,
}: RichTextMarkdownContentProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const images = useMemo(() => extractMarkdownImages(content), [content]);
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const serifStyle: React.CSSProperties = isLight
    ? { fontFamily: 'var(--font-serif)', letterSpacing: '-0.005em', color: 'var(--text-primary)' }
    : {};
  const quoteStyle: React.CSSProperties = isLight
    ? {
        borderLeft: '3px solid var(--accent-claude)',
        paddingLeft: '0.75rem',
        margin: '0.5rem 0',
        color: 'var(--text-secondary)',
        fontStyle: 'italic',
      }
    : {
        borderLeft: '3px solid var(--border-default)',
        paddingLeft: '0.75rem',
        margin: '0.5rem 0',
        color: 'var(--text-secondary)',
      };

  return (
    <>
      <div
        className={`surface-inset rounded-xl p-3 ${className ?? ''}`.trim()}
        style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 22px rgba(0,0,0,0.14)' }}
      >
        {showRealtimeLabel && (
          <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
            实时预览
          </div>
        )}
        <div className="text-[12px] leading-relaxed text-left">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{
              p: ({ children }) => (
                <p className="my-1 whitespace-pre-wrap break-words">{children}</p>
              ),
              h1: ({ children }) => (
                <h1 className="text-[17px] font-semibold mt-3 mb-1.5" style={serifStyle}>{children}</h1>
              ),
              h2: ({ children }) => (
                <h2 className="text-[15px] font-semibold mt-2.5 mb-1" style={serifStyle}>{children}</h2>
              ),
              h3: ({ children }) => (
                <h3 className="text-[13.5px] font-semibold mt-2 mb-1" style={serifStyle}>{children}</h3>
              ),
              blockquote: ({ children }) => (
                <blockquote style={quoteStyle}>{children}</blockquote>
              ),
              img: ({ src, alt }) => {
                const imageSrc = typeof src === 'string' ? src : '';
                if (!imageSrc) return null;
                const idx = Math.max(0, images.findIndex((it) => it.url === imageSrc));
                return (
                  <button
                    type="button"
                    className="group relative inline-block max-w-full my-2 cursor-zoom-in align-top"
                    onClick={() => {
                      setPreviewIndex(idx);
                      setPreviewOpen(true);
                    }}
                    title="点击查看大图"
                  >
                    <div
                      className="relative inline-block overflow-hidden rounded-xl border transition-all duration-200"
                      style={{
                        borderColor: 'var(--border-primary)',
                        background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))',
                        boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
                      }}
                    >
                      <img
                        src={imageSrc}
                        alt={alt || '周报图片'}
                        className="block h-auto w-auto max-w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
                        style={{
                          maxHeight: `min(${imageMaxHeight}px, 42vh)`,
                          background: 'rgba(255,255,255,0.01)',
                        }}
                      />
                      <div
                        className="absolute inset-x-0 bottom-0 px-3 py-1.5 text-[11px] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                        style={{
                          color: 'rgba(255,255,255,0.92)',
                          background: 'linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.55))',
                        }}
                      >
                        点击查看大图
                      </div>
                    </div>
                  </button>
                );
              },
            }}
          >
            {content?.trim() ? content : '（空）'}
          </ReactMarkdown>
        </div>
      </div>
      <ImagePreviewDialog
        images={images}
        initialIndex={previewIndex}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
}

