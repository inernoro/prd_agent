import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  listScheduledNotifications, saveScheduledNotification,
  type NotificationFrequency, type ScheduledNotification, type ScheduledNotificationInput,
} from '@/services/real/productScheduledNotifications';

const frequencyLabel = { once: '单次', daily: '每天', weekly: '每周', monthly: '每月' };
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const resultLabel = { sending: '发送中', sent: '发送成功', failed: '发送失败，请检查 Webhook', unknown: '结果未知，请查看群消息' };
const beijing = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const field = 'mt-1 w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary';

function scheduleLabel(task: ScheduledNotification) {
  if (task.frequency === 'once') return `${task.date} ${task.time}`;
  if (task.frequency === 'weekly') return `每${weekdays[task.day ?? 0]} ${task.time}`;
  if (task.frequency === 'monthly') return `每月 ${task.day} 日 ${task.time}`;
  return `每天 ${task.time}`;
}

export function ScheduledNotifications() {
  const [items, setItems] = useState<ScheduledNotification[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<ScheduledNotification | null | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    void listScheduledNotifications(controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      if (res.success) {
        setItems(res.data.items);
        setCanManage(res.data.canManage);
      } else setError(res.error.message);
    }).catch(() => {
      if (!controller.signal.aborted) setError('任务列表读取失败，请重试。');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reload]);

  function refresh() {
    setError('');
    setLoading(true);
    setReload((value) => value + 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-token-muted">按北京时间将消息发送到企业微信群。</p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" disabled={loading} onClick={refresh}>刷新</Button>
          {canManage && <Button size="sm" variant="primary" onClick={() => setEditing(null)}><Plus size={14} />新建任务</Button>}
        </div>
      </div>
      {loading ? <MapSectionLoader text="正在读取通知任务…" /> : error ? (
        <p role="alert" className="text-sm text-token-secondary">{error}</p>
      ) : !canManage ? (
        <p className="rounded-xl border border-token-subtle p-5 text-sm text-token-muted">请在正式环境管理定时通知。</p>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-token-subtle p-5 text-sm text-token-muted">暂无通知任务。点击「新建任务」设置第一条定时通知。</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-token-subtle">
          <table className="w-full text-left text-sm">
            <thead className="bg-token-nested text-token-secondary">
              <tr>{['任务名称', '发送计划', '状态', '下次执行', '最近发送', '操作'].map((title) => <th key={title} scope="col" className="px-4 py-3 font-medium">{title}</th>)}</tr>
            </thead>
            <tbody>
              {items.map((task) => (
                <tr key={task.id} className="border-t border-token-subtle align-top">
                  <td className="min-w-48 break-all px-4 py-3">
                    <div className="font-medium text-token-primary">{task.name}</div>
                    <div className="mt-1 text-xs text-token-muted">{task.webhookMasked}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{scheduleLabel(task)}</td>
                  <td className="whitespace-nowrap px-4 py-3">{task.enabled ? '已启用' : task.frequency === 'once' && task.lastRunAt ? '已执行' : '已停用'}</td>
                  <td className="whitespace-nowrap px-4 py-3">{task.nextRunAt ? beijing.format(new Date(task.nextRunAt)) : '—'}</td>
                  <td className="min-w-36 px-4 py-3">
                    {task.lastResult ? resultLabel[task.lastResult] : '尚未发送'}
                    {task.lastRunAt && <div className="mt-1 text-xs text-token-muted">{beijing.format(new Date(task.lastRunAt))}</div>}
                  </td>
                  <td className="px-4 py-3"><Button size="sm" variant="ghost" onClick={() => setEditing(task)}>编辑</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined && <NotificationEditor task={editing} onClose={() => setEditing(undefined)} onSaved={(saved) => {
        setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
        setEditing(undefined);
      }} />}
    </div>
  );
}

function NotificationEditor({ task, onClose, onSaved }: {
  task: ScheduledNotification | null;
  onClose: () => void;
  onSaved: (task: ScheduledNotification) => void;
}) {
  const [frequency, setFrequency] = useState<NotificationFrequency>(task?.frequency ?? 'daily');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(event.currentTarget);
    const input: ScheduledNotificationInput = {
      name: String(data.get('name') ?? ''),
      message: String(data.get('message') ?? ''),
      frequency,
      time: String(data.get('time') ?? ''),
      date: frequency === 'once' ? String(data.get('date') ?? '') : null,
      day: frequency === 'weekly' || frequency === 'monthly' ? Number(data.get('day')) : null,
      enabled: data.has('enabled'),
      webhookUrl: String(data.get('webhook') ?? '').trim() || undefined,
      revision: task?.revision,
    };
    setError('');
    setSaving(true);
    try {
      const response = await saveScheduledNotification(input, task?.id);
      if (response.success) onSaved(response.data);
      else setError(response.error.message);
    } catch {
      setError('保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title={task ? '编辑通知任务' : '新建通知任务'} maxWidth={560}
      contentStyle={{ maxHeight: 'calc(100dvh - 32px)' }}
      content={
        <form id="scheduled-notification-form" className="space-y-4 text-sm text-token-secondary" onSubmit={(event) => void submit(event)}>
          <label className="block">任务名称<input className={field} name="name" required maxLength={100} defaultValue={task?.name} /></label>
          <label className="block">通知内容<textarea className={field} name="message" rows={4} required defaultValue={task?.message} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label>发送周期<select className={field} value={frequency} onChange={(event) => setFrequency(event.target.value as NotificationFrequency)}>
              {Object.entries(frequencyLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>发送时间（北京时间）<input className={field} name="time" type="time" required defaultValue={task?.time ?? '09:00'} /></label>
            {frequency === 'once' && <label>发送日期<input className={field} name="date" type="date" required defaultValue={task?.date ?? ''} /></label>}
            {frequency === 'weekly' && <label>发送星期<select className={field} name="day" defaultValue={task?.frequency === 'weekly' ? task.day ?? 1 : 1}>
              {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select></label>}
            {frequency === 'monthly' && <label>每月日期<input className={field} name="day" type="number" min={1} max={31} required defaultValue={task?.frequency === 'monthly' ? task.day ?? 1 : 1} />
              <span className="mt-1 block text-xs text-token-muted">当月没有该日期时跳过。</span>
            </label>}
          </div>
          <label className="block">企业微信群机器人 Webhook
            {task && <span className="mt-1 block break-all text-xs text-token-muted">{task.webhookMasked}</span>}
            <input className={field} name="webhook" type="password" autoComplete="new-password" required={!task} maxLength={512}
              placeholder={task ? '留空保留原链接，输入新链接即可替换' : '粘贴企业微信机器人链接'} />
          </label>
          <label className="flex items-center gap-2"><input name="enabled" type="checkbox" defaultChecked={task?.enabled ?? true} />启用定时发送</label>
          {error && <p role="alert" className="text-semantic-danger">{error}</p>}
        </form>
      }
      actions={<>
        <Button size="sm" onClick={onClose} disabled={saving}>取消</Button>
        <Button size="sm" variant="primary" type="submit" form="scheduled-notification-form" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
      </>}
    />
  );
}
