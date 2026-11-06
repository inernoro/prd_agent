import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { NotificationGroupsDialog } from './NotificationGroupsDialog';
import {
  listScheduledNotifications, saveScheduledNotification, listNotificationGroups,
  getNotificationDebugSettings, saveNotificationDebugSettings, debugScheduledNotification,
  type NotificationFrequency, type ScheduledNotification, type ScheduledNotificationInput,
  type NotificationDebugSettings, type NotificationGroup,
} from '@/services/real/productScheduledNotifications';

const frequencyLabel = { once: '单次', daily: '每天', weekly: '每周', monthly: '每月' };
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const resultLabel = { sending: '发送中', sent: '发送成功', failed: '发送失败，请检查 Webhook', unknown: '结果未知，请查看群消息', partial: '部分群已发送' };
const beijing = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const field = 'mt-1 w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary';
type EditorSelection = { mode: 'new' } | { mode: 'edit' | 'copy'; task: ScheduledNotification };
type WebhookRow = { id: number; existingIndex?: number; replacing?: boolean; group?: NotificationGroup };
const maxWebhooks = 10;

function webhookCount(task: ScheduledNotification) {
  return task.webhookCount ?? (task.webhookConfigured ? 1 : 0);
}

function scheduleLabel(task: ScheduledNotification) {
  if (task.frequency === 'once') return `${task.date} ${task.time}`;
  if (task.frequency === 'weekly') return `每${weekdays[task.day ?? 0]} ${task.time}`;
  if (task.frequency === 'monthly') return `每月 ${task.day} 日 ${task.time}`;
  return `每天 ${task.time}`;
}

function notificationStatus(task: ScheduledNotification) {
  return task.lastResult === 'sent' || task.lastResult === 'partial' ? '已发送' : '待发送';
}

export function ScheduledNotifications() {
  const [items, setItems] = useState<ScheduledNotification[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<EditorSelection | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [debugSettingsOpen, setDebugSettingsOpen] = useState(false);
  const [debugging, setDebugging] = useState<string | null>(null);
  const [enableActions, setEnableActions] = useState<Record<string, { pending: boolean; error?: string }>>({});
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

  async function changeEnabled(task: ScheduledNotification, enabled: boolean) {
    if (enableActions[task.id]?.pending) return;
    const { name, message, frequency, time, date, day, mentionAll, revision } = task;
    setEnableActions((current) => ({ ...current, [task.id]: { pending: true } }));
    let error: string | undefined;
    try {
      const response = await saveScheduledNotification({ name, message, frequency, time, date, day, mentionAll, enabled, revision }, task.id);
      if (response.success) {
        setItems((current) => current.map((item) => item.id === task.id ? response.data : item));
      } else {
        error = response.error.message;
      }
    } catch {
      error = '状态更新失败，请刷新列表后重试。';
    } finally {
      setEnableActions((current) => ({ ...current, [task.id]: { pending: false, error } }));
      setReload((value) => value + 1);
    }
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
          {canManage && <Button size="sm" onClick={() => setGroupsOpen(true)}>常用群</Button>}
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
                    <div className="mt-1 text-xs text-token-muted">{webhookCount(task)} 个 Webhook</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{scheduleLabel(task)}</td>
                  <td className="whitespace-nowrap px-4 py-3">{notificationStatus(task)}</td>
                  <td className="whitespace-nowrap px-4 py-3">{task.nextRunAt ? beijing.format(new Date(task.nextRunAt)) : '—'}</td>
                  <td className="min-w-36 px-4 py-3">
                    {task.lastResult ? resultLabel[task.lastResult] : task.enabled ? '等待到点发送' : '—'}
                    {task.lastDelivery && <div className="mt-1 text-xs text-token-muted">
                      成功 {task.lastDelivery.sent} · 失败 {task.lastDelivery.failed} · 未知 {task.lastDelivery.unknown}
                    </div>}
                    {task.lastRunAt && <div className="mt-1 text-xs text-token-muted">{beijing.format(new Date(task.lastRunAt))}</div>}
                    {task.debugLastResult && <div className="mt-2 text-xs text-token-muted">最近调试 {resultLabel[task.debugLastResult]}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex whitespace-nowrap gap-1">
                      {task.canEdit && <Button size="sm" variant="ghost" disabled={enableActions[task.id]?.pending}
                        onClick={() => void changeEnabled(task, !task.enabled)}>
                        {enableActions[task.id]?.pending ? '保存中…' : task.enabled ? '禁用' : '启用'}
                      </Button>}
                      {task.canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: 'edit', task })}>编辑</Button>}
                      {task.canEdit && <Button size="sm" variant="ghost" disabled={debugging !== null || task.debugLastResult === 'sending'}
                        onClick={() => void debug(task)}>{debugging === task.id ? '调试发送中…' : '立即调试'}</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ mode: 'copy', task })}>复制</Button>
                    </div>
                    {enableActions[task.id]?.error && <p role="alert" className="mt-1 text-xs text-semantic-danger">
                      {enableActions[task.id].error}
                    </p>}
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
      {groupsOpen && <NotificationGroupsDialog onClose={() => setGroupsOpen(false)} />}
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
  const initialWebhookCount = source ? webhookCount(source) : 0;
  const nextWebhookId = useRef(initialWebhookCount);
  const [webhookRows, setWebhookRows] = useState<WebhookRow[]>(() =>
    Array.from({ length: initialWebhookCount }, (_, index) => ({ id: index, existingIndex: index })));
  const [groups, setGroups] = useState<NotificationGroup[] | null>(null);
  const [groupsError, setGroupsError] = useState('');
  const [groupsReload, setGroupsReload] = useState(0);
  const availableGroups = groups?.filter((group) => !webhookRows.some((row) => row.group?.id === group.id)) ?? [];
  const enabled = source?.enabled ?? true;
  const [frequency, setFrequency] = useState<NotificationFrequency>(source?.frequency ?? 'once');
  const [creationDate] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${datePart('year')}-${datePart('month')}-${datePart('day')}`;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void listNotificationGroups(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      if (response.success) {
        setGroups(response.data.items);
        setGroupsError('');
      } else setGroupsError(response.error.message);
    }).catch(() => {
      if (!controller.signal.aborted) setGroupsError('常用群读取失败。');
    });
    return () => controller.abort();
  }, [groupsReload]);

  function addWebhook(group?: NotificationGroup) {
    const id = nextWebhookId.current++;
    setWebhookRows((rows) => rows.length < maxWebhooks ? [...rows, { id, group }] : rows);
  }

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
      enabled,
      mentionAll: data.has('mentionAll'),
      webhooks: webhookRows.map((row) => {
        if (row.group) return { groupId: row.group.id, groupRevision: row.group.revision };
        if (row.existingIndex !== undefined && !row.replacing) return { existingIndex: row.existingIndex };
        return { url: String(data.get(`webhook-${row.id}`) ?? '').trim() };
      }),
      revision: task?.revision,
      sourceTaskId: selection.mode === 'copy' ? selection.task.id : undefined,
      sourceRevision: selection.mode === 'copy' ? selection.task.revision : undefined,
    };
    setError('');
    setSaving(true);
    try {
      const response = await saveScheduledNotification(input, task?.id);
      if (response.success) onSaved(response.data);
      else if (response.error.code === 'NOTIFICATION_GROUP_CHANGED') {
        setError('常用群已更新，请移除旧选择并重新选择该群。');
        setGroupsReload((value) => value + 1);
      } else setError(response.error.message);
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
          <label className="block">任务名称<input className={field} name="name" required maxLength={100} defaultValue={source?.name} /></label>
          <label className="block">通知内容<textarea className={field} name="message" rows={4} required defaultValue={source?.message} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label>发送周期<select className={field} value={frequency} onChange={(event) => setFrequency(event.target.value as NotificationFrequency)}>
              {Object.entries(frequencyLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>发送时间（北京时间）<input className={field} name="time" type="time" required defaultValue={source?.time ?? '18:30'} /></label>
            {frequency === 'once' && <label>发送日期<input className={field} name="date" type="date" required defaultValue={source?.date ?? creationDate} /></label>}
            {frequency === 'weekly' && <label>发送星期<select className={field} name="day" defaultValue={source?.frequency === 'weekly' ? source.day ?? 1 : 1}>
              {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select></label>}
            {frequency === 'monthly' && <label>每月日期<input className={field} name="day" type="number" min={1} max={31} required defaultValue={source?.frequency === 'monthly' ? source.day ?? 1 : 1} />
              <span className="mt-1 block text-xs text-token-muted">当月没有该日期时跳过。</span>
            </label>}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>企业微信群机器人 Webhook</span>
              <Button size="sm" disabled={saving || webhookRows.length >= maxWebhooks}
                onClick={() => addWebhook()}><Plus size={14} />添加 Webhook</Button>
            </div>
            <p className="text-xs text-token-muted">同一条通知会发到这里配置的所有群，最多 {maxWebhooks} 个。</p>
            <label className="block">选择常用群
              <select className={field} value="" disabled={saving || webhookRows.length >= maxWebhooks || !availableGroups.length}
                onChange={(event) => {
                  const group = availableGroups.find((item) => item.id === event.target.value);
                  if (group) addWebhook(group);
                }}>
                <option value="">{groups === null ? '正在读取常用群…' : groups.length ? '选择要发送的群' : '还没有常用群'}</option>
                {availableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            {groups?.length === 0 && <p className="text-xs text-token-muted">可在通知页「常用群」中添加，或在这里手动填写链接。</p>}
            {groupsError && <div className="flex items-center gap-2 text-xs text-token-muted">
              <span>{groupsError}</span>
              <Button size="sm" disabled={saving} onClick={() => setGroupsReload((value) => value + 1)}>重试</Button>
            </div>}
            {webhookRows.map((row, index) => <div key={row.id} className="rounded-lg border border-token-subtle bg-token-nested p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 break-all font-medium text-token-primary">
                  {row.group?.name ?? (row.existingIndex !== undefined && !row.replacing ? source?.webhookGroupNames?.[row.existingIndex] : null) ?? `Webhook ${index + 1}`}
                </span>
                <div className="flex gap-1">
                  {row.existingIndex !== undefined && <Button size="sm" variant="ghost" disabled={saving} onClick={() =>
                    setWebhookRows((rows) => rows.map((item) => item.id === row.id ? { ...item, replacing: !item.replacing } : item))
                  }>{row.replacing ? '取消修改' : '修改'}</Button>}
                  <Button size="sm" variant="ghost" disabled={saving} onClick={() =>
                    setWebhookRows((rows) => rows.filter((item) => item.id !== row.id))
                  }>移除</Button>
                </div>
              </div>
              {row.group || (row.existingIndex !== undefined && !row.replacing) ? <>
                <div className="text-xs text-token-secondary">已填写（脱敏）</div>
                <div className="mt-1 break-all text-xs text-token-muted">{row.group?.webhookMasked ?? source?.webhookMasked}</div>
              </> : <input className={field} name={`webhook-${row.id}`} type="password" autoComplete="new-password"
                aria-label={`Webhook ${index + 1} 链接`} required maxLength={512} placeholder="粘贴企业微信机器人链接" />}
            </div>)}
          </div>
          {!enabled && <p className="text-xs text-token-muted">保存后可在操作列点击「启用」。</p>}
          <label className="flex items-center gap-2"><input name="mentionAll" type="checkbox" defaultChecked={source?.mentionAll ?? true} />@全部人</label>
          {error && <p role="alert" className="text-semantic-danger">{error}</p>}
        </form>
      }
      actions={<>
        <Button size="sm" onClick={onClose} disabled={saving}>取消</Button>
        <Button size="sm" variant="primary" type="submit" form="scheduled-notification-form" disabled={saving || !webhookRows.length}>{saving ? '保存中…' : '保存'}</Button>
      </>}
    />
  );
}
