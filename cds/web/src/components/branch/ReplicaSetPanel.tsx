/*
 * ReplicaSetPanel — 复制集双画布（模式二选一版，2026-07-24 用户第二次拍板）。
 *
 *   - 管理模式**二选一**：容器级 / 项目级只能启用一种（branch.replicaMode 钉住，
 *     副本清零后自动解除才能换）。另一个页签在钉住期间上锁，不再出现两级混管的乱象。
 *   - 容器级：自上而下调用关系链（边由后端从环境变量引用 + depends_on 推导）。
 *     每个容器是**展开的容器盒**——主实例/副本/草稿都收纳在盒内一眼可见，
 *     加号就在容器盒里；连线盒对盒，不再与实例条互相遮挡。
 *   - 项目级：三个节点——入口 → 项目 → 基础设施。整组加副本 = 项目节点**右侧**
 *     多出一个「整组副本」节点（放不下换行），副本紧跟主容器走。
 *   - 数据隔离统一战线（分支级）：隔离区一次把所有有副本的服务切到同一专用隔离实例。
 *   - 所有操作先进「变更清单」草稿，保存后串行执行；执行中可调序/跳过/取消；
 *     失败红显 + 可选回滚；执行记录持久可查。分流实测为只读诊断即时执行。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, ExternalLink, Layers, Loader2, Lock, Play, Plus, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { apiRequest, ApiError } from '@/lib/api';
import { profileColor } from '@/lib/replica-colors';

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

type ReplicaMode = 'container' | 'project';

interface ReplicaSetsResponse {
  replicaSets: Record<string, ProfileReplicaSetView>;
  candidates: Record<string, ReplicaCandidateView[]>;
  snapshots?: ReplicaDbSnapshotView[];
  memberLimit: number;
  graph?: ServiceGraphView;
  replicaMode?: ReplicaMode | null;
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
const BOX_W = 208;
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
  const [tab, setTab] = useState<ReplicaMode>('container');
  const tabInitRef = useRef(false);
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
      if (!tabInitRef.current) {
        tabInitRef.current = true;
        if (data.replicaMode === 'container' || data.replicaMode === 'project') setTab(data.replicaMode);
      }
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
      body: { onFailure, mode: tab, steps: draft.map((d) => ({ kind: d.kind, profileId: d.profileId, params: d.params })) },
    });
    setDraft([]);
  }, '变更计划已保存，开始按序执行'), [branchId, draft, onFailure, tab, call]);

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
  const totalMembers = Object.values(replicaSets).reduce((s, rs) => s + (rs.enabled ? rs.members.length : 0), 0);
  const pinnedMode = state.data.replicaMode ?? null;
  // 二选一：模式已钉住（还有副本）时，另一个页签只读上锁
  const lockedOther = pinnedMode !== null && totalMembers > 0;
  const activeMode: ReplicaMode = lockedOther ? pinnedMode : tab;
  const viewingLocked = lockedOther && tab !== pinnedMode;

  // 统一战线动作：隔离 / 回切一次覆盖所有符合条件的服务（草稿同入清单）
  const isolateTargets = profileIds.filter((p) => {
    const rs = replicaSets[p];
    const hasMembers = (rs?.enabled && rs.members.length > 0) || draft.some((d) => d.profileId === p && d.kind === 'add-replica');
    return hasMembers && !rs?.isolated && !draft.some((d) => d.profileId === p && d.kind === 'isolate-db');
  });
  const revertTargets = profileIds.filter((p) => !!replicaSets[p]?.isolated && !draft.some((d) => d.profileId === p && d.kind === 'revert-db'));
  const isolateAll = (): void => {
    if (isolateTargets.length === 0) { onToast?.('隔离作用于副本——先加副本，同一计划内先加副本再隔离'); return; }
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

  const modeLabel = (m: ReplicaMode): string => (m === 'container' ? '容器级' : '项目级');

  return (
    <div className="grid gap-4">
      <section className="cds-surface-raised cds-hairline flex flex-wrap items-center gap-3 px-5 py-2.5">
        <div className="inline-flex overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
          {(['container', 'project'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setTab(m)}
              className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs ${tab === m ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'}`}
              title={lockedOther && pinnedMode !== m ? `该分支已按${modeLabel(pinnedMode!)}管理，关闭全部复制集后可切换` : undefined}>
              {lockedOther && pinnedMode !== m ? <Lock className="h-3 w-3" /> : null}
              {modeLabel(m)}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {lockedOther
            ? `管理模式二选一：当前按${modeLabel(pinnedMode!)}管理（${totalMembers} 个副本）`
            : tab === 'container'
              ? '自上而下调用关系链，容器展开可见内部实例，每容器就地加副本'
              : '三节点：入口 → 项目 → 基础设施；整组副本作为节点长在项目右侧'}
        </span>
        {/* 右上角执行区（2026-07-25 用户拍板：不再悬浮，杜绝与底部通知带重叠） */}
        <span className="ml-auto flex items-center gap-2">
          {totalMembers > 0 && !activePlan ? (
            <Button type="button" size="sm" variant="outline" disabled={busy}
              title="一键还原：全部容器回到普通模式（移除全部副本，隔离库转快照保留）——进变更清单，保存后执行"
              onClick={() => {
                let n = 0;
                for (const p of profileIds) {
                  const rs = replicaSets[p];
                  if (rs?.enabled && rs.members.length > 0 && !draft.some((d) => d.profileId === p && d.kind === 'dissolve')) {
                    addDraft({ kind: 'dissolve', profileId: p, label: `${p} · 关闭复制集（一键还原）` });
                    n += 1;
                  }
                }
                if (n) onToast?.(`一键还原：已加入 ${n} 个容器的关闭复制集草稿，点「保存执行」生效`);
              }}>
              <Undo2 />一键还原
            </Button>
          ) : null}
          {activePlan ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              执行中 {activePlan.steps.filter((s) => s.status === 'done').length}/{activePlan.steps.length}
            </span>
          ) : draft.length > 0 ? (
            <>
              {/* 放弃变更 ≠ 一键还原：前者只扔掉本页未保存的草稿（什么都不执行），
                  后者是业务动作（关闭全部复制集回普通模式）。2026-07-25 用户点破，分开摆 */}
              <Button type="button" size="sm" variant="ghost" disabled={busy}
                title="放弃本页累积的全部草稿，不执行任何操作（线上现状不变）"
                onClick={() => { setDraft(() => []); onToast?.('已放弃全部未保存的变更，未执行任何操作'); }}>
                <X />放弃变更
              </Button>
              <Button type="button" size="sm" disabled={busy} title="保存并按序执行变更清单" onClick={savePlan}>
                <Play />保存执行（{draft.length} 步）
              </Button>
            </>
          ) : null}
        </span>
      </section>

      {viewingLocked ? (
        <section className="cds-surface-raised cds-hairline flex flex-col items-center gap-3 px-5 py-12 text-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground">
            <Lock className="h-5 w-5" />
          </span>
          <p className="text-sm font-semibold">{modeLabel(tab)}暂不可用 — 管理模式二选一</p>
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            该分支的复制集当前由「{modeLabel(pinnedMode!)}」管理（还有 {totalMembers} 个副本在运行）。
            为避免两种视角互相踩踏，同一时间只能启用一种。回到{modeLabel(pinnedMode!)}关闭全部复制集后，这里会自动解锁。
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => setTab(pinnedMode!)}>回到{modeLabel(pinnedMode!)}</Button>
        </section>
      ) : activeMode === 'container' ? (
        <ContainerGraphStage {...stageProps} />
      ) : (
        <ProjectStage {...stageProps} />
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

/* ── 数据层（两个画布共用）：左框共享基础设施（主库）+ 右框隔离区（统一战线）── */
function DataLayerSvg({ geo, fy, fh, iso, draftIsoCount, mainDbX, transferActive }: {
  geo: ReturnType<typeof dataGeo>; fy: number; fh: number; iso: BranchIso; draftIsoCount: number; mainDbX: number; transferActive: boolean;
}): JSX.Element {
  const dbY = fy + 16;
  return (
    <>
      <rect x={geo.fx} y={fy} width={geo.leftFrameW} height={fh} rx="14" fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.4" strokeDasharray="7 6" opacity="0.5" />
      <rect x={geo.rightX} y={fy} width={geo.rightFrameW} height={fh} rx="14" fill="none"
        stroke={iso.state === 'partial' ? '#f59e0b' : '#10b981'} strokeWidth="1.6" strokeDasharray="7 6"
        opacity={iso.state === 'idle' && draftIsoCount === 0 ? 0.45 : 0.9}
        className={iso.state === 'cloning' ? 'animate-[rsants_1.2s_linear_infinite]' : undefined} />
      {transferActive ? (
        <g>
          <path d={`M ${mainDbX + geo.dbCW} ${dbY + 46} L ${geo.isoX} ${dbY + 46}`} fill="none" stroke="#10b981" strokeWidth="2" strokeDasharray="4 4" />
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

/* ── 容器级画布：调用关系链 + 展开的容器盒（Railway 风简洁行；加号挂在盒外右侧）── */
const BOX_ROW_H = 22;
function containerBoxHeight(rows: number): number {
  return 64 + rows * BOX_ROW_H;
}

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
  const layered = new Set(graph.layers.flat());
  const layers = graph.layers.map((l) => l.filter((id) => profileIds.includes(id)));
  const missing = profileIds.filter((p) => !layered.has(p));
  if (missing.length) layers.push(missing);
  const rows = layers.filter((l) => l.length > 0);

  const boxRowsOf = (pid: string): number => {
    const members = replicaSets[pid]?.enabled ? replicaSets[pid].members : [];
    const adds = draft.filter((d) => d.profileId === pid && d.kind === 'add-replica').length;
    return (members.length > 0 ? 1 : 0) + members.length + adds;
  };
  const boxH = (pid: string): number => containerBoxHeight(boxRowsOf(pid));

  const entryHost = previewUrl ? new URL(previewUrl).hostname : '预览入口未就绪';
  const dbInfra = infra.filter((s) => /mongo|mysql|mariadb|postgres|redis/i.test(s.dockerImage || s.id));
  const geoProbe = dataGeo(w, Math.max(dbInfra.length, 1));

  // gap 留出盒外右侧的加号小按钮（Railway 风：加号不进盒内）
  const gap = 52, layerGap = 66, layerTop = 150;
  const maxRowW = Math.max(0, ...rows.map((l) => l.length * BOX_W + (l.length - 1) * gap));
  const canvasW = Math.max(w, maxRowW + 24, geoProbe.minWidth);
  const geo = dataGeo(canvasW, Math.max(dbInfra.length, 1));
  const entryX = (canvasW - CW) / 2, entryY = 14;

  // 逐层定位：层高 = 该层最高容器盒 + 间隔（盒高随实例数伸缩）
  const pos = new Map<string, { x: number; cx: number; y: number; h: number }>();
  let cursorY = layerTop;
  rows.forEach((ids) => {
    const rowW = ids.length * BOX_W + (ids.length - 1) * gap;
    const startX = Math.max(8, (canvasW - rowW) / 2);
    let rowMaxH = 0;
    ids.forEach((id, i) => {
      const h = boxH(id);
      rowMaxH = Math.max(rowMaxH, h);
      pos.set(id, { x: startX + i * (BOX_W + gap), cx: startX + i * (BOX_W + gap) + BOX_W / 2, y: cursorY, h });
    });
    cursorY += rowMaxH + layerGap;
  });
  const fy = cursorY - layerGap + 26;
  const dbY = fy + 16, fh = 128;
  const height = fy + fh + 44;
  const mainDbIdx = Math.max(dbInfra.findIndex((s) => /mongo|mysql|mariadb|postgres/i.test(s.dockerImage || s.id)), 0);
  const mainDbX = geo.dbX(mainDbIdx);

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
        <span className="text-[11px] text-muted-foreground">悬停连线看环境变量键名 · 操作先进变更清单</span>
      </div>

      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
        <div className="relative" style={{ width: canvasW, height, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
          <svg className="pointer-events-none absolute inset-0" width={canvasW} height={height}>
            <defs><marker id="rsArr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker></defs>
            {entryTargets.map((id) => {
              const p = pos.get(id);
              if (!p) return null;
              const hasReplicas = (replicaSets[id]?.members.length ?? 0) > 0;
              return (
                <path key={`entry-${id}`} d={edgeD(entryX + CW / 2, entryY + 88, p.cx, p.y)} fill="none"
                  stroke={hasReplicas ? '#6366f1' : 'hsl(var(--muted-foreground))'} strokeWidth={hasReplicas ? 2 : 1.4}
                  strokeDasharray="5 5" opacity={hasReplicas ? 0.7 : 0.4} markerEnd="url(#rsArr)" />
              );
            })}
            {/* 服务 → 服务（调用链）。标签沿边错落分布：多条边汇入同一目标不叠字。 */}
            {svcEdges.map((e, idx) => {
              const a = pos.get(e.from)!, b = pos.get(e.to)!;
              const t = 0.56 + (idx % 3) * 0.14;
              const labelX = a.cx + (b.cx - a.cx) * t;
              const labelY = (a.y + a.h) + (b.y - (a.y + a.h)) * t + 3;
              const label = e.envKeys.length > 0
                ? `${e.envKeys[0].length > 22 ? `${e.envKeys[0].slice(0, 21)}…` : e.envKeys[0]}${e.envKeys.length > 1 ? ` +${e.envKeys.length - 1}` : ''}`
                : 'depends_on';
              return (
                <g key={`svc-${e.from}-${e.to}`}>
                  <path d={edgeD(a.cx, a.y + a.h, b.cx, b.y)} fill="none" stroke="#6366f1" strokeWidth="1.6" strokeDasharray="5 5" opacity="0.55" markerEnd="url(#rsArr)">
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
            {infraEdges.map((e) => {
              const a = pos.get(e.from)!;
              const idx = dbInfra.findIndex((s) => s.id === e.to);
              const toIso = !!replicaSets[e.from]?.isolated && /mongo|mysql|mariadb|postgres/i.test(dbInfra[idx]?.dockerImage || e.to);
              const tx = toIso ? geo.isoX + geo.dbCW / 2 : geo.dbX(idx) + geo.dbCW / 2;
              return (
                <path key={`infra-${e.from}-${e.to}`} d={edgeD(a.cx, a.y + a.h, tx, dbY)} fill="none"
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
            const color = profileColor(pid);
            const rs = replicaSets[pid];
            const members = rs?.enabled ? rs.members : [];
            const running = members.filter((m) => m.status === 'running');
            const tw = (rs?.primaryWeight ?? 100) + running.reduce((s, m) => s + m.weight, 0);
            const myDraft = draft.filter((d) => d.profileId === pid);
            const draftAdds = myDraft.filter((d) => d.kind === 'add-replica');
            const draftRemovals = new Set(myDraft.filter((d) => d.kind === 'remove-member').map((d) => d.params?.memberId));
            const canAdd = members.length + draftAdds.length < memberLimit;
            const danger = rs?.primaryReachable === false || members.some((m) => m.status === 'error');
            const availOld = (candidates[pid] ?? []).filter((row) => !row.isCurrent && !members.some((m) => m.versionId === row.versionId && m.status !== 'error'));
            return (
              <div key={pid}>
                <div className="absolute overflow-hidden rounded-xl border-[1.5px] bg-background text-xs shadow-md"
                  style={{ left: p.x, top: p.y, width: BOX_W, height: p.h, borderColor: danger ? 'hsl(var(--destructive) / 0.6)' : `${color}59` }}>
                  <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] font-bold">
                    <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[9px] font-extrabold text-white" style={{ background: color }}>{isWebLike(node, pid) ? 'WEB' : 'API'}</span>
                    <span className="min-w-0 flex-1 truncate" title={pid}>{node?.name || pid}</span>
                    {members.length > 0 ? (
                      <span className="inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[10px] font-bold text-white" style={{ background: color }} title={`1 主 + ${members.length} 副本`}>
                        x{1 + members.length}
                      </span>
                    ) : null}
                  </div>
                  <div className={`flex h-[20px] items-center gap-1.5 px-2.5 text-[10px] ${danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : '#10b981' }} />
                    <span className="min-w-0 flex-1 truncate">
                      {rs?.primaryReachable === false ? '主实例不可达' : members.some((m) => m.status === 'provisioning') ? '副本创建中…' : members.length > 0 ? '按权重分流' : '单实例'}
                    </span>
                    <span className="shrink-0 font-mono">{services?.[pid]?.hostPort ? `:${services[pid].hostPort}` : node?.containerPort ? `:${node.containerPort}` : ''}</span>
                  </div>
                  {members.length > 0 ? (
                    <ChipRow key="primary" color="#8b8578" mono="主实例" sub={rs?.primaryReachable === false ? '不可达' : undefined} danger={rs?.primaryReachable === false}
                      weight={weightFor === `${pid}:primary` ? undefined : `${Math.round(((rs?.primaryWeight ?? 100) / tw) * 100)}%`}
                      onWeightClick={() => { setWeightFor(`${pid}:primary`); setWeightDraft(String(rs?.primaryWeight ?? 100)); }}
                      weightInput={weightFor === `${pid}:primary` ? (
                        <WeightInput value={weightDraft} onChange={setWeightDraft} onCommit={() => commitWeight(pid, 'primary')} onCancel={() => setWeightFor(null)} />
                      ) : undefined} />
                  ) : null}
                  {members.map((m) => {
                    const removal = draftRemovals.has(m.id);
                    const url = memberDirectUrl(previewUrl, m.id);
                    return (
                      <ChipRow key={m.id} color={color} mono={m.id}
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
                </div>
                {/* 盒外右侧小按钮（Railway 风，2026-07-25 用户拍板：加号不进盒内） */}
                <div className="absolute flex flex-col gap-1.5" style={{ left: p.x + BOX_W + 8, top: p.y + 6 }}>
                  {canAdd ? (
                    <button type="button"
                      className="flex h-6 w-6 items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:text-white"
                      style={{ borderColor: `${color}90`, color }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = color; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                      title="加一个副本：再起一个当前版本的实例，与主实例按权重分流（进变更清单）"
                      onClick={() => onDraft({ kind: 'add-replica', profileId: pid, label: `${pid} · 新增当前版本副本` })}>
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {canAdd && availOld.length > 0 ? (
                    <button type="button" className={`flex h-6 w-6 items-center justify-center rounded-full border bg-background shadow-sm ${pickFor === pid ? 'border-indigo-500 text-indigo-500' : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-indigo-500'}`}
                      title="用旧版本起副本：从历史部署版本里挑一个，与当前版本并排跑（新旧对比 / 灰度回退用；点开在画布下方选版本）" onClick={() => setPickFor(pickFor === pid ? null : pid)}>
                      <Layers className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {running.length > 0 ? (
                    <button type="button" className="flex h-6 w-6 items-center justify-center rounded-full border border-[hsl(var(--hairline))] bg-background text-muted-foreground shadow-sm hover:text-primary"
                      title="分流实测：真实请求穿过入口统计落点" onClick={() => void runProbe(pid)}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
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

/** 实例行（容器盒内，Railway 风：细分隔线 + 素净行，无边框小盒）：状态点 + 名称 + 权重（可点改）+ 动作 */
function ChipRow({ color, mono, sub, weight, onWeightClick, weightInput, actions, danger, boot, ghost, dim }: {
  color: string; mono: string; sub?: string; weight?: string; onWeightClick?: () => void; weightInput?: JSX.Element;
  actions?: JSX.Element; danger?: boolean; boot?: boolean; ghost?: boolean; dim?: boolean;
}): JSX.Element {
  return (
    <div className={`flex h-[22px] items-center gap-1.5 border-t border-[hsl(var(--hairline))]/70 px-2.5 text-[10px] ${danger ? 'bg-destructive/[.06] text-destructive' : ghost ? 'text-muted-foreground opacity-80' : ''} ${dim ? 'opacity-50' : ''}`}>
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

/* ── 项目级画布：三节点（入口 → 项目 → 基础设施）。整组副本 = 项目右侧长出的节点 ── */
const PROJ_W = 208;
const GROUP_W = 180;

function ProjectStage(props: StageSharedProps): JSX.Element {
  const { previewUrl, infra, replicaSets, memberLimit, draft, onDraft, onToast, profileIds, branchIso, isolateTargets, revertTargets, isolateAll, revertAll, draftIsoCount, draftRevertCount } = props;
  const [hostRef, w] = useMeasuredWidth();
  const [weightFor, setWeightFor] = useState<number | null>(null);
  const [weightDraft, setWeightDraft] = useState('');

  const entryHost = previewUrl ? new URL(previewUrl).hostname : '预览入口未就绪';
  const dbInfra = infra.filter((s) => /mongo|mysql|mariadb|postgres|redis/i.test(s.dockerImage || s.id));

  // 整组视角：第 k 组 = 每个容器按创建序的第 k 个副本
  const membersOf = (pid: string): ReplicaMemberView[] => (replicaSets[pid]?.enabled ? replicaSets[pid].members : []);
  const groupCount = Math.max(0, ...profileIds.map((p) => membersOf(p).length));
  const uneven = profileIds.some((p) => membersOf(p).length !== groupCount) && groupCount > 0;
  const addable = profileIds.filter((p) => {
    const adds = draft.filter((d) => d.profileId === p && d.kind === 'add-replica').length;
    return membersOf(p).length + adds < memberLimit;
  });
  const draftGroupAdds = Math.max(0, ...profileIds.map((p) => draft.filter((d) => d.profileId === p && d.kind === 'add-replica').length));
  const canAddGroup = addable.length > 0;

  // 中间行节点序列：项目主节点 + 整组副本节点们 + 草稿幽灵 + 添加按钮；放不下换行（副本紧跟主容器右侧）
  // 容器名较长时每枚 chip 独占一行，高度按一行一枚估算，避免溢出盒外
  const PROJ_H = 64 + profileIds.length * 21 + 12;
  const GROUP_H = 96;
  const gap = 26;
  const midNodes: Array<{ kind: 'main' | 'group' | 'ghost' | 'add'; k?: number; w: number; h: number }> = [
    { kind: 'main', w: PROJ_W, h: PROJ_H },
    ...Array.from({ length: groupCount }, (_, k) => ({ kind: 'group' as const, k, w: GROUP_W, h: GROUP_H })),
    ...Array.from({ length: draftGroupAdds }, (_, k) => ({ kind: 'ghost' as const, k, w: GROUP_W, h: GROUP_H })),
    ...(canAddGroup ? [{ kind: 'add' as const, w: GROUP_W, h: GROUP_H }] : []),
  ];
  const geoProbe = dataGeo(w, Math.max(dbInfra.length, 1));
  const canvasW = Math.max(w, geoProbe.minWidth, PROJ_W + 2 * (GROUP_W + gap) + 40);
  const geo = dataGeo(canvasW, Math.max(dbInfra.length, 1));

  // 换行布局：主节点固定行首（居中偏左），副本节点依序排右侧，超宽换行
  const rowsOut: Array<Array<{ node: typeof midNodes[number]; x: number }>> = [];
  {
    const totalW = midNodes.reduce((s, n) => s + n.w, 0) + (midNodes.length - 1) * gap;
    let startX = Math.max(12, (canvasW - Math.min(totalW, canvasW - 24)) / 2);
    let x = startX, row: Array<{ node: typeof midNodes[number]; x: number }> = [];
    for (const node of midNodes) {
      if (row.length > 0 && x + node.w > canvasW - 12) {
        rowsOut.push(row);
        row = [];
        x = startX;
      }
      row.push({ node, x });
      x += node.w + gap;
    }
    if (row.length) rowsOut.push(row);
  }
  const entryX = (canvasW - CW) / 2, entryY = 14;
  const midTop = 190;
  const rowHeights = rowsOut.map((r) => Math.max(...r.map((n) => n.node.h)));
  const rowY: number[] = [];
  {
    let y = midTop;
    rowsOut.forEach((_, i) => { rowY.push(y); y += rowHeights[i] + 30; });
  }
  const midBottom = rowY.length ? rowY[rowY.length - 1] + rowHeights[rowHeights.length - 1] : midTop + PROJ_H;
  const fy = midBottom + 56;
  const dbY = fy + 16, fh = 128;
  const height = fy + fh + 44;
  const mainDbIdx = Math.max(dbInfra.findIndex((s) => /mongo|mysql|mariadb|postgres/i.test(s.dockerImage || s.id)), 0);
  const mainDbX = geo.dbX(mainDbIdx);

  // 展平定位（带行号）
  const placed = rowsOut.flatMap((row, ri) => row.map((n) => ({ ...n, y: rowY[ri] })));
  const allIsolated = branchIso.state === 'done';

  const groupStatus = (k: number): { ok: number; boot: number; bad: number; missing: number; weightPct: number } => {
    let ok = 0, boot = 0, bad = 0, missing = 0;
    let pct = 0, pctN = 0;
    for (const pid of profileIds) {
      const m = membersOf(pid)[k];
      if (!m) { missing += 1; continue; }
      if (m.status === 'running' && m.reachable !== false) ok += 1;
      else if (m.status === 'provisioning') boot += 1;
      else bad += 1;
      const rs = replicaSets[pid]!;
      const tw = rs.primaryWeight + rs.members.filter((x) => x.status === 'running').reduce((s, x) => s + x.weight, 0);
      if (m.status === 'running' && tw > 0) { pct += (m.weight / tw) * 100; pctN += 1; }
    }
    return { ok, boot, bad, missing, weightPct: pctN ? Math.round(pct / pctN) : 0 };
  };

  const removeGroup = (k: number): void => {
    let n = 0;
    for (const pid of profileIds) {
      const m = membersOf(pid)[k];
      if (m) { onDraft({ kind: 'remove-member', profileId: pid, params: { memberId: m.id }, label: `${pid} · 下线 ${m.id}（整组 ${k + 1}）` }); n += 1; }
    }
    if (n) onToast?.(`已加入整组副本 ${k + 1} 的 ${n} 条下线草稿`);
  };
  const commitGroupWeight = (k: number): void => {
    const v = Math.max(0, Math.min(100, Math.round(Number(weightDraft))));
    setWeightFor(null);
    if (!Number.isFinite(v)) return;
    for (const pid of profileIds) {
      const m = membersOf(pid)[k];
      if (m) onDraft({ kind: 'set-weight', profileId: pid, params: { memberId: m.id, weight: v }, label: `${pid} · ${m.id} 权重 → ${v}（整组 ${k + 1}）` });
    }
  };
  const addGroup = (): void => {
    addable.forEach((p) => onDraft({ kind: 'add-replica', profileId: p, label: `${p} · 新增当前版本副本（整组）` }));
    onToast?.(`整组副本草稿已加入（${addable.length} 个容器各 1 个）`);
  };

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-3">
        <b className="text-sm">项目画布</b>
        <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500"><Layers className="mr-1 inline h-3 w-3" />入口 → 项目 → 基础设施</span>
        {groupCount > 0 ? <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] text-indigo-500">整组副本 x{groupCount}</span> : null}
        {uneven ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">各容器副本数不齐</span> : null}
        {branchIso.state === 'done' ? <span className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">已隔离 · 统一战线</span> : null}
        {branchIso.state === 'partial' ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">部分隔离 {branchIso.isolatedProfiles.length}/{branchIso.withMembersProfiles.length}</span> : null}
        {draft.length > 0 ? <span className="rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">{draft.length} 项变更待保存</span> : null}
      </div>

      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
        <div className="relative" style={{ width: canvasW, height, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
          <svg className="pointer-events-none absolute inset-0" width={canvasW} height={height}>
            <defs><marker id="rsArrP" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker></defs>
            {placed.map((n, i) => {
              if (n.node.kind === 'add') return null;
              const cx = n.x + n.node.w / 2;
              const ghost = n.node.kind === 'ghost';
              const group = n.node.kind === 'group';
              return (
                <g key={`edges-${i}`}>
                  <path d={edgeD(entryX + CW / 2, entryY + 88, cx, n.y)} fill="none"
                    stroke={group ? '#6366f1' : 'hsl(var(--muted-foreground))'} strokeWidth={group ? 2 : 1.4}
                    strokeDasharray="5 5" opacity={ghost ? 0.2 : group ? 0.7 : 0.45} markerEnd={ghost ? undefined : 'url(#rsArrP)'} />
                  {!ghost ? (
                    <path d={edgeD(cx, n.y + n.node.h, (group && allIsolated ? geo.isoX : mainDbX) + geo.dbCW / 2, dbY)} fill="none"
                      stroke={group && allIsolated ? '#10b981' : 'hsl(var(--muted-foreground))'} strokeWidth={group && allIsolated ? 1.8 : 1.2}
                      strokeDasharray="5 5" opacity={group && allIsolated ? 0.65 : 0.22} markerEnd={group && allIsolated ? 'url(#rsArrP)' : undefined} />
                  ) : null}
                </g>
              );
            })}
            <DataLayerSvg geo={geo} fy={fy} fh={fh} iso={branchIso} draftIsoCount={draftIsoCount} mainDbX={mainDbX}
              transferActive={branchIso.state === 'cloning' || branchIso.state === 'switching'} />
          </svg>

          <StageCard x={entryX} y={entryY} name="入口" ico="GW" color="#6366f1" ok status={entryHost} foot="forwarder · 按权重分流" />

          {placed.map((n, i) => {
            if (n.node.kind === 'main') {
              return (
                <div key={`main-${i}`} className="absolute rounded-xl border-[1.5px] border-[hsl(var(--hairline))] bg-background text-xs shadow-md"
                  style={{ left: n.x, top: n.y, width: PROJ_W, height: n.node.h }}>
                  <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] font-bold">
                    <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-[#8b8578] text-[10px] font-extrabold text-white">PRJ</span>
                    <span className="min-w-0 flex-1 truncate">项目</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 pt-0.5 text-[10px] text-muted-foreground">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                    {profileIds.length} 容器 · 主实例组
                  </div>
                  <div className="flex flex-wrap gap-1 px-2.5 pb-2 pt-1">
                    {profileIds.map((pid) => (
                      <span key={pid} className="inline-flex max-w-full items-center gap-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-1 text-[9px] font-mono">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: profileColor(pid) }} />
                        <span className="truncate" title={pid}>{pid}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            }
            if (n.node.kind === 'group') {
              const k = n.node.k!;
              const st = groupStatus(k);
              const danger = st.bad > 0;
              return (
                <div key={`group-${k}`} className={`absolute rounded-xl border-[1.5px] border-dashed bg-background text-xs shadow-md ${danger ? 'border-destructive/60' : 'border-indigo-500/55'}`}
                  style={{ left: n.x, top: n.y, width: GROUP_W, height: n.node.h }}>
                  <div className="flex items-center gap-2 px-2.5 pt-2 text-[12px] font-bold">
                    <span className="inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-md bg-indigo-500 text-[10px] font-extrabold text-white">R{k + 1}</span>
                    <span className="min-w-0 flex-1 truncate">整组副本 {k + 1}</span>
                    <button type="button" className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-destructive"
                      title="下线这一组（每个容器各下线对应副本，进变更清单）" onClick={() => removeGroup(k)}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className={`flex items-center gap-1.5 px-2.5 pt-1 text-[10px] ${danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                    {st.boot > 0 ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-amber-500" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : '#10b981' }} />}
                    <span className="truncate">{st.boot > 0 ? '创建中…' : danger ? `${st.bad} 个容器副本异常` : st.missing > 0 ? `覆盖 ${profileIds.length - st.missing}/${profileIds.length} 容器` : '全容器就绪'}</span>
                    {weightFor === k ? (
                      <WeightInput value={weightDraft} onChange={setWeightDraft} onCommit={() => commitGroupWeight(k)} onCancel={() => setWeightFor(null)} />
                    ) : st.ok > 0 ? (
                      <button type="button" className="ml-auto shrink-0 rounded border border-indigo-500/45 bg-background px-1 font-mono text-[9px] text-indigo-500 hover:bg-indigo-500/10"
                        title="点击调整这一组的权重（整组统一，进变更清单）"
                        onClick={() => { setWeightFor(k); setWeightDraft(String(membersOf(profileIds[0])[k]?.weight ?? 0)); }}>
                        {st.weightPct}%
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1 px-2.5 pt-1">
                    {profileIds.map((pid) => {
                      const m = membersOf(pid)[k];
                      const c = !m ? '#9ca3af' : m.status === 'running' && m.reachable !== false ? '#10b981' : m.status === 'provisioning' ? '#f59e0b' : '#ef4444';
                      return <span key={pid} className="h-2 w-2 rounded-full" style={{ background: c, opacity: m ? 1 : 0.4 }} title={`${pid}：${m ? (m.status === 'running' ? (m.reachable === false ? '不可达' : '运行中') : m.status) : '缺此组副本'}`} />;
                    })}
                  </div>
                  <div className="px-2.5 pb-2 pt-1">
                    <span className="inline-flex rounded border border-indigo-500/50 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-500"
                      title="这是为你创建的复制集成员容器组：入口已做好负载，按权重分流">复制集成员 · 已负载</span>
                  </div>
                </div>
              );
            }
            if (n.node.kind === 'ghost') {
              return (
                <div key={`ghost-${i}`} className="absolute flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-amber-500/60 bg-amber-500/[.06] text-[11px] font-semibold text-amber-600 dark:text-amber-400"
                  style={{ left: n.x, top: n.y, width: GROUP_W, height: n.node.h }}>
                  <Layers className="h-4 w-4" />整组副本 · 待保存
                </div>
              );
            }
            return (
              <button key={`add-${i}`} type="button"
                className="absolute flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-indigo-500/50 bg-indigo-500/10 text-xs font-semibold text-indigo-500 transition-colors hover:bg-indigo-500 hover:text-white"
                style={{ left: n.x, top: n.y, width: GROUP_W, height: n.node.h }}
                title={`加一组副本：${addable.length} 个容器各加一个当前版本副本（进变更清单）`}
                onClick={addGroup}>
                <Plus className="h-5 w-5" />整组副本
              </button>
            );
          })}

          <DataLayerCards geo={geo} dbY={dbY} dbInfra={dbInfra} mainDbIdx={mainDbIdx} iso={branchIso}
            draftIsoCount={draftIsoCount} draftRevertCount={draftRevertCount}
            isolateTargets={isolateTargets} revertTargets={revertTargets} onIsolateAll={isolateAll} onRevertAll={revertAll} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] px-5 py-2.5">
        <span className="text-[11px] text-muted-foreground">整组副本紧跟项目节点右侧生长（放不下换行）· 操作与隔离统一战线同入变更清单，保存后串行执行</span>
      </div>
      <style>{'@keyframes rsants{to{stroke-dashoffset:-40}}'}</style>
    </section>
  );
}

const MEMBER_COLORS = ['#6366f1', '#0ea5e9', '#14b8a6'];
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
