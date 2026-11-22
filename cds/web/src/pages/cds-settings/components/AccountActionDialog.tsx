import { type FormEvent, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest, ApiError, type CdsPublicUser } from '@/lib/api';
import { ErrorBlock, Field, Section } from '../components';
import { actionLabels, actionStateLabels, decideAccountAction, requestAccountAction, type AccountAction, type AccountActionEntry } from '../accountAccess';

export const accountInputClass = 'w-full min-h-[3.25rem] rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-9 lg:text-sm';

type ActionSubject = { user: CdsPublicUser; action: AccountAction } | { entry: AccountActionEntry };

export function AccountActionFacts({ entry }: { entry: AccountActionEntry }): JSX.Element {
  return (
    <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-border bg-muted/30 p-4 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">目标账号</dt><dd className="break-all font-medium">{entry.targetName}</dd></div>
      <div><dt className="text-muted-foreground">影响会话</dt><dd>{entry.backfill ? '依原始证据' : entry.scope === 'all-system-sessions'
        ? `全部系统账号会话，已登记 ${entry.affectedSessions} 个` : `${entry.affectedSessions} 个`}</dd></div>
      {entry.requestedBy ? <div><dt className="text-muted-foreground">发起人</dt><dd>{entry.requestedBy}</dd></div> : null}
      {entry.approvedBy ? <div><dt className="text-muted-foreground">批准人</dt><dd>{entry.approvedBy}{entry.requestedBy === entry.approvedBy ? ' · 本人确认' : ''}</dd></div> : null}
      {entry.executedByAccountId && entry.approvedBy ? <div><dt className="text-muted-foreground">执行人</dt><dd>{entry.approvedBy}</dd></div> : null}
      {entry.backfill ? <div className="sm:col-span-2"><dt className="text-muted-foreground">
        事后补录 · {entry.backfill.priorApproval === 'missing' ? '原审批缺失' : '已有审批证据'}
      </dt><dd className="mt-1 break-words">{new Date(entry.backfill.occurredAt).toLocaleString()} · {entry.backfill.evidence}</dd></div> : null}
      {entry.expiresAt && entry.status === 'pending' ? <div><dt className="text-muted-foreground">确认截止</dt><dd>{new Date(entry.expiresAt).toLocaleString()}</dd></div> : null}
      {entry.reason ? <div className="sm:col-span-2"><dt className="text-muted-foreground">变更原因</dt><dd className="whitespace-pre-wrap break-words">{entry.reason}</dd></div> : null}
      {entry.decisionReason ? <div className="sm:col-span-2"><dt className="text-muted-foreground">处理说明</dt><dd className="whitespace-pre-wrap break-words">{entry.decisionReason}</dd></div> : null}
    </dl>
  );
}

export function AccountActionDialog({
  subject, owner, viewerId, inline = false, onClose, onChange,
}: {
  subject: ActionSubject;
  owner: boolean;
  viewerId: string;
  inline?: boolean;
  onClose: () => void;
  onChange: (entry: AccountActionEntry) => void;
}): JSX.Element {
  const [entry, setEntry] = useState<AccountActionEntry | null>('entry' in subject ? subject.entry : null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [decisionReason, setDecisionReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [impact, setImpact] = useState<number | null>(null);
  const [impactError, setImpactError] = useState('');
  const [impactAttempt, setImpactAttempt] = useState(0);

  const action = 'action' in subject ? subject.action : subject.entry.action;
  const targetName = 'user' in subject ? (subject.user.username || subject.user.githubLogin) : subject.entry.targetName;
  const canConfirm = owner && entry?.status === 'pending';
  const targetId = 'user' in subject ? subject.user.id : undefined;

  useEffect(() => {
    if (!targetId || entry) return;
    const ctrl = new AbortController();
    setImpactError('');
    apiRequest<{ affectedSessions: number }>(`/api/auth/users/${encodeURIComponent(targetId)}/impact`, { signal: ctrl.signal })
      .then(result => { if (!ctrl.signal.aborted) setImpact(result.affectedSessions); })
      .catch(() => { if (!ctrl.signal.aborted) setImpactError('暂时无法读取当前会话'); });
    return () => ctrl.abort();
  }, [targetId, entry, impactAttempt]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!entry && 'user' in subject) {
        const next = await requestAccountAction(action, subject.user.id, reason);
        setEntry(next);
        onChange(next);
      } else if (canConfirm && entry) {
        const next = await decideAccountAction(entry.id, rejecting ? 'reject' : 'confirm', rejecting
          ? { reason: decisionReason }
          : { targetName: typed, ...(action === 'reset-password' ? { newPassword } : {}) });
        setNewPassword('');
        setEntry(next);
        onChange(next);
      }
    } catch (error) {
      setNewPassword('');
      setError(error instanceof ApiError && error.status === 409
        ? `${error.message}。可在待批申请中核对原回执。`
        : error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(): Promise<void> {
    if (!entry) return;
    setBusy(true);
    setError('');
    try {
      const next = await decideAccountAction(entry.id, 'cancel', {});
      setEntry(next);
      onChange(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  const subtitle = canConfirm ? '第 2 步 · 核对影响，确认后立即执行'
    : entry ? actionStateLabels[entry.status] : '第 1 步 · 说明本次变更';
  const form = (
        <form onSubmit={submit} className="space-y-4">
          {entry ? <AccountActionFacts entry={entry} /> : (
            <>
              <p className="break-words text-sm">目标账号 <strong>{targetName}</strong></p>
              <p className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                {impactError ? impactError : impact === null ? '正在读取受影响会话' : `本次操作涉及 1 个账号，预计结束 ${impact} 个会话。`}
                {impactError ? <Button className="ml-2" variant="outline" type="button" onClick={() => setImpactAttempt(value => value + 1)}>重新读取</Button> : null}
              </p>
              <Field label="变更原因">
                <textarea aria-label="变更原因" className={accountInputClass} required minLength={3} maxLength={500}
                  value={reason} disabled={busy} onChange={event => setReason(event.target.value)} rows={3} />
              </Field>
            </>
          )}
          {canConfirm ? rejecting ? (
            <Field label="退回原因">
              <textarea aria-label="退回原因" className={accountInputClass} required maxLength={500} value={decisionReason}
                disabled={busy} onChange={event => setDecisionReason(event.target.value)} rows={3} />
            </Field>
          ) : (
            <>
              <Field label={`输入 ${targetName} 确认目标`}>
                <input aria-label="确认目标账号" className={accountInputClass} autoComplete="off"
                  required value={typed} disabled={busy} onChange={event => setTyped(event.target.value)} />
              </Field>
              {action === 'reset-password' ? (
                <Field label="新口令（至少 8 位）">
                  <input aria-label="新口令" className={accountInputClass} type="password" autoComplete="new-password"
                    required minLength={8} maxLength={512} value={newPassword} disabled={busy} onChange={event => setNewPassword(event.target.value)} />
                </Field>
              ) : null}
            </>
          ) : null}
          {entry ? (
            <p className="break-all text-xs text-muted-foreground">申请回执 <span className="font-mono">{entry.id}</span></p>
          ) : null}
          {error ? <ErrorBlock message={error} /> : null}
          <div className="flex flex-wrap gap-2">
            {!entry || canConfirm ? (
              <Button type="submit" variant={canConfirm && !rejecting ? 'destructive' : 'default'}
                disabled={busy || (!entry && impact === null) || (canConfirm && !rejecting && typed !== targetName)}>
                {busy ? '正在保存' : !entry ? owner ? '下一步' : '提交申请' : rejecting ? '退回申请' : '确认并执行'}
              </Button>
            ) : null}
            {canConfirm ? <Button type="button" variant="outline" disabled={busy}
              onClick={() => { setRejecting(value => !value); setNewPassword(''); setError(''); }}>
              {rejecting ? '返回确认' : '退回'}
            </Button> : null}
            {entry?.status === 'pending' && entry.requestedByAccountId === viewerId && !rejecting ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void withdraw()}>撤回申请</Button>
            ) : null}
            {entry && !canConfirm ? <Button type="button" variant="outline" disabled={busy} onClick={onClose}>关闭</Button> : null}
          </div>
        </form>
  );

  if (inline) {
    return (
      <Section title="申请详情" description={`${actionLabels[action]} · ${subtitle}`}
        actions={<Button variant="outline" onClick={onClose}>返回申请</Button>}>
        <div className="max-w-3xl">{form}</div>
      </Section>
    );
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldAlert className="size-4 shrink-0 text-warn" />{actionLabels[action]}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
