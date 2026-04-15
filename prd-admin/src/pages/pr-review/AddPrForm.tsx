import { useState } from 'react';
import { Plus } from 'lucide-react';
import { usePrReviewStore } from './usePrReviewStore';
import { MapSpinner } from '@/components/ui/VideoLoader';

/**
 * 添加 PR 表单：粘贴 URL → 同步拉取。
 * 仅在已连接 GitHub 时显示。
 */
export function AddPrForm() {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const addItem = usePrReviewStore((s) => s.addItem);
  const authStatus = usePrReviewStore((s) => s.authStatus);

  if (!authStatus?.connected) return null;

  const handleSubmit = async () => {
    if (!url.trim() || submitting) return;
    setSubmitting(true);
    const ok = await addItem(url.trim(), note.trim() || undefined);
    setSubmitting(false);
    if (ok) {
      setUrl('');
      setNote('');
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <div className="text-sm text-white/60 mb-3">添加 PR</div>
      <div className="space-y-3">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="https://github.com/owner/repo/pull/123"
          disabled={submitting}
          className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-white/10 text-white placeholder-white/30 text-sm focus:border-white/30 focus:outline-none disabled:opacity-50"
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选）"
          disabled={submitting}
          className="w-full px-3 py-2.5 rounded-lg bg-black/30 border border-white/10 text-white placeholder-white/30 text-sm focus:border-white/30 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting || !url.trim()}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-violet-500 text-white font-semibold text-sm hover:bg-violet-400 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          {submitting ? <MapSpinner size={16} /> : <Plus size={16} />}
          {submitting ? '提交中...' : '添加并同步'}
        </button>
      </div>
    </div>
  );
}
