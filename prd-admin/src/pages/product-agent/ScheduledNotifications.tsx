import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  listScheduledNotifications, saveScheduledNotification,
  getNotificationDebugSettings, saveNotificationDebugSettings, debugScheduledNotification,
  type NotificationFrequency, type ScheduledNotification, type ScheduledNotificationInput,
  type NotificationDebugSettings,
} from '@/services/real/productScheduledNotifications';

const frequencyLabel = { once: '单次', daily: '每天', weekly: '每周', monthly: '每月' };
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const resultLabel = { sending: '发送中', sent: '发送成功', failed: '发送失败，请检查 Webhook', unknown: '结果未知，请查看群消息' };
const beijing = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const field = 'mt-1 w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary';
type EditorSelection = { mode: 'new' } | { mode: 'edit' | 'copy'; task: ScheduledNotification };

function scheduleLabel(task: ScheduledNotification) {
  if (task.frequency === 'once') return `${task.date} ${task.time}`;
  if (task.frequency === 'weekly') return `每${weekdays[task.day ?? 0]} ${task.time}`;
  if (task.frequency === 'monthly') return `每月 ${task.day} 日 ${task.time}`;
  return `每天 ${task.time}`;
}

function notificationStatus(task: ScheduledNotification) {
  if (task.lastResult === 'sending') return '发送中';
  if (task.enabled) return '待发送';
  if (task.lastResult === 'sent') return '已发送';
  return task.lastRunAt ? '已执行' : '已停用';
}

export function ScheduledNotifications() {
  const [items, setItems] = useState<ScheduledNotification[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<EditorSelection | null>(null);
  const [debugSettingsOpen, setDebugSettingsOpen] = useState(false);
  const [debugging, setDebugging] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let shouldPoll = true;
    async function load() {
      try {
        const res = await listScheduledNotifications(controller.signal);
        if (controller.signal.aborted) return;
        if (res.success) {
          setItems(res.data.items);
          setCanManage(res.data.canManage);
          setError('');
          shouldPoll = res.data.canManage && res.data.items.some((task) =>
            task.enabled || task.lastResult === 'sending' || task.debugLastResult === 'sending');
        } else {
          setError(res.error.message);
          shouldPoll = false;
        }
      } catch {
        if (!controller.signal.aborted) setError('任务列表读取失败，请重试。');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (shouldPoll) timer = window.setTimeout(() => void load(), 5000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [reload]);

  function refresh() {
    setError('');
    setLoading(true);
    setReload((value) => value + 1);
  }

  async function debug(task: ScheduledNotification) {
    if (debugging) return;
    setDebugging(task.id);
    setActionMessage('');
    try {
      const response = await debugScheduledNotification(task.id, crypto.randomUUID().replaceAll('-', ''));
      if (response.success) {
        const status = response.data.status;
        setActionMessage(status ? `调试结果 ${resultLabel[status]}` : '调试结果未确认，请查看调试群消息。');
      } else {
        setActionMessage(response.error.message);
      }
    } catch {
      setActionMessage('调试结果未确认，请查看调试群消息后再操作。');
    } finally {
      setDebugging(null);
      setReload((value) => value + 1);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-token-muted">按北京时间将消息发送到企业微信群。</p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" disabled={loading} onClick={refresh}>刷新</Button>
          {canManage && <Button size="sm" onClick={() => setDebugSettingsOpen(true)}>调试设置</Button>}
          {canManage && <Button size="sm" variant="primary" onClick={() => setEditing({ mode: 'new' })}><Plus size={14} />新建任务</Button>}
        </div>
      </div>
      {actionMessage && <p role="status" className="text-sm text-token-secondary">{actionMessage}</p>}
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
                  <td className="whitespace-nowrap px-4 py-3">{notificationStatus(task)}</td>
                  <td className="whitespace-nowrap px-4 py-3">{task.nextRunAt ? beijing.format(new Date(task.nextRunAt)) : '—'}</td>
                  <td className="min-w-36 px-4 py-3">
                    {task.lastResult ? resultLabel[task.lastResult] : task.enabled ? '等待到点发送' : '—'}
                    {task.lastRunAt && <div className="mt-1 text-xs text-token-muted">{beijing.format(new Date(task.lastRunAt))}</div>}
                    {task.debugLastResult && <div className="mt-2 text-xs text-token-muted">最近调试 {resultLabel[task.debugLastResult]}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex whitespace-nowrap gap-1">
                      {task.canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: 'edit', task })}>编辑</Button>}
                      {task.canEdit && <Button size="sm" variant="ghost" disabled={debugging !== null || task.debugLastResult === 'sending'}
                        onClick={() => void debug(task)}>{debugging === task.id ? '调试发送中…' : '立即调试'}</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: 'copy', task })}>复制为新任务</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <NotificationEditor selection={editing} onClose={() => setEditing(null)} onSaved={(saved) => {
        setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
        setEditing(null);
        setReload((value) => value + 1);
      }} />}
      {debugSettingsOpen && <DebugSettingsDialog onClose={() => setDebugSettingsOpen(false)} onSaved={() => {
        setDebugSettingsOpen(false);
        setActionMessage('调试群已保存。立即调试会发送到此群，原定时计划继续按保存时间执行。');
      }} />}
    </div>
  );
}

function DebugSettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<NotificationDebugSettings | null>(null);
  const [changeWebhook, setChangeWebhook] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getNotificationDebugSettings(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      if (response.success) {
        setSettings(response.data);
        setChangeWebhook(!response.data.configured);
      } else setError(response.error.message);
    }).catch(() => { if (!controller.signal.aborted) setError('调试设置读取失败，请关闭后重试。'); });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setError('');
    try {
      const response = await saveNotificationDebugSettings(String(data.get('debugWebhook') ?? '').trim());
      if (response.success) onSaved();
      else setError(response.error.message);
    } catch {
      setError('调试设置保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}
    title="调试群设置" description="立即调试发送到此固定群，原定时计划继续按保存时间执行。"
    content={<form id="notification-debug-settings" onSubmit={(event) => void save(event)} className="space-y-3 text-sm text-token-secondary">
      {!settings && !error && <MapSectionLoader text="正在读取调试设置…" />}
      {settings?.configured && <div className="rounded-lg border border-token-subtle bg-token-nested p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-token-primary">已填写（脱敏）</span>
          <Button size="sm" onClick={() => setChangeWebhook((value) => !value)}>{changeWebhook ? '取消修改' : '修改'}</Button>
        </div>
        <div className="mt-1 break-all text-xs text-token-muted">{settings.webhookMasked}</div>
      </div>}
      {changeWebhook && <label className="block">调试群 Webhook
        <input className={field} type="password" name="debugWebhook" required maxLength={512} autoComplete="new-password" placeholder="粘贴企业微信机器人链接" />
      </label>}
      {error && <p role="alert">{error}</p>}
    </form>}
    actions={<>
      <Button size="sm" disabled={saving} onClick={onClose}>关闭</Button>
      <Button size="sm" variant="primary" type="submit" form="notification-debug-settings" disabled={saving || !settings?.canManage || !changeWebhook}>{saving ? '保存中…' : '保存'}</Button>
    </>} />;
}

function NotificationEditor({ selection, onClose, onSaved }: {
  selection: EditorSelection;
  onClose: () => void;
  onSaved: (task: ScheduledNotification) => void;
}) {
  const source = selection.mode === 'new' ? null : selection.task;
  const task = selection.mode === 'edit' ? selection.task : null;
  const [changeWebhook, setChangeWebhook] = useState(!source?.webhookConfigured);
  const [frequency, setFrequency] = useState<NotificationFrequency>(task?.frequency ?? 'once');
  const [creationDate] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
  });
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
      enabled: true,
      mentionAll: data.has('mentionAll'),
      webhookUrl: String(data.get('webhook') ?? '').trim() || undefined,
      revision: task?.revision,
      sourceTaskId: selection.mode === 'copy' ? selection.task.id : undefined,
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
      title={task ? '编辑通知任务' : selection.mode === 'copy' ? '复制为新任务' : '新建通知任务'} maxWidth={560}
      contentStyle={{ maxHeight: 'calc(100dvh - 32px)' }}
      content={
        <form id="scheduled-notification-form" className="space-y-4 text-sm text-token-secondary" onSubmit={(event) => void submit(event)}>
          <label className="block">任务名称<input className={field} name="name" required maxLength={100} defaultValue={selection.mode === 'copy' ? `${selection.task.name.slice(0, 96)}（副本）` : task?.name} /></label>
          <label className="block">通知内容<textarea className={field} name="message" rows={4} required defaultValue={source?.message} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label>发送周期<select className={field} value={frequency} onChange={(event) => setFrequency(event.target.value as NotificationFrequency)}>
              {Object.entries(frequencyLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>发送时间（北京时间）<input className={field} name="time" type="time" required defaultValue={task?.time ?? '18:30'} /></label>
            {frequency === 'once' && <label>发送日期<input className={field} name="date" type="date" required defaultValue={task?.date ?? creationDate} /></label>}
            {frequency === 'weekly' && <label>发送星期<select className={field} name="day" defaultValue={task?.frequency === 'weekly' ? task.day ?? 1 : 1}>
              {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select></label>}
            {frequency === 'monthly' && <label>每月日期<input className={field} name="day" type="number" min={1} max={31} required defaultValue={task?.frequency === 'monthly' ? task.day ?? 1 : 1} />
              <span className="mt-1 block text-xs text-token-muted">当月没有该日期时跳过。</span>
            </label>}
          </div>
          <div>
            <div className="text-sm">企业微信群机器人 Webhook</div>
            {source?.webhookConfigured && (
              <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border border-token-subtle bg-token-nested p-3">
                <div className="min-w-0">
                  <div className="font-medium text-token-primary">已填写（脱敏）</div>
                  <div className="mt-1 break-all text-xs text-token-muted">{source.webhookMasked}</div>
                  {selection.mode === 'copy' && <div className="mt-1 text-xs text-token-muted">自动沿用原任务的 Webhook</div>}
                </div>
                <Button size="sm" onClick={() => setChangeWebhook((value) => !value)}>{changeWebhook ? '取消修改' : '修改'}</Button>
              </div>
            )}
            {changeWebhook && <label className="mt-2 block">Webhook 链接
              <input className={field} name="webhook" type="password" autoComplete="new-password" required maxLength={512} placeholder="粘贴企业微信机器人链接" />
            </label>}
          </div>
          <label className="flex items-center gap-2"><input name="mentionAll" type="checkbox" defaultChecked={source?.mentionAll ?? true} />@全部人</label>
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
