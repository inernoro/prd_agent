/*
 * ReplicaSetPanel — 复制集双画布（两页签定案，2026-07-24 用户拍板）。
 *
 *   - 容器级 / 项目级两个页签都是同一种「节点卡画布」（Railway 风拓扑），不是下拉框、不是列表。
 *   - 容器级：一屏自上而下展示全部容器的调用关系（前端 → 服务 → 服务），关系由后端从
 *     环境变量引用 + depends_on 推导（GET replica-sets 的 graph 字段，只含 env 键名）。
 *     每个容器独立加副本 / 权重 / 下线 / 分流实测。
 *   - 项目级：原版舞台形态 —— 入口 → 全部容器（副本以「复制集成员 · 已负载」特殊标记的
 *     叠卡呈现，不隐藏）→ 基础设施；整组加副本一键进清单。
 *   - 数据隔离两级统一战线（debt #22）：隔离决策升到分支级，隔离区一次把所有有副本的
 *     服务一起切到同一专用隔离实例；部分隔离会黄牌提示「统一战线未对齐」并可一键补齐。
 *   - 所有变更操作先进「变更清单」草稿，点「保存执行」才提交后端执行计划，串行执行；
 *     执行中可调序 / 跳过 / 取消；失败红显 + 可选回滚；执行记录持久可查。
 *   - 分流实测是只读诊断，保持即时执行（不进草稿）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, ExternalLink, Layers, Loader2, Lock, Play, Plus, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
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

interface GraphNodeView { id: string; name: string; kind: 'service' | 'infra'; pathPrefixes?: string[]; subdomain?: string; containerPort?: number; dockerImage?: string }
interface GraphEdgeView { from: string; to: string; envKeys: string[]; dependsOn: boolean }
interface ServiceGraphView { nodes: GraphNodeView[]; edges: GraphEdgeView[]; layers: string[][] }

interface ReplicaSetsResponse {
  replicaSets: Record<string, ProfileReplicaSetView>;
  candidates: Record<string, ReplicaCandidateView[]>;
  snapshots?: ReplicaDbSnapshotView[];
  memberLimit: number;
  graph?: ServiceGraphView;
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

/* ── 画布几何共用 ── */
const CW = 180;
const edgeD = (x1: number, y1: number, x2: number, y2: number): string => {
  const k = Math.max(52, (y2 - y1) * 0.55);
  return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2 - 8}`;
};

function dataGeo(w: number, dbCount: number) {
  const dbCW = 168, dbGap = 26;
  const n = Math.max(dbCount, 1);
  const leftFrameW = n * dbCW + (n - 1) * dbGap + 28;
  const rightFrameW = dbCW + 28;
  const frameGap = 44;
  const fx = Math.max(6, (w - leftFrameW - frameGap - rightFrameW) / 2);
  const rightX = fx + leftFrameW + frameGap;
  return {
    dbCW, leftFrameW, rightFrameW, fx, rightX,
    isoX: rightX + 14,
    dbX: (i: number): number => fx + 14 + i * (dbCW + dbGap),
    minWidth: leftFrameW + frameGap + rightFrameW + 24,
  };
}

/** 分支级隔离统一战线状态（debt #22：禁止一半连主库一半连隔离库） */
interface BranchIso {
  state: 'idle' | 'cloning' | 'switching' | 'partial' | 'done';
  isolatedProfiles: string[];
  withMembersProfiles: string[];
  dbNames: string[];
}
function computeBranchIso(replicaSets: Record<string, ProfileReplicaSetView>): BranchIso {
  const entries = Object.values(replicaSets);
  const withMembers = entries.filter((rs) => rs.enabled && rs.members.length > 0);
  const isolated = entries.filter((rs) => rs.isolated);
  const cloning = entries.some((rs) => rs.members.some((m) => m.status === 'provisioning' && m.statusMessage?.includes('第1步')));
  const switching = isolated.length > 0 && entries.some((rs) => rs.members.some((m) => m.status === 'provisioning'));
  let state: BranchIso['state'] = 'idle';
  if (cloning) state = 'cloning';
  else if (switching) state = 'switching';
  else if (isolated.length === 0) state = 'idle';
  else if (withMembers.every((rs) => rs.isolated)) state = 'done';
  else state = 'partial';
  return {
    state,
    isolatedProfiles: isolated.map((rs) => rs.profileId),
    withMembersProfiles: withMembers.map((rs) => rs.profileId),
    dbNames: isolated.map((rs) => rs.isolated!.dbName),
  };
}

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
  const [tab, setTab] = useState<'container' | 'project'>('container');
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
  // 旧后端滚动更新期兜底：没有 graph 时退化为单层（不画调用边，卡片仍是画布形态）
  const graph: ServiceGraphView = state.data.graph ?? { nodes: [], edges: [], layers: [profileIds] };
  const branchIso = computeBranchIso(replicaSets);

  // 统一战线动作：隔离 / 回切一次覆盖所有符合条件的服务（草稿同入清单）
  const isolateTargets = profileIds.filter((p) => {
    const rs = replicaSets[p];
    const hasMembers = (rs?.enabled && rs.members.length > 0) || draft.some((d) => d.profileId === p && d.kind === 'add-replica');
    return hasMembers && !rs?.isolated && !draft.some((d) => d.profileId === p && d.kind === 'isolate-db');
  });
  const revertTargets = profileIds.filter((p) => !!replicaSets[p]?.isolated && !draft.some((d) => d.profileId === p && d.kind === 'revert-db'));
  const isolateAll = (): void => {
    if (isolateTargets.length === 0) { onToast?.('隔离作用于副本——先给容器点「+副本」，同一计划内先加副本再隔离'); return; }
    isolateTargets.forEach((p) => addDraft({ kind: 'isolate-db', profileId: p, label: `${p} · 复制隔离（统一战线，克隆 → 副本切换，可回切）` }));
    onToast?.(`统一战线：已加入 ${isolateTargets.length} 个服务的复制隔离草稿`);
  };
  const revertAll = (): void => {
    revertTargets.forEach((p) => addDraft({ kind: 'revert-db', profileId: p, label: `${p} · 回切主库（隔离库转快照保留）` }));
    if (revertTargets.length) onToast?.(`已加入 ${revertTargets.length} 个服务的回切草稿`);
  };
  const draftIsoCount = draft.filter((d) => d.kind === 'isolate-db').length;
  const draftRevertCount = draft.filter((d) => d.kind === 'revert-db').length;

  const stageProps = {
    branchId, previewUrl, services, infra: infra ?? [], replicaSets, candidates, memberLimit,
    draft, onDraft: addDraft, onToast, profileIds, graph, branchIso,
    isolateTargets, revertTargets, isolateAll, revertAll, draftIsoCount, draftRevertCount,
  };

  return (
    <div className="grid gap-4">
      <section className="cds-surface-raised cds-hairline flex flex-wrap items-center gap-3 px-5 py-2.5">
        <div className="inline-flex overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
          <button type="button" onClick={() => setTab('container')}
            className={`px-3 py-1.5 text-xs ${tab === 'container' ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'}`}>
            容器级
          </button>
          <button type="button" onClick={() => setTab('project')}
            className={`px-3 py-1.5 text-xs ${tab === 'project' ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'}`}>
            项目级
          </button>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {tab === 'container'
            ? '全部容器的调用关系一屏纵览（边来自环境变量引用），每个容器独立操作'
            : '整组视角：入口 → 全部容器 → 基础设施，一键整组加副本 / 统一战线隔离'}
        </span>
      </section>

      {tab === 'container' ? <ContainerGraphStage {...stageProps} /> : <ProjectStage {...stageProps} />}

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

      {/* 悬浮执行按钮：画布高、清单在下方要滚动——右下角常驻，随时可保存/看到执行态 */}
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
        <span className="text-[11px] text-muted-foreground">画布上的操作先进清单，点「保存执行」才真正开始；执行中可调序 / 跳过 / 取消</span>
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
        <p className="mt-2 text-xs text-muted-foreground">暂无待保存的变更。在画布上点「+副本」「复制隔离」等即可加入清单。</p>
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

/* ── 两个画布共享的 props ── */
interface StageSharedProps {
  branchId: string;
  previewUrl?: string;
  services?: Record<string, PanelServiceInfo>;
  infra: PanelInfraInfo[];
  replicaSets: Record<string, ProfileReplicaSetView>;
  candidates: Record<string, ReplicaCandidateView[]>;
  memberLimit: number;
  draft: DraftOp[];
  onDraft: (op: Omit<DraftOp, 'key'>) => void;
  onToast?: (m: string) => void;
  profileIds: string[];
  graph: ServiceGraphView;
  branchIso: BranchIso;
  isolateTargets: string[];
  revertTargets: string[];
  isolateAll: () => void;
  revertAll: () => void;
  draftIsoCount: number;
  draftRevertCount: number;
}

function useMeasuredWidth(): [React.RefObject<HTMLDivElement>, number] {
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
  return [hostRef, w];
}

const isWebLike = (node: GraphNodeView | undefined, id: string): boolean =>
  /web|admin|front|console|ui/i.test(id) || (node?.pathPrefixes ?? []).includes('/');

function serviceStatusText(rs: ProfileReplicaSetView | undefined, members: ReplicaMemberView[]): { text: string; danger: boolean } {
  if (rs?.primaryReachable === false) return { text: '不可达 · 端口拒绝连接', danger: true };
  if (members.some((m) => m.status === 'error')) return { text: '有副本失败 · 详见下方', danger: true };
  if (members.some((m) => m.status === 'provisioning')) return { text: '副本创建中…', danger: false };
  if (members.length > 0) return { text: `1+${members.length} 实例 · 按权重分流`, danger: false };
  return { text: '单实例 · 可加副本', danger: false };
}

/* ── 数据层（两个画布共用）：左框共享基础设施 + 右框隔离区（统一战线）── */
function DataLayerSvg({ geo, fy, fh, iso, draftIsoCount, mainDbX, transferActive }: {
  geo: ReturnType<typeof dataGeo>; fy: number; fh: number; iso: BranchIso; draftIsoCount: number; mainDbX: number; transferActive: boolean;
}): JSX.Element {
  const dbY = fy + 16;
  return (
    <>
      {/* 左框：共享基础设施（主库） */}
      <rect x={geo.fx} y={fy} width={geo.leftFrameW} height={fh} rx="14" fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.4" strokeDasharray="7 6" opacity="0.5" />
      {/* 右框：隔离区（统一战线目的地） */}
      <rect x={geo.rightX} y={fy} width={geo.rightFrameW} height={fh} rx="14" fill="none"
        stroke={iso.state === 'partial' ? '#f59e0b' : '#10b981'} strokeWidth="1.6" strokeDasharray="7 6"
        opacity={iso.state === 'idle' && draftIsoCount === 0 ? 0.45 : 0.9}
        className={iso.state === 'cloning' ? 'animate-[rsants_1.2s_linear_infinite]' : undefined} />
      {transferActive ? (
        <g>
          <path d={`M ${mainDbX + geo.dbCW} ${dbY + 46} L ${geo.isoX} ${dbY + 46}`} fill="none" stroke="#10b981" strokeWidth="2" strokeDasharray="4 4" />
          {/* 转移动画：一枚小库卡从左框飞进右框 */}
          <g>
            <animateMotion dur="1.4s" repeatCount="indefinite" path={`M ${mainDbX + geo.dbCW} ${dbY + 40} L ${geo.isoX} ${dbY + 40}`} />
            <rect x="-13" y="-9" width="26" height="18" rx="4" fill="hsl(var(--background))" stroke="#10b981" strokeWidth="1.6" />
            <text x="0" y="4" textAnchor="middle" fontSize="8" fontWeight="700" fill="#10b981">DB</text>
          </g>
        </g>
      ) : null}
    </>
  );
}

function DataLayerCards({ geo, dbY, dbInfra, mainDbIdx, iso, draftIsoCount, draftRevertCount, isolateTargets, revertTargets, onIsolateAll, onRevertAll }: {
  geo: ReturnType<typeof dataGeo>; dbY: number; dbInfra: PanelInfraInfo[]; mainDbIdx: number;
  iso: BranchIso; draftIsoCount: number; draftRevertCount: number;
  isolateTargets: string[]; revertTargets: string[]; onIsolateAll: () => void; onRevertAll: () => void;
}): JSX.Element {
  const locked = iso.state === 'done';
  return (
    <>
      {(dbInfra.length ? dbInfra : [{ id: 'db', name: '数据库', dockerImage: '', status: 'running' }]).map((s, i) => {
        const isMainDb = i === mainDbIdx && !/redis/i.test(s.dockerImage || s.id);
        const lockThis = isMainDb && locked;
        return (
          <StageCard key={s.id} x={geo.dbX(i)} y={dbY} w={geo.dbCW} name={s.name || s.id} ico={/redis/i.test(s.dockerImage || s.id) ? 'R' : 'DB'}
            color={/redis/i.test(s.dockerImage || s.id) ? '#c2372f' : '#10b981'} ok={!lockThis} locked={lockThis}
            status={lockThis ? '已上锁 · 副本请求已转移' : isMainDb && iso.state === 'partial' ? '主库 · 仍有服务在写' : isMainDb ? '主库' : '共享实例'} foot={`${s.id}-volume`} />
        );
      })}
      {iso.state === 'idle' && draftIsoCount === 0 ? (
        <button type="button"
          className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/[.06] text-xs font-semibold text-emerald-600 transition-colors hover:border-emerald-500 hover:bg-emerald-500/15 dark:text-emerald-400"
          style={{ left: geo.isoX, top: dbY, width: geo.dbCW, height: 92 }}
          title={`统一战线（分支级）：一次把 ${isolateTargets.length || '所有有副本的'} 个服务的副本切到同一专用隔离实例，禁止一半连主库一半连隔离库。进变更清单，保存后执行`}
          onClick={onIsolateAll}>
          <Copy className="h-4 w-4" />复制隔离到此
          <span className="text-[10px] font-normal opacity-80">统一战线 · 覆盖 {isolateTargets.length} 个服务</span>
        </button>
      ) : iso.state === 'idle' && draftIsoCount > 0 ? (
        <div className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-amber-500/60 bg-amber-500/10 text-xs font-semibold text-amber-600 dark:text-amber-400"
          style={{ left: geo.isoX, top: dbY, width: geo.dbCW, height: 92 }}>
          <Copy className="h-4 w-4" />复制隔离 · 待保存
          <span className="text-[10px] font-normal opacity-80">{draftIsoCount} 个服务</span>
        </div>
      ) : (
        <StageCard x={geo.isoX} y={dbY} w={geo.dbCW} name="隔离区" ico="DB" color={iso.state === 'partial' ? '#f59e0b' : '#10b981'}
          ok={iso.state === 'done'} boot={iso.state === 'cloning'} danger={iso.state === 'partial'}
          status={iso.state === 'cloning' ? '第1步 复制：拷入数据…'
            : iso.state === 'switching' ? '第2步 切换：副本改连新库…'
            : iso.state === 'partial' ? `统一战线未对齐 ${iso.isolatedProfiles.length}/${iso.withMembersProfiles.length}`
            : draftRevertCount > 0 ? '回切主库 · 待保存' : `专用实例 · ${iso.isolatedProfiles.length} 服务已切换`}
          foot={iso.dbNames.join(' · ')}
          extra={(
            <span className="absolute bottom-1.5 right-1.5 flex gap-1">
              {iso.state === 'partial' && isolateTargets.length > 0 ? (
                <button type="button" className="rounded border border-amber-500/60 bg-background px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                  title="把尚未隔离的服务也加入隔离草稿，对齐统一战线" onClick={onIsolateAll}>补齐隔离</button>
              ) : null}
              {(iso.state === 'done' || iso.state === 'partial') && revertTargets.length > 0 ? (
                <button type="button" className="rounded border border-emerald-500/50 bg-background px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
                  title="全部已隔离服务回切主库（隔离库转快照保留）" onClick={onRevertAll}>回切主库</button>
              ) : null}
            </span>
          )} />
      )}
    </>
  );
}

/* ── 容器级画布：全部容器自上而下的调用关系（每容器独立操作）── */
function ContainerGraphStage(props: StageSharedProps): JSX.Element {
  const { branchId, previewUrl, services, infra, replicaSets, candidates, memberLimit, draft, onDraft, onToast, profileIds, graph, branchIso, isolateTargets, revertTargets, isolateAll, revertAll, draftIsoCount, draftRevertCount } = props;
  const [hostRef, w] = useMeasuredWidth();
  const [weightFor, setWeightFor] = useState<string | null>(null); // `${profileId}:${memberId}`
  const [weightDraft, setWeightDraft] = useState('');
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [probeRes, setProbeRes] = useState<ProbeResult | null>(null);
  const [flying, setFlying] = useState<{ path: string; key: number } | null>(null);
  const probing = useRef(false);

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // 分层兜底：graph.layers 可能缺少个别 profile（如仅有历史候选）——补进末层
  const layered = new Set(graph.layers.flat());
  const layers = graph.layers.map((l) => l.filter((id) => profileIds.includes(id)));
  const missing = profileIds.filter((p) => !layered.has(p));
  if (missing.length) layers.push(missing);
  const rows = layers.filter((l) => l.length > 0);

  const entryHost = previewUrl ? new URL(previewUrl).hostname : '预览入口未就绪';
  const dbInfra = infra.filter((s) => /mongo|mysql|mariadb|postgres|redis/i.test(s.dockerImage || s.id));
  const geoProbe = dataGeo(w, Math.max(dbInfra.length, 1));

  const gap = 26, bandH = 196, layerTop = 150;
  const maxRowW = Math.max(0, ...rows.map((l) => l.length * CW + (l.length - 1) * gap));
  const canvasW = Math.max(w, maxRowW + 24, geoProbe.minWidth);
  const geo = dataGeo(canvasW, Math.max(dbInfra.length, 1));
  const entryX = (canvasW - CW) / 2, entryY = 14;
  const fy = layerTop + rows.length * bandH + 18;
  const dbY = fy + 16, fh = 128;
  const height = fy + fh + 44;
  const mainDbIdx = Math.max(dbInfra.findIndex((s) => /mongo|mysql|mariadb|postgres/i.test(s.dockerImage || s.id)), 0);
  const mainDbX = geo.dbX(mainDbIdx);

  const pos = new Map<string, { x: number; cx: number; y: number }>();
  rows.forEach((ids, li) => {
    const rowW = ids.length * CW + (ids.length - 1) * gap;
    const startX = Math.max(8, (canvasW - rowW) / 2);
    ids.forEach((id, i) => {
      const x = startX + i * (CW + gap);
      pos.set(id, { x, cx: x + CW / 2, y: layerTop + li * bandH });
    });
  });

  // 入口直达面：有 pathPrefixes / subdomain 的服务；一个都没有时退化为第 0 层
  const entryFacing = profileIds.filter((p) => {
    const n = nodeById.get(p);
    return (n?.pathPrefixes?.length ?? 0) > 0 || !!n?.subdomain;
  });
  const entryTargets = entryFacing.length > 0 ? entryFacing : (rows[0] ?? []);
  const svcEdges = graph.edges.filter((e) => pos.has(e.from) && pos.has(e.to));
  const infraEdges = graph.edges.filter((e) => pos.has(e.from) && dbInfra.some((s) => s.id === e.to));

  const runProbe = async (profileId: string): Promise<void> => {
    if (probing.current) return;
    probing.current = true;
    setLog([`分流实测 ${profileId} — 串流模式：每个请求等上一个响应返回才发出——`]);
    setProbeRes(null);
    try {
      if (!previewUrl) { onToast?.('该分支还没有预览入口，无法实测'); probing.current = false; return; }
      const res = await apiRequest<ProbeResult>(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/probe`, {
        method: 'POST', body: { host: new URL(previewUrl).hostname, count: 12 },
      });
      const target = pos.get(profileId);
      for (let i = 0; i < res.hits.length; i += 1) {
        const hit = res.hits[i];
        const missed = hit.servedBy === 'untagged' || hit.servedBy === 'error';
        if (!missed && target) {
          setFlying({ path: edgeD(entryX + CW / 2, entryY + 88, target.cx, target.y), key: i });
          await new Promise((r) => setTimeout(r, 520));
          setFlying(null);
        }
        const line = missed
          ? `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'error' ? '连接失败' : '未命中复制集路由'}  HTTP ${hit.status}`
          : `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'primary' ? '主实例' : hit.servedBy}  X-CDS-Replica: ${hit.servedBy}  HTTP ${hit.status}${hit.status >= 200 && hit.status < 300 ? ' OK' : ' · 业务路由响应，落点已验证'}`;
        setLog((prev) => [...prev, line]);
      }
      setProbeRes(res);
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
    }
    probing.current = false;
  };

  const commitWeight = (profileId: string, memberId: string): void => {
    const v = Math.max(0, Math.min(100, Math.round(Number(weightDraft))));
    setWeightFor(null);
    if (!Number.isFinite(v)) return;
    onDraft({ kind: 'set-weight', profileId, params: { memberId, weight: v }, label: `${profileId} · ${memberId === 'primary' ? '主实例' : memberId} 权重 → ${v}` });
  };

  const pickRows = pickFor
    ? (candidates[pickFor] ?? []).filter((row) => !row.isCurrent && !(replicaSets[pickFor]?.members ?? []).some((m) => m.versionId === row.versionId && m.status !== 'error'))
    : [];

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-3">
        <b className="text-sm">调用关系画布</b>
        <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500"><Layers className="mr-1 inline h-3 w-3" />{profileIds.length} 容器 · 边=环境变量引用</span>
        {branchIso.state === 'done' ? <span className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">已隔离 · 统一战线</span> : null}
        {branchIso.state === 'partial' ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">部分隔离 {branchIso.isolatedProfiles.length}/{branchIso.withMembersProfiles.length} · 建议补齐</span> : null}
        {draft.length > 0 ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">{draft.length} 项变更待保存</span> : null}
        <span className="text-[11px] text-muted-foreground">悬停连线可看引用的环境变量 · 所有操作先进变更清单</span>
      </div>

      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
        <div className="relative" style={{ width: canvasW, height, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
          <svg className="pointer-events-none absolute inset-0" width={canvasW} height={height}>
            <defs><marker id="rsArr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker></defs>
            {/* 入口 → 直达服务 */}
            {entryTargets.map((id) => {
              const p = pos.get(id);
              if (!p) return null;
              const hasReplicas = (replicaSets[id]?.members.length ?? 0) > 0;
              return (
                <path key={`entry-${id}`} d={edgeD(entryX + CW / 2, entryY + 88, p.cx, p.y)} fill="none"
                  stroke={hasReplicas ? '#6366f1' : 'hsl(var(--muted-foreground))'} strokeWidth={hasReplicas ? 2 : 1.4}
                  strokeDasharray="5 5" opacity={hasReplicas ? 0.75 : 0.4} markerEnd="url(#rsArr)" />
              );
            })}
            {/* 服务 → 服务（调用链，来自 env 引用 / depends_on）。
                标签沿边错落分布（t 按序递进）：多条边汇入同一目标时不再叠字。 */}
            {svcEdges.map((e, idx) => {
              const a = pos.get(e.from)!, b = pos.get(e.to)!;
              const t = 0.56 + (idx % 3) * 0.14;
              const labelX = a.cx + (b.cx - a.cx) * t;
              const labelY = (a.y + 96) + (b.y - (a.y + 96)) * t + 3;
              const label = e.envKeys.length > 0
                ? `${e.envKeys[0].length > 22 ? `${e.envKeys[0].slice(0, 21)}…` : e.envKeys[0]}${e.envKeys.length > 1 ? ` +${e.envKeys.length - 1}` : ''}`
                : 'depends_on';
              return (
                <g key={`svc-${e.from}-${e.to}`}>
                  <path d={edgeD(a.cx, a.y + 96, b.cx, b.y)} fill="none" stroke="#6366f1" strokeWidth="1.6" strokeDasharray="5 5" opacity="0.55" markerEnd="url(#rsArr)">
                    <title>{`${e.from} 调用 ${e.to}\n${e.envKeys.length ? `环境变量引用：${e.envKeys.join('、')}` : ''}${e.dependsOn ? `${e.envKeys.length ? '\n' : ''}depends_on 声明` : ''}`}</title>
                  </path>
                  <rect x={labelX - 4 - label.length * 2.8} y={labelY - 9} width={label.length * 5.6 + 8} height={13} rx={3}
                    fill="hsl(var(--surface-sunken))" opacity="0.92" />
                  <text x={labelX} y={labelY} textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))" className="font-mono">
                    {label}
                    <title>{e.envKeys.join('、') || 'depends_on'}</title>
                  </text>
                </g>
              );
            })}
            {/* 服务 → 基础设施（淡边；隔离后被切换的服务改连隔离区） */}
            {infraEdges.map((e) => {
              const a = pos.get(e.from)!;
              const idx = dbInfra.findIndex((s) => s.id === e.to);
              const toIso = !!replicaSets[e.from]?.isolated && /mongo|mysql|mariadb|postgres/i.test(dbInfra[idx]?.dockerImage || e.to);
              const tx = toIso ? geo.isoX + geo.dbCW / 2 : geo.dbX(idx) + geo.dbCW / 2;
              return (
                <path key={`infra-${e.from}-${e.to}`} d={edgeD(a.cx, a.y + 96, tx, dbY)} fill="none"
                  stroke={toIso ? '#10b981' : 'hsl(var(--muted-foreground))'} strokeWidth={toIso ? 1.8 : 1.2}
                  strokeDasharray="5 5" opacity={toIso ? 0.7 : 0.16} markerEnd={toIso ? 'url(#rsArr)' : undefined}>
                  <title>{`${e.from} → ${e.to}${e.envKeys.length ? `\n环境变量引用：${e.envKeys.join('、')}` : ''}`}</title>
                </path>
              );
            })}
            <DataLayerSvg geo={geo} fy={fy} fh={fh} iso={branchIso} draftIsoCount={draftIsoCount} mainDbX={mainDbX}
              transferActive={branchIso.state === 'cloning' || branchIso.state === 'switching'} />
            {flying ? (
              <circle key={flying.key} r="4.6" fill="#f59e0b">
                <animateMotion dur="0.5s" repeatCount="1" fill="freeze" path={flying.path} />
              </circle>
            ) : null}
          </svg>

          <StageCard x={entryX} y={entryY} name="入口" ico="GW" color="#6366f1" ok status={entryHost} foot="forwarder · 按权重分流" />

          {rows.flatMap((ids) => ids).map((pid) => {
            const p = pos.get(pid)!;
            const node = nodeById.get(pid);
            const rs = replicaSets[pid];
            const members = rs?.enabled ? rs.members : [];
            const running = members.filter((m) => m.status === 'running');
            const tw = (rs?.primaryWeight ?? 100) + running.reduce((s, m) => s + m.weight, 0);
            const myDraft = draft.filter((d) => d.profileId === pid);
            const draftAdds = myDraft.filter((d) => d.kind === 'add-replica');
            const draftRemovals = new Set(myDraft.filter((d) => d.kind === 'remove-member').map((d) => d.params?.memberId));
            const canAdd = members.length + draftAdds.length < memberLimit;
            const st = serviceStatusText(rs, members);
            const availOld = (candidates[pid] ?? []).filter((row) => !row.isCurrent && !members.some((m) => m.versionId === row.versionId && m.status !== 'error'));
            return (
              <div key={pid}>
                <StageCard x={p.x} y={p.y} w={CW} name={node?.name || pid} ico={isWebLike(node, pid) ? 'WEB' : 'API'}
                  color="#8b8578" ok={!st.danger} danger={st.danger}
                  status={st.text} foot={services?.[pid]?.hostPort ? `:${services[pid].hostPort}` : node?.containerPort ? `容器 :${node.containerPort}` : ''}
                  hero={members.length > 0}
                  extra={members.length > 0 ? (
                    <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-indigo-500/60 bg-indigo-500 px-1 text-[10px] font-bold text-white" title={`复制集 · 1 主 + ${members.length} 副本`}>
                      x{1 + members.length}
                    </span>
                  ) : undefined} />
                {/* 成员条：主实例权重 + 每个副本（权重可点改 / 直达 / 下线）+ 操作行 */}
                <div className="absolute" style={{ left: p.x, top: p.y + 102, width: CW }}>
                  {members.length > 0 ? (
                    <ChipRow key="primary" color="#8b8578" mono="主实例" sub={rs?.primaryReachable === false ? '不可达' : undefined} danger={rs?.primaryReachable === false}
                      weight={weightFor === `${pid}:primary` ? undefined : `${Math.round(((rs?.primaryWeight ?? 100) / tw) * 100)}%`}
                      onWeightClick={() => { setWeightFor(`${pid}:primary`); setWeightDraft(String(rs?.primaryWeight ?? 100)); }}
                      weightInput={weightFor === `${pid}:primary` ? (
                        <WeightInput value={weightDraft} onChange={setWeightDraft} onCommit={() => commitWeight(pid, 'primary')} onCancel={() => setWeightFor(null)} />
                      ) : undefined} />
                  ) : null}
                  {members.map((m, mi) => {
                    const removal = draftRemovals.has(m.id);
                    const url = memberDirectUrl(previewUrl, m.id);
                    return (
                      <ChipRow key={m.id} color={MEMBER_COLORS[mi % MEMBER_COLORS.length]} mono={m.id}
                        sub={m.status === 'provisioning' ? (m.statusMessage || '创建中') : m.status === 'error' ? (m.statusMessage || '失败') : removal ? '待下线（草稿）' : m.reachable === false ? '不可达' : undefined}
                        danger={m.status === 'error' || (m.status === 'running' && m.reachable === false)}
                        boot={m.status === 'provisioning'} dim={removal}
                        weight={m.status === 'running' && weightFor !== `${pid}:${m.id}` ? `${Math.round((m.weight / tw) * 100)}%` : undefined}
                        onWeightClick={m.status === 'running' ? () => { setWeightFor(`${pid}:${m.id}`); setWeightDraft(String(m.weight)); } : undefined}
                        weightInput={weightFor === `${pid}:${m.id}` ? (
                          <WeightInput value={weightDraft} onChange={setWeightDraft} onCommit={() => commitWeight(pid, m.id)} onCancel={() => setWeightFor(null)} />
                        ) : undefined}
                        actions={!removal ? (
                          <>
                            {url && m.status === 'running' ? (
                              <a className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-primary" title="直达该副本" href={url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" /></a>
                            ) : null}
                            <button type="button" className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-destructive" title="下线（进变更清单）"
                              onClick={() => onDraft({ kind: 'remove-member', profileId: pid, params: { memberId: m.id }, label: `${pid} · 下线 ${m.id}` })}>
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </>
                        ) : undefined} />
                    );
                  })}
                  {draftAdds.map((d, i) => (
                    <ChipRow key={d.key} color="#9ca3af" mono={`副本(草稿${i + 1})`} sub={d.params?.versionId ? '历史版本 · 待保存' : '当前版本 · 待保存'} ghost />
                  ))}
                  <div className="mt-1 flex items-center gap-1">
                    {canAdd ? (
                      <button type="button"
                        className="flex flex-1 items-center justify-center gap-0.5 rounded border border-dashed border-indigo-500/50 bg-indigo-500/[.07] px-1 py-0.5 text-[10px] font-semibold text-indigo-500 transition-colors hover:bg-indigo-500 hover:text-white"
                        title="加一个当前版本副本（进变更清单）"
                        onClick={() => onDraft({ kind: 'add-replica', profileId: pid, label: `${pid} · 新增当前版本副本` })}>
                        <Plus className="h-3 w-3" />副本
                      </button>
                    ) : null}
                    {canAdd && availOld.length > 0 ? (
                      <button type="button" className={`rounded border p-0.5 ${pickFor === pid ? 'border-indigo-500 text-indigo-500' : 'border-[hsl(var(--hairline))] bg-background text-muted-foreground hover:text-indigo-500'}`}
                        title="加历史版本副本（下方选择版本）" onClick={() => setPickFor(pickFor === pid ? null : pid)}>
                        <Layers className="h-3 w-3" />
                      </button>
                    ) : null}
                    {running.length > 0 ? (
                      <button type="button" className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-primary"
                        title="分流实测：真实请求穿过入口统计落点" onClick={() => void runProbe(pid)}>
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    ) : null}
                    {members.length > 0 ? (
                      <button type="button" className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-destructive"
                        title="关闭复制集：移除该容器全部副本（进变更清单）"
                        onClick={() => onDraft({ kind: 'dissolve', profileId: pid, label: `${pid} · 关闭复制集（移除全部副本）` })}>
                        <Undo2 className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}

          <DataLayerCards geo={geo} dbY={dbY} dbInfra={dbInfra} mainDbIdx={mainDbIdx} iso={branchIso}
            draftIsoCount={draftIsoCount} draftRevertCount={draftRevertCount}
            isolateTargets={isolateTargets} revertTargets={revertTargets} onIsolateAll={isolateAll} onRevertAll={revertAll} />
        </div>
      </div>

      {pickFor && pickRows.length > 0 ? (
        <div className="mx-5 mb-3 grid gap-1.5">
          <span className="text-[11px] font-semibold text-muted-foreground">{pickFor} · 选择历史版本作为副本：</span>
          {pickRows.slice(0, 6).map((row) => (
            <button key={row.versionId} type="button"
              onClick={() => { setPickFor(null); onDraft({ kind: 'add-replica', profileId: pickFor, params: { versionId: row.versionId }, label: `${pickFor} · 新增历史版本副本 ${row.commitSha.slice(0, 7)}` }); }}
              className="flex items-center gap-4 rounded-md border border-[hsl(var(--hairline))] bg-background px-3 py-2 text-left text-xs hover:border-indigo-500/50 hover:bg-indigo-500/[.06]">
              <span className="font-mono font-semibold">{row.commitSha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{row.image}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</span>
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
      <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] px-5 py-2.5">
        <span className="text-[11px] text-muted-foreground">连线 = 环境变量引用（悬停看键名）· 操作先进变更清单 · 粘性 cookie cds_rs · 响应头 X-CDS-Replica</span>
      </div>
      <style>{'@keyframes rsants{to{stroke-dashoffset:-40}}'}</style>
    </section>
  );
}

/** 成员小条（容器级卡片下方）：状态点 + 名称 + 权重（可点改）+ 动作 */
function ChipRow({ color, mono, sub, weight, onWeightClick, weightInput, actions, danger, boot, ghost, dim }: {
  color: string; mono: string; sub?: string; weight?: string; onWeightClick?: () => void; weightInput?: JSX.Element;
  actions?: JSX.Element; danger?: boolean; boot?: boolean; ghost?: boolean; dim?: boolean;
}): JSX.Element {
  return (
    <div className={`mt-1 flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${danger ? 'border-destructive/50 bg-destructive/[.05]' : ghost ? 'border-dashed border-[hsl(var(--muted-foreground))]/50 opacity-70' : 'border-[hsl(var(--hairline))] bg-background'} ${dim ? 'opacity-50' : ''}`}>
      {boot ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-amber-500" /> : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : ghost ? '#9ca3af' : color }} />
      )}
      <span className={`min-w-0 flex-1 truncate font-mono ${danger ? 'text-destructive' : ''}`} title={sub ? `${mono} · ${sub}` : mono}>
        {mono}{sub ? <span className="ml-1 opacity-70">{sub}</span> : null}
      </span>
      {weightInput}
      {weight !== undefined && !weightInput ? (
        <button type="button" disabled={!onWeightClick} onClick={onWeightClick}
          title={onWeightClick ? '点击调整权重（进变更清单）' : undefined}
          className={`shrink-0 rounded border border-indigo-500/45 bg-background px-1 font-mono text-[9px] text-indigo-500 ${onWeightClick ? 'cursor-pointer hover:bg-indigo-500/10' : ''}`}>
          {weight}
        </button>
      ) : null}
      {actions}
    </div>
  );
}

function WeightInput({ value, onChange, onCommit, onCancel }: { value: string; onChange: (v: string) => void; onCommit: () => void; onCancel: () => void }): JSX.Element {
  return (
    <input autoFocus type="number" min={0} max={100} value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
      className="h-4 w-12 shrink-0 rounded border border-primary bg-background px-0.5 text-center font-mono text-[9px] outline-none" />
  );
}

/* ── 项目级画布：原版舞台形态（入口 → 全部容器 → 基础设施），整组操作 ── */
function ProjectStage(props: StageSharedProps): JSX.Element {
  const { previewUrl, services, infra, replicaSets, memberLimit, draft, onDraft, onToast, profileIds, graph, branchIso, isolateTargets, revertTargets, isolateAll, revertAll, draftIsoCount, draftRevertCount } = props;
  const [hostRef, w] = useMeasuredWidth();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const entryHost = previewUrl ? new URL(previewUrl).hostname : '预览入口未就绪';
  const dbInfra = infra.filter((s) => /mongo|mysql|mariadb|postgres|redis/i.test(s.dockerImage || s.id));
  const addable = profileIds.filter((p) => {
    const members = replicaSets[p]?.enabled ? replicaSets[p].members : [];
    const adds = draft.filter((d) => d.profileId === p && d.kind === 'add-replica').length;
    return members.length + adds < memberLimit;
  });

  const gap = 24;
  const slots = profileIds.length + (addable.length > 0 ? 1 : 0);
  const rowW = slots * CW + (slots - 1) * gap;
  const geoProbe = dataGeo(w, Math.max(dbInfra.length, 1));
  const canvasW = Math.max(w, rowW + 24, geoProbe.minWidth);
  const geo = dataGeo(canvasW, Math.max(dbInfra.length, 1));
  const entryX = (canvasW - CW) / 2, entryY = 14, svcY = 190;
  const fy = 430 - 16, dbY = 430, fh = 128;
  const height = fy + fh + 44;
  const startX = Math.max(8, (canvasW - rowW) / 2);
  const mainDbIdx = Math.max(dbInfra.findIndex((s) => /mongo|mysql|mariadb|postgres/i.test(s.dockerImage || s.id)), 0);
  const mainDbX = geo.dbX(mainDbIdx);
  const svcX = (i: number): number => startX + i * (CW + gap);

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-3">
        <b className="text-sm">项目整组画布</b>
        <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500"><Layers className="mr-1 inline h-3 w-3" />{profileIds.length} 容器 · 整组操作</span>
        {branchIso.state === 'done' ? <span className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">已隔离 · 统一战线</span> : null}
        {branchIso.state === 'partial' ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">部分隔离 {branchIso.isolatedProfiles.length}/{branchIso.withMembersProfiles.length} · 建议补齐</span> : null}
        {draft.length > 0 ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">{draft.length} 项变更待保存</span> : null}
        <span className="text-[11px] text-muted-foreground">副本以「复制集成员」叠卡标记 · 单容器细操作请切换到容器级</span>
      </div>

      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
        <div className="relative" style={{ width: canvasW, height, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
          <svg className="pointer-events-none absolute inset-0" width={canvasW} height={height}>
            <defs><marker id="rsArrP" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker></defs>
            {profileIds.map((pid, i) => {
              const members = replicaSets[pid]?.enabled ? replicaSets[pid].members : [];
              const hasReplicas = members.length > 0;
              const cx = svcX(i) + CW / 2;
              const isolated = !!replicaSets[pid]?.isolated;
              const dbTx = isolated ? geo.isoX + geo.dbCW / 2 : mainDbX + geo.dbCW / 2;
              return (
                <g key={pid}>
                  <path d={edgeD(entryX + CW / 2, entryY + 88, cx, svcY)} fill="none"
                    stroke={hasReplicas ? '#6366f1' : 'hsl(var(--muted-foreground))'} strokeWidth={hasReplicas ? 2 : 1.4}
                    strokeDasharray="5 5" opacity={hasReplicas ? 0.75 : 0.38} markerEnd="url(#rsArrP)" />
                  <path d={edgeD(cx, svcY + 96, dbTx, dbY)} fill="none"
                    stroke={isolated ? '#10b981' : 'hsl(var(--muted-foreground))'} strokeWidth={isolated ? 1.8 : 1.2}
                    strokeDasharray="5 5" opacity={isolated ? 0.65 : 0.2} markerEnd={isolated ? 'url(#rsArrP)' : undefined} />
                </g>
              );
            })}
            <DataLayerSvg geo={geo} fy={fy} fh={fh} iso={branchIso} draftIsoCount={draftIsoCount} mainDbX={mainDbX}
              transferActive={branchIso.state === 'cloning' || branchIso.state === 'switching'} />
          </svg>

          <StageCard x={entryX} y={entryY} name="入口" ico="GW" color="#6366f1" ok status={entryHost} foot="forwarder · 按权重分流" />

          {profileIds.map((pid, i) => {
            const node = nodeById.get(pid);
            const rs = replicaSets[pid];
            const members = rs?.enabled ? rs.members : [];
            const adds = draft.filter((d) => d.profileId === pid && d.kind === 'add-replica').length;
            const st = serviceStatusText(rs, members);
            const x = svcX(i);
            const deck = Math.min(members.length, 2);
            return (
              <div key={pid}>
                {/* 副本叠卡（特殊标记，不隐藏）：主卡背后的偏移卡代表复制集成员 */}
                {Array.from({ length: deck }).map((_, k) => (
                  <div key={k} className="absolute rounded-xl border border-dashed border-indigo-500/50 bg-background/80"
                    style={{ left: x + 7 * (k + 1), top: svcY + 7 * (k + 1), width: CW, height: 96 }} />
                ))}
                <StageCard x={x} y={svcY} w={CW} name={node?.name || pid} ico={isWebLike(node, pid) ? 'WEB' : 'API'}
                  color="#8b8578" ok={!st.danger} danger={st.danger} hero={members.length > 0}
                  status={st.text} foot={services?.[pid]?.hostPort ? `:${services[pid].hostPort}` : node?.containerPort ? `容器 :${node.containerPort}` : ''}
                  extra={members.length > 0 ? (
                    <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-indigo-500/60 bg-indigo-500 px-1 text-[10px] font-bold text-white" title={`复制集 · 1 主 + ${members.length} 副本`}>
                      x{1 + members.length}
                    </span>
                  ) : undefined} />
                {members.length > 0 || adds > 0 ? (
                  <div className="absolute flex flex-col items-center gap-0.5" style={{ left: x, top: svcY + 108 + 7 * deck, width: CW }}>
                    {members.length > 0 ? (
                      <span className="rounded border border-indigo-500/50 bg-indigo-500/10 px-1.5 py-0.5 text-center text-[10px] font-semibold text-indigo-500"
                        title="这是为你创建的复制集成员容器：入口已做好负载，按权重分流">
                        复制集成员 x{members.length} · 已负载
                      </span>
                    ) : null}
                    {rs?.isolated ? (
                      <span className="rounded border border-emerald-500/50 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">已隔离 · {rs.isolated.dbName}</span>
                    ) : null}
                    {adds > 0 ? (
                      <span className="rounded border border-dashed border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">+{adds} 副本草稿 · 待保存</span>
                    ) : null}
                    {members.some((m) => m.status === 'error') ? (
                      <span className="rounded border border-destructive/50 bg-destructive/[.06] px-1.5 py-0.5 text-[10px] text-destructive">有副本失败</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {addable.length > 0 ? (
            <button type="button"
              className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-indigo-500/50 bg-indigo-500/10 text-xs font-semibold text-indigo-500 transition-colors hover:bg-indigo-500 hover:text-white"
              style={{ left: svcX(profileIds.length), top: svcY, width: CW, height: 96 }}
              title={`给每个未满员的容器各加一个当前版本副本（${addable.length} 个，进变更清单）`}
              onClick={() => { addable.forEach((p) => onDraft({ kind: 'add-replica', profileId: p, label: `${p} · 新增当前版本副本（整组）` })); onToast?.(`已加入 ${addable.length} 个容器的副本草稿`); }}>
              <Plus className="h-5 w-5" />整组副本（{addable.length}）
            </button>
          ) : null}

          <DataLayerCards geo={geo} dbY={dbY} dbInfra={dbInfra} mainDbIdx={mainDbIdx} iso={branchIso}
            draftIsoCount={draftIsoCount} draftRevertCount={draftRevertCount}
            isolateTargets={isolateTargets} revertTargets={revertTargets} onIsolateAll={isolateAll} onRevertAll={revertAll} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] px-5 py-2.5">
        <span className="text-[11px] text-muted-foreground">整组操作与隔离统一战线同入变更清单，保存后串行执行 · 单容器权重/下线/分流实测在容器级页签</span>
      </div>
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
      <div className={`absolute rounded-xl border bg-background text-xs shadow-md ${danger ? 'border-destructive/60' : ghost ? 'border-dashed border-[hsl(var(--muted-foreground))]/50 opacity-70' : hero ? 'border-indigo-500/45' : 'border-[hsl(var(--hairline))]'}`}
        style={{ left: x, top: y, width: w, ...(boot ? { animation: 'rscolorin 2.4s forwards' } : {}), ...(locked ? { filter: 'grayscale(0.9)', opacity: 0.65 } : {}) }}>
        {locked ? (
          <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[hsl(var(--hairline))] bg-background text-muted-foreground" title="副本请求已转移到隔离区，回切主库可解锁">
            <Lock className="h-3 w-3" />
          </span>
        ) : null}
        <div className="flex items-center gap-2 overflow-hidden rounded-t-xl px-3 py-2 text-[13px] font-bold">
          <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[10px] font-extrabold text-white" style={{ background: color }}>{ico}</span>
          <span className="truncate">{name}</span>
        </div>
        <div className={`flex items-center gap-1.5 px-3 pb-2 text-[11px] ${danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : ok ? '#10b981' : 'hsl(var(--muted-foreground))' }} />
          <span className="truncate" title={status}>{status}</span>
        </div>
        {foot !== undefined ? (
          <div className="overflow-hidden truncate rounded-b-xl border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-1.5 font-mono text-[10px] text-muted-foreground" title={foot}>{foot || ' '}</div>
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
