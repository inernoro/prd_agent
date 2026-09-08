/*
 * BranchDbKeepList — 删分支前先展示会留下什么（数据库隔离收敛 3）。
 *
 * 数据源 GET /api/branches/:id/db-ledger。默认每条都「保留」（转台账孤儿条目，数据不丢）；
 * 勾「一并丢弃」时，没有演练验证过的备份就必须复述库名，否则后端门禁会拒绝。
 * 产出 choices 交给 DELETE /api/branches/:id 的请求体 dbs。
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiRequest, ApiError } from '@/lib/api';
import { hasVerifiedBackup, KIND_LABEL, type DbLedgerEntry } from '@/components/branch/DbLedgerSection';

export interface BranchDbChoice { entryId: string; dbName: string; action: 'keep' | 'drop'; confirmDbName?: string }

export function BranchDbKeepList({ branchId, choices, onChange }: {
  branchId: string; choices: BranchDbChoice[]; onChange: (next: BranchDbChoice[]) => void;
}): JSX.Element {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; entries: DbLedgerEntry[]; hint: string } | { status: 'error'; message: string }>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    apiRequest<{ entries: DbLedgerEntry[]; hint: string }>(`/api/branches/${encodeURIComponent(branchId)}/db-ledger`)
      .then((r) => { if (alive) { setState({ status: 'ok', entries: r.entries, hint: r.hint }); onChange(r.entries.map((e) => ({ entryId: e.id, dbName: e.dbName, action: 'keep' as const }))); } })
      .catch((err) => { if (alive) setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  if (state.status === 'loading') return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在查这条分支留下了哪些库…</div>;
  if (state.status === 'error') return <div className="text-xs text-warn">查不到派生库清单（{state.message}），删除将按默认保留处理</div>;
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-3 py-2 text-xs" data-branch-db-keep-list={state.entries.length}>
      <div className="text-muted-foreground">{state.hint}</div>
      {state.entries.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {state.entries.map((e) => {
            const c = choices.find((x) => x.entryId === e.id) ?? { entryId: e.id, dbName: e.dbName, action: 'keep' as const };
            const verified = hasVerifiedBackup(e);
            const update = (patch: Partial<BranchDbChoice>): void => {
              const exists = choices.some((x) => x.entryId === e.id);
              onChange(exists ? choices.map((x) => (x.entryId === e.id ? { ...x, ...patch } : x)) : [...choices, { ...c, ...patch }]);
            };
            return (
              <li key={e.id} className="flex flex-col gap-1 rounded border border-[hsl(var(--hairline))] px-2 py-1.5" data-branch-db-choice={e.dbName}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{e.dbName}</span>
                  <span className="text-muted-foreground">{KIND_LABEL[e.kind]} · {verified ? '有验证过的备份' : e.backups.length ? '备份未演练' : '没有备份'}</span>
                  <label className="ml-auto inline-flex items-center gap-1"><input type="radio" name={`db-${e.id}`} checked={c.action === 'keep'} onChange={() => update({ action: 'keep', confirmDbName: undefined })} />保留</label>
                  <label className="inline-flex items-center gap-1"><input type="radio" name={`db-${e.id}`} checked={c.action === 'drop'} onChange={() => update({ action: 'drop' })} />一并丢弃</label>
                </div>
                {c.action === 'drop' && !verified ? (
                  <div className="text-warn">
                    没有演练验证过的备份，丢弃需要复述库名：
                    <input className="ml-1 h-7 w-56 rounded border border-input bg-background px-2 font-mono" placeholder={e.dbName} value={c.confirmDbName ?? ''} onChange={(ev) => update({ confirmDbName: ev.target.value })} aria-label={`复述库名 ${e.dbName}`} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
