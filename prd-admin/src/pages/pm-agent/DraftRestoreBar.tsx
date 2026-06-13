import { History, X } from 'lucide-react';

/**
 * 「已恢复未保存草稿」提示条。配合 useFormDraft：检测到草稿并回填后展示，
 * 提供「放弃草稿」（还原为原始内容并清除草稿）与关闭提示两个动作。
 */
export function DraftRestoreBar({ onDiscard, onDismiss }: { onDiscard: () => void; onDismiss: () => void }) {
  return (
    <div
      className="flex items-center gap-2 text-[11px] rounded-md px-2.5 py-1.5"
      style={{ background: 'rgba(59,130,246,0.10)', color: '#3B82F6' }}
    >
      <History size={12} className="shrink-0" />
      <span className="flex-1">已恢复上次未保存的草稿</span>
      <button onClick={onDiscard} className="hover:underline shrink-0" style={{ color: '#3B82F6' }}>放弃草稿</button>
      <button onClick={onDismiss} className="p-0.5 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }} title="知道了">
        <X size={11} />
      </button>
    </div>
  );
}
