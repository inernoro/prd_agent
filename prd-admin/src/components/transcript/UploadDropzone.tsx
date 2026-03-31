import { useState, useCallback, useRef } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

interface UploadDropzoneProps {
  onUpload: (file: File) => void;
  uploading: boolean;
  className?: string;
}

const ACCEPT = 'audio/*,video/mp4,video/webm,video/quicktime';

export function UploadDropzone({ onUpload, uploading, className }: UploadDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const file = e.dataTransfer.files[0];
    if (file) onUpload(file);
  }, [onUpload]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onUpload(file);
    e.target.value = '';
  }, [onUpload]);

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept={ACCEPT}
        onChange={handleFileChange}
      />

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className={cn(
          'w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg',
          'border border-dashed transition-all text-xs',
          dragging
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-border/30 hover:border-border/60 text-muted-foreground hover:text-foreground',
          uploading && 'opacity-50 cursor-not-allowed',
        )}
      >
        {uploading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>上传中...</span>
          </>
        ) : dragging ? (
          <span>释放文件开始上传</span>
        ) : (
          <>
            <Upload className="w-3.5 h-3.5" />
            <span>上传音视频</span>
          </>
        )}
      </button>

      {/* Full-area drag overlay */}
      {dragging && (
        <div className="absolute inset-0 rounded-lg border-2 border-dashed border-primary/40 bg-primary/5 pointer-events-none z-10" />
      )}
    </div>
  );
}
