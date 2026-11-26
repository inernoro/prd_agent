import { type FormEvent, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { actionLabels, actionStateLabels, listAccountActionAudit, type AccountActionEntry } from '../accountAccess';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import { AccountActionFacts, accountInputClass } from './AccountActionDialog';

export function AccountAuditDialog({ receiptId, entry, onClose }: {
  receiptId?: string; entry?: AccountActionEntry; onClose: () => void;
}): JSX.Element {
  const [record, setRecord] = useState<AccountActionEntry | null | undefined>(entry);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!receiptId) return;
    const ctrl = new AbortController();
    setFailed(false);
    setRecord(undefined);
    listAccountActionAudit(new URLSearchParams({ receiptId }), ctrl.signal)
      .then(rows => { if (!ctrl.signal.aborted) setRecord(rows.find(row => row.id === receiptId) ?? null); })
      .catch(() => { if (!ctrl.signal.aborted) setFailed(true); });
    return () => ctrl.abort();
  }, [attempt, receiptId]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] overflow-auto">
      <DialogHeader>
        <DialogTitle>{record ? actionLabels[record.action] : '账号审计回执'}</DialogTitle>
        <DialogDescription>{record ? `${actionStateLabels[record.status]} · ${new Date(record.decidedAt || record.createdAt).toLocaleString()}`
          : '查阅这次账号变更的处理记录。'}</DialogDescription>
      </DialogHeader>
      {record ? <>
        <AccountActionFacts entry={record} />
        <p className="break-all text-xs text-muted-foreground">回执 <span className="font-mono">{record.id}</span></p>
      </> : failed ? <div className="space-y-2">
        <ErrorBlock message="审计回执读取失败。" />
        <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>重新读取</Button>
      </div> : record === null ? <p className="text-sm text-muted-foreground">没有可查看的审计回执。</p>
      : <LoadingBlock label="读取审计回执" />}
    </DialogContent>
  </Dialog>;
}

export function AccountAudit({ canViewAll, canFilterAccounts = false }: { canViewAll: boolean; canFilterAccounts?: boolean }): JSX.Element {
  const [account, setAccount] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState(new URLSearchParams());
  const [rows, setRows] = useState<AccountActionEntry[] | null>(null);
  const [error, setError] = useState('');
  const [requestId, setRequestId] = useState<string>();
  const [selected, setSelected] = useState<AccountActionEntry | null>(null);
  const [backfillOpen, setBackfillOpen] = useState(false);

  function applyFilter(event: FormEvent): void {
    event.preventDefault();
    const query = new URLSearchParams();
    if (account.trim() && (canViewAll || canFilterAccounts)) query.set('targetId', account.trim());
    if (action) query.set('action', action);
    if (status) query.set('status', status);
    if (from) query.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (until) query.set('until', new Date(`${until}T23:59:59.999`).toISOString());
    setFilter(query);
  }

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setRequestId(undefined);
    setRows(null);
    listAccountActionAudit(filter, controller.signal)
      .then(result => { if (!controller.signal.aborted) setRows(result); })
      .catch(error => {
        if (controller.signal.aborted) return;
        const id = error instanceof ApiError ? error.requestId : undefined;
        const details = error instanceof Error ? error.message : String(error);
        setError(id ? details.replace(` · requestId=${id}`, '') : details);
        setRequestId(id);
      });
    return () => controller.abort();
  }, [filter]);

  return (
    <Section title="账号审计" description="查阅申请、逐次确认和执行回执。"
      actions={canViewAll ? <Button variant="outline" onClick={() => setBackfillOpen(true)}>补录历史事件</Button> : undefined}>
      <form onSubmit={applyFilter} className="mb-4 flex flex-wrap items-end gap-3">
        {(canViewAll || canFilterAccounts) ? <Field label="账号编号">
          <input aria-label="账号编号" className={accountInputClass} value={account} onChange={event => setAccount(event.target.value)} />
        </Field> : null}
        <Field label="操作">
          <select aria-label="操作" value={action} className={accountInputClass} onChange={event => setAction(event.target.value)}>
            <option value="">全部操作</option>
            {Object.entries(actionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </Field>
        <Field label="结果">
          <select aria-label="结果" value={status} className={accountInputClass} onChange={event => setStatus(event.target.value)}>
            <option value="">全部结果</option>
            {Object.entries(actionStateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </Field>
        <Field label="起始日期">
          <input aria-label="起始日期" type="date" className={accountInputClass} value={from} onChange={event => setFrom(event.target.value)} />
        </Field>
        <Field label="结束日期">
          <input aria-label="结束日期" type="date" className={accountInputClass} value={until} onChange={event => setUntil(event.target.value)} />
        </Field>
        <Button type="submit">查询</Button>
      </form>
      {error ? <div className="space-y-2">
        <ErrorBlock message="账号审计读取失败。读取失败时无法判断是否有操作记录。" />
        <p className="break-all text-xs text-muted-foreground">{error}</p>
        {requestId ? <p className="break-all text-xs text-muted-foreground">请求编号 <span className="font-mono">{requestId}</span></p> : null}
        <Button variant="outline" onClick={() => setFilter(value => new URLSearchParams(value))}>重新读取</Button>
      </div> : !rows ? <LoadingBlock label="读取账号审计" /> : !rows.length ? (
        <EmptyBlock title="没有符合条件的记录" description="可调整日期或操作筛选，再查询一次。" />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {rows.map(row => (
            <li key={row.id}>
              <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left text-sm hover:bg-muted/50"
                onClick={() => setSelected(row)}>
                <span className="min-w-0 break-all"><strong>{actionLabels[row.action]}</strong> · {row.targetName}</span>
                <span className="text-xs text-muted-foreground">{row.backfill ? '事后补录' : actionStateLabels[row.status]} · {new Date(row.backfill?.occurredAt || row.decidedAt || row.createdAt).toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected ? <AccountAuditDialog key={selected.id} entry={selected} onClose={() => setSelected(null)} /> : null}
      {backfillOpen ? <AuditBackfillDialog onClose={() => setBackfillOpen(false)} onSaved={entry => {
        setBackfillOpen(false);
        setSelected(entry);
        setFilter(value => new URLSearchParams(value));
      }} /> : null}
    </Section>
  );
}

function AuditBackfillDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (entry: AccountActionEntry) => void }): JSX.Element {
  const [targetId, setTarget] = useState('');
  const [occurredAt, setTime] = useState('');
  const [description, setDescription] = useState('');
  const [evidence, setEvidence] = useState('');
  const [priorApproval, setApproval] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<{ request: AccountActionEntry }>('/api/auth/account-action-audit/backfill', {
        method: 'POST', body: { targetId: targetId.trim(), occurredAt: new Date(occurredAt).toISOString(), description, evidence, priorApproval },
      });
      onSaved(result.request);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-auto">
        <DialogHeader><DialogTitle>补录历史账号事件</DialogTitle>
          <DialogDescription>保留历史经过、审批情况和证据。补录只新增审计记录。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={submit}>
          <Field label="涉及账号编号"><input aria-label="涉及账号编号" className={accountInputClass} value={targetId}
            required disabled={busy} onChange={event => setTarget(event.target.value)} /></Field>
          <Field label="实际发生时间"><input aria-label="实际发生时间" className={accountInputClass} type="datetime-local" value={occurredAt}
            required disabled={busy} onChange={event => setTime(event.target.value)} /></Field>
          <Field label="经过"><textarea aria-label="经过" className={accountInputClass} value={description} required minLength={3} maxLength={500}
            disabled={busy} onChange={event => setDescription(event.target.value)} rows={3} /></Field>
          <Field label="证据链接或回执"><input aria-label="证据链接或回执" className={accountInputClass} value={evidence}
            required minLength={3} maxLength={500} disabled={busy} onChange={event => setEvidence(event.target.value)} /></Field>
          <Field label="原审批情况"><select aria-label="原审批情况" className={accountInputClass} value={priorApproval} required
            disabled={busy} onChange={event => setApproval(event.target.value)}>
            <option value="">请选择审批情况</option><option value="missing">原审批缺失</option><option value="verified">已有审批证据</option>
          </select></Field>
          {error ? <ErrorBlock message={error} /> : null}
          <Button className="justify-self-start" type="submit" disabled={busy}>{busy ? '正在补录' : '保存补录'}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
