import { type FormEvent, useEffect, useState } from 'react';
import { AccessRequestInbox } from '@/components/AccessRequestInbox';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCdsEvents } from '@/hooks/useCdsEvents';
import { apiRequest, apiUrl } from '@/lib/api';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import { accountInputClass } from './AccountActionDialog';

export interface AccessRequestNotice {
  id: string;
  agentName: string;
  projectName?: string;
  purpose?: string;
  status: string;
  notificationAccountId?: string | null;
}

interface KeyRecipient {
  ref: { kind: 'project' | 'global' | 'user'; projectId?: string; id: string };
  label: string;
  projectName?: string;
  recipientAccountId?: string | null;
  recipientName?: string;
  state: 'revoked' | 'legacy' | 'assigned' | 'handoff';
  handoff?: { reason: string; at: string };
}

interface Ownership {
  keys: KeyRecipient[];
  accounts: Array<{ id: string; name: string }>;
}

const keyLabels: Record<KeyRecipient['state'], string> = {
  revoked: '已吊销', legacy: '历史受众', assigned: '定向通知', handoff: '需要指定接手账号',
};

export function KeyNotifications({ owner, personal = false }: { owner: boolean; personal?: boolean }): JSX.Element {
  const [all, setAll] = useState(false);
  const [notices, setNotices] = useState<AccessRequestNotice[] | null>(null);
  const [routing, setRouting] = useState<Ownership | null>(null);
  const [selected, setSelected] = useState<KeyRecipient | null>(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const lastEvent = useCdsEvents().lastAccessRequestEvent;
  const refresh = () => setAttempt(value => value + 1);
  useEffect(() => {
    if (owner) return;
    const source = new EventSource(apiUrl('/api/cds-events?scope=account-notifications'));
    const update = () => setAttempt(value => value + 1);
    for (const event of ['access-request.created', 'access-request.decided', 'access-request.progress', 'open']) {
      source.addEventListener(event, update);
    }
    return () => source.close();
  }, [owner]);
  useEffect(() => {
    const ctrl = new AbortController();
    setError('');
    const queue = all && owner && !personal ? 'all' : owner && !personal ? 'inbox' : 'mine';
    const endpoint = queue === 'inbox' ? '/api/access-requests' : `/api/access-requests?queue=${queue}`;
    const requests = apiRequest<{ requests: AccessRequestNotice[] }>(endpoint, { signal: ctrl.signal });
    const keys = personal ? Promise.resolve(null)
      : apiRequest<Ownership>('/api/auth/key-notification-owners', { signal: ctrl.signal });
    Promise.all([requests, keys]).then(([queue, ownerData]) => {
      if (!ctrl.signal.aborted) { setNotices(queue.requests); setRouting(ownerData); }
    }).catch(error => { if (!ctrl.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => ctrl.abort();
  }, [all, owner, personal, attempt, lastEvent]);

  const keys = routing?.keys.filter(key => filter === 'all' || key.state === filter);
  return (
    <Section title="Key 通知" description={personal ? '查阅发给当前账号的授权申请通知。' : '新 Key 的通知归签发账号。存量 Key 沿用历史收件范围。'}
      actions={<div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={refresh}>刷新</Button>
        {owner && !personal ? <Button variant="outline" onClick={() => setAll(current => !current)}>{all ? '返回收件箱' : '查看完整审批队列'}</Button> : null}
      </div>}>
      {error ? <ErrorBlock message={error} /> : !notices ? <LoadingBlock label="读取 Key 通知" /> : <>
        {all && owner && !personal ? <div className="mb-3"><AccessRequestInbox queue="all" /></div> : null}
        {notices.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {notices.map(item => <li className="flex flex-wrap justify-between gap-2 p-3" key={item.id}>
              <span className="min-w-0 break-words">
                <strong>{item.agentName}{item.projectName ? ` · ${item.projectName}` : ''}</strong>
                {item.purpose ? <small className="block text-muted-foreground">{item.purpose}</small> : null}
              </span>
              <span className="text-xs text-muted-foreground">{item.status === 'pending' ? '待处理' : '已处理'} · {item.notificationAccountId === null ? '待接手' : item.notificationAccountId ? '定向通知' : '历史范围'}</span>
            </li>)}
          </ul>
        ) : <EmptyBlock title="暂无 Key 通知" description="后续授权申请会按当前归属出现在这里。" />}
        {routing && !personal ? <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">通知归属</h3>
            <select aria-label="筛选 Key 通知归属" className={`${accountInputClass} w-auto`}
              value={filter} onChange={event => setFilter(event.target.value)}>
              <option value="all">全部 Key</option>
              {Object.entries(keyLabels).map(([state, label]) => <option key={state} value={state}>{label}</option>)}
            </select>
          </div>
          {keys?.length ? <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {keys.map(key => (
              <li key={JSON.stringify(key.ref)} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="break-all font-medium">{key.label}{key.projectName ? ` · ${key.projectName}` : ''}</p>
                  <p className="break-all text-xs text-muted-foreground">{keyLabels[key.state]}{key.recipientName ? ` · ${key.recipientName}` : ''}</p>
                  {key.handoff ? <p className="mt-1 break-words text-xs text-muted-foreground">最近交接 · {key.handoff.reason}</p> : null}
                </div>
                {owner && (key.state === 'handoff' || key.state === 'assigned') ? (
                  <Button variant="outline" onClick={() => setSelected(key)}>交接通知</Button>
                ) : null}
              </li>
            ))}
          </ul> : <EmptyBlock title="没有匹配的 Key" description="可以切回全部 Key 查看现有归属。" />}
        </div> : null}
      </>}
      {selected && routing ? (
        <HandoffDialog subject={selected} accounts={routing.accounts}
          onClose={() => setSelected(null)} onSaved={() => { setSelected(null); refresh(); }} />
      ) : null}
    </Section>
  );
}

function HandoffDialog({ subject, accounts, onClose, onSaved }: {
  subject: KeyRecipient;
  accounts: Ownership['accounts'];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [recipientAccountId, setRecipient] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiRequest('/api/auth/key-notification-owners/assign', {
        method: 'POST', body: { ref: subject.ref, recipientAccountId, reason, expectedRecipientAccountId: subject.recipientAccountId ?? null },
      });
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>交接 Key 通知</DialogTitle>
          <DialogDescription className="break-all">{subject.label} · 此操作更新收件账号，现有 Key 的项目权限保持当前授权。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="接手账号"><select aria-label="接手账号" required className={accountInputClass} value={recipientAccountId} disabled={busy}
            onChange={event => setRecipient(event.target.value)}>
            <option value="">选择可用管理者</option>
            {accounts.filter(account => account.id !== subject.recipientAccountId).map(account => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select></Field>
          <Field label="交接原因"><textarea aria-label="交接原因" required minLength={3} maxLength={500} rows={3}
            className={accountInputClass} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} /></Field>
          {error ? <ErrorBlock message={error} /> : null}
          <Button type="submit" className="justify-self-start" disabled={busy}>{busy ? '正在交接' : '确认交接'}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
