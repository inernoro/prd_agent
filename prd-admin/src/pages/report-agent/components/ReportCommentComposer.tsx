import { useCallback, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ImagePlus, Send, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';
import { toast } from '@/lib/toast';
import { uploadReportCommentImage } from '@/services';
import type { ReportCommentAttachmentInfo } from '@/services/contracts/reportAgent';

/** 与后端 MaxCommentImages 保持一致 */
const MAX_COMMENT_IMAGES = 9;

interface PendingImage {
  attachmentId: string;
  url: string;
  fileName: string;
}

interface ReportCommentComposerProps {
  reportId: string;
  submitting: boolean;
  /** 发送（文字与图片至少有其一；attachmentIds 为已上传附件 ID） */
  onSubmit: (content: string, attachmentIds: string[]) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * 周报评论输入器（图文结合）：
 * - 文本域内直接 Ctrl+V 粘贴截图 / 拖拽 / 点图片按钮选择，上传后以缩略图 chip 待发
 * - 图片统一挂在评论文字下方（方案 A），允许纯图无文字
 * - Enter 发送，Shift+Enter 换行
 */
export function ReportCommentComposer({ reportId, submitting, onSubmit, onCancel }: ReportCommentComposerProps) {
  const [text, setText] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 上限判定需要跨异步回调读最新值，用 ref 兜底避免闭包读到旧 state
  const pendingCountRef = useRef(0);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;
      const remaining = MAX_COMMENT_IMAGES - pendingCountRef.current;
      if (remaining <= 0) {
        toast.error(`每条评论最多 ${MAX_COMMENT_IMAGES} 张图片`);
        return;
      }
      if (imageFiles.length > remaining) {
        toast.error(`每条评论最多 ${MAX_COMMENT_IMAGES} 张图片，已忽略多余的 ${imageFiles.length - remaining} 张`);
      }
      const accepted = imageFiles.slice(0, remaining);
      pendingCountRef.current += accepted.length;
      setUploadingCount((c) => c + accepted.length);
      for (const file of accepted) {
        const res = await uploadReportCommentImage({ reportId, file });
        if (res.success && res.data) {
          const { attachmentId, url, fileName } = res.data;
          setPendingImages((prev) => [...prev, { attachmentId, url, fileName }]);
        } else {
          pendingCountRef.current -= 1;
          toast.error(res.error?.message || '图片上传失败');
        }
        setUploadingCount((c) => c - 1);
      }
    },
    [reportId]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files);
      }
    },
    [uploadFiles]
  );

  const removePending = useCallback((attachmentId: string) => {
    pendingCountRef.current -= 1;
    setPendingImages((prev) => prev.filter((img) => img.attachmentId !== attachmentId));
  }, []);

  const canSubmit = !submitting && uploadingCount === 0 && (text.trim().length > 0 || pendingImages.length > 0);

  const handleSubmit = useCallback(() => {
    if (!canSubmit) {
      if (uploadingCount > 0) toast.error('图片上传中，请稍候');
      return;
    }
    void onSubmit(text.trim(), pendingImages.map((img) => img.attachmentId));
  }, [canSubmit, uploadingCount, onSubmit, text, pendingImages]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div>
      <textarea
        className="w-full text-[12px] px-3 py-2 rounded-lg resize-none leading-relaxed"
        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 56, maxHeight: 160 }}
        placeholder="输入评论，可直接粘贴截图..."
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        autoFocus
      />

      {(pendingImages.length > 0 || uploadingCount > 0) && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {pendingImages.map((img) => (
            <div
              key={img.attachmentId}
              className="relative group rounded-lg overflow-hidden"
              style={{ width: 56, height: 56, border: '1px solid var(--border-primary)' }}
              title={img.fileName}
            >
              <img src={img.url} alt={img.fileName} className="w-full h-full object-cover block" />
              <button
                className="absolute top-0.5 right-0.5 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ background: 'rgba(0,0,0,0.55)' }}
                onClick={() => removePending(img.attachmentId)}
                title="移除图片"
              >
                <X size={10} style={{ color: '#fff' }} />
              </button>
            </div>
          ))}
          {Array.from({ length: uploadingCount }).map((_, i) => (
            <div
              key={`uploading-${i}`}
              className="rounded-lg flex items-center justify-center"
              style={{ width: 56, height: 56, border: '1px dashed var(--border-primary)', background: 'var(--bg-primary)' }}
            >
              <MapSpinner size={16} />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-1.5">
        <button
          className="p-1.5 rounded-lg hover-bg-soft"
          style={{ color: 'var(--text-muted)' }}
          onClick={() => fileInputRef.current?.click()}
          title="添加图片"
        >
          <ImagePlus size={14} />
        </button>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Enter 发送 · Shift+Enter 换行 · 可粘贴截图
        </span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X size={12} />
        </Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!canSubmit}>
          <Send size={12} />
        </Button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          void uploadFiles(files);
        }}
      />
    </div>
  );
}

/**
 * 评论附件展示网格：单图给较大预览，多图收成等尺寸缩略格；点击进入大图预览（可左右切换）。
 */
export function ReportCommentAttachmentGrid({ attachments }: { attachments?: ReportCommentAttachmentInfo[] }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  if (!attachments || attachments.length === 0) return null;

  const single = attachments.length === 1;
  return (
    <>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {attachments.map((att, i) => (
          <button
            key={att.attachmentId}
            className="rounded-lg overflow-hidden transition-opacity hover:opacity-85"
            style={{ border: '1px solid var(--border-primary)', cursor: 'zoom-in' }}
            onClick={() => setPreviewIndex(i)}
            title={`${att.fileName}（点击查看大图）`}
          >
            <img
              src={att.url}
              alt={att.fileName}
              loading="lazy"
              className="block"
              style={single ? { maxHeight: 200, maxWidth: 280 } : { width: 88, height: 88, objectFit: 'cover' }}
            />
          </button>
        ))}
      </div>
      <ImagePreviewDialog
        images={attachments.map((att) => ({ url: att.url, alt: att.fileName }))}
        initialIndex={previewIndex ?? 0}
        open={previewIndex != null}
        onClose={() => setPreviewIndex(null)}
      />
    </>
  );
}
