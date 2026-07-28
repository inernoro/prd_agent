import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { glassPanel } from '@/lib/glassStyles';

interface ImageItem {
  url: string;
  alt: string;
}

interface ImagePreviewDialogProps {
  images: ImageItem[];
  initialIndex: number;
  open: boolean;
  onClose: () => void;
}

export function ImagePreviewDialog({ images, initialIndex, open, onClose }: ImagePreviewDialogProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        setCurrentIndex(prev => (prev > 0 ? prev - 1 : images.length - 1));
      } else if (e.key === 'ArrowRight') {
        setCurrentIndex(prev => (prev < images.length - 1 ? prev + 1 : 0));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, images.length, onClose]);

  if (!open || images.length === 0) return null;

  const currentImage = images[currentIndex];

  // createPortal 挂 body：脱离祖先 stacking context（GlassCard 的 backdrop-filter/transform 会把
  // fixed 层困在卡片内，被右侧栏等兄弟层遮挡）。z-[10000] 与 ImageLightbox 对齐：大图查看永远
  // 盖在 modal/drawer 之上（frontend-modal.md 硬约束）
  const overlay = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.9)' }}
      onClick={onClose}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10"
        style={{
          ...glassPanel,
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'all 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = glassPanel.background as string;
        }}
      >
        <X size={20} style={{ color: 'white' }} />
      </button>

      {/* Image container */}
      <div 
        className="relative max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={currentImage.url}
          alt={currentImage.alt}
          className="max-w-full max-h-[90vh] object-contain"
        />

        {/* Image counter */}
        <div
          className="absolute bottom-4 left-1/2 transform -translate-x-1/2 px-4 py-2 rounded-full text-sm font-medium"
          style={{
            ...glassPanel,
            color: 'white',
          }}
        >
          {currentIndex + 1} / {images.length}
        </div>

        {/* Navigation buttons */}
        {images.length > 1 && (
          <>
            <button
              onClick={() => setCurrentIndex(prev => (prev > 0 ? prev - 1 : images.length - 1))}
              className="absolute left-4 top-1/2 transform -translate-y-1/2"
              style={{
                ...glassPanel,
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = glassPanel.background as string;
              }}
            >
              <ChevronLeft size={24} style={{ color: 'white' }} />
            </button>

            <button
              onClick={() => setCurrentIndex(prev => (prev < images.length - 1 ? prev + 1 : 0))}
              className="absolute right-4 top-1/2 transform -translate-y-1/2"
              style={{
                ...glassPanel,
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = glassPanel.background as string;
              }}
            >
              <ChevronRight size={24} style={{ color: 'white' }} />
            </button>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
