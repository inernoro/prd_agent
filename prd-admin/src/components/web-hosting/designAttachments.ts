import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadAttachment } from '@/services/real/aiToolbox';

/**
 * 网页生成 / 修改用到的附件上传队列。
 *
 * 两处复用：生成弹窗的「直接上传」（文档，最多 5 个）与「帮我修改」的「附上截图」（图片，最多 3 张）。
 * 走的都是 POST /api/v1/attachments：文档在上传那一次请求里由服务端提取正文，
 * 所以「字节传完」和「可以用」之间还有一段读取时间——这段没有进度可报，单独显示「正在读取」，
 * 不许让进度条停在 100% 却迟迟不变成可用（那是另一种白等）。
 */

/**
 * 服务端 AttachmentsController 的 20 MiB 限的是整个 multipart 请求（含分隔符与头），不只是文件本身：
 * 恰好 20 MiB 的文件会在 Kestrel 就被 413（Codex P2）。这里给 64 KiB 的封包余量。
 */
export const DESIGN_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024 - 64 * 1024;
/** 截图与服务端 DesignRunInputAttachments.MaxReferenceImageBytes 同一口径：超过就在选文件时拦下，不等传完再被 400。 */
export const DESIGN_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_GENERATE_ATTACHMENTS = 5;
export const MAX_EDIT_SCREENSHOTS = 3;

export type DesignAttachmentKind = 'document' | 'image';
export type DesignAttachmentStatus = 'uploading' | 'reading' | 'ready' | 'failed';

export interface DesignAttachmentItem {
  key: string;
  fileName: string;
  size: number;
  status: DesignAttachmentStatus;
  /** 字节上传进度 0–100。 */
  progress: number;
  attachmentId?: string;
  error?: string;
  /** 图片的本地缩略图（object URL），移除或重置时回收。 */
  thumbnailUrl?: string;
}

// 与上传端点的扩展名映射一致：服务端只把 .md 认作 Markdown，.markdown 会被当成未知类型拒收（Codex P2）。
const DOCUMENT_EXTENSIONS = ['.doc', '.docx', '.pdf', '.md', '.txt', '.html', '.htm'];
// 与服务端参考图白名单一致（PNG、JPEG、WebP）：GIF 传得上去，建修改任务时会被拒。
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

export const DESIGN_ATTACHMENT_ACCEPT: Record<DesignAttachmentKind, string> = {
  document: DOCUMENT_EXTENSIONS.join(','),
  image: IMAGE_EXTENSIONS.join(','),
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

/** 文件卡片上的类型徽标（DOCX / PDF / MD / 图片后缀）。 */
export function attachmentBadge(fileName: string): string {
  const ext = extensionOf(fileName).replace('.', '');
  if (ext === 'markdown') return 'MD';
  if (ext === 'htm') return 'HTML';
  if (ext === 'jpeg') return 'JPG';
  return ext ? ext.toUpperCase().slice(0, 4) : '文件';
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 选文件那一刻就能判的拒收原因；返回 null 表示可以上传。 */
export function validateDesignAttachment(
  file: Pick<File, 'name' | 'size'>,
  kind: DesignAttachmentKind,
): string | null {
  const allowed = kind === 'image' ? IMAGE_EXTENSIONS : DOCUMENT_EXTENSIONS;
  if (!allowed.includes(extensionOf(file.name))) {
    return kind === 'image'
      ? `「${file.name}」不是支持的截图格式，只支持 PNG、JPG、WebP`
      : `「${file.name}」格式不支持，只支持 Word、PDF、Markdown、TXT、HTML`;
  }
  if (kind === 'image' && file.size > DESIGN_SCREENSHOT_MAX_BYTES) {
    return `「${file.name}」超过 5 MB，请压缩后再传`;
  }
  if (file.size > DESIGN_ATTACHMENT_MAX_BYTES) {
    return `「${file.name}」超过 19.9 MB 上传上限，请压缩或拆分后再传`;
  }
  if (file.size === 0) return `「${file.name}」是空文件`;
  return null;
}

/** 底部那句状态：「2 个文件已就绪，1 个还在读取」。 */
export function summarizeAttachments(items: readonly Pick<DesignAttachmentItem, 'status'>[]): string {
  if (items.length === 0) return '';
  const ready = items.filter((item) => item.status === 'ready').length;
  const pending = items.filter((item) => item.status === 'uploading' || item.status === 'reading').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const parts: string[] = [];
  if (ready > 0) parts.push(`${ready} 个文件已就绪`);
  if (pending > 0) parts.push(`${pending} 个还在上传或读取`);
  if (failed > 0) parts.push(`${failed} 个失败，可移除后重传`);
  return parts.join('，');
}

/**
 * 截图参考只对精细设计（OpenDesign）生效：快速修改（map-gateway）带截图时后端返回 400
 * 「截图参考需要用精细设计（OpenDesign）执行器」。前端按同一口径置灰，不让用户白传。
 */
export const SCREENSHOT_CAPABLE_RUNTIMES: readonly string[] = ['open-design'];

export function screenshotRuntimeSupported(runtimeId: string | null | undefined): boolean {
  return !!runtimeId && SCREENSHOT_CAPABLE_RUNTIMES.includes(runtimeId);
}

export function readyAttachmentIds(items: readonly DesignAttachmentItem[]): string[] {
  return items
    .filter((item) => item.status === 'ready' && item.attachmentId)
    .map((item) => item.attachmentId as string);
}

let keySeed = 0;
function nextKey() {
  keySeed += 1;
  return `att-${Date.now().toString(36)}-${keySeed}`;
}

/**
 * 上传队列 hook。addFiles 返回被拒收的原因列表（格式 / 大小 / 数量），调用方负责提示；
 * 队列里的每一项自己推进：uploading（带字节进度）→ reading（服务端提取正文）→ ready / failed。
 */
export function useDesignAttachmentUploads(kind: DesignAttachmentKind, max: number) {
  const [items, setItems] = useState<DesignAttachmentItem[]>([]);
  const itemsRef = useRef<DesignAttachmentItem[]>([]);
  const controllersRef = useRef(new Map<string, AbortController>());
  // 缩略图 object URL 单独记一份（稳定对象），卸载时一次回收，不依赖随时被替换的 items。
  const thumbnailsRef = useRef(new Set<string>());

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const patch = useCallback((key: string, next: Partial<DesignAttachmentItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }, []);

  const startUpload = useCallback(async (key: string, file: File) => {
    const controller = new AbortController();
    controllersRef.current.set(key, controller);
    const result = await uploadAttachment(file, {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        patch(key, percent >= 100 ? { progress: 100, status: 'reading' } : { progress: percent });
      },
    });
    controllersRef.current.delete(key);
    if (controller.signal.aborted) return;
    if (result.success && result.data?.attachmentId) {
      patch(key, { status: 'ready', progress: 100, attachmentId: result.data.attachmentId, error: undefined });
    } else {
      patch(key, { status: 'failed', error: result.error?.message || '上传失败，请稍后重试' });
    }
  }, [patch]);

  const addFiles = useCallback((files: readonly File[]): string[] => {
    const rejected: string[] = [];
    const accepted: Array<{ item: DesignAttachmentItem; file: File }> = [];
    let room = max - itemsRef.current.length;
    for (const file of files) {
      const reason = validateDesignAttachment(file, kind);
      if (reason) {
        rejected.push(reason);
        continue;
      }
      if (room <= 0) {
        rejected.push(`最多 ${max} 个${kind === 'image' ? '截图' : '文件'}，「${file.name}」没有加入`);
        continue;
      }
      room -= 1;
      accepted.push({
        file,
        item: {
          key: nextKey(),
          fileName: file.name,
          size: file.size,
          status: 'uploading',
          progress: 0,
          thumbnailUrl: kind === 'image' && typeof URL !== 'undefined' && URL.createObjectURL
            ? URL.createObjectURL(file)
            : undefined,
        },
      });
      const created = accepted[accepted.length - 1].item.thumbnailUrl;
      if (created) thumbnailsRef.current.add(created);
    }
    if (accepted.length > 0) {
      const next = [...itemsRef.current, ...accepted.map((entry) => entry.item)];
      itemsRef.current = next;
      setItems(next);
      accepted.forEach(({ item, file }) => { void startUpload(item.key, file); });
    }
    return rejected;
  }, [kind, max, startUpload]);

  const remove = useCallback((key: string) => {
    controllersRef.current.get(key)?.abort();
    controllersRef.current.delete(key);
    const target = itemsRef.current.find((item) => item.key === key);
    if (target?.thumbnailUrl) {
      URL.revokeObjectURL(target.thumbnailUrl);
      thumbnailsRef.current.delete(target.thumbnailUrl);
    }
    const next = itemsRef.current.filter((item) => item.key !== key);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const reset = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    thumbnailsRef.current.forEach((url) => URL.revokeObjectURL(url));
    thumbnailsRef.current.clear();
    itemsRef.current = [];
    setItems([]);
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    const thumbnails = thumbnailsRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      thumbnails.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const busy = items.some((item) => item.status === 'uploading' || item.status === 'reading');
  return { items, addFiles, remove, reset, busy, readyIds: readyAttachmentIds(items) };
}
