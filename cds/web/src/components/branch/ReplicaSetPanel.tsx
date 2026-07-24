/*
 * ReplicaSetPanel — 复制集流量舞台（草稿-保存执行模型，2026-07-24 用户拍板）。
 *
 *   - 舞台是唯一视图（行式页签已删除）：Railway 风拓扑，入口 → 实例层 → 数据层。
 *   - 所有变更操作（加副本/下线/权重/复制隔离/回切/关闭复制集）先进「变更清单」
 *     草稿，点「保存执行」才提交后端执行计划，串行执行；执行中可调序/跳过/取消。
 *   - 失败红显具体原因；失败策略可选「仅停止 / 停止并回滚」；执行记录持久可查。
 *   - 分流实测是只读诊断，保持即时执行（不进草稿）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, ExternalLink, Layers, Loader2, Lock, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { apiRequest, ApiError } from '@/lib/api';

export interface ReplicaMemberView {
  id: string;
  versionId: string;
  label?: string;
  weight: number;
  image: string;
  commitSha?: string;
  containerName?: string;
  hostPort?: number;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  statusMessage?: string;
  dbMode: 'shared' | 'isolated';
  isolatedDbName?: string;
  createdAt: string;
  reachable?: boolean;
}

export interface ReplicaDbSnapshotView {
  id: string;
  profileId: string;
  memberId: string;
  engine: 'mongo' | 'mysql' | 'postgres';
  sourceDb: string;
  dbName: string;
  dedicatedContainer?: string;
  clonedAt: string;
}

export interface ProfileReplicaSetView {
  profileId: string;
  enabled: boolean;
  primaryWeight: number;
  members: ReplicaMemberView[];
  isolated?: { dbName: string; snapshotId: string; isolatedAt: string };
  primaryReachable?: boolean;
  updatedAt: string;
}

interface ReplicaCandidateView { versionId: string; commitSha: string; image: string; createdAt: string; isCurrent: boolean }
interface ReplicaSetsResponse {
  replicaSets: Record<string, ProfileReplicaSetView>;
  candidates: Record<string, ReplicaCandidateView[]>;
  snapshots?: ReplicaDbSnapshotView[];
  memberLimit: number;
}

type PlanStepKind = 'add-replica' | 'remove-member' | 'set-weight' | 'isolate-db' | 'revert-db' | 'dissolve';
interface PlanStep {
  id: string; kind: PlanStepKind; profileId: string;
  params?: { memberId?: string; versionId?: string; weight?: number; dbMode?: 'shared' | 'isolated' };
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled' | 'rolled-back';
  error?: string; startedAt?: string; endedAt?: string;
}
interface Plan { id: string; status: 'running' | 'done' | 'error' | 'cancelled' | 'rolled-back'; onFailure: 'stop' | 'rollback'; steps: PlanStep[]; rollbackLog?: string[]; createdAt: string; endedAt?: string }
interface DraftOp { key: string; kind: PlanStepKind; profileId: string; params?: PlanStep['params']; label: string }

interface ProbeHit { seq: number; servedBy: string; status: number }
interface ProbeResult { tally: Record<string, number>; hits: ProbeHit[]; count: number; path: string }

export interface PanelServiceInfo { hostPort?: number; status?: string }
export interface PanelInfraInfo { id: string; name?: string; dockerImage?: string; status?: string }

export function memberDirectUrl(previewUrl: string | undefined, memberId: string): string | null {
  if (!previewUrl) return null;
  try {
    const url = new URL(previewUrl);
    const [first, ...rest] = url.hostname.split('.');
    if (!first || rest.length === 0) return null;
    url.hostname = [`${first}-${memberId}`, ...rest].join('.');
    return url.toString();
  } catch { return null; }
}

const MEMBER_COLORS = ['#6366f1', '#0ea5e9', '#14b8a6'];
const KIND_LABEL: Record<PlanStepKind, string> = {
  'add-replica': '新增副本', 'remove-member': '下线副本', 'set-weight': '调整权重',
  'isolate-db': '复制隔离数据库', 'revert-db': '回切主库', dissolve: '关闭复制集',
};
const STEP_STATUS_META: Record<PlanStep['status'], { text: string; cls: string }> = {
  pending: { text: '待执行', cls: 'text-muted-foreground' },
  running: { text: '执行中', cls: 'text-amber-600 dark:text-amber-400' },
  done: { text: '完成', cls: 'text-emerald-600 dark:text-emerald-400' },
  error: { text: '失败', cls: 'text-destructive' },
  skipped: { text: '已跳过', cls: 'text-muted-foreground' },
  cancelled: { text: '已取消', cls: 'text-muted-foreground' },
  'rolled-back': { text: '已回滚', cls: 'text-sky-600 dark:text-sky-400' },
};
const PLAN_STATUS_LABEL: Record<Plan['status'], string> = {
  running: '执行中', done: '全部完成', error: '有失败(已停止)', cancelled: '已取消', 'rolled-back': '失败并已回滚',
};

export function ReplicaSetPanel({ branchId, previewUrl, services, infra, onToast }: {
  branchId: string;
  previewUrl?: string;
  services?: Record<string, PanelServiceInfo>;
  infra?: PanelInfraInfo[];
  onToast?: (message: string) => void;
}): JSX.Element {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; data: ReplicaSetsResponse } | { status: 'error'; message: string }>({ status: 'loading' });
  const [plans, setPlans] = useState<Plan[]>([]);
  const [draft, setDraft] = useState<DraftOp[]>([]);
  const [onFailure, setOnFailure] = useState<'stop' | 'rollback'>('stop');
  const [busy, setBusy] = useState(false);
  const draftSeq = useRef(0);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setState({ status: 'loading' });
    try {
      const [data, planRes] = await Promise.all([
        apiRequest<ReplicaSetsResponse>(`/api/branches/${encodeURIComponent(branchId)}/replica-sets`),
        apiRequest<{ plans: Plan[] }>(`/api/branches/${encodeURIComponent(branchId)}/replica-plans`).catch(() => ({ plans: [] })),
      ]);
      setState({ status: 'ok', data });
      setPlans(planRes.plans || []);
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  const activePlan = plans.find((p) => p.status === 'running') || null;

  // 活跃计划 / provisioning：3s 轮询（结束即停，避免空转）
  useEffect(() => {
    if (state.status !== 'ok') return;
    const busyNow = !!activePlan || Object.values(state.data.replicaSets).some((rs) => rs.members.some((m) => m.status === 'provisioning'));
    if (!busyNow) return;
    const t = setInterval(() => { void load(true); }, 3000);
    return () => clearInterval(t);
  }, [state, activePlan, load]);

  // 成员转 error 即 toast（失败不许静默）
  const toastedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (state.status !== 'ok') return;
    for (const [pid, rs] of Object.entries(state.data.replicaSets)) {
      for (const m of rs.members) {
        const key = `${pid}:${m.id}:${m.statusMessage ?? ''}`;
        if (m.status === 'error' && !toastedRef.current.has(key)) {
          toastedRef.current.add(key);
          onToast?.(`${pid} 的副本 ${m.id} 失败：${m.statusMessage || '未知原因'}`);
        }
      }
    }
  }, [state, onToast]);

  const addDraft = useCallback((op: Omit<DraftOp, 'key'>) => {
    draftSeq.current += 1;
    setDraft((prev) => [...prev, { ...op, key: `d${draftSeq.current}` }]);
  }, []);

  const call = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) onToast?.(done); await load(true); }
    catch (err) { onToast?.(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(false); }
  }, [load, onToast]);

  const savePlan = useCallback(() => call(async () => {
    await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-plans`, {
      method: 'POST',
      body: { onFailure, steps: draft.map((d) => ({ kind: d.kind, profileId: d.profileId, params: d.params })) },
    });
    setDraft([]);
  }, '变更计划已保存，开始按序执行'), [branchId, draft, onFailure, call]);

  if (state.status === 'loading') {
    return (
      <section className="cds-surface-raised cds-hairline flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />正在加载复制集配置…
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="cds-surface-raised cds-hairline px-5 py-8 text-sm">
        <p className="text-destructive">{state.message}</p>
        <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void load()}><RefreshCw />重试</Button>
      </section>
    );
  }

  const { replicaSets, candidates, memberLimit } = state.data;
  const snapshots = state.data.snapshots ?? [];
  const profileIds = Array.from(new Set([...Object.keys(replicaSets), ...Object.keys(candidates)])).sort();

  return (
    <div className="grid gap-4">
      {profileIds.length > 0 ? (
        <ReplicaStage
          branchId={branchId}
          profiles={profileIds.map((p) => ({ profileId: p, rs: replicaSets[p], candidates: candidates[p] ?? [], service: services?.[p] }))}
          infra={infra ?? []}
          previewUrl={previewUrl}
          memberLimit={memberLimit}
          draft={draft}
          onDraft={addDraft}
          onToast={onToast}
        />
      ) : (
        <section className="cds-surface-raised cds-hairline px-5 py-8 text-sm text-muted-foreground">
          还没有可复制集化的服务：走一次极速版/托管构建部署后即可在此操作。
        </section>
      )}

      <PlanBoard
        branchId={branchId}
        draft={draft}
        setDraft={setDraft}
        onFailure={onFailure}
        setOnFailure={setOnFailure}
        activePlan={activePlan}
        plans={plans}
        busy={busy}
        onSave={savePlan}
        onCall={call}
      />

      {/* 悬浮执行按钮：舞台高、清单在下方要滚动——右下角常驻，随时可保存/看到执行态 */}
      {(draft.length > 0 && !activePlan) || activePlan ? createPortal(
        <button type="button" disabled={busy || !!activePlan}
          onClick={() => { if (!activePlan) savePlan(); }}
          className={`fixed bottom-6 right-6 z-[120] inline-flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-semibold shadow-2xl transition-colors ${activePlan
            ? 'border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-400'
            : 'border-primary bg-primary text-primary-foreground hover:opacity-90'}`}
          title={activePlan ? '计划执行中，步骤实况见下方变更清单' : '保存并按序执行变更清单'}>
          {activePlan ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {activePlan ? `执行中 ${activePlan.steps.filter((s) => s.status === 'done').length}/${activePlan.steps.length}` : `保存执行（${draft.length} 步）`}
        </button>,
        document.body,
      ) : null}

      {snapshots.length > 0 ? (
        <section className="cds-surface-raised cds-hairline px-5 py-4">
          <div className="text-sm font-semibold">隔离库数据快照（{snapshots.length}）</div>
          <p className="mt-1 text-xs text-muted-foreground">回切/下线后隔离库保留在这里。手动删除才会真正移除。</p>
          <div className="mt-3 grid gap-2">
            {snapshots.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-4 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs">
                <span className="min-w-0">
                  <span className="block font-mono font-semibold">{s.dbName}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{s.engine} · 来源 {s.sourceDb}{s.dedicatedContainer ? ' · 专用隔离实例' : ''} · {new Date(s.clonedAt).toLocaleString()}</span>
                </span>
                <ConfirmAction title="删除隔离库" description={`将移除隔离库 ${s.dbName}（专用实例整容器删除），数据不可恢复。确认？`} confirmLabel="删除"
                  trigger={<Button type="button" size="sm" variant="ghost" disabled={busy}><Trash2 />删除</Button>}
                  onConfirm={() => call(async () => { await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-db-snapshots/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); }, `隔离库 ${s.dbName} 已删除`)} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ── 变更清单 + 执行实况 + 执行记录 ── */
function PlanBoard({ branchId, draft, setDraft, onFailure, setOnFailure, activePlan, plans, busy, onSave, onCall }: {
  branchId: string;
  draft: DraftOp[];
  setDraft: (fn: (prev: DraftOp[]) => DraftOp[]) => void;
  onFailure: 'stop' | 'rollback';
  setOnFailure: (v: 'stop' | 'rollback') => void;
  activePlan: Plan | null;
  plans: Plan[];
  busy: boolean;
  onSave: () => void;
  onCall: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
}): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = plans.filter((p) => p.status !== 'running');
  const move = (idx: number, dir: -1 | 1) => setDraft((prev) => {
    const next = [...prev];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return prev;
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });
  const api = (path: string) => `/api/branches/${encodeURIComponent(branchId)}/replica-plans${path}`;
  const movePending = (plan: Plan, stepId: string, dir: -1 | 1) => {
    const pending = plan.steps.filter((s) => s.status === 'pending').map((s) => s.id);
    const i = pending.indexOf(stepId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= pending.length) return;
    [pending[i], pending[j]] = [pending[j], pending[i]];
    void onCall(async () => { await apiRequest(api(`/${encodeURIComponent(plan.id)}`), { method: 'PATCH', body: { order: pending } }); });
  };

  return (
    <section className="cds-surface-raised cds-hairline px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">变更清单</span>
        <span className="text-[11px] text-muted-foreground">舞台上的操作先进清单，点「保存执行」才真正开始；执行中可调序 / 跳过 / 取消</span>
      </div>

      {activePlan ? (
        <div className="mt-3 grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
            <b>执行中</b>
            <span className="text-muted-foreground">失败策略：{activePlan.onFailure === 'rollback' ? '停止并回滚' : '仅停止'}</span>
            <ConfirmAction title="取消剩余步骤" description="当前执行中的步骤会跑完，其余待执行步骤取消。确认？" confirmLabel="取消剩余"
              trigger={<Button type="button" size="sm" variant="ghost" disabled={busy}><X />取消剩余</Button>}
              onConfirm={() => onCall(async () => { await apiRequest(api(`/${encodeURIComponent(activePlan.id)}/cancel`), { method: 'POST' }); }, '剩余步骤已取消')} />
          </div>
          {activePlan.steps.map((s) => (
            <StepLine key={s.id} step={s}
              controls={s.status === 'pending' ? (
                <span className="flex items-center gap-0.5">
                  <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title="上移" onClick={() => movePending(activePlan, s.id, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title="下移" onClick={() => movePending(activePlan, s.id, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
                  <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-destructive" title="跳过"
                    onClick={() => void onCall(async () => { await apiRequest(api(`/${encodeURIComponent(activePlan.id)}/steps/${encodeURIComponent(s.id)}/skip`), { method: 'POST' }); })}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : undefined} />
          ))}
        </div>
      ) : draft.length > 0 ? (
        <div className="mt-3 grid gap-1.5">
          {draft.map((d, i) => (
            <div key={d.key} className="flex items-center gap-2 rounded-md border border-dashed border-indigo-500/40 bg-indigo-500/[.05] px-2.5 py-1.5 text-xs">
              <span className="w-5 text-right font-mono text-[11px] text-muted-foreground">{i + 1}.</span>
              <span className="rounded border border-indigo-500/40 px-1.5 text-[10px] font-semibold text-indigo-500">{KIND_LABEL[d.kind]}</span>
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title="上移" onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title="下移" onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-destructive" title="移除" onClick={() => setDraft((prev) => prev.filter((x) => x.key !== d.key))}><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={onSave}><Play />保存执行（{draft.length} 步）</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(() => [])}>清空</Button>
            <label className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              失败时
              <select value={onFailure} onChange={(e) => setOnFailure(e.target.value as 'stop' | 'rollback')}
                className="h-6 rounded-md border border-[hsl(var(--hairline))] bg-transparent px-1.5 text-xs outline-none focus:border-primary">
                <option value="stop">仅停止剩余步骤</option>
                <option value="rollback">停止并回滚已完成步骤</option>
              </select>
            </label>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">暂无待保存的变更。在舞台上点「+副本」「复制隔离」等即可加入清单。</p>
      )}

      {history.length > 0 ? (
        <div className="mt-4 border-t border-dashed border-[hsl(var(--hairline))] pt-3">
          <button type="button" className="flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary" onClick={() => setHistoryOpen(!historyOpen)}>
            {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            执行记录（{history.length}）
          </button>
          {historyOpen ? (
            <div className="mt-2 grid gap-2">
              {history.map((p) => <PlanRecord key={p.id} plan={p} />)}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function StepLine({ step, controls }: { step: PlanStep; controls?: JSX.Element }): JSX.Element {
  const meta = STEP_STATUS_META[step.status];
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 px-2.5 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        {step.status === 'running' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" /> : (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${step.status === 'done' ? 'bg-emerald-500' : step.status === 'error' ? 'bg-destructive' : step.status === 'rolled-back' ? 'bg-sky-500' : 'bg-[hsl(var(--muted-foreground))]/50'}`} />
        )}
        <span className="rounded border border-[hsl(var(--hairline))] px-1.5 text-[10px] font-semibold">{KIND_LABEL[step.kind]}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{step.profileId}{step.params?.memberId ? ` · ${step.params.memberId}` : ''}{typeof step.params?.weight === 'number' ? ` · 权重 ${step.params.weight}` : ''}</span>
        <b className={`text-[11px] ${meta.cls}`}>{meta.text}</b>
        {controls}
      </div>
      {step.error ? <p className="mt-1 whitespace-pre-wrap break-all pl-5 text-[11px] text-destructive">{step.error}</p> : null}
    </div>
  );
}

function PlanRecord({ plan }: { plan: Plan }): JSX.Element {
  const [open, setOpen] = useState(false);
  const bad = plan.status === 'error' || plan.status === 'rolled-back';
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${bad ? 'border-destructive/40 bg-destructive/[.04]' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35'}`}>
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <b className={bad ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>{PLAN_STATUS_LABEL[plan.status]}</b>
        <span className="text-muted-foreground">{plan.steps.length} 步 · {new Date(plan.createdAt).toLocaleString()}</span>
        {bad ? <span className="min-w-0 flex-1 truncate text-destructive">{plan.steps.find((s) => s.error)?.error}</span> : null}
      </button>
      {open ? (
        <div className="mt-2 grid gap-1">
          {plan.steps.map((s) => <StepLine key={s.id} step={s} />)}
          {plan.rollbackLog?.length ? (
            <div className="mt-1 rounded-md border border-sky-500/30 bg-sky-500/[.05] px-2.5 py-1.5 text-[11px]">
              <b className="text-sky-600 dark:text-sky-400">回滚日志</b>
              {plan.rollbackLog.map((line, i) => <p key={i} className="mt-0.5 text-muted-foreground">{line}</p>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── 流量舞台：容器级视图（一屏纵览全部容器，自上而下调用关系；每容器独立操作）── */
function ReplicaStage({ branchId, profiles, infra, previewUrl, memberLimit, draft, onDraft, onToast }: {
  branchId: string;
  profiles: Array<{ profileId: string; rs?: ProfileReplicaSetView; candidates: ReplicaCandidateView[]; service?: PanelServiceInfo }>;
  infra: PanelInfraInfo[];
  previewUrl?: string;
  memberLimit: number;
  draft: DraftOp[];
  onDraft: (op: Omit<DraftOp, 'key'>) => void;
  onToast?: (m: string) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(860);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const [log, setLog] = useState<string[]>([]);
  const [probeRes, setProbeRes] = useState<ProbeResult | null>(null);
  const [flying, setFlying] = useState<{ path: string; key: number } | null>(null);
  const [weightFor, setWeightFor] = useState<{ profileId: string; memberId: string; x: number; y: number } | null>(null);
  const [weightDraft, setWeightDraft] = useState('');
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const probing = useRef(false);

  const entryHost = previewUrl ? new URL(previewUrl).hostname : '预览入口未就绪';
  const dbInfra = infra.filter((s) => /mongo|mysql|mariadb|postgres|redis/i.test(s.dockerImage || s.id));
  const totalInstances = profiles.reduce((n, p) => n + 1 + (p.rs?.enabled ? p.rs.members.length : 0), 0);
  const draftCount = draft.length;

  // 几何：入口在顶部；每个容器一行（自上而下调用关系）；数据层双框在底部
  const CW = 168, IGAP = 12, LABEL_W = 178, ROW_H = 132;
  const entryY = 14;
  const rowY = (i: number): number => 150 + i * ROW_H;
  const dataY = 150 + profiles.length * ROW_H + 34;
  const dbCW = 168, dbGap = 26;
  const dbCount = Math.max(dbInfra.length, 1);
  const leftFrameW = dbCount * dbCW + (dbCount - 1) * dbGap + 28;
  const rightFrameW = dbCW + 28;
  const frameGap = 44;
  const fx = Math.max(6, (w - leftFrameW - frameGap - rightFrameW) / 2);
  const rightX = fx + leftFrameW + frameGap;
  const fy = dataY - 16, fh = 128;
  const mainDbIdx = Math.max(dbInfra.findIndex((s) => /mongo|mysql|mariadb|postgres/i.test(s.dockerImage || s.id)), 0);
  const dbX = (i: number): number => fx + 14 + i * (dbCW + dbGap);
  const isoX = rightX + 14;
  const mainDbX = dbX(mainDbIdx);
  const entryX = (w - CW) / 2;
  const canvasH = dataY + fh + 30;
  const edgeD = (x1: number, y1: number, x2: number, y2: number): string => {
    const k = Math.max(40, (y2 - y1) * 0.5);
    return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2 - 8}`;
  };

  // 每行实例（primary + members + 草稿幽灵）
  const rows = profiles.map((p, ri) => {
    const rs = p.rs;
    const members = rs?.enabled ? rs.members : [];
    const running = members.filter((m) => m.status === 'running');
    const tw = (rs?.primaryWeight ?? 100) + running.reduce((s, m) => s + m.weight, 0);
    const my = draft.filter((d) => d.profileId === p.profileId);
    const adds = my.filter((d) => d.kind === 'add-replica');
    const removals = new Set(my.filter((d) => d.kind === 'remove-member').map((d) => d.params?.memberId));
    const draftIso = my.some((d) => d.kind === 'isolate-db');
    const draftRevert = my.some((d) => d.kind === 'revert-db');
    const draftWeights = new Map(my.filter((d) => d.kind === 'set-weight').map((d) => [d.params?.memberId, d.params?.weight]));
    const isoState = rs?.isolated
      ? (members.some((m) => m.status === 'provisioning') ? 'switching' : 'done')
      : (members.some((m) => m.status === 'provisioning' && m.statusMessage?.includes('第1步')) ? 'cloning' : 'idle');
    const insts = [
      { id: 'primary', name: '主实例', w: rs?.primaryWeight ?? 100, boot: false, ghost: false, danger: rs?.primaryReachable === false, sub: rs?.primaryReachable === false ? '不可达' : 'primary', port: p.service?.hostPort },
      ...members.map((m) => ({
        id: m.id, name: m.id, w: m.status === 'running' ? m.weight : 0, boot: m.status === 'provisioning', ghost: false,
        danger: m.status === 'error' || (m.status === 'running' && m.reachable === false),
        sub: m.status === 'provisioning' ? (m.statusMessage || '创建中') : m.status === 'error' ? `失败：${m.statusMessage || ''}` : m.reachable === false ? '不可达 · 建议下线' : `副本 · ${m.commitSha?.slice(0, 7) ?? ''}`,
        port: m.hostPort,
      })),
      ...adds.map((d, i) => ({ id: d.key, name: `副本(草稿${i + 1})`, w: 0, boot: false, ghost: true, danger: false, sub: '待保存', port: undefined })),
    ];
    return { ...p, ri, members, running, tw, adds, removals, draftIso, draftRevert, draftWeights, isoState, insts, y: rowY(ri) };
  });
  const anyIsolatedRow = rows.find((r) => r.isoState !== 'idle');

  const runProbe = async (profileId: string): Promise<void> => {
    if (probing.current) return;
    probing.current = true;
    setLog([`实测 ${profileId}：串流模式，每个请求等上一个响应返回——`]);
    setProbeRes(null);
    try {
      if (!previewUrl) { onToast?.('该分支还没有预览入口，无法实测'); probing.current = false; return; }
      const res = await apiRequest<ProbeResult>(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/probe`, {
        method: 'POST', body: { host: new URL(previewUrl).hostname, count: 12 },
      });
      const row = rows.find((r) => r.profileId === profileId);
      for (let i = 0; i < res.hits.length; i += 1) {
        const hit = res.hits[i];
        const missed = hit.servedBy === 'untagged' || hit.servedBy === 'error';
        const idx = row ? (hit.servedBy === 'primary' ? 0 : row.insts.findIndex((x) => x.id === hit.servedBy)) : -1;
        if (!missed && row && idx >= 0) {
          const tx = LABEL_W + 12 + idx * (CW + IGAP) + CW / 2;
          setFlying({ path: edgeD(entryX + CW / 2, entryY + 88, tx, row.y), key: i });
          await new Promise((r) => setTimeout(r, 620));
          setFlying(null);
        }
        const line = missed
          ? `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'error' ? '连接失败' : '未命中复制集路由'}  HTTP ${hit.status}`
          : `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'primary' ? '主实例' : hit.servedBy}  X-CDS-Replica: ${hit.servedBy}  HTTP ${hit.status}${hit.status >= 200 && hit.status < 300 ? ' OK' : ' · 业务路由响应'}`;
        setLog((prev) => [...prev, line]);
      }
      setProbeRes(res);
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
    }
    probing.current = false;
  };

  const commitWeight = (): void => {
    if (!weightFor) return;
    const v = Math.max(0, Math.min(100, Math.round(Number(weightDraft))));
    const target = weightFor;
    setWeightFor(null);
    if (!Number.isFinite(v)) return;
    onDraft({ kind: 'set-weight', profileId: target.profileId, params: { memberId: target.memberId, weight: v }, label: `${target.profileId} · ${target.memberId === 'primary' ? '主实例' : target.memberId} 权重 → ${v}` });
  };

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-3">
        <b className="text-sm">容器级视图 · 全部服务</b>
        <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500"><Layers className="mr-1 inline h-3 w-3" />{profiles.length} 容器 · {totalInstances} 实例</span>
        {draftCount > 0 ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">{draftCount} 项变更待保存</span> : null}
        <span className="text-[11px] text-muted-foreground">每行一个容器 · 各自加副本 / 调权重 / 复制隔离 · 操作先进变更清单</span>
      </div>

      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]"
        style={{ height: canvasH, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <defs><marker id="rsArr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker></defs>
          {rows.map((row) => {
            const firstX = LABEL_W + 12 + CW / 2;
            return (
              <g key={row.profileId}>
                {/* 入口 → 该容器行（调用关系自上而下） */}
                <path d={edgeD(entryX + CW / 2, entryY + 88, firstX, row.y)} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.4" strokeDasharray="5 5" opacity="0.32" markerEnd="url(#rsArr)" />
                {/* 容器行 → 数据层 */}
                {row.isoState === 'done' ? (
                  <>
                    <path d={edgeD(firstX + CW + IGAP, row.y + 92, mainDbX + dbCW / 2, dataY)} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.3" strokeDasharray="5 5" opacity="0.18" />
                    <path d={edgeD(firstX + CW + IGAP, row.y + 92, isoX + dbCW / 2, dataY)} fill="none" stroke="#6366f1" strokeWidth="1.8" strokeDasharray="5 5" opacity="0.75" markerEnd="url(#rsArr)" />
                  </>
                ) : (
                  <path d={edgeD(firstX, row.y + 92, mainDbX + dbCW / 2, dataY)} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.3" strokeDasharray="5 5" opacity="0.22" markerEnd="url(#rsArr)" />
                )}
              </g>
            );
          })}
          {/* 左框：共享基础设施；右框：隔离区 */}
          <rect x={fx} y={fy} width={leftFrameW} height={fh} rx="14" fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.4" strokeDasharray="7 6" opacity="0.5" />
          <rect x={rightX} y={fy} width={rightFrameW} height={fh} rx="14" fill="none" stroke="#10b981" strokeWidth="1.6" strokeDasharray="7 6"
            opacity={anyIsolatedRow ? 0.9 : 0.45}
            className={anyIsolatedRow?.isoState === 'cloning' ? 'animate-[rsants_1.2s_linear_infinite]' : undefined} />
          {anyIsolatedRow && (anyIsolatedRow.isoState === 'cloning' || anyIsolatedRow.isoState === 'switching') ? (
            <g>
              <path d={`M ${mainDbX + dbCW} ${dataY + 46} L ${isoX} ${dataY + 46}`} fill="none" stroke="#10b981" strokeWidth="2" strokeDasharray="4 4" />
              <g>
                <animateMotion dur="1.4s" repeatCount="indefinite" path={`M ${mainDbX + dbCW} ${dataY + 40} L ${isoX} ${dataY + 40}`} />
                <rect x="-13" y="-9" width="26" height="18" rx="4" fill="hsl(var(--background))" stroke="#10b981" strokeWidth="1.6" />
                <text x="0" y="4" textAnchor="middle" fontSize="8" fontWeight="700" fill="#10b981">DB</text>
              </g>
            </g>
          ) : null}
          {flying ? (
            <circle key={flying.key} r="4.6" fill="#f59e0b">
              <animateMotion dur="0.6s" repeatCount="1" fill="freeze" path={flying.path} />
            </circle>
          ) : null}
        </svg>

        <StageCard x={entryX} y={entryY} name="入口" ico="GW" color="#6366f1" ok status={entryHost} foot="forwarder · 按权重分流" />

        {rows.map((row) => (
          <div key={row.profileId}>
            {/* 行标签：容器名 + 行级操作 */}
            <div className="absolute rounded-lg border border-[hsl(var(--hairline))] bg-background/85 px-2.5 py-1.5 text-xs" style={{ left: 8, top: row.y, width: LABEL_W - 16 }}>
              <div className="truncate font-semibold" title={row.profileId}>{row.profileId}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {row.rs?.isolated ? <span className="rounded border border-emerald-500/50 bg-emerald-500/10 px-1 text-[10px] text-emerald-600 dark:text-emerald-400">已隔离</span> : null}
                {row.draftIso ? <span className="rounded border border-amber-500/50 px-1 text-[10px] text-amber-600 dark:text-amber-400">隔离·草稿</span> : null}
                {row.running.length > 0 && row.isoState === 'idle' && !row.draftIso ? (
                  <button type="button" className="rounded border border-emerald-500/50 px-1 text-[10px] text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400" title="复制隔离：克隆进专用隔离实例，副本切换（进变更清单）"
                    onClick={() => onDraft({ kind: 'isolate-db', profileId: row.profileId, label: `${row.profileId} · 复制隔离（克隆 → 副本切换，可回切）` })}>
                    <Copy className="mr-0.5 inline h-2.5 w-2.5" />隔离
                  </button>
                ) : null}
                {row.isoState === 'done' && !row.draftRevert ? (
                  <button type="button" className="rounded border border-emerald-500/50 px-1 text-[10px] text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400" title="回切主库（进变更清单）"
                    onClick={() => onDraft({ kind: 'revert-db', profileId: row.profileId, label: `${row.profileId} · 回切主库（隔离库转快照保留）` })}>回切</button>
                ) : null}
                {row.members.length > 0 ? (
                  <button type="button" className="rounded border border-[hsl(var(--hairline))] px-1 text-[10px] text-muted-foreground hover:text-destructive" title="关闭复制集（进变更清单）"
                    onClick={() => onDraft({ kind: 'dissolve', profileId: row.profileId, label: `${row.profileId} · 关闭复制集（移除全部副本）` })}>关闭</button>
                ) : null}
                {row.running.length > 0 ? (
                  <button type="button" className="rounded border border-[hsl(var(--hairline))] px-1 text-[10px] text-muted-foreground hover:text-primary" title="分流实测（即时诊断，不进清单）"
                    onClick={() => void runProbe(row.profileId)}>实测</button>
                ) : null}
                {row.candidates.some((c) => !c.isCurrent) && row.members.length + row.adds.length < memberLimit ? (
                  <button type="button" className="rounded border border-[hsl(var(--hairline))] px-1 text-[10px] text-muted-foreground hover:text-primary" title="用历史版本加副本"
                    onClick={() => setPickerFor(pickerFor === row.profileId ? null : row.profileId)}>历史版</button>
                ) : null}
              </div>
            </div>
            {/* 实例卡 */}
            {row.insts.map((inst, ii) => (
              <StageCard key={inst.id} x={LABEL_W + 12 + ii * (CW + IGAP)} y={row.y} w={CW} name={inst.name} ico="API"
                color={inst.ghost ? '#9ca3af' : ii === 0 ? '#8b8578' : '#6366f1'}
                ok={!inst.boot && !inst.danger && !inst.ghost} danger={inst.danger} ghost={inst.ghost || row.removals.has(inst.id)}
                status={row.removals.has(inst.id) ? '待下线（草稿）' : inst.sub} foot={inst.port ? `:${inst.port}` : ''} hero={ii > 0 && !inst.ghost} boot={inst.boot}
                extra={(
                  <span className="absolute right-1 top-1 flex gap-0.5">
                    {!inst.ghost && inst.id !== 'primary' && !row.removals.has(inst.id) ? (
                      <>
                        {memberDirectUrl(previewUrl, inst.id) && !inst.boot ? (
                          <a className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-primary" title="直达该副本"
                            href={memberDirectUrl(previewUrl, inst.id)!} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" /></a>
                        ) : null}
                        <button type="button" className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-destructive" title="下线（进变更清单）"
                          onClick={() => onDraft({ kind: 'remove-member', profileId: row.profileId, params: { memberId: inst.id }, label: `${row.profileId} · 下线 ${inst.id}` })}>
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    ) : null}
                  </span>
                )}
                label={inst.ghost ? '草稿' : `${inst.boot ? '…' : `${Math.round((inst.w / row.tw) * 100)}%${row.draftWeights.has(inst.id) ? `→${row.draftWeights.get(inst.id)}` : ''}`}`}
                labelX={LABEL_W + 12 + ii * (CW + IGAP) + CW / 2} labelY={row.y - 12}
                onLabelClick={!inst.ghost && !inst.boot ? () => { setWeightFor({ profileId: row.profileId, memberId: inst.id, x: LABEL_W + 12 + ii * (CW + IGAP) + CW / 2, y: row.y - 12 }); setWeightDraft(String(inst.id === 'primary' ? row.rs?.primaryWeight ?? 100 : row.members.find((m) => m.id === inst.id)?.weight ?? 0)); } : undefined} />
            ))}
            {/* 行内 + 按钮 */}
            {row.members.length + row.adds.length < memberLimit ? (
              <button type="button"
                className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-indigo-500/50 bg-indigo-500/10 text-xs font-semibold text-indigo-500 transition-colors hover:bg-indigo-500 hover:text-white"
                style={{ left: LABEL_W + 12 + row.insts.length * (CW + IGAP), top: row.y, width: 96, height: 92 }}
                title={`给 ${row.profileId} 加一个当前版本副本（进变更清单）`}
                onClick={() => onDraft({ kind: 'add-replica', profileId: row.profileId, label: `${row.profileId} · 新增当前版本副本` })}>
                <Plus className="h-5 w-5" />副本
              </button>
            ) : null}
          </div>
        ))}

        {weightFor ? (
          <input autoFocus type="number" min={0} max={100} value={weightDraft}
            onChange={(e) => setWeightDraft(e.target.value)}
            onBlur={commitWeight}
            onKeyDown={(e) => { if (e.key === 'Enter') commitWeight(); if (e.key === 'Escape') setWeightFor(null); }}
            className="absolute z-10 h-6 w-16 -translate-x-1/2 -translate-y-1/2 rounded border border-primary bg-background px-1 text-center font-mono text-xs outline-none"
            style={{ left: weightFor.x, top: weightFor.y }} />
        ) : null}

        {(dbInfra.length ? dbInfra : [{ id: 'db', name: '数据库', dockerImage: '', status: 'running' }]).map((s, i) => {
          const isMainDb = i === mainDbIdx && !/redis/i.test(s.dockerImage || s.id);
          const locked = isMainDb && anyIsolatedRow?.isoState === 'done';
          return (
            <StageCard key={s.id} x={dbX(i)} y={dataY} w={dbCW} name={s.name || s.id} ico={/redis/i.test(s.dockerImage || s.id) ? 'R' : 'DB'}
              color={/redis/i.test(s.dockerImage || s.id) ? '#c2372f' : '#10b981'} ok={!locked} locked={locked}
              status={locked ? '已上锁 · 副本请求已转移' : isMainDb ? '主库' : '共享实例'} foot={`${s.id}-volume`} />
          );
        })}
        {!anyIsolatedRow ? (
          <div className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/[.06] text-xs font-semibold text-emerald-600 dark:text-emerald-400"
            style={{ left: isoX, top: dataY, width: dbCW, height: 92 }}
            title="隔离区：在容器行点「隔离」即把复制隔离加入变更清单">
            <span className="text-[18px] leading-none">&#9676;</span>隔离区 · 空
            <span className="text-[10px] font-normal text-muted-foreground">在容器行点「隔离」</span>
          </div>
        ) : (
          <StageCard x={isoX} y={dataY} w={dbCW} name="隔离库" ico="DB" color="#10b981" ok={anyIsolatedRow.isoState === 'done'} boot={anyIsolatedRow.isoState === 'cloning'}
            status={anyIsolatedRow.isoState === 'cloning' ? '第1步 复制：拷入数据…' : anyIsolatedRow.isoState === 'switching' ? '第2步 切换：副本改连新库…' : `${anyIsolatedRow.profileId} 专用实例`}
            foot={anyIsolatedRow.rs?.isolated?.dbName || ''} />
        )}
      </div>

      {pickerFor ? (
        <div className="mx-5 mb-3 grid gap-1.5">
          {(rows.find((r) => r.profileId === pickerFor)?.candidates || []).filter((c) => !c.isCurrent).slice(0, 6).map((row2) => (
            <button key={row2.versionId} type="button"
              onClick={() => { setPickerFor(null); onDraft({ kind: 'add-replica', profileId: pickerFor, params: { versionId: row2.versionId }, label: `${pickerFor} · 新增历史版本副本 ${row2.commitSha.slice(0, 7)}` }); }}
              className="flex items-center gap-4 rounded-md border border-[hsl(var(--hairline))] bg-background px-3 py-2 text-left text-xs hover:border-indigo-500/50 hover:bg-indigo-500/[.06]">
              <span className="font-mono font-semibold">{row2.commitSha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{row2.image}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{new Date(row2.createdAt).toLocaleString()}</span>
            </button>
          ))}
        </div>
      ) : null}
      {log.length > 1 ? (
        <div className="mx-5 mb-3 max-h-32 overflow-y-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      ) : null}
      {probeRes ? <div className="mx-5 mb-4"><ProbeDashboard result={probeRes} /></div> : null}
      <style>{'@keyframes rsants{to{stroke-dashoffset:-40}}'}</style>
    </section>
  );
}

const PROBE_WHO_LABEL: Record<string, string> = { primary: '主实例', untagged: '未标记响应', error: '连接失败' };
function probeWhoColor(who: string, i: number): string {
  if (who === 'primary') return '#8b8578';
  if (who === 'untagged') return '#9ca3af';
  if (who === 'error') return '#ef4444';
  return MEMBER_COLORS[i % MEMBER_COLORS.length];
}

function ProbeDashboard({ result }: { result: ProbeResult }): JSX.Element {
  const entries = Object.entries(result.tally).sort((x, y) => y[1] - x[1]);
  const C = 2 * Math.PI * 20;
  const nonOkTagged = result.hits.filter((h) => h.servedBy !== 'untagged' && h.servedBy !== 'error' && (h.status < 200 || h.status >= 300)).length;
  return (
    <div className="flex flex-wrap items-center gap-6 rounded-md border border-[hsl(var(--hairline))] bg-background px-4 py-3">
      <span className="text-xs text-muted-foreground">分流仪表盘<br /><span className="font-mono text-[10px]">{result.count} 请求 · 串流 · {result.path}</span></span>
      {entries.map(([who, n], i) => {
        const pct = n / result.count;
        return (
          <span key={who} className="flex items-center gap-2.5">
            <svg width="52" height="52">
              <circle cx="26" cy="26" r="20" fill="none" stroke="hsl(var(--hairline))" strokeWidth="6" />
              <circle cx="26" cy="26" r="20" fill="none" stroke={probeWhoColor(who, i)} strokeWidth="6"
                strokeDasharray={C} strokeDashoffset={C * (1 - pct)} strokeLinecap="round" transform="rotate(-90 26 26)" />
              <text x="26" y="30" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">{Math.round(pct * 100)}%</text>
            </svg>
            <span className="text-xs"><b className="block">{PROBE_WHO_LABEL[who] ?? who}</b><span className="font-mono text-[10px] text-muted-foreground">{n} / {result.count} 次</span></span>
          </span>
        );
      })}
      {nonOkTagged > 0 ? (
        <span className="basis-full text-[11px] text-muted-foreground">
          {nonOkTagged} 个请求返回非 2xx（业务路由无此路径）——落点以 X-CDS-Replica 响应头为准，分流统计不受影响。
        </span>
      ) : null}
    </div>
  );
}

function StageCard({ x, y, w = 180, name, ico, color, ok, danger, ghost, locked, status, foot, hero, boot, extra, label, labelX, labelY, onLabelClick }: {
  x: number; y: number; w?: number; name: string; ico: string; color: string; ok?: boolean; danger?: boolean; ghost?: boolean; locked?: boolean;
  status: string; foot?: string; hero?: boolean; boot?: boolean; extra?: JSX.Element; label?: string; labelX?: number; labelY?: number;
  onLabelClick?: () => void;
}): JSX.Element {
  return (
    <>
      <div className={`absolute overflow-hidden rounded-xl border bg-background text-xs shadow-md ${danger ? 'border-destructive/60' : ghost ? 'border-dashed border-[hsl(var(--muted-foreground))]/50 opacity-70' : hero ? 'border-indigo-500/45' : 'border-[hsl(var(--hairline))]'}`}
        style={{ left: x, top: y, width: w, ...(boot ? { animation: 'rscolorin 2.4s forwards' } : {}), ...(locked ? { filter: 'grayscale(0.9)', opacity: 0.65 } : {}) }}>
        {locked ? (
          <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[hsl(var(--hairline))] bg-background text-muted-foreground" title="副本请求已转移到隔离区，回切主库可解锁">
            <Lock className="h-3 w-3" />
          </span>
        ) : null}
        <div className="flex items-center gap-2 px-3 py-2 text-[13px] font-bold">
          <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[10px] font-extrabold text-white" style={{ background: color }}>{ico}</span>
          <span className="truncate">{name}</span>
        </div>
        <div className={`flex items-center gap-1.5 px-3 pb-2 text-[11px] ${danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : ok ? '#10b981' : 'hsl(var(--muted-foreground))' }} />
          <span className="truncate" title={status}>{status}</span>
        </div>
        {foot !== undefined ? (
          <div className="border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-1.5 font-mono text-[10px] text-muted-foreground">{foot}</div>
        ) : null}
        {extra}
      </div>
      {label !== undefined && labelX !== undefined && labelY !== undefined ? (
        <button type="button" disabled={!onLabelClick} onClick={onLabelClick}
          title={onLabelClick ? '点击调整权重（进变更清单）' : undefined}
          className={`absolute -translate-x-1/2 -translate-y-1/2 rounded border border-indigo-500/45 bg-background px-1.5 font-mono text-[10px] text-indigo-500 ${onLabelClick ? 'cursor-pointer hover:bg-indigo-500/10' : ''}`}
          style={{ left: labelX, top: labelY }}>{label}</button>
      ) : null}
      <style>{'@keyframes rscolorin{from{filter:grayscale(1);opacity:.45}to{filter:grayscale(0);opacity:1}}'}</style>
    </>
  );
}
