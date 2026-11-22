import { type FormEvent, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api';
import { actionStateLabels, type AccountActionEntry } from '../accountAccess';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import { AccountActionFacts, accountInputClass } from './AccountActionDialog';

const path = '/api/auth/recovery-requests';

export function RecoveryRequestsPanel({ owner, viewerId, selectionId, onSelect }: {
  owner: boolean;
  viewerId: string;
  selectionId?: string;
  onSelect: (id?: string) => void;
}): JSX.Element {
  const [records, setRecords] = useState<AccountActionEntry[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const current = records?.find(record => record.id === selectionId);

  useEffect(() => {
    const ctrl = new AbortController();
    setError('');
    apiRequest<{ requests: AccountActionEntry[] }>(path, { signal: ctrl.signal })
      .then(data => { if (!ctrl.signal.aborted) setRecords(data.requests); })
      .catch(error => { if (!ctrl.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => ctrl.abort();
  }, [attempt]);

  return (
    <Section title="身份恢复" description="先核实身份并登记依据，再由另一位系统所有者批准一次性恢复链接。"
      actions={<Button variant="outline" onClick={() => setAttempt(value => value + 1)}>刷新申请</Button>}>
      {error ? <ErrorBlock message={error} /> : !records ? <LoadingBlock label="读取恢复申请" /> : !records.length ? (
        <EmptyBlock title="暂无身份恢复申请" description="成员可以从登录页的「申请身份恢复」提交说明。" />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {records.map(record => <li key={record.id}>
            <button className="flex w-full flex-wrap justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-muted/50"
              onClick={() => onSelect(record.id)} type="button">
              <strong className="break-all">{record.targetName}</strong>
              <span className="text-muted-foreground">{actionStateLabels[record.status]} · {new Date(record.createdAt).toLocaleDateString()}</span>
            </button>
          </li>)}
        </ul>
      )}
      {current ? (
        <RecoveryRequestDialog key={current.id} request={current} viewerId={viewerId} owner={owner}
          onClose={() => onSelect()}
          onChanged={entry => setRecords(rows => rows?.map(row => row.id === entry.id ? entry : row) ?? null)} />
      ) : selectionId && records && !error ? <p className="mt-3 text-sm text-muted-foreground">当前管理范围内没有这条申请。</p> : null}
    </Section>
  );
}

function RecoveryRequestDialog({ request, viewerId, owner, onClose, onChanged }: {
  request: AccountActionEntry;
  viewerId: string;
  owner: boolean;
  onClose: () => void;
  onChanged: (entry: AccountActionEntry) => void;
}): JSX.Element {
  const [evidence, setEvidence] = useState('');
  const [targetName, setTargetName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const verifying = request.status === 'pending';
  const approving = request.status === 'verified' && owner && request.verification?.byAccountId !== viewerId;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!verifying && !approving) return;
    setError('');
    setBusy(true);
    try {
      const result = await apiRequest<{ request: AccountActionEntry; invitation?: { path: string; expiresAt: string } }>(
        `${path}/${encodeURIComponent(request.id)}/${verifying ? 'verify' : 'approve'}`,
        { method: 'POST', body: verifying ? { evidence } : { targetName } },
      );
      if (result.invitation) setIssued({ url: new URL(result.invitation.path, window.location.origin).href, expiresAt: result.invitation.expiresAt });
      onChanged(result.request);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-auto">
        <DialogHeader><DialogTitle>身份恢复申请</DialogTitle>
          <DialogDescription>{actionStateLabels[request.status]} · {request.targetName}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <AccountActionFacts entry={request} />
          {request.verification ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            已由 {request.verification.by} 核实 · {request.verification.evidence}
          </p> : null}
          {verifying ? <Field label="身份核实依据"><textarea aria-label="身份核实依据" className={accountInputClass}
            required minLength={3} maxLength={500} value={evidence} onChange={event => setEvidence(event.target.value)} disabled={busy} rows={3} /></Field> : null}
          {approving ? <Field preserveCase label={`输入 ${request.targetName} 确认签发`}><input aria-label="确认目标账号" className={accountInputClass} required
            value={targetName} onChange={event => setTargetName(event.target.value)} disabled={busy} autoComplete="off" /></Field> : null}
          {request.status === 'verified' && !approving ? <p className="text-sm text-muted-foreground">等待另一位系统所有者批准。</p> : null}
          {verifying || approving ? <Button type="submit" className="justify-self-start" variant={approving ? 'destructive' : 'default'}
            disabled={busy || (approving && targetName !== request.targetName)}>
            {busy ? '正在保存' : verifying ? '登记核实' : '批准并签发一次性链接'}
          </Button> : null}
          {issued ? <div className="space-y-2">
            <Field label="一次性恢复链接"><input aria-label="一次性恢复链接" className={accountInputClass} readOnly value={issued.url}
              onFocus={event => event.target.select()} /></Field>
            <p className="text-sm text-muted-foreground">仅交给已核实的本人。有效至 {new Date(issued.expiresAt).toLocaleString()}。</p>
            <Button type="button" variant="outline" onClick={() => {
              void navigator.clipboard.writeText(issued.url).then(() => setCopied(true)).catch(() => setError('请选中链接并手动复制'));
            }}>{copied ? '已复制' : '复制恢复链接'}</Button>
          </div> : null}
          {error ? <ErrorBlock message={error} /> : null}
          <p className="break-all text-xs text-muted-foreground">申请编号 <span className="font-mono">{request.id}</span></p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
