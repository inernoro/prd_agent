/*
 * DbLedgerSection — 数据台账（数据库隔离收敛 3）。
 *
 * 一本账回答四个问题：这个项目派生出过哪些库（分支独立库 / 隔离库 / 扫描补录的来源未知库）、
 * 每条从谁来、现在在哪（活跃 / 孤儿 / 已丢弃）、备份在哪并且演练过没有。
 * 三个动作：备份、演练验证、丢弃（门禁：演练验证过的备份，或复述库名强制）。
 *
 * 数据源：GET /api/projects/:id/db-ledger；动作：POST …/backup、POST …/backups/:id/verify、
 * DELETE …/:entryId、POST …/scan。所有判定在后端，这里只把它们摆清楚、把门禁说清楚。
 */
import { useCallback, useEffect, useState } from 'react';
import { Archive, Loader2, RefreshCw, ScanSearch, ShieldCheck, Trash2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';

export interface DbLedgerBackup { id: string; file: string; bytes: number; sha256: string; createdAt: string; objects?: number; verifiedAt?: string; verifyDetail?: string }
export interface DbLedgerEntry {
  id: string; projectId: string; kind: 'per-branch' | 'isolated' | 'unknown'; engine: 'mongo' | 'mysql' | 'postgres'; dbName: string;
  infraId?: string; infraContainer: string; sourceDb?: string; branchId?: string; branch?: string; profileId?: string; memberId?: string;
  snapshotId?: string; dedicatedContainer?: string; origin: 'cds' | 'scan'; status: 'active' | 'orphaned' | 'dropped';
  createdAt: string; updatedAt: string; orphanedAt?: string; droppedAt?: string; droppedBy?: string; droppedForced?: boolean;
  backups: DbLedgerBackup[]; lastObjects?: { count: number; measuredAt: string }; note?: string;
  /** 时间点克隆初始化（收敛 4）：从哪个库、什么时候、逐表行数校验结果 */
  clone?: DbLedgerClone;
  /** 视图字段：按当前配置折算的初始化方式（分支独立库才有） */
  initMode?: 'empty' | 'clone';
}
export interface DbCloneVerification {
  ok: boolean; measuredAt: string;
  tables: Array<{ table: string; source: number; target: number }>;
  mismatched: string[]; sourceOnly: string[]; targetOnly: string[];
}
export interface DbLedgerClone { sourceDb: string; clonedAt: string; verification: DbCloneVerification }

/** 校验结果一句话（与后端 describeCloneVerification 同口径，前端不再自己算） */
export function describeCloneVerification(v: DbCloneVerification): string {
  if (v.ok) return `逐表校验 ${v.tables.length} 张表行数一致`;
  const parts: string[] = [];
  if (v.mismatched.length) parts.push(`${v.mismatched.length} 张表行数不一致：${v.mismatched.map((t) => { const row = v.tables.find((x) => x.table === t); return row ? `${t}（源 ${row.source} / 目标 ${row.target}）` : t; }).join('、')}`);
  if (v.sourceOnly.length) parts.push(`只在源库：${v.sourceOnly.join('、')}`);
  if (v.targetOnly.length) parts.push(`只在目标库：${v.targetOnly.join('、')}`);
  return `逐表校验不一致——${parts.join('；')}`;
}
export interface DbLedgerView {
  projectId: string; generatedAt: string; entries: DbLedgerEntry[];
  tree: Array<{ sourceDb: string | null; children: DbLedgerEntry[] }>;
  summary: { total: number; active: number; orphaned: number; dropped: number; unknown: number; withVerifiedBackup: number; withoutBackup: number };
}

export const KIND_LABEL = { 'per-branch': '分支独立库', isolated: '隔离库', unknown: '来源未知' } as const;
export const STATUS_META = {
  active: { label: '活跃', cls: 'border-ok/40 bg-ok-soft text-ok' },
  orphaned: { label: '孤儿（分支已删）', cls: 'border-warn/40 bg-warn-soft text-warn' },
  dropped: { label: '已丢弃', cls: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
} as const;

/** 第一屏那句判断 */
export function dbLedgerHeadline(view: Pick<DbLedgerView, 'summary'>): string {
  const s = view.summary;
  const live = s.total - s.dropped;
  if (live === 0) return '这个项目没有派生库（分支独立库 / 隔离库），也没有扫描出来源未知的存量库。';
  const parts: string[] = [];
  if (s.orphaned > 0) parts.push(`${s.orphaned} 个孤儿库（分支已删、数据还在）`);
  if (s.unknown > 0) parts.push(`${s.unknown} 个来源未知`);
  const lead = `${live} 个派生库，${s.withVerifiedBackup} 个有演练验证过的备份`;
  const tail = s.withoutBackup > 0 ? `；${s.withoutBackup} 个没有任何备份，现在丢弃会拒绝` : '';
  return `${lead}${parts.length ? `（${parts.join('，')}）` : ''}${tail}。`;
}

export function hasVerifiedBackup(e: Pick<DbLedgerEntry, 'backups'>): boolean {
  return e.backups.some((b) => !!b.verifiedAt);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function EntryRow({ e, busy, onBackup, onVerify, onDrop, onClone }: {
  e: DbLedgerEntry; busy: string | null;
  onBackup?: (e: DbLedgerEntry) => void; onVerify?: (e: DbLedgerEntry, b: DbLedgerBackup) => void; onDrop?: (e: DbLedgerEntry) => void;
  onClone?: (e: DbLedgerEntry) => void;
}): JSX.Element {
  const clonePending = e.kind === 'per-branch' && e.status === 'active' && e.initMode === 'clone' && !e.clone && !!e.branchId && !!e.profileId;
  const latest = [...e.backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const verified = hasVerifiedBackup(e);
  const droppable = e.status !== 'dropped' && !(e.status === 'active' && e.branchId);
  return (
    <li className="rounded-md border border-[hsl(var(--hairline))] bg-card px-3 py-2" data-db-ledger-entry={e.dbName} data-db-ledger-status={e.status}>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="min-w-0 sm:flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{e.dbName}</span>
            <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[11px] text-muted-foreground">{KIND_LABEL[e.kind]} · {e.engine}</span>
            <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_META[e.status].cls}`}>{STATUS_META[e.status].label}</span>
            {e.origin === 'scan' ? <span className="rounded border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">扫描补录</span> : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {e.branch ? <span className="mr-2">分支 <span className="font-mono">{e.branch}</span></span> : null}
            {e.profileId ? <span className="mr-2">服务 <span className="font-mono">{e.profileId}</span></span> : null}
            <span className="mr-2">{e.kind === 'isolated' ? '克隆于' : '记于'} {new Date(e.createdAt).toLocaleString('zh-CN')}</span>
            {e.lastObjects ? <span className="mr-2">{e.lastObjects.count} 个表/集合</span> : null}
            {e.clone ? (
              <span className={`mr-2 ${e.clone.verification.ok ? 'text-ok' : 'text-warn'}`} data-db-ledger-clone={e.clone.verification.ok ? 'ok' : 'mismatch'}
                title={e.clone.verification.ok ? '克隆是时间点快照，之后源库的写入不会同步' : '克隆是时间点快照：不一致通常是克隆之后源库又有写入；表名与两边行数已列出'}>
                时间点克隆自 <span className="font-mono">{e.clone.sourceDb}</span>（{new Date(e.clone.clonedAt).toLocaleString('zh-CN')}），{describeCloneVerification(e.clone.verification)}
              </span>
            ) : clonePending ? (
              <span className="mr-2" data-db-ledger-clone="pending">初始化方式：时间点克隆（首次部署前从 <span className="font-mono">{e.sourceDb}</span> 克隆；库已在实例上则跳过、不覆盖）</span>
            ) : null}
            {e.droppedAt ? <span className="mr-2">已于 {new Date(e.droppedAt).toLocaleString('zh-CN')} 丢弃{e.droppedForced ? '（强制，未备份）' : ''}</span> : null}
            {e.note ? <span className="mr-2">{e.note}</span> : null}
          </div>
          <div className="mt-1 text-xs">
            {e.backups.length === 0 ? (
              <span className="text-warn">没有备份</span>
            ) : (
              <span className={verified ? 'text-ok' : 'text-warn'}>
                {e.backups.length} 份备份，最近 {new Date(latest.createdAt).toLocaleString('zh-CN')}（{fmtBytes(latest.bytes)}）
                {verified ? '，已演练验证' : '，从没演练还原过，不算备份'}
              </span>
            )}
          </div>
        </div>
        {e.status !== 'dropped' ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {onBackup ? (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onBackup(e)} title="导出这个库到 CDS 宿主的备份目录">
                {busy === `backup:${e.id}` ? <Loader2 className="animate-spin" /> : <Archive />} 备份
              </Button>
            ) : null}
            {onVerify && latest && !latest.verifiedAt ? (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onVerify(e, latest)} title="把最近一份备份还原到临时库并核对对象数；通过后这份备份才算数">
                {busy === `verify:${e.id}` ? <Loader2 className="animate-spin" /> : <ShieldCheck />} 演练验证
              </Button>
            ) : null}
            {onClone && clonePending ? (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => onClone(e)} title="现在就从共享库时间点克隆到这个独立库（目标库已存在则不会覆盖）">
                {busy === `clone:${e.id}` ? <Loader2 className="animate-spin" /> : <Copy />} 现在克隆
              </Button>
            ) : null}
            {onDrop ? (
              <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy !== null || !droppable} onClick={() => onDrop(e)}
                title={!droppable ? '仍属于在册分支：先删除分支（默认保留库）或回切主库' : verified ? '有演练验证过的备份，可以丢弃' : '没有验证过的备份：需要复述库名强制丢弃'}>
                <Trash2 /> 丢弃
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** 血缘树（纯展示，可离线渲染测试） */
export function DbLedgerTree({ view, busy = null, onBackup, onVerify, onDrop, onClone }: {
  view: DbLedgerView; busy?: string | null;
  onBackup?: (e: DbLedgerEntry) => void; onVerify?: (e: DbLedgerEntry, b: DbLedgerBackup) => void; onDrop?: (e: DbLedgerEntry) => void;
  onClone?: (e: DbLedgerEntry) => void;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="text-sm text-foreground">{dbLedgerHeadline(view)}</div>
      {view.tree.map((node) => (
        <div key={node.sourceDb ?? '(unknown)'} data-db-ledger-root={node.sourceDb ?? ''}>
          <div className="mb-1 text-xs text-muted-foreground">
            {node.sourceDb ? <>源库 <span className="font-mono text-foreground">{node.sourceDb}</span> 派生出 {node.children.length} 个库</> : <>来源未知（扫描补录，CDS 台账里没有它们的派生记录）</>}
          </div>
          <ul className="space-y-1.5 border-l border-[hsl(var(--hairline))] pl-3">
            {node.children.map((e) => <EntryRow key={e.id} e={e} busy={busy} onBackup={onBackup} onVerify={onVerify} onDrop={onDrop} onClone={onClone} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** 丢弃确认：有验证备份 → 一键；没有 → 必须复述库名 */
export function DropConfirm({ entry, pending, onCancel, onConfirm }: { entry: DbLedgerEntry; pending: boolean; onCancel: () => void; onConfirm: (force?: string) => void }): JSX.Element {
  const [typed, setTyped] = useState('');
  const verified = hasVerifiedBackup(entry);
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" data-db-ledger-drop-confirm={entry.dbName}>
      <div className="font-medium text-destructive">丢弃 {entry.dbName}？</div>
      {verified ? (
        <div className="mt-1 text-muted-foreground">这个库有演练验证过的备份（{entry.backups.filter((b) => b.verifiedAt).length} 份），丢弃后可从备份还原。</div>
      ) : (
        <div className="mt-1 text-warn">
          {entry.backups.length === 0 ? '这个库没有任何备份。' : '这个库的备份从没演练还原过，不算备份。'}
          推荐先「备份」再「演练验证」；确实要不备份直接删，请一字不差复述库名：
          <input className="mt-2 block h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs" placeholder={entry.dbName} value={typed} onChange={(ev) => setTyped(ev.target.value)} aria-label="复述库名" />
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="destructive" disabled={pending || (!verified && typed !== entry.dbName)} onClick={() => onConfirm(verified ? undefined : typed)}>
          {pending ? <Loader2 className="animate-spin" /> : <Trash2 />} {verified ? '丢弃' : '不备份直接删'}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

export function DbLedgerSection({ projectId, onToast, reloadToken = 0 }: { projectId: string; onToast?: (m: string) => void; /** 外部改了配置（如初始化方式）后递增，让台账按新配置重算 */ reloadToken?: number }): JSX.Element {
  const [state, setState] = useState<{ status: 'idle' | 'loading' } | { status: 'ok'; view: DbLedgerView } | { status: 'error'; message: string }>({ status: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [dropping, setDropping] = useState<DbLedgerEntry | null>(null);
  const base = `/api/projects/${encodeURIComponent(projectId)}/db-ledger`;

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try { setState({ status: 'ok', view: await apiRequest<DbLedgerView>(base) }); }
    catch (err) { setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) }); }
  }, [base]);
  useEffect(() => { void load(); }, [load, reloadToken]);

  const run = async (key: string, fn: () => Promise<{ message?: string }>): Promise<boolean> => {
    setBusy(key);
    try { const r = await fn(); if (r.message) onToast?.(r.message); await load(); return true; }
    catch (err) { onToast?.(err instanceof ApiError ? err.message : String(err)); return false; }
    finally { setBusy(null); }
  };

  return (
    <section data-db-ledger-section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">派生库台账</h3>
          <p className="mt-1 text-sm text-muted-foreground">分支独立库、隔离库、备份、演练、丢弃记在同一本账里，按血缘成树。删分支默认保留派生库；丢弃之前必须有演练验证过的备份，或复述库名强制。</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run('scan', () => apiRequest<{ added: DbLedgerEntry[] }>(`${base}/scan`, { method: 'POST' }).then((r) => ({ message: r.added.length ? `扫描补录 ${r.added.length} 个来源未知的库：${r.added.map((e) => e.dbName).join(', ')}` : '扫描完成，实例上没有台账不认识的库' })))} title="列出实例上的全部库，把台账不认识的补录为来源未知">
            {busy === 'scan' ? <Loader2 className="animate-spin" /> : <ScanSearch />} 扫描补录
          </Button>
          <Button size="sm" variant="ghost" disabled={state.status === 'loading'} onClick={() => void load()} title="刷新"><RefreshCw className={state.status === 'loading' ? 'animate-spin' : ''} /></Button>
        </div>
      </div>
      <div className="mt-3">
        {state.status === 'loading' || state.status === 'idle' ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在合并台账…</div> : null}
        {state.status === 'error' ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.message}</div> : null}
        {state.status === 'ok' ? (
          <>
            {dropping ? (
              <div className="mb-3">
                <DropConfirm entry={dropping} pending={busy === `drop:${dropping.id}`} onCancel={() => setDropping(null)}
                  onConfirm={(force) => void run(`drop:${dropping.id}`, () => apiRequest<{ message: string }>(`${base}/${encodeURIComponent(dropping.id)}`, { method: 'DELETE', body: force ? { force: { confirmDbName: force } } : {} })).then((ok) => { if (ok) setDropping(null); })} />
              </div>
            ) : null}
            <DbLedgerTree
              view={state.view} busy={busy}
              onBackup={(e) => void run(`backup:${e.id}`, () => apiRequest<{ message: string }>(`${base}/${encodeURIComponent(e.id)}/backup`, { method: 'POST' }))}
              onVerify={(e, b) => void run(`verify:${e.id}`, () => apiRequest<{ message: string }>(`${base}/${encodeURIComponent(e.id)}/backups/${encodeURIComponent(b.id)}/verify`, { method: 'POST' }))}
              onDrop={(e) => setDropping(e)}
              onClone={(e) => void run(`clone:${e.id}`, () => apiRequest<{ message: string }>(`/api/branches/${encodeURIComponent(e.branchId!)}/db-init/${encodeURIComponent(e.profileId!)}`, { method: 'POST' }))}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
