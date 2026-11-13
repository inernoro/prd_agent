import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  listNotificationGroups, removeNotificationGroup, saveNotificationGroup, type NotificationGroup,
} from '@/services/real/productScheduledNotifications';

const field = 'mt-1 w-full rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary';

export function NotificationGroupsDialog({ onClose }: { onClose: () => void }) {
  const [groups, setGroups] = useState<NotificationGroup[] | null>(null);
  const [editing, setEditing] = useState<NotificationGroup | 'new' | null>(null);
  const [changeUrl, setChangeUrl] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const group = editing === 'new' ? null : editing;

  useEffect(() => {
    const controller = new AbortController();
    void listNotificationGroups(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      if (response.success) setGroups(response.data.items);
      else setError(response.error.message);
    }).catch(() => {
      if (!controller.signal.aborted) setError('常用群读取失败，请刷新重试。');
    });
    return () => controller.abort();
  }, [reload]);

  function edit(selection: NotificationGroup | 'new' | null) {
    setEditing(selection);
    setChangeUrl(selection === 'new');
    setRemoving(null);
    setError('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const response = await saveNotificationGroup({
        name: String(data.get('name') ?? '').trim(),
        webhookUrl: changeUrl ? String(data.get('webhook') ?? '').trim() : undefined,
        revision: group?.revision,
      }, group?.id);
      if (response.success) {
        const saved = response.data;
        setGroups((items) => group
          ? (items ?? []).map((item) => item.id === saved.id ? saved : item)
          : [...(items ?? []), saved]);
        edit(null);
      } else setError(response.error.message);
    } catch {
      setError('常用群保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: NotificationGroup) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await removeNotificationGroup(item);
      if (response.success) {
        setGroups((items) => (items ?? []).filter((current) => current.id !== item.id));
        setRemoving(null);
      } else setError(response.error.message);
    } catch {
      setError('常用群移除失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}
    title={editing === 'new' ? '添加常用群' : editing ? '编辑常用群' : '常用群'}
    description="保存群名和机器人链接，编辑通知时可直接按群名选择。"
    maxWidth={560} contentStyle={{ maxHeight: 'calc(100dvh - 32px)' }}
    content={<div className="space-y-3 text-sm text-token-secondary">
      {editing ? <form id="notification-group-form" onSubmit={(event) => void save(event)} className="space-y-3">
        <label className="block">群名<input name="name" className={field} required maxLength={60} defaultValue={group?.name} /></label>
        {group && <div className="rounded-lg border border-token-subtle bg-token-nested p-3">
          <div className="flex items-center justify-between gap-2">
            <span>已填写（脱敏）</span>
            <Button size="sm" disabled={busy} onClick={() => setChangeUrl((value) => !value)}>
              {changeUrl ? '取消更换' : '更换链接'}
            </Button>
          </div>
          <div className="mt-1 break-all text-xs text-token-muted">{group.webhookMasked}</div>
        </div>}
        {changeUrl && <label className="block">Webhook 链接
          <input name="webhook" className={field} type="password" autoComplete="new-password" required maxLength={512}
            placeholder="粘贴企业微信机器人链接" />
        </label>}
        {group && <p className="text-xs text-token-muted">已保存的通知会继续使用原来的群地址。</p>}
      </form> : <>
        {!groups && !error && <MapSectionLoader text="正在读取常用群…" />}
        {groups?.length === 0 && <p>还没有常用群，点击「添加常用群」保存第一个群。</p>}
        {groups?.map((item) => <div key={item.id} className="rounded-lg border border-token-subtle bg-token-nested p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 break-all font-medium text-token-primary">{item.name}</span>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(item)}>编辑</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRemoving(item.id); setError(''); }}>移除</Button>
            </div>
          </div>
          <div className="mt-1 break-all text-xs text-token-muted">{item.webhookMasked}</div>
          {removing === item.id && <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs">移除后，已保存的任务仍按原地址发送。</span>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(item)}>确认移除</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>取消</Button>
          </div>}
        </div>)}
      </>}
      {error && <p role="alert" className="text-semantic-danger">{error}</p>}
    </div>}
    actions={editing ? <>
      <Button size="sm" disabled={busy} onClick={() => { edit(null); setReload((value) => value + 1); }}>返回</Button>
      <Button size="sm" variant="primary" disabled={busy} type="submit" form="notification-group-form">{busy ? '保存中…' : '保存'}</Button>
    </> : <>
      <Button size="sm" disabled={busy} onClick={onClose}>关闭</Button>
      <Button size="sm" disabled={busy} onClick={() => { setError(''); setReload((value) => value + 1); }}>刷新</Button>
      <Button size="sm" variant="primary" disabled={busy || groups === null} onClick={() => edit('new')}>添加常用群</Button>
    </>} />;
}
