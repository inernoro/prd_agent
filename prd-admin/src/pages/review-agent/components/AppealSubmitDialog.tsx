import { useState, useEffect, useRef, useCallback } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { createAppeal, uploadAppealImage } from '@/services/real/reviewAgent';
import type { ReviewSubmission } from '@/services';

const APPEAL_WINDOW_HOURS = 3;

function computeRemainingMs(completedAt?: string): number {
  if (!completedAt) return 0;
  const deadline = new Date(completedAt).getTime() + APPEAL_WINDOW_HOURS * 3600_000;
  return Math.max(0, deadline - Date.now());
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0 分';
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

export function AppealSubmitDialog({
  submission,
  onClose,
  onSuccess,
}: {
  submission: ReviewSubmission;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [imageAttachmentIds, setImageAttachmentIds] = useState<string[]>([]);
  const [plainLen, setPlainLen] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(() => computeRemainingMs(submission.completedAt));

  useEffect(() => {
    const t = setInterval(() => setRemainingMs(computeRemainingMs(submission.completedAt)), 30_000);
    return () => clearInterval(t);
  }, [submission.completedAt]);

  const expired = remainingMs <= 0;

  const syncPlainLen = useCallback(() => {
    if (editorRef.current) setPlainLen((editorRef.current.textContent || '').trim().length);
  }, []);

  const handleInput = () => syncPlainLen();

  const handlePaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(it => it.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;

    setError(null);
    setUploadingImg(true);
    const res = await uploadAppealImage(file);
    setUploadingImg(false);
    if (!res.success || !res.data) {
      setError(res.error?.message || '图片上传失败');
      return;
    }
    // 在光标位置插入 <img>，沿用 contentEditable 的 execCommand
    document.execCommand(
      'insertHTML',
      false,
      `<img src="${res.data.url}" alt="" data-att="${res.data.attachmentId}" style="max-width:100%;border-radius:4px;margin:4px 0" />`
    );
    setImageAttachmentIds(prev => [...prev, res.data!.attachmentId]);
    syncPlainLen();
  };

  const handleSubmit = async () => {
    if (expired) { setError('已超过申诉窗口'); return; }
    if (plainLen < 10) { setError('请至少填写 10 个字的申诉理由'); return; }
    setSubmitting(true);
    setError(null);
    const reasonHtml = editorRef.current?.innerHTML || '';
    const res = await createAppeal(submission.id, { reasonHtml, imageAttachmentIds });
    setSubmitting(false);
    if (!res.success) {
      setError(res.error?.message || '提交失败');
      return;
    }
    onSuccess();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => { if (!v) onClose(); }}
      title="提交申诉"
      description={`方案《${submission.title}》评审结果申诉 · 剩余 ${formatRemaining(remainingMs)}`}
      maxWidth={640}
      content={
        <div className="flex flex-col gap-4">
          <div className="text-xs text-white/55 leading-relaxed">
            申诉提交后将由有权限的管理员审理。请在评审完成后 <strong>{APPEAL_WINDOW_HOURS} 小时内</strong> 提交，
            清楚说明你认为评审结果存在偏差的具体原因。支持粘贴图片佐证（每张 ≤5MB）。
          </div>

          <div
            ref={editorRef}
            contentEditable={!submitting}
            suppressContentEditableWarning
            onPaste={handlePaste}
            onInput={handleInput}
            data-placeholder="详细说明你对评审结果的异议，并粘贴方案截图或对比图作为佐证..."
            className="appeal-editor min-h-[180px] max-h-[360px] overflow-y-auto px-3 py-2.5 rounded-lg border border-white/10 bg-white/5 text-sm text-white focus:outline-none focus:border-indigo-500/50"
            style={{ overscrollBehavior: 'contain', lineHeight: '1.6' }}
          />

          {error && (
            <div className="text-xs text-red-400/90 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <div className="text-xs text-white/40">
              {imageAttachmentIds.length} 张图片 · {plainLen} 字{uploadingImg && ' · 上传图片中...'}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={submitting}
                className="text-sm px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 transition-colors"
              >取消</button>
              <button
                onClick={handleSubmit}
                disabled={submitting || expired || uploadingImg}
                className="text-sm px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? '提交中...' : expired ? '已过窗口' : '提交申诉'}
              </button>
            </div>
          </div>

          <style>{`
            .appeal-editor:empty::before {
              content: attr(data-placeholder);
              color: rgba(255,255,255,0.3);
              pointer-events: none;
            }
            .appeal-editor img {
              max-width: 100%;
              border-radius: 4px;
              margin: 4px 0;
            }
          `}</style>
        </div>
      }
    />
  );
}
