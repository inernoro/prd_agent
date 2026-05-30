import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Trash2, Link2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import { updatePmTask, deletePmTask, createPmTask } from '@/services';
import type { PmTask, PmTaskStatus, PmTaskPriority } from '@/services/contracts/pmAgent';
import { TASK_STATUS_REGISTRY, PRIORITY_REGISTRY } from './pmConstants';

interface Props {
  task: PmTask;
  allTasks: PmTask[];
  onClose: () => void;
  onSaved: (task: PmTask) => void;
  onDeleted: (taskId: string) => void;
  /** 子任务增删后触发父级刷新 */
  onChanged: () => void;
}

const STATUSES: PmTaskStatus[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled'];
const PRIORITIES: PmTaskPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

const toDateInput = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');
const fromDateInput = (v: string) => (v ? new Date(v + 'T00:00:00').toISOString() : undefined);

/**
 * 任务详情抽屉（P0）— 点卡片打开，集中编辑全部字段。
 * 接现有 updatePmTask（后端已支持全字段），右侧滑入，createPortal 到 body。
 */
export function TaskDetailDrawer({ task, allTasks, onClose, onSaved, onDeleted, onChanged }: Props) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [status, setStatus] = useState<PmTaskStatus>(task.status);
  const [priority, setPriority] = useState<PmTaskPriority>(task.priority);
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? '');
  const [estimateDays, setEstimateDays] = useState(task.estimateDays != null ? String(task.estimateDays) : '');
  const [startAt, setStartAt] = useState(toDateInput(task.startAt));
  const [dueAt, setDueAt] = useState(toDateInput(task.dueAt));
  const [labels, setLabels] = useState((task.labels ?? []).join(', '));
  const [dependsOn, setDependsOn] = useState<string[]>(task.dependsOn ?? []);
  const [saving, setSaving] = useState(false);
  const [subTitle, setSubTitle] = useState('');

  const children = useMemo(() => allTasks.filter((t) => t.parentTaskId === task.id), [allTasks, task.id]);

  const addSubtask = async () => {
    if (!subTitle.trim()) return;
    const res = await createPmTask(task.projectId, { title: subTitle.trim(), parentTaskId: task.id, status: 'todo' });
    if (res.success) { setSubTitle(''); onChanged(); } else toast.error('创建子任务失败', res.error?.message || '');
  };
  const toggleSubDone = async (sub: PmTask) => {
    const next: PmTaskStatus = sub.status === 'done' ? 'todo' : 'done';
    const res = await updatePmTask(sub.id, { status: next });
    if (res.success) onChanged(); else toast.error('更新失败', res.error?.message || '');
  };

  // 候选依赖（同项目、排除自己与自己的子任务，避免环）
  const depCandidates = useMemo(
    () => allTasks.filter((t) => t.id !== task.id && t.parentTaskId !== task.id),
    [allTasks, task.id],
  );
  const taskById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);

  // 依赖守卫：要改成"进行中/完成"，但前置未完成
  const blockedBy = useMemo(
    () => dependsOn.map((id) => taskById.get(id)).filter((d) => d && d.status !== 'done' && d.status !== 'cancelled'),
    [dependsOn, taskById],
  );

  const save = async () => {
    if (!title.trim()) { toast.warning('请填写标题', ''); return; }
    if ((status === 'in_progress' || status === 'done') && blockedBy.length > 0) {
      const ok = window.confirm(`该任务有 ${blockedBy.length} 个前置任务尚未完成（${blockedBy.map((d) => d!.title).join('、')}），确定要标记为「${TASK_STATUS_REGISTRY[status].label}」吗？`);
      if (!ok) return;
    }
    setSaving(true);
    const res = await updatePmTask(task.id, {
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      assigneeId,
      estimateDays: estimateDays === '' ? undefined : Number(estimateDays),
      startAt: fromDateInput(startAt),
      dueAt: fromDateInput(dueAt),
      labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
      dependsOn,
    });
    setSaving(false);
    if (res.success) {
      toast.success('已保存', '');
      onSaved({
        ...task,
        title: title.trim(), description: description.trim(), status, priority,
        assigneeId: assigneeId || null,
        estimateDays: estimateDays === '' ? null : Number(estimateDays),
        startAt: fromDateInput(startAt) ?? null, dueAt: fromDateInput(dueAt) ?? null,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
        dependsOn,
      });
    } else toast.error('保存失败', res.error?.message || '');
  };

  const remove = async () => {
    if (!window.confirm('确定删除该任务（含子任务）？')) return;
    const res = await deletePmTask(task.id);
    if (res.success) { toast.success('已删除', ''); onDeleted(task.id); }
    else toast.error('删除失败', res.error?.message || '');
  };

  const toggleDep = (id: string) => setDependsOn((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const labelCls = 'text-[11px] font-medium mb-1 block';
  const inputCls = 'w-full rounded-lg px-3 py-2 text-[13px] outline-none border';
  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };

  const modal = (
    <div className="fixed inset-0 z-[100] flex justify-end" onClick={onClose}>
      <div className="surface-backdrop absolute inset-0" />
      <div
        className="relative flex flex-col border-l h-full"
        style={{ width: 'min(480px, 100vw)', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>任务详情</div>
          {task.source === 'ai_decompose' && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(168,85,247,0.15)', color: '#A855F7' }}>AI 拆解</span>}
          <button onClick={remove} className="ml-auto p-1 rounded hover:opacity-70" style={{ color: '#EF4444' }} title="删除任务"><Trash2 size={16} /></button>
          <button onClick={onClose} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-4 flex flex-col gap-3.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>标题</label>
            <input className={inputCls} style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>描述</label>
            <textarea className={inputCls} style={{ ...inputStyle, resize: 'vertical', minHeight: 72 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务说明 / 交付物" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>状态</label>
              <select className={inputCls} style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value as PmTaskStatus)}>
                {STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_REGISTRY[s].label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>优先级</label>
              <select className={inputCls} style={inputStyle} value={priority} onChange={(e) => setPriority(e.target.value as PmTaskPriority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_REGISTRY[p].label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>负责人</label>
            <UserSearchSelect value={assigneeId} onChange={setAssigneeId} placeholder="搜索用户名或昵称…" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>开始</label>
              <input type="date" className={inputCls} style={inputStyle} value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            </div>
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>截止</label>
              <input type="date" className={inputCls} style={inputStyle} value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>工时(人天)</label>
              <input type="number" min={0} step={0.5} className={inputCls} style={inputStyle} value={estimateDays} onChange={(e) => setEstimateDays(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>标签（逗号分隔）</label>
            <input className={inputCls} style={inputStyle} value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="如：前端, 设计" />
          </div>

          {/* 依赖 */}
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}><Link2 size={11} className="inline mr-1" />前置依赖</label>
            {blockedBy.length > 0 && (
              <div className="text-[11px] mb-1.5 flex items-center gap-1" style={{ color: '#F59E0B' }}>
                <AlertTriangle size={12} /> 有 {blockedBy.length} 个前置未完成（被阻塞）
              </div>
            )}
            <div className="rounded-lg border max-h-40 overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
              {depCandidates.length === 0 ? (
                <div className="text-[11px] text-center py-3" style={{ color: 'var(--text-muted)' }}>无其他任务可依赖</div>
              ) : depCandidates.map((t) => (
                <label key={t.id} className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[12px]" style={{ color: 'var(--text-primary)' }}>
                  <input type="checkbox" checked={dependsOn.includes(t.id)} onChange={() => toggleDep(t.id)} style={{ accentColor: '#3B82F6' }} />
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: TASK_STATUS_REGISTRY[t.status].color }} />
                  <span className="truncate">{t.title}</span>
                </label>
              ))}
            </div>
          </div>

          {/* 子任务 */}
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>子任务{children.length > 0 ? `（${children.filter((c) => c.status === 'done').length}/${children.length}）` : ''}</label>
            <div className="flex flex-col gap-1">
              {children.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[12px] px-2 py-1 rounded" style={{ background: 'var(--bg-base)' }}>
                  <input type="checkbox" checked={c.status === 'done'} onChange={() => toggleSubDone(c)} style={{ accentColor: '#10B981' }} />
                  <span className="truncate" style={{ color: 'var(--text-primary)', textDecoration: c.status === 'done' ? 'line-through' : 'none', opacity: c.status === 'done' ? 0.6 : 1 }}>{c.title}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <input className="flex-1 rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle}
                  value={subTitle} onChange={(e) => setSubTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSubtask(); }} placeholder="添加子任务，回车确认" />
                <Button variant="secondary" size="sm" onClick={addSubtask} disabled={!subTitle.trim()}>添加</Button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : null}保存</Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
