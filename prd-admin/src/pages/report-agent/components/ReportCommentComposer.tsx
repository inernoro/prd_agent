import { useCallback, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ImagePlus, Send, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';
import { toast } from '@/lib/toast';
import { uploadReportCommentImage } from '@/services';
import { detectMentionQuery, type MentionUser } from '@/components/MentionTextarea';
import { resolveAvatarUrl } from '@/lib/avatar';
import type { ReportCommentAttachmentInfo, ReportTeamMember } from '@/services/contracts/reportAgent';

/** 团队成员 → @ 候选（无名字的成员不参与候选，避免下拉里出现一串 userId） */
export function toMentionUsers(members: ReportTeamMember[]): MentionUser[] {
  return members
    .filter((m) => !!m.userName?.trim())
    .map((m) => ({
      userId: m.userId,
      displayName: m.userName!.trim(),
      avatarFileName: m.avatarFileName ?? null,
    }));
}

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
  /** @ 候选成员（团队成员）；为空时不显示 @ 下拉，输入仍可正常提交 */
  members?: MentionUser[];
  /** 发送（文字与图片至少有其一；attachmentIds 为已上传附件 ID）。被 @ 的人由服务端按正文解析，前端不传 */
  onSubmit: (content: string, attachmentIds: string[]) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * 周报评论输入器（图文结合）：
 * - 文本域内直接 Ctrl+V 粘贴截图 / 拖拽 / 点图片按钮选择，上传后以缩略图 chip 待发
 * - 图片统一挂在评论文字下方（方案 A），允许纯图无文字
 * - 输入 @ 唤出成员下拉，选中后被 @ 的人会收到站内通知并同步推送到企微群
 * - Enter 发送，Shift+Enter 换行；@ 下拉打开时 Enter 用于选中候选
 */
export function ReportCommentComposer({ reportId, submitting, members, onSubmit, onCancel }: ReportCommentComposerProps) {
  const [text, setText] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
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

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null || !members || members.length === 0) return [];
    const keyword = mentionQuery.trim().toLowerCase();
    return members
      .filter((m) => {
        if (!keyword) return true;
        return (m.displayName?.toLowerCase() ?? '').includes(keyword)
          || (m.username?.toLowerCase() ?? '').includes(keyword);
      })
      .slice(0, 8);
  }, [members, mentionQuery]);

  const showMentionDropdown = mentionQuery !== null && mentionMatches.length > 0;

  const syncMentionQuery = useCallback((value: string, caret: number) => {
    const next = detectMentionQuery(value, caret);
    setMentionQuery(next);
    if (next !== null) setActiveIndex(0);
  }, []);

  const pickMention = useCallback((user: MentionUser) => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const name = user.displayName?.trim() || user.username || user.userId;
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${name} `);
    const next = before + text.slice(caret);
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }, [text]);

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
      // @ 下拉打开时方向键/回车归下拉，避免「想选人却把评论发出去」
      if (showMentionDropdown) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % mentionMatches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          pickMention(mentionMatches[activeIndex] ?? mentionMatches[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [activeIndex, handleSubmit, mentionMatches, pickMention, showMentionDropdown]
  );

  return (
    <div>
      <div className="relative">
        {showMentionDropdown && (
          <div
            className="surface-popover absolute left-0 bottom-full z-20 mb-1 w-full max-w-sm overflow-hidden rounded-lg py-1"
            role="listbox"
          >
            {mentionMatches.map((user, index) => (
              <button
                key={user.userId}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(user)}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                  index === activeIndex ? 'surface-action-accent' : 'hover-bg-soft text-token-primary'
                }`}
              >
                <img
                  src={resolveAvatarUrl({ avatarFileName: user.avatarFileName, username: user.username })}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded-full border border-token-subtle object-cover"
                />
                <span className="truncate">{user.displayName || user.username}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="w-full text-[12px] px-3 py-2 rounded-lg resize-none leading-relaxed"
          style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', minHeight: 56, maxHeight: 160 }}
          placeholder={members && members.length > 0 ? '输入评论，@ 提醒成员，可直接粘贴截图...' : '输入评论，可直接粘贴截图...'}
          rows={2}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            syncMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => syncMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => syncMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onPaste={handlePaste}
          autoFocus
        />
      </div>

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
          Enter 发送 · Shift+Enter 换行 · 可粘贴截图{members && members.length > 0 ? ' · @ 提醒成员' : ''}
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
