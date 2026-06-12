import { useCallback, useRef, type ChangeEvent, type ClipboardEvent } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import { toast } from '@/lib/toast';

export interface ScreenshotAttachment {
  id: string;
  dataUrl: string;
  name: string;
}

const MAX_SCREENSHOTS = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function createAttachment(file: File, dataUrl: string): ScreenshotAttachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    dataUrl,
    name: file.name || 'pasted-screenshot.png',
  };
}

interface FrontEndScreenshotInputProps {
  notes: string;
  onNotesChange: (value: string) => void;
  screenshots: ScreenshotAttachment[];
  onScreenshotsChange: (next: ScreenshotAttachment[]) => void;
  placeholder: string;
}

export function FrontEndScreenshotInput({
  notes,
  onNotesChange,
  screenshots,
  onScreenshotsChange,
  placeholder,
}: FrontEndScreenshotInputProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      toast.error('仅支持粘贴或上传图片');
      return;
    }

    const remaining = MAX_SCREENSHOTS - screenshots.length;
    if (remaining <= 0) {
      toast.error(`最多添加 ${MAX_SCREENSHOTS} 张截图`);
      return;
    }

    const batch = imageFiles.slice(0, remaining);
    const next: ScreenshotAttachment[] = [...screenshots];

    for (const file of batch) {
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(`${file.name || '图片'} 超过 4MB，请压缩后再粘贴`);
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        next.push(createAttachment(file, dataUrl));
      } catch {
        toast.error('读取图片失败，请换一张截图重试');
      }
    }

    if (next.length > screenshots.length) {
      onScreenshotsChange(next);
      toast.success(`已添加 ${next.length - screenshots.length} 张截图`);
    }
  }, [onScreenshotsChange, screenshots]);

  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length === 0) return;
    e.preventDefault();
    await addImageFiles(pastedFiles);
  }, [addImageFiles]);

  const handleImageSelect = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) await addImageFiles(files);
  }, [addImageFiles]);

  const removeScreenshot = useCallback((id: string) => {
    onScreenshotsChange(screenshots.filter((item) => item.id !== id));
  }, [onScreenshotsChange, screenshots]);

  return (
    <label className="block">
      <span className="text-xs font-medium text-white/70">截图现象 / 设计稿差异描述</span>
      <p className="mt-1 text-[11px] text-violet-200/55">
        支持 Ctrl+V 直接粘贴截图，也可上传图片；可叠加文字说明差异点。
      </p>
      <textarea
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        onPaste={handlePaste}
        placeholder={placeholder}
        className="mt-2 w-full min-h-[100px] rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-white/25 outline-none focus:border-violet-300/35 transition-colors duration-200"
      />

      {screenshots.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {screenshots.map((shot) => (
            <div
              key={shot.id}
              className="relative rounded-xl border border-violet-400/20 bg-black/25 overflow-hidden group"
            >
              <img
                src={shot.dataUrl}
                alt={shot.name}
                className="w-full h-28 object-cover object-top"
              />
              <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent">
                <p className="text-[10px] text-white/70 truncate">{shot.name}</p>
              </div>
              <button
                type="button"
                onClick={() => removeScreenshot(shot.id)}
                className="fea-btn absolute top-1.5 right-1.5 h-6 w-6 rounded-md border border-white/15 bg-black/55 text-white/70 opacity-0 group-hover:opacity-100 hover:bg-black/75 inline-flex items-center justify-center transition-opacity duration-200"
                aria-label="移除截图"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={imageInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        multiple
        onChange={handleImageSelect}
      />
      <button
        type="button"
        onClick={() => imageInputRef.current?.click()}
        className="fea-btn mt-2 h-8 px-3 rounded-lg border border-violet-400/20 bg-violet-500/10 hover:bg-violet-500/15 text-xs text-violet-100 inline-flex items-center gap-1.5"
      >
        <ImageIcon className="w-3.5 h-3.5" />
        上传截图
      </button>
    </label>
  );
}
