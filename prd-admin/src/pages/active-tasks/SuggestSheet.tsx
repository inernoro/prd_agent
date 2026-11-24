/**
 * 给别人提一条建议 —— 任何人都能提，不需要管理权限。
 *
 * 和派活的区别写在提交按钮旁边那句话里：提了不会变成对方的任务，
 * 由对方自己决定要不要吸取。这个区别必须在提的那一刻就让人知道，
 * 否则提的人会以为自己安排了活，收的人会觉得被安排了活。
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { createSuggestion, getSuggestPeople } from '@/services/real/activeTasks';
import type { SuggestPerson } from '@/services/contracts/activeTasks';
import { TaskSheet } from './TaskSheet';

export interface SuggestSheetProps {
  /** 预选给谁（从团队页某一行点进来时带上） */
  presetUserId?: string;
  onClose: () => void;
}

export function SuggestSheet({ presetUserId, onClose }: SuggestSheetProps) {
  const [people, setPeople] = useState<SuggestPerson[]>([]);
  const [to, setTo] = useState(presetUserId ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSuggestPeople().then((r) => { if (r.success && r.data) setPeople(r.data); });
  }, []);

  const onSubmit = useCallback(async () => {
    if (!to || !text.trim()) return;
    setBusy(true);
    const res = await createSuggestion({ targetUserId: to, text: text.trim() });
    setBusy(false);
    if (res.success) {
      toast.success('提过去了');
      onClose();
    } else toast.error(res.error?.message ?? '没提出去');
  }, [to, text, onClose]);

  return (
    <TaskSheet
      title="提个建议"
      confirmLabel="提过去"
      confirmDisabled={busy || !to || !text.trim()}
      onConfirm={() => void onSubmit()}
      onClose={onClose}
    >
      <select className="atb-input" aria-label="提给谁" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">提给谁</option>
        {people.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.displayName}{p.standbyCount > 0 ? ` · 堆 ${p.standbyCount} 件` : ''}
          </option>
        ))}
      </select>
      <textarea
        className="atb-input"
        style={{ minHeight: 110 }}
        placeholder="你觉得他也许该做点什么"
        aria-label="建议内容"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="atb-sheet__hint">建议不会变成他的任务，由他自己决定要不要吸取。</span>
    </TaskSheet>
  );
}

export default SuggestSheet;
