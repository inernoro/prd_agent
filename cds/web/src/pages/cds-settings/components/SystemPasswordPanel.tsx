import { type FormEvent, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest, ApiError } from '@/lib/api';
import type { AccountActionEntry } from '../accountAccess';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import { AccountActionFacts, accountInputClass } from './AccountActionDialog';

interface SystemAccount {
  account: { id: string; name: string };
  available: boolean;
  sessions?: Array<{ device: string; location: string | null; createdAt: string; lastSeenAt: string }>;
}

export function SystemPasswordPanel({ owner }: { owner: boolean }): JSX.Element {
  const [current, setCurrent] = useState<SystemAccount | null>(null);
  const [error, setError] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!owner) return;
    const ctrl = new AbortController();
    setError('');
    setDisabled(false);
    apiRequest<SystemAccount>('/api/auth/system-password', { signal: ctrl.signal })
      .then(result => { if (!ctrl.signal.aborted) setCurrent(result); })
      .catch(error => {
        if (ctrl.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) setDisabled(true);
        else setError(error instanceof Error ? error.message : String(error));
      });
    return () => ctrl.abort();
  }, [owner, attempt]);

  return (
    <Section title="系统账号" description="为日常协作使用独立个人账号。系统账号用于实例维护。"
      actions={current?.available && owner ? <Button onClick={() => setOpen(true)}>变更系统口令</Button> : undefined}>
      {!owner ? <EmptyBlock title="由系统所有者管理" description="在「我的账号」管理个人登录方式。" /> : disabled ? (
        <EmptyBlock title="当前实例没有可维护的共用口令" description="个人账号在「我的账号」中管理。" />
      ) : error ? <><ErrorBlock message={error} /><Button variant="outline" className="mt-3" onClick={() => setAttempt(value => value + 1)}>重新读取</Button></>
        : !current ? <LoadingBlock label="读取系统账号" />
          : <div className="rounded-lg border border-border bg-card p-4 text-sm">
            <div className="flex items-center gap-2 font-medium"><ShieldCheck size={16} /><span className="break-all">{current.account.name}</span></div>
            <p className="mt-2 text-muted-foreground">已登记 {current.sessions?.length ?? 0} 个浏览器会话。变更口令后，所有旧系统账号会话均需重新登录。</p>
            {current.sessions?.length ? <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
              {current.sessions.map((session, index) => <li key={`${session.createdAt}-${index}`} className="flex flex-wrap justify-between gap-2 p-3">
                <p className="break-all"><strong>{session.device}</strong> · {session.location || '来源未知'} · 使用者未知</p>
                <p className="text-xs text-muted-foreground">最近活动 {new Date(session.lastSeenAt).toLocaleString()}</p>
              </li>)}
            </ul> : <p className="mt-3 text-muted-foreground">已有浏览器重新访问系统时会登记到此处。</p>}
            {!current.available ? <p className="mt-2 text-warn">当前审批存储不可用，请恢复后再提交变更。</p> : null}
          </div>}
      {open && current ? <SystemPasswordDialog accountName={current.account.name} sessions={current.sessions}
        onClose={() => setOpen(false)} /> : null}
    </Section>
  );
}

export function SystemPasswordDialog({ accountName, initial, sessions, onClose, onChange }: {
  accountName: string;
  initial?: AccountActionEntry;
  sessions?: SystemAccount['sessions'];
  onClose: () => void;
  onChange?: (entry: AccountActionEntry) => void;
}): JSX.Element {
  const [entry, setEntry] = useState<AccountActionEntry | null>(initial ?? null);
  const [reason, setReason] = useState('');
  const [targetName, setTargetName] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canSubmit = !entry || entry.status === 'pending' || (entry.status === 'failed' &&
    (entry.failureCode === 'system_password_source_busy' || entry.failureCode === 'system_password_source_mismatch'));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const url = entry ? `/api/auth/system-password/${encodeURIComponent(entry.id)}/confirm` : '/api/auth/system-password/prepare';
      const { request } = await apiRequest<{ request: AccountActionEntry }>(url, {
        method: 'POST', body: entry ? { targetName, oldPassword, newPassword, notify } : { reason },
      });
      setEntry(request);
      onChange?.(request);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOldPassword('');
      setNewPassword('');
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>变更系统账号口令</DialogTitle>
          <DialogDescription>{entry?.status === 'completed' ? '变更已保存' : entry ? '第 2 步 · 确认范围并执行' : '第 1 步 · 说明本次变更'}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={submit}>
          {entry ? <AccountActionFacts entry={entry} /> : <>
            <p className="break-words text-sm">账号 <strong>{accountName}</strong> · 结束所有旧系统会话{sessions ? ` · 已登记 ${sessions.length} 个` : ''}</p>
            <Field label="变更原因"><textarea aria-label="变更原因" className={accountInputClass} rows={3}
              required minLength={3} maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></Field>
          </>}
          {entry && canSubmit ? <>
            {sessions?.length ? <p className="text-sm text-muted-foreground">已登记设备 {sessions.map(session => session.device).join('、')}。共用账号无法识别具体人员。</p> : null}
            <Field preserveCase label={`输入 ${accountName} 确认目标`}><input aria-label="确认系统账号" className={accountInputClass}
              value={targetName} disabled={busy} onChange={event => setTargetName(event.target.value)} required autoComplete="off" /></Field>
            <Field label="目前口令"><input aria-label="目前口令" className={accountInputClass} type="password" autoComplete="current-password"
              value={oldPassword} disabled={busy} onChange={event => setOldPassword(event.target.value)} required /></Field>
            <Field label="新口令（至少 8 位）"><input aria-label="新口令" className={accountInputClass} type="password" autoComplete="new-password"
              value={newPassword} disabled={busy} onChange={event => setNewPassword(event.target.value)} required minLength={8} maxLength={512} /></Field>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={notify} required disabled={busy}
              onChange={event => setNotify(event.target.checked)} />我已告知共用账号的使用者。确认后结束所有旧会话，原因写入账号审计。</label>
          </> : null}
          {error ? <ErrorBlock message={error} /> : null}
          {entry?.status === 'completed' ? (
            <div className="space-y-2 text-sm">
              <p>旧系统会话已失效。请在新窗口用新口令登录验证。</p>
              <p className="break-all text-xs text-muted-foreground">回执 <span className="font-mono">{entry.id}</span></p>
              <Button asChild variant="outline"><a href="/login" target="_blank" rel="noopener noreferrer">打开登录页</a></Button>
            </div>
          ) : canSubmit ? (
            <Button type="submit" variant={entry ? 'destructive' : 'default'} className="justify-self-start"
              disabled={busy || Boolean(entry && (!notify || targetName !== accountName))}>
              {busy ? '正在保存' : entry ? '确认并执行' : '下一步'}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">此申请已结束。可查阅账号审计并重新发起。</p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
