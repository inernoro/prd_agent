import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';

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
        <div className="text-[12px] leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ src, alt }) => {
                const imageSrc = typeof src === 'string' ? src : '';
                if (!imageSrc) return null;
                const idx = Math.max(0, images.findIndex((it) => it.url === imageSrc));
                return (
                  <button
                    type="button"
                    className="group relative block w-full my-2 cursor-zoom-in"
                    onClick={() => {
                      setPreviewIndex(idx);
                      setPreviewOpen(true);
                    }}
                    title="点击查看大图"
                  >
                    <div
                      className="relative mx-auto overflow-hidden rounded-xl border transition-all duration-200"
                      style={{
                        borderColor: 'var(--border-primary)',
                        background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015))',
                        boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
                      }}
                    >
                      <img
                        src={imageSrc}
                        alt={alt || '周报图片'}
                        className="w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
                        style={{
                          maxHeight: `min(${imageMaxHeight}px, 42vh)`,
                          minHeight: '72px',
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

