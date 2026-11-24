/**
 * 点行进去改这条任务 —— 标题、时间、备注。
 *
 * 上一版任务建完就再也改不了：标题打错只能删了重建，note 字段后端有、
 * 三个页面一次都没渲染过（契约建了一半没接线）。提醒事项点行就是进编辑，
 * 这是列表类应用最基本的一条。
 */
import { useCallback, useState } from 'react';
import { toast } from '@/lib/toast';
import {
  deleteActiveTask, dropActiveTask, promoteActiveTask, startActiveTask, updateActiveTask,
} from '@/services/real/activeTasks';
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

  /**
   * 这一排操作在手机端是**唯一**入口。
   * 390px 上一行塞不下「圆圈 + 标题 + 日期 + 开始/提前/删除」—— 2026-09-16 真机验收实测，
   * 五条里四条标题被腰斩成「解决同一个项目部署为多个项…」，用户根本不知道那是什么任务。
   * 桌面端那三个按钮是悬停才出来的，手机端没有悬停，当时写成了常驻，于是把标题挤没了。
   * 现在手机端行上只留圆圈 + 标题 + 日期，操作收进这里（点行就进来）。
   */
  const act = useCallback(async (fn: () => Promise<{ success: boolean; error?: { message?: string } | null }>) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.success) { onSaved(); onClose(); }
    else toast.error(res.error?.message ?? '没能完成');
  }, [onSaved, onClose]);

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

      {task.state === 'standby' && (
        <div className="atb-rowops">
          <button className="atb-link" disabled={busy} onClick={() => void act(() => startActiveTask(task.id))}>
            现在就做
          </button>
          <button className="atb-link" disabled={busy} onClick={() => void act(() => promoteActiveTask(task.id))}>
            排到最前
          </button>
          <button
            className="atb-link atb-link--quiet"
            disabled={busy}
            onClick={() => void act(() => (task.elapsedSeconds > 0 ? dropActiveTask(task.id) : deleteActiveTask(task.id)))}
          >
            {task.elapsedSeconds > 0 ? '放下' : '删除'}
          </button>
        </div>
      )}
      {task.state === 'active' && (
        <div className="atb-rowops">
          <button className="atb-link atb-link--quiet" disabled={busy} onClick={() => void act(() => dropActiveTask(task.id))}>
            放下这件
          </button>
        </div>
      )}
    </TaskSheet>
  );
}

export default EditTaskSheet;
