/**
 * 点行进去改这条任务 —— 标题、时间、备注。
 *
 * 上一版任务建完就再也改不了：标题打错只能删了重建，note 字段后端有、
 * 三个页面一次都没渲染过（契约建了一半没接线）。提醒事项点行就是进编辑，
 * 这是列表类应用最基本的一条。
 */
import { useCallback, useState } from 'react';
import { toast } from '@/lib/toast';
import { updateActiveTask } from '@/services/real/activeTasks';
import type { ActiveTaskDto } from '@/services/contracts/activeTasks';
import { TaskSheet } from './TaskSheet';
import { DuePicker } from './DuePicker';

export interface EditTaskSheetProps {
  task: ActiveTaskDto;
  onClose: () => void;
  onSaved: () => void;
}

export function EditTaskSheet({ task, onClose, onSaved }: EditTaskSheetProps) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note ?? '');
  const [due, setDue] = useState<string | null>(task.dueAt ?? null);
  const [busy, setBusy] = useState(false);

  const onSave = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    const res = await updateActiveTask(task.id, {
      title: title.trim(),
      note: note.trim(),
      // dueAt 传 null 和「不改」在 JSON 里分不开，所以清空走 clearDue 这个开关
      ...(due ? { dueAt: due } : { clearDue: true }),
    });
    setBusy(false);
    if (res.success) { onSaved(); onClose(); }
    else toast.error(res.error?.message ?? '没改上');
  }, [task.id, title, note, due, onSaved, onClose]);

  return (
    <TaskSheet
      title="改这条"
      confirmLabel="改好了"
      confirmDisabled={busy || !title.trim()}
      onConfirm={() => void onSave()}
      onClose={onClose}
    >
      <input
        className="atb-input"
        aria-label="任务标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void onSave(); }}
      />
      <DuePicker value={due} onChange={setDue} />
      <textarea
        className="atb-input"
        style={{ minHeight: 84 }}
        placeholder="补充说明（可不填）"
        aria-label="补充说明"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {task.assignedByName && <span className="atb-sheet__hint">{task.assignedByName} 派的</span>}
    </TaskSheet>
  );
}

export default EditTaskSheet;
