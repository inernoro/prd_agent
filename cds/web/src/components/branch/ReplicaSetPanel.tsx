/*
 * ReplicaSetPanel — 复制集双画布（草稿预期管理版，2026-07-25 用户拍板）。
 *
 *   - 管理模式**二选一**：容器级 / 项目级只能启用一种（branch.replicaMode 钉住，
 *     副本清零自动解除才能换）。模式切换按钮并入画布头部一行，压缩纵向空间。
 *   - **草稿按用户操作聚合**：一次手势（整组副本 / 统一战线隔离 / 一键还原）= 一条草稿，
 *     保存时才展开为串行步骤。支持「撤销上一步」（按手势回退）与「放弃变更」（全部丢弃）。
 *   - **草稿预期管理**：所有草稿一律黄色（amber）。复制隔离在画布上直接画出将来的样子——
 *     主库置灰上锁（预览）、隔离区出现一张与主库同样式的黄色副本库卡、黄色虚线预连——
 *     保存执行 = 黄色转正常色，用户始终知道「保存后会变成什么」。
 *   - 容器级：调用关系链 + 展开的容器盒（Railway 风简洁行；加号挂盒外右侧）；
 *     项目级：三节点（入口 → 项目 → 基础设施），整组副本节点长在项目右侧。
 *   - 失败红显 + 可选回滚 + 执行记录持久可查。分流实测为只读诊断即时执行。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Database, ExternalLink, Layers, Loader2, Lock, Play, Plus, RefreshCw, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { apiRequest, ApiError } from '@/lib/api';
import { profileColor } from '@/lib/replica-colors';
import { buildProjectGroups, newProjectGroupId, replicaSharePct, REPLICA_PLAN_MAX_STEPS } from '@/lib/replicaGroups';
import { ReplicaLoadTestPanel, type LoadTestMemberOption } from '@/components/branch/ReplicaLoadTestPanel';

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
  /** 项目级整组身份（Codex 第二十轮 P1）：整组手势创建的成员共享，按 id join 成组 */
  projectGroupId?: string;
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

interface GraphNodeView { id: string; rawId?: string; name: string; kind: 'service' | 'infra'; pathPrefixes?: string[]; subdomain?: string; containerPort?: number; dockerImage?: string }
interface GraphEdgeView { from: string; to: string; envKeys: string[]; dependsOn: boolean }
interface ServiceGraphView { nodes: GraphNodeView[]; edges: GraphEdgeView[]; layers: string[][] }

type ReplicaMode = 'container' | 'project';

interface ReplicaSetsResponse {
  replicaSets: Record<string, ProfileReplicaSetView>;
  candidates: Record<string, ReplicaCandidateView[]>;
  snapshots?: ReplicaDbSnapshotView[];
  memberLimit: number;
  /** 单个计划步数上限（服务端 SSOT，见 replica-set.ts REPLICA_PLAN_MAX_STEPS）。 */
  planMaxSteps?: number;
  /** 每个服务能否隔离数据库（服务端用隔离执行同一条 resolveReplicaDbTarget 判定）。 */
  dbIsolatable?: Record<string, { ok: boolean; reason?: string }>;
  graph?: ServiceGraphView;
  replicaMode?: ReplicaMode | null;
}

type PlanStepKind = 'add-replica' | 'remove-member' | 'set-weight' | 'isolate-db' | 'revert-db' | 'dissolve';
interface PlanStep {
  id: string; kind: PlanStepKind; profileId: string;
  params?: { memberId?: string; versionId?: string; weight?: number; dbMode?: 'shared' | 'isolated'; projectGroupId?: string };
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled' | 'rolled-back';
  error?: string; startedAt?: string; endedAt?: string;
}
interface Plan { id: string; status: 'running' | 'done' | 'error' | 'cancelled' | 'rolled-back'; onFailure: 'stop' | 'rollback'; steps: PlanStep[]; rollbackLog?: string[]; createdAt: string; endedAt?: string }

/** 一次用户操作 = 一条草稿（预期管理：清单按手势聚合，撤销以手势为单位；保存时才展开为步骤） */
interface DraftStep { kind: PlanStepKind; profileId: string; params?: PlanStep['params'] }
interface DraftAction { key: string; label: string; steps: DraftStep[] }
interface DraftStepEx extends DraftStep { actionKey: string }

interface ProbeHit { seq: number; servedBy: string; status: number }
interface ProbeResult { tally: Record<string, number>; hits: ProbeHit[]; count: number; path: string }

export interface PanelServiceInfo { hostPort?: number; status?: string }
export interface PanelInfraInfo { id: string; name?: string; dockerImage?: string; status?: string }

/**
 * 成员直达链：`<slug>-<profile清洗段>-<memberId>.<root>`。host 带 profile 段与
 * forwarder-route-publisher 同步（Codex P1：res-N 按 profile 顺位命名，
 * 不带 profile 段时两个服务的 res-1 撞同一 host）。
 * profile 段 DNS 清洗（Codex P2）：`_`/`.` 等合法 profile 字符不是合法 DNS 标签
 * 字符——与发布器 dnsSafeProfile **同款算法**，两端必须同步改。
 */
export function memberDirectUrl(previewUrl: string | undefined, profileId: string, memberId: string): string | null {
  if (!previewUrl) return null;
  // 防撞编码（Codex 第十四轮 P2）：清洗有损时追加原始 id 的 djb2-xor 短哈希，
  // 与发布器 dnsSafeProfile 完全同款——两端必须同步改
  const cleaned = profileId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'svc';
  let safeProfile = cleaned;
  if (cleaned !== profileId) {
    let h = 5381;
    for (let i = 0; i < profileId.length; i++) h = ((h * 33) ^ profileId.charCodeAt(i)) >>> 0;
    safeProfile = `${cleaned}-${h.toString(36)}`;
  }
  try {
    const url = new URL(previewUrl);
    const [first, ...rest] = url.hostname.split('.');
    if (!first || rest.length === 0) return null;
    const label = `${first}-${safeProfile}-${memberId}`;
    if (label.length > 63) {
      // 第一 DNS 标签超 63 octet 上限时发布器不会发这条直达路由（Codex 第十七轮
      // P2）——展示不存在的 host 会让用户拿到 DNS 解析失败。回落为主入口的
      // profile 作用域钉选深链（?__rs=profileId:memberId），同样一击直达该副本
      url.searchParams.set('__rs', `${profileId}:${memberId}`);
      return url.toString();
    }
    url.hostname = [label, ...rest].join('.');
    return url.toString();
  } catch { return null; }
}

const KIND_LABEL: Record<PlanStepKind, string> = {
  'add-replica': '新增副本', 'remove-member': '下线副本', 'set-weight': '调整权重',
  'isolate-db': '复制隔离数据库', 'revert-db': '回切主库', dissolve: '关闭复制集',
};
const STEP_STATUS_META: Record<PlanStep['status'], { text: string; cls: string }> = {
  pending: { text: '待执行', cls: 'text-muted-foreground' },
  running: { text: '执行中', cls: 'text-warn' },
  done: { text: '完成', cls: 'text-ok' },
  error: { text: '失败', cls: 'text-destructive' },
  skipped: { text: '已跳过', cls: 'text-muted-foreground' },
  cancelled: { text: '已取消', cls: 'text-muted-foreground' },
  'rolled-back': { text: '已回滚', cls: 'text-info' },
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
  // 右框 = 左框的镜像（2026-07-25 用户拍板：隔离 = 复制整套基础设施元素，不是只复制一个库）
  const rightFrameW = leftFrameW;
  const frameGap = 44;
  const fx = Math.max(6, (w - leftFrameW - frameGap - rightFrameW) / 2);
  const rightX = fx + leftFrameW + frameGap;
  return {
    dbCW, leftFrameW, rightFrameW, fx, rightX,
    isoX: rightX + 14,
    dbX: (i: number): number => fx + 14 + i * (dbCW + dbGap),
    /** 隔离区内与左框同索引的镜像位 */
    isoDbX: (i: number): number => rightX + 14 + i * (dbCW + dbGap),
    minWidth: leftFrameW + frameGap + rightFrameW + 24,
  };
}

/** 分支级隔离统一战线状态（debt #22：禁止一半连主库一半连隔离库） */
interface BranchIso {
  state: 'idle' | 'cloning' | 'switching' | 'partial' | 'done';
  isolatedProfiles: string[];
  effectiveProfiles: string[];
  dbNames: string[];
}
function computeBranchIso(replicaSets: Record<string, ProfileReplicaSetView>, effectiveProfileIds: string[]): BranchIso {
  const entries = Object.values(replicaSets);
  const isolated = entries.filter((rs) => rs.isolated);
  const cloning = entries.some((rs) => rs.members.some((m) => m.status === 'provisioning' && m.statusMessage?.includes('第1步')));
  const switching = isolated.length > 0 && entries.some((rs) => rs.members.some((m) => m.status === 'provisioning'));
  // 完成判定以**全量有效服务**为分母（Codex 第十七轮 P2）：零副本服务同样可
  // 隔离（零副本先隔离是既定语义），没有 rs 条目/没有成员的服务不隔离就不算
  // 「统一战线已对齐」——多服务计划中途失败时不许把分支报成 done
  const allIsolated = effectiveProfileIds.length > 0
    && effectiveProfileIds.every((pid) => !!replicaSets[pid]?.isolated);
  let state: BranchIso['state'] = 'idle';
  if (cloning) state = 'cloning';
  else if (switching) state = 'switching';
  else if (isolated.length === 0) state = 'idle';
  else if (allIsolated) state = 'done';
  else state = 'partial';
  return {
    state,
    isolatedProfiles: isolated.map((rs) => rs.profileId),
    effectiveProfiles: effectiveProfileIds,
    dbNames: isolated.map((rs) => rs.isolated!.dbName),
  };
}

export function ReplicaSetPanel({ branchId, previewUrl, services, infra, entries, onToast }: {
  branchId: string;
  previewUrl?: string;
  services?: Record<string, PanelServiceInfo>;
  infra?: PanelInfraInfo[];
  /** 公开入口（主应用 + 命名子域网关）——入口卡入画布（2026-07-26 用户拍板），挂在入口节点右侧 */
  entries?: Array<{ name: string; url: string }>;
  onToast?: (message: string) => void;
}): JSX.Element {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; data: ReplicaSetsResponse } | { status: 'error'; message: string }>({ status: 'loading' });
  const [plans, setPlans] = useState<Plan[]>([]);
  const [draft, setDraft] = useState<DraftAction[]>([]);
  const [onFailure, setOnFailure] = useState<'stop' | 'rollback'>('stop');
  const [tab, setTab] = useState<ReplicaMode>('container');
  const tabInitRef = useRef(false);
  const [busy, setBusy] = useState(false);
  /** 压测弹窗当前针对的服务（null = 未打开） */
  const [loadTestFor, setLoadTestFor] = useState<string | null>(null);
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

  const onAction = useCallback((label: string, steps: DraftStep[]) => {
    if (!steps.length) return;
    draftSeq.current += 1;
    setDraft((prev) => [...prev, { key: `a${draftSeq.current}`, label, steps }]);
  }, []);
  const onRemoveAction = useCallback((key: string) => {
    setDraft((prev) => prev.filter((a) => a.key !== key));
  }, []);
  const undoLast = useCallback(() => {
    setDraft((prev) => {
      if (!prev.length) return prev;
      onToast?.(`已撤销：${prev[prev.length - 1].label}`);
      return prev.slice(0, -1);
    });
  }, [onToast]);

  const call = useCallback(async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) onToast?.(done); await load(true); }
    catch (err) { onToast?.(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(false); }
  }, [load, onToast]);

  const savePlan = useCallback(() => call(async () => {
    await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-plans`, {
      method: 'POST',
      body: { onFailure, mode: tab, steps: draft.flatMap((a) => a.steps) },
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
  // 全量服务清单（Codex 第十五轮 P1）：并上 services——没有可复用版本快照的服务
  // 不在 candidates 里，若又没有既有复制集就会从画布消失，项目级「整组」会把它
  // 静默排除在外（假整组：该服务流量仍打主实例）。全量列出，缺口交给整组门显式拦。
  const profileIds = Array.from(new Set([
    ...Object.keys(services ?? {}), ...Object.keys(replicaSets), ...Object.keys(candidates),
  ])).sort();
  const graph: ServiceGraphView = state.data.graph ?? { nodes: [], edges: [], layers: [profileIds] };
  // 可隔离服务集（Codex 第二十六轮 P2）：无状态服务（前端等，env 无数据库名）没有
  // 库可隔离，纳入统一战线只会让那一步必败并按「失败即停」拖垮后续服务。服务端
  // 判定缺省（旧版本 CDS）时退回全量，保持行为不回归。
  const dbIsolatable = state.data.dbIsolatable;
  const isolatableProfileIds = dbIsolatable
    ? profileIds.filter((p) => dbIsolatable[p]?.ok !== false)
    : profileIds;
  const planMaxSteps = state.data.planMaxSteps ?? REPLICA_PLAN_MAX_STEPS;
  // 分母同样只算可隔离服务，否则挂着一个前端服务的分支永远停在「部分隔离」
  const branchIso = computeBranchIso(replicaSets, isolatableProfileIds);
  const totalMembers = Object.values(replicaSets).reduce((s, rs) => s + (rs.enabled ? rs.members.length : 0), 0);
  const pinnedMode = state.data.replicaMode ?? null;
  const lockedOther = pinnedMode !== null && totalMembers > 0;
  const activeMode: ReplicaMode = lockedOther ? pinnedMode : tab;
  const viewingLocked = lockedOther && tab !== pinnedMode;

  const draftSteps: DraftStepEx[] = draft.flatMap((a) => a.steps.map((s) => ({ ...s, actionKey: a.key })));

  // 统一战线动作：隔离 / 回切一次覆盖所有符合条件的服务 —— 一次手势 = 一条草稿
  // 2026-07-25 用户拍板：隔离不要求先有副本——零副本也可先隔离数据库（隔离态钉住后，
  // 之后加的副本自动连隔离库），统一战线覆盖当前分支的所有服务
  const isolateTargets = isolatableProfileIds.filter((p) => {
    const rs = replicaSets[p];
    return !rs?.isolated && !draftSteps.some((d) => d.profileId === p && d.kind === 'isolate-db');
  });
  const revertTargets = profileIds.filter((p) => !!replicaSets[p]?.isolated && !draftSteps.some((d) => d.profileId === p && d.kind === 'revert-db'));
  // 步数预检（Codex 第二十六轮 P2）：批量动作按服务数生成步骤，攒过上限时后端
  // startPlan 会 400，用户却要等到「保存」那一刻才知道——加草稿前就拦下并说清。
  const wouldExceedPlanLimit = (addCount: number, what: string): boolean => {
    if (draftSteps.length + addCount <= planMaxSteps) return false;
    onToast?.(`无法加${what}：本次会让计划达到 ${draftSteps.length + addCount} 步，超出单计划上限 ${planMaxSteps} 步——请先保存执行已有草稿，再分批操作`);
    return true;
  };
  const isolateAll = (): void => {
    if (isolateTargets.length === 0) { onToast?.('全部服务已隔离或已有隔离草稿'); return; }
    if (wouldExceedPlanLimit(isolateTargets.length, '统一战线隔离')) return;
    onAction(`复制隔离 · 统一战线（${isolateTargets.length} 服务切专用隔离实例，可回切）`,
      isolateTargets.map((p) => ({ kind: 'isolate-db' as const, profileId: p })));
    onToast?.(`统一战线：复制隔离草稿已加入（覆盖 ${isolateTargets.length} 个服务）`);
  };
  const revertAll = (): void => {
    if (!revertTargets.length) return;
    if (wouldExceedPlanLimit(revertTargets.length, '统一回切')) return;
    onAction(`回切主库（${revertTargets.length} 服务，隔离库转快照保留）`,
      revertTargets.map((p) => ({ kind: 'revert-db' as const, profileId: p })));
    onToast?.(`回切草稿已加入（${revertTargets.length} 个服务）`);
  };
  const draftIsoCount = draftSteps.filter((d) => d.kind === 'isolate-db').length;
  const draftIsoProfiles = new Set(draftSteps.filter((d) => d.kind === 'isolate-db').map((d) => d.profileId));
  const draftRevertCount = draftSteps.filter((d) => d.kind === 'revert-db').length;
  const removeIsoDrafts = (): void => {
    setDraft((prev) => prev.filter((a) => !a.steps.some((s) => s.kind === 'isolate-db')));
    onToast?.('已撤销复制隔离草稿');
  };

  const modeLabel = (m: ReplicaMode): string => (m === 'container' ? '容器级' : '项目级');

  // 模式切换（并入画布头部一行，压缩纵向空间 —— 2026-07-25 用户拍板）
  const modeToggle = (
    <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
      {(['container', 'project'] as const).map((m) => (
        <button key={m} type="button" onClick={() => setTab(m)}
          className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs ${tab === m ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'}`}
          title={lockedOther && pinnedMode !== m ? `该分支已按${modeLabel(pinnedMode!)}管理，关闭全部复制集后可切换` : undefined}>
          {lockedOther && pinnedMode !== m ? <Lock className="h-3 w-3" /> : null}
          {modeLabel(m)}
        </button>
      ))}
    </div>
  );

  // 右上执行区：一键还原（业务）| 撤销上一步（按手势回退）| 放弃变更（全丢）| 保存执行
  const execArea = (
    <span className="ml-auto flex shrink-0 items-center gap-2">
      {totalMembers > 0 && !activePlan ? (
        <Button type="button" size="sm" variant="outline" disabled={busy}
          title="一键还原：全部容器回到普通模式（移除全部副本，隔离库转快照保留）——进变更清单，保存后执行"
          onClick={() => {
            const targets = profileIds.filter((p) => {
              const rs = replicaSets[p];
              return rs?.enabled && rs.members.length > 0 && !draftSteps.some((d) => d.profileId === p && d.kind === 'dissolve');
            });
            if (!targets.length) return;
            onAction(`一键还原（${targets.length} 容器关闭复制集，回普通模式）`,
              targets.map((p) => ({ kind: 'dissolve' as const, profileId: p })));
            onToast?.('一键还原草稿已加入，点「保存执行」生效');
          }}>
          <Undo2 />一键还原
        </Button>
      ) : null}
      {draft.length > 0 && !activePlan ? (
        <>
          <Button type="button" size="sm" variant="ghost" disabled={busy}
            title={`撤销上一步：${draft[draft.length - 1]?.label ?? ''}`} onClick={undoLast}>
            <RotateCcw />撤销上一步
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy}
            title="放弃本页累积的全部草稿，不执行任何操作（线上现状不变）"
            onClick={() => { setDraft([]); onToast?.('已放弃全部未保存的变更，未执行任何操作'); }}>
            <X />放弃变更
          </Button>
        </>
      ) : null}
      {activePlan ? (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-warn/50 bg-warn-soft px-3 py-1.5 text-xs font-semibold text-warn">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          执行中 {activePlan.steps.filter((s) => s.status === 'done').length}/{activePlan.steps.length}
        </span>
      ) : draft.length > 0 ? (
        <Button type="button" size="sm" disabled={busy} title="保存并按序执行变更清单（草稿转正式，黄色转常色）" onClick={savePlan}>
          <Play />保存执行（{draft.length} 项）
        </Button>
      ) : null}
    </span>
  );

  const stageProps: StageSharedProps = {
    branchId, previewUrl, entries: entries ?? [], services, infra: infra ?? [], replicaSets, candidates, memberLimit, planMaxSteps,
    draftActions: draft, draftSteps, onAction, onRemoveAction, onToast, profileIds, graph, branchIso,
    isolateTargets, revertTargets, isolateAll, revertAll, draftIsoCount, draftIsoProfiles, draftRevertCount, removeIsoDrafts,
    headerLeft: modeToggle, headerRight: execArea,
    onOpenLoadTest: (pid) => setLoadTestFor(pid ?? profileIds[0] ?? ''),
  };

  // 压测落点清单：主实例 + 该服务的副本（未运行的也列出来但置灰，用户知道为什么少了一个）。
  // 普通函数而非 useCallback：这里在早退分支之后，放 hook 会违反 hooks 规则。
  const loadTestMembers = (profileId: string): LoadTestMemberOption[] => {
    const rows: LoadTestMemberOption[] = [{
      memberId: 'primary',
      label: '主实例',
      running: services?.[profileId]?.status === 'running',
    }];
    for (const m of replicaSets[profileId]?.members ?? []) {
      rows.push({ memberId: m.id, label: m.label || m.id, running: m.status === 'running' });
    }
    return rows;
  };

  return (
    <div className="grid gap-4">
      {viewingLocked ? (
        <section className="cds-surface-raised cds-hairline px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">{modeToggle}{execArea}</div>
          <div className="mt-6 flex flex-col items-center gap-3 pb-6 text-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground">
              <Lock className="h-5 w-5" />
            </span>
            <p className="text-sm font-semibold">{modeLabel(tab)}暂不可用 — 管理模式二选一</p>
            <p className="max-w-md text-xs leading-5 text-muted-foreground">
              该分支的复制集当前由「{modeLabel(pinnedMode!)}」管理（还有 {totalMembers} 个副本在运行）。
              为避免两种视角互相踩踏，同一时间只能启用一种。回到{modeLabel(pinnedMode!)}关闭全部复制集后，这里会自动解锁。
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => setTab(pinnedMode!)}>回到{modeLabel(pinnedMode!)}</Button>
          </div>
        </section>
      ) : activeMode === 'container' ? (
        <ContainerGraphStage {...stageProps} />
      ) : (
        <ProjectStage {...stageProps} />
      )}

      {loadTestFor !== null ? (
        <ReplicaLoadTestPanel
          branchId={branchId}
          profileIds={profileIds}
          defaultProfileId={loadTestFor || undefined}
          membersOf={loadTestMembers}
          onToast={onToast}
          onClose={() => setLoadTestFor(null)}
        />
      ) : null}

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

/* ── 变更清单（按用户操作聚合）+ 执行实况 + 执行记录 ── */
function PlanBoard({ branchId, draft, setDraft, onFailure, setOnFailure, activePlan, plans, busy, onSave, onCall }: {
  branchId: string;
  draft: DraftAction[];
  setDraft: (next: DraftAction[] | ((prev: DraftAction[]) => DraftAction[])) => void;
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
  const actionKinds = (a: DraftAction): string => {
    const kinds = Array.from(new Set(a.steps.map((s) => s.kind)));
    return kinds.length === 1 ? KIND_LABEL[kinds[0]] : '组合操作';
  };

  return (
    <section className="cds-surface-raised cds-hairline px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">变更清单</span>
        <span className="text-[11px] text-muted-foreground">一次操作一条草稿（黄色 = 未保存预期）；点「保存执行」才真正开始，执行中可调序 / 跳过 / 取消</span>
      </div>

      {activePlan ? (
        <div className="mt-3 grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-warn" />
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
          {draft.map((a, i) => (
            <div key={a.key} className="flex items-center gap-2 rounded-md border border-dashed border-warn/50 bg-warn/[.06] px-2.5 py-1.5 text-xs">
              <span className="w-5 text-right font-mono text-[11px] text-muted-foreground">{i + 1}.</span>
              <span className="rounded border border-warn/50 px-1.5 text-[10px] font-semibold text-warn">{actionKinds(a)}</span>
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{a.steps.length} 步</span>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title="上移" onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></button>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-primary" title="下移" onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></button>
              <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-destructive" title="撤销这条操作" onClick={() => setDraft((prev) => prev.filter((x) => x.key !== a.key))}><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={onSave}><Play />保存执行（{draft.length} 项）</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft([])}>放弃变更</Button>
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
        <p className="mt-2 text-xs text-muted-foreground">暂无待保存的变更。在画布上点「+」「复制隔离」等即可加入清单。</p>
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
        {step.status === 'running' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warn" /> : (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${step.status === 'done' ? 'bg-ok' : step.status === 'error' ? 'bg-destructive' : step.status === 'rolled-back' ? 'bg-info' : 'bg-[hsl(var(--muted-foreground))]/50'}`} />
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
        <b className={bad ? 'text-destructive' : 'text-ok'}>{PLAN_STATUS_LABEL[plan.status]}</b>
        <span className="text-muted-foreground">{plan.steps.length} 步 · {new Date(plan.createdAt).toLocaleString()}</span>
        {bad ? <span className="min-w-0 flex-1 truncate text-destructive">{plan.steps.find((s) => s.error)?.error}</span> : null}
      </button>
      {open ? (
        <div className="mt-2 grid gap-1">
          {plan.steps.map((s) => <StepLine key={s.id} step={s} />)}
          {plan.rollbackLog?.length ? (
            <div className="mt-1 rounded-md border border-info/30 bg-info/[.05] px-2.5 py-1.5 text-[11px]">
              <b className="text-info">回滚日志</b>
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
  entries: Array<{ name: string; url: string }>;
  services?: Record<string, PanelServiceInfo>;
  infra: PanelInfraInfo[];
  replicaSets: Record<string, ProfileReplicaSetView>;
  candidates: Record<string, ReplicaCandidateView[]>;
  memberLimit: number;
  /** 单计划步数上限（服务端 SSOT），项目级整组动作提交前预检用。 */
  planMaxSteps: number;
  draftActions: DraftAction[];
  draftSteps: DraftStepEx[];
  onAction: (label: string, steps: DraftStep[]) => void;
  onRemoveAction: (key: string) => void;
  onToast?: (m: string) => void;
  profileIds: string[];
  graph: ServiceGraphView;
  branchIso: BranchIso;
  isolateTargets: string[];
  revertTargets: string[];
  isolateAll: () => void;
  revertAll: () => void;
  draftIsoCount: number;
  draftIsoProfiles: Set<string>;
  draftRevertCount: number;
  removeIsoDrafts: () => void;
  headerLeft: JSX.Element;
  headerRight: JSX.Element;
  /** 打开压测弹窗（复制集 = 现成的 A/B 负载对比台） */
  onOpenLoadTest: (profileId?: string) => void;
}

/** 画布弹窗（分流实测 / 历史版本选择）：portal 到 body，inline 高度约束，内部滚动 */
function CanvasModal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex w-full flex-col rounded-xl border border-[hsl(var(--hairline))] bg-background shadow-2xl"
        style={{ maxWidth: wide ? 760 : 560, maxHeight: '82vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5">
          <b className="text-sm">{title}</b>
          <button type="button" className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground" title="关闭" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 分流实测共享逻辑（容器级 / 项目级共用）：真实请求穿过入口统计落点，结果进弹窗 */
function useProbe(branchId: string, previewUrl: string | undefined, onToast?: (m: string) => void) {
  const [probeFor, setProbeFor] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [probeRes, setProbeRes] = useState<ProbeResult | null>(null);
  const probing = useRef(false);
  const runProbe = async (profileId: string): Promise<void> => {
    if (probing.current) return;
    if (!previewUrl) { onToast?.('该分支还没有预览入口，无法实测'); return; }
    probing.current = true;
    setProbeFor(profileId);
    setLog([`分流实测 ${profileId} — 串流模式：每个请求等上一个响应返回才发出——`]);
    setProbeRes(null);
    try {
      const res = await apiRequest<ProbeResult>(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/probe`, {
        method: 'POST', body: { host: new URL(previewUrl).hostname, count: 12 },
      });
      for (let i = 0; i < res.hits.length; i += 1) {
        const hit = res.hits[i];
        const missed = hit.servedBy === 'untagged' || hit.servedBy === 'error';
        const line = missed
          ? `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'error' ? '连接失败' : '未命中复制集路由'}  HTTP ${hit.status}`
          : `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'primary' ? '主实例' : hit.servedBy}  X-CDS-Replica: ${hit.servedBy}  HTTP ${hit.status}${hit.status >= 200 && hit.status < 300 ? ' OK' : ' · 业务路由响应，落点已验证'}`;
        setLog((prev) => [...prev, line]);
        await new Promise((r) => setTimeout(r, 120));
      }
      setProbeRes(res);
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
    }
    probing.current = false;
  };
  const close = (): void => { if (!probing.current) { setProbeFor(null); setLog([]); setProbeRes(null); } };
  return { probeFor, log, probeRes, probing, runProbe, close };
}

function ProbeModal({ probe }: { probe: ReturnType<typeof useProbe> }): JSX.Element | null {
  if (!probe.probeFor) return null;
  return (
    <CanvasModal wide title={`分流实测 · ${probe.probeFor}`} onClose={probe.close}>
      <div className="max-h-52 overflow-y-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 font-mono text-[11px] text-muted-foreground" style={{ overscrollBehavior: 'contain' }}>
        {probe.log.map((line, i) => <div key={i}>{line}</div>)}
        {probe.probing.current ? <div className="mt-1 flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin text-warn" />请求进行中…</div> : null}
      </div>
      {probe.probeRes ? <div className="mt-3"><ProbeDashboard result={probe.probeRes} /></div> : null}
      {probe.probeRes ? (
        <div className="mt-3 flex justify-end">
          <Button type="button" size="sm" variant="outline" onClick={probe.close}>关闭</Button>
        </div>
      ) : null}
    </CanvasModal>
  );
}

/* ── 隔离 MECE 审计（2026-07-26 用户点名「隔离测过有效吗 + 没有可观测性」）──
 * 五面实测矩阵弹窗：意图 / 配置（容器真实 env）/ 实例 / 数据（双向金丝雀真写真查）
 * / 边界（显式列出没隔住的部分）。未隔离时退化为「连接观测」——逐容器列出
 * 真实连接的库。全部度量来自服务端 docker inspect + 真实读写，不是配置推断。 */
interface AuditCheck { id: string; group: string; title: string; verdict: 'pass' | 'fail' | 'skip' | 'boundary' | 'info'; evidence: string }
interface AuditReport { branchId: string; profileId: string; overall: 'effective' | 'broken' | 'not-isolated'; checks: AuditCheck[]; ranAt: string }

function useIsolationAudit(branchId: string, onToast?: (m: string) => void) {
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [report, setReport] = useState<AuditReport | null>(null);
  const running = useRef(false);
  const run = async (profileId: string): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setAuditFor(profileId);
    setReport(null);
    try {
      const res = await apiRequest<{ report: AuditReport }>(
        `/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/isolation-audit`,
        { method: 'POST', body: {} },
      );
      setReport(res.report);
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
      setAuditFor(null);
    }
    running.current = false;
  };
  const close = (): void => { if (!running.current) { setAuditFor(null); setReport(null); } };
  return { auditFor, report, running, run, close };
}

const AUDIT_VERDICT_STYLE: Record<string, string> = {
  pass: 'border-ok/50 bg-ok-soft text-ok',
  fail: 'border-bad/60 bg-bad-soft text-bad',
  boundary: 'border-warn/60 bg-warn-soft text-warn',
  skip: 'border-[hsl(var(--hairline))] bg-muted/40 text-muted-foreground',
  info: 'border-info/40 bg-info-soft text-info',
};
const AUDIT_VERDICT_LABEL: Record<string, string> = { pass: '通过', fail: '失效', boundary: '已知边界', skip: '不适用', info: '观测' };

function IsolationAuditModal({ audit }: { audit: ReturnType<typeof useIsolationAudit> }): JSX.Element | null {
  if (!audit.auditFor) return null;
  const r = audit.report;
  const groups = r ? [...new Set(r.checks.map((c) => c.group))] : [];
  return (
    <CanvasModal wide title={`隔离审计（MECE 实测）· ${audit.auditFor}`} onClose={audit.close}>
      {!r ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-warn" />
          正在实测：逐容器 docker inspect 真实连接 + 专用实例活性 + 双向金丝雀写入验证…
        </div>
      ) : (
        <>
          <div className={`mb-3 rounded-md border px-3 py-2 text-sm font-semibold ${r.overall === 'effective' ? AUDIT_VERDICT_STYLE.pass : r.overall === 'broken' ? AUDIT_VERDICT_STYLE.fail : AUDIT_VERDICT_STYLE.info}`}>
            {r.overall === 'effective' ? '隔离有效：核心检查全部实测通过（配置面 + 实例面 + 双向数据面）'
              : r.overall === 'broken' ? '隔离失效：存在未通过的核心检查，见下方红项'
                : '该服务未隔离——以下为逐容器真实连接观测'}
          </div>
          {groups.map((g) => (
            <div key={g} className="mb-3">
              <div className="mb-1 text-xs font-semibold text-muted-foreground">{g}</div>
              <div className="space-y-1.5">
                {r.checks.filter((c) => c.group === g).map((c) => (
                  <div key={c.id} className="rounded-md border border-[hsl(var(--hairline))] px-2.5 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${AUDIT_VERDICT_STYLE[c.verdict]}`}>{AUDIT_VERDICT_LABEL[c.verdict]}</span>
                      <span className="text-xs font-medium">{c.title}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{c.id}</span>
                    </div>
                    <div className="mt-1 break-all font-mono text-[10px] leading-relaxed text-muted-foreground">{c.evidence}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-end"><Button type="button" size="sm" variant="outline" onClick={audit.close}>关闭</Button></div>
        </>
      )}
    </CanvasModal>
  );
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
  const previewTransfer = iso.state === 'idle' && draftIsoCount > 0;
  return (
    <>
      <rect x={geo.fx} y={fy} width={geo.leftFrameW} height={fh} rx="14" fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.4" strokeDasharray="7 6" opacity="0.5" />
      <rect x={geo.rightX} y={fy} width={geo.rightFrameW} height={fh} rx="14" fill="none"
        stroke={iso.state === 'partial' ? '#f59e0b' : previewTransfer ? '#f59e0b' : '#10b981'} strokeWidth="1.6" strokeDasharray="7 6"
        opacity={iso.state === 'idle' && draftIsoCount === 0 ? 0.45 : 0.9}
        className={iso.state === 'cloning' ? 'animate-[rsants_1.2s_linear_infinite]' : undefined} />
      {previewTransfer ? (
        // 预期管理：保存前先画出「将来会发生什么」——主库 → 镜像位副本库的黄色流动预连线
        <path className="rsflow" d={`M ${mainDbX + geo.dbCW} ${dbY + 46} L ${geo.isoDbX(0) - 8} ${dbY + 46}`} fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeDasharray="4 4" opacity="0.75" markerEnd="url(#rsArrAmber)" />
      ) : null}
      {transferActive ? (
        <g>
          <path className="rsflow" d={`M ${mainDbX + geo.dbCW} ${dbY + 46} L ${geo.isoX} ${dbY + 46}`} fill="none" stroke="#10b981" strokeWidth="2" strokeDasharray="4 4" />
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

function DataLayerCards({ geo, dbY, dbInfra, mainDbIdx, iso, draftIsoCount, draftRevertCount, isolateTargets, revertTargets, onIsolateAll, onRevertAll, onRemoveIsoDrafts, onAudit }: {
  geo: ReturnType<typeof dataGeo>; dbY: number; dbInfra: PanelInfraInfo[]; mainDbIdx: number;
  iso: BranchIso; draftIsoCount: number; draftRevertCount: number;
  isolateTargets: string[]; revertTargets: string[]; onIsolateAll: () => void; onRevertAll: () => void; onRemoveIsoDrafts: () => void;
  /** 隔离 MECE 审计入口（弹窗矩阵）——已隔离时挂在隔离区卡上 */
  onAudit?: () => void;
}): JSX.Element {
  const locked = iso.state === 'done';
  const previewIso = iso.state === 'idle' && draftIsoCount > 0;
  const infraRow = dbInfra.length ? dbInfra : [{ id: 'db', name: '数据库', dockerImage: '', status: 'running' }];
  return (
    <>
      {infraRow.map((s, i) => {
        const isRedis = /redis/i.test(s.dockerImage || s.id);
        const isMainDb = i === mainDbIdx && !isRedis;
        // 预期管理：隔离草稿时**整套**原件置灰上锁——用户一眼看到「保存后请求会离开这一排」
        const lockThis = (isMainDb && locked) || previewIso;
        return (
          <StageCard key={s.id} x={geo.dbX(i)} y={dbY} w={geo.dbCW} name={s.name || s.id} ico={isRedis ? 'R' : 'DB'}
            color={isRedis ? '#c2372f' : '#10b981'} ok={!lockThis} locked={lockThis}
            status={previewIso ? '保存后上锁 · 预览' : lockThis ? '已上锁 · 副本请求已转移' : isMainDb && iso.state === 'partial' ? '主库 · 仍有服务在写' : isMainDb ? '主库' : '共享实例'}
            foot={`${s.id}-volume`} />
        );
      })}
      {previewIso ? (
        // 预期管理：隔离区镜像复制**整套**基础设施元素（同样式黄色拷贝，一一对位）
        <>
          {infraRow.map((s, i) => {
            const isRedis = /redis/i.test(s.dockerImage || s.id);
            return (
              <StageCard key={`iso-${s.id}`} x={geo.isoDbX(i)} y={dbY} w={geo.dbCW} name={s.name || s.id} ico={isRedis ? 'R' : 'DB'}
                color={isRedis ? '#c2372f' : '#10b981'} draftStyle
                status={i === mainDbIdx && !isRedis ? `隔离副本库 · 待保存（${draftIsoCount} 服务切换）` : '隔离副本 · 待保存'}
                foot={`${s.id}-isolated`}
                extra={(
                  <button type="button" className="absolute right-1.5 top-1.5 rounded border border-warn/60 bg-background p-0.5 text-warn hover:text-destructive "
                    title="撤销复制隔离草稿" onClick={onRemoveIsoDrafts}>
                    <X className="h-3 w-3" />
                  </button>
                )} />
            );
          })}
        </>
      ) : iso.state === 'idle' ? (
        <button type="button"
          className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-ok/50 bg-ok/[.06] text-xs font-semibold text-ok transition-colors hover:border-ok hover:bg-ok-soft "
          style={{ left: geo.rightX + (geo.rightFrameW - geo.dbCW) / 2, top: dbY, width: geo.dbCW, height: 92 }}
          title={`统一战线（分支级）：把主库整库克隆进专用隔离实例，${isolateTargets.length || '所有有副本的'} 个服务的副本改连隔离库（可回切）。先进变更清单，保存后执行`}
          onClick={onIsolateAll}>
          <Copy className="h-4 w-4" />复制隔离到此
          <span className="text-[10px] font-normal opacity-80">统一战线 · 覆盖 {isolateTargets.length} 个服务</span>
        </button>
      ) : (
        <StageCard x={geo.isoDbX(mainDbIdx)} y={dbY} w={geo.dbCW} name="隔离区" ico="DB" color={iso.state === 'partial' ? '#f59e0b' : '#10b981'}
          ok={iso.state === 'done'} boot={iso.state === 'cloning'} danger={iso.state === 'partial'}
          status={iso.state === 'cloning' ? '第1步 复制：拷入数据…'
            : iso.state === 'switching' ? '第2步 切换：副本改连新库…'
            : iso.state === 'partial' ? `统一战线未对齐 ${iso.isolatedProfiles.length}/${iso.effectiveProfiles.length}`
            : draftRevertCount > 0 ? '回切主库 · 待保存' : `专用实例 · ${iso.isolatedProfiles.length} 服务已切换`}
          foot={iso.dbNames.join(' · ')}
          extra={(
            <span className="absolute bottom-1.5 right-1.5 flex gap-1">
              {(iso.state === 'done' || iso.state === 'partial') && onAudit ? (
                <button type="button" className="rounded border border-info/50 bg-background px-1.5 text-[10px] text-info"
                  title="隔离审计（MECE 实测）：逐容器 docker inspect 真实连接 + 专用实例活性 + 双向金丝雀写入验证，弹窗显示五面矩阵" onClick={onAudit}>隔离审计</button>
              ) : null}
              {iso.state === 'partial' && isolateTargets.length > 0 ? (
                <button type="button" className="rounded border border-warn/60 bg-background px-1.5 text-[10px] text-warn"
                  title="把尚未隔离的服务也加入隔离草稿，对齐统一战线" onClick={onIsolateAll}>补齐隔离</button>
              ) : null}
              {(iso.state === 'done' || iso.state === 'partial') && revertTargets.length > 0 ? (
                <button type="button" className="rounded border border-ok/50 bg-background px-1.5 text-[10px] text-ok"
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
  const { branchId, previewUrl, entries, services, infra, replicaSets, candidates, memberLimit, draftActions, draftSteps, onAction, onRemoveAction, onToast, profileIds, graph, branchIso, isolateTargets, revertTargets, isolateAll, revertAll, draftIsoCount, draftIsoProfiles, draftRevertCount, removeIsoDrafts, headerLeft, headerRight, onOpenLoadTest } = props;
  const [hostRef, w] = useMeasuredWidth();
  const [weightFor, setWeightFor] = useState<string | null>(null); // `${profileId}:${memberId}`
  const [weightDraft, setWeightDraft] = useState('');
  const [pickFor, setPickFor] = useState<string | null>(null);
  const probe = useProbe(branchId, previewUrl, onToast);
  const audit = useIsolationAudit(branchId, onToast);
  const runAuditRep = (): void => {
    const rep = branchIso.isolatedProfiles[0] || profileIds[0];
    if (rep) void audit.run(rep);
  };
  // 点选节点 → 相关连线高亮、其余变淡（2026-07-25 用户拍板）
  const [selected, setSelected] = useState<string | null>(null);
  const dimIf = (touching: boolean): number => (selected === null ? 1 : touching ? 1 : 0.22);

  // 图节点 id 带命名空间前缀（service:/infra:，Codex 第二十七轮 P2 治同名撞车），
  // 这里按 rawId 建服务索引；rawId 缺省时兼容旧响应的裸 id。
  const infraNodeId = (iid: string): string => `infra:${iid}`;
  const nodeById = new Map(graph.nodes
    .filter((n) => n.kind === 'service')
    .map((n) => [n.rawId ?? n.id.replace(/^service:/, ''), n]));
  const layered = new Set(graph.layers.flat());
  const layers = graph.layers.map((l) => l.filter((id) => profileIds.includes(id)));
  const missing = profileIds.filter((p) => !layered.has(p));
  if (missing.length) layers.push(missing);
  const rows = layers.filter((l) => l.length > 0);

  const boxRowsOf = (pid: string): number => {
    const members = replicaSets[pid]?.enabled ? replicaSets[pid].members : [];
    const adds = draftSteps.filter((d) => d.profileId === pid && d.kind === 'add-replica').length;
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
  const fy = cursorY - layerGap + 64;
  const dbY = fy + 16, fh = 128;
  const height = fy + fh + 44;
  const mainDbIdx = Math.max(dbInfra.findIndex((s) => /mongo|mysql|mariadb|postgres/i.test(s.dockerImage || s.id)), 0);
  const mainDbX = geo.dbX(mainDbIdx);

  const entryFacing = profileIds.filter((p) => {
    const n = nodeById.get(p);
    return (n?.pathPrefixes?.length ?? 0) > 0 || !!n?.subdomain;
  });
  const entryTargets = entryFacing.length > 0 ? entryFacing : (rows[0] ?? []);
  const edgeSvc = (endpoint: string): string => endpoint.replace(/^service:/, '');
  const svcEdges = graph.edges
    .map((e) => ({ ...e, from: edgeSvc(e.from), to: edgeSvc(e.to) }))
    .filter((e) => pos.has(e.from) && pos.has(e.to));
  const infraEdges = graph.edges
    .filter((e) => dbInfra.some((s) => e.to === infraNodeId(s.id) || e.to === s.id))
    .map((e) => ({ ...e, from: edgeSvc(e.from), to: e.to.replace(/^infra:/, '') }))
    .filter((e) => pos.has(e.from));
  const previewIso = branchIso.state === 'idle' && draftIsoCount > 0;

  const commitWeight = (profileId: string, memberId: string): void => {
    const v = Math.max(0, Math.min(100, Math.round(Number(weightDraft))));
    setWeightFor(null);
    if (!Number.isFinite(v)) return;
    onAction(`${profileId} · ${memberId === 'primary' ? '主实例' : memberId} 权重 → ${v}`,
      [{ kind: 'set-weight', profileId, params: { memberId, weight: v } }]);
  };

  const pickRows = pickFor
    ? (candidates[pickFor] ?? []).filter((row) => !row.isCurrent && !(replicaSets[pickFor]?.members ?? []).some((m) => m.versionId === row.versionId && m.status !== 'error'))
    : [];

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-2.5">
        {headerLeft}
        <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500"><Layers className="mr-1 inline h-3 w-3" />{profileIds.length} 容器 · 边=环境变量引用</span>
        {branchIso.state === 'done' ? <span className="rounded-md border border-ok/50 bg-ok-soft px-1.5 py-0.5 text-[11px] text-ok">已隔离 · 统一战线</span> : null}
        {branchIso.state === 'partial' ? <span className="rounded-md border border-warn/50 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">部分隔离 {branchIso.isolatedProfiles.length}/{branchIso.effectiveProfiles.length} · 建议补齐</span> : null}
        {draftActions.length > 0 ? <span className="rounded-md border border-warn/50 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">{draftActions.length} 项变更待保存</span> : null}
        {headerRight}
      </div>

      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
        <div className="relative" style={{ width: canvasW, height, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
          <svg className="pointer-events-none absolute inset-0" width={canvasW} height={height}>
            <defs>
              <marker id="rsArr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker>
              <marker id="rsArrAmber" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#f59e0b" /></marker>
            </defs>
            {entryTargets.map((id) => {
              const p = pos.get(id);
              if (!p) return null;
              const hasReplicas = (replicaSets[id]?.members.length ?? 0) > 0;
              return (
                <path key={`entry-${id}`} className="rsflow" d={edgeD(entryX + CW / 2, entryY + 88, p.cx, p.y)} fill="none"
                  stroke={hasReplicas ? '#6366f1' : 'hsl(var(--muted-foreground))'} strokeWidth={hasReplicas ? 2 : 1.4}
                  strokeDasharray="5 5" opacity={(hasReplicas ? 0.7 : 0.4) * dimIf(selected === id || selected === 'entry')} markerEnd="url(#rsArr)" />
              );
            })}
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
                  <path className="rsflow" d={edgeD(a.cx, a.y + a.h, b.cx, b.y)} fill="none" stroke="#6366f1" strokeWidth="1.6" strokeDasharray="5 5" opacity={0.55 * dimIf(selected === e.from || selected === e.to)} markerEnd="url(#rsArr)">
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
              const tx = toIso ? geo.isoDbX(mainDbIdx) + geo.dbCW / 2 : geo.dbX(idx) + geo.dbCW / 2;
              return (
                <path key={`infra-${e.from}-${e.to}`} d={edgeD(a.cx, a.y + a.h, tx, dbY)} fill="none"
                  stroke={toIso ? '#10b981' : 'hsl(var(--muted-foreground))'} strokeWidth={toIso ? 1.8 : 1.3}
                  strokeDasharray="5 5" opacity={(toIso ? 0.7 : 0.34) * dimIf(selected === e.from || selected === e.to)} markerEnd={toIso ? 'url(#rsArr)' : undefined}>
                  <title>{`${e.from} → ${e.to}${e.envKeys.length ? `\n环境变量引用：${e.envKeys.join('、')}` : ''}`}</title>
                </path>
              );
            })}
            {/* 预期管理：隔离草稿的黄色预连线——保存后这些服务的副本会改连隔离副本库 */}
            {previewIso ? Array.from(draftIsoProfiles).map((pid) => {
              const a = pos.get(pid);
              if (!a) return null;
              return (
                <path key={`iso-preview-${pid}`} className="rsflow" d={edgeD(a.cx, a.y + a.h, geo.isoDbX(mainDbIdx) + geo.dbCW / 2, dbY)} fill="none"
                  stroke="#f59e0b" strokeWidth="1.6" strokeDasharray="4 4" opacity="0.55" markerEnd="url(#rsArrAmber)" />
              );
            }) : null}
            <DataLayerSvg geo={geo} fy={fy} fh={fh} iso={branchIso} draftIsoCount={draftIsoCount} mainDbX={mainDbX}
              transferActive={branchIso.state === 'cloning' || branchIso.state === 'switching'} />
          </svg>

          <div onClick={() => setSelected(selected === 'entry' ? null : 'entry')} className="cursor-pointer">
            <StageCard x={entryX} y={entryY} name="入口" ico="GW" color="#6366f1" ok status={entryHost} foot="forwarder · 按权重分流" />
          </div>
          <EntryLinks x={entryX + CW + 12} y={entryY + 4} entries={entries} />

          {rows.flatMap((ids) => ids).map((pid) => {
            const p = pos.get(pid)!;
            const node = nodeById.get(pid);
            const color = profileColor(pid);
            const rs = replicaSets[pid];
            const members = rs?.enabled ? rs.members : [];
            const running = members.filter((m) => m.status === 'running');
            const tw = (rs?.primaryWeight ?? 100) + running.reduce((s, m) => s + m.weight, 0);
            const myDraft = draftSteps.filter((d) => d.profileId === pid);
            const draftAdds = myDraft.filter((d) => d.kind === 'add-replica');
            const draftRemovals = new Set(myDraft.filter((d) => d.kind === 'remove-member').map((d) => d.params?.memberId));
            const canAdd = members.length + draftAdds.length < memberLimit;
            const danger = rs?.primaryReachable === false || members.some((m) => m.status === 'error');
            const availOld = (candidates[pid] ?? []).filter((row) => !row.isCurrent && !members.some((m) => m.versionId === row.versionId && m.status !== 'error'));
            return (
              <div key={pid}>
                <div className="absolute cursor-pointer overflow-hidden rounded-xl border-[1.5px] bg-background text-xs shadow-md"
                  onClick={(e) => { if ((e.target as HTMLElement).closest('button,a,input')) return; setSelected(selected === pid ? null : pid); }}
                  title="点击高亮与它相连的线"
                  style={{ left: p.x, top: p.y, width: BOX_W, height: p.h, borderColor: danger ? 'hsl(var(--destructive) / 0.6)' : selected === pid ? color : `${color}59`, boxShadow: selected === pid ? `0 0 0 2px ${color}55` : undefined }}>
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
                      weight={weightFor === `${pid}:primary` ? undefined : `${replicaSharePct(rs?.primaryWeight ?? 100, tw, true)}%`}
                      onWeightClick={() => { setWeightFor(`${pid}:primary`); setWeightDraft(String(rs?.primaryWeight ?? 100)); }}
                      weightInput={weightFor === `${pid}:primary` ? (
                        <WeightInput value={weightDraft} onChange={setWeightDraft} onCommit={() => commitWeight(pid, 'primary')} onCancel={() => setWeightFor(null)} />
                      ) : undefined} />
                  ) : null}
                  {members.map((m) => {
                    const removal = draftRemovals.has(m.id);
                    const url = memberDirectUrl(previewUrl, pid, m.id);
                    return (
                      <ChipRow key={m.id} color={color} mono={m.id}
                        sub={m.status === 'provisioning' ? (m.statusMessage || '创建中') : m.status === 'error' ? (m.statusMessage || '失败') : removal ? '待下线（草稿）' : m.reachable === false ? '不可达' : undefined}
                        danger={m.status === 'error' || (m.status === 'running' && m.reachable === false)}
                        boot={m.status === 'provisioning'} dim={removal}
                        weight={m.status === 'running' && weightFor !== `${pid}:${m.id}` ? `${replicaSharePct(m.weight, tw, false)}%` : undefined}
                        onWeightClick={m.status === 'running' ? () => { setWeightFor(`${pid}:${m.id}`); setWeightDraft(String(m.weight)); } : undefined}
                        weightInput={weightFor === `${pid}:${m.id}` ? (
                          <WeightInput value={weightDraft} onChange={setWeightDraft} onCommit={() => commitWeight(pid, m.id)} onCancel={() => setWeightFor(null)} />
                        ) : undefined}
                        actions={!removal ? (
                          <>
                            {url && m.status === 'running' ? (
                              <a className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-primary" title="直达该副本" href={url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" /></a>
                            ) : null}
                            <button type="button" className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-destructive" title="下线该副本（进变更清单）"
                              onClick={() => onAction(`${pid} · 下线 ${m.id}`, [{ kind: 'remove-member', profileId: pid, params: { memberId: m.id } }])}>
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </>
                        ) : undefined} />
                    );
                  })}
                  {draftAdds.map((d, i) => (
                    <ChipRow key={`${d.actionKey}-${i}`} color="#f59e0b" mono={`副本(草稿${i + 1})`} sub={d.params?.versionId ? '历史版本 · 待保存' : '当前版本 · 待保存'} ghost
                      actions={(
                        <button type="button" className="rounded border border-warn/50 bg-background p-0.5 text-warn hover:text-destructive "
                          title="撤销这条草稿（不影响其他草稿）" onClick={() => onRemoveAction(d.actionKey)}>
                          <X className="h-3 w-3" />
                        </button>
                      )} />
                  ))}
                </div>
                {/* 盒外右侧小按钮（Railway 风：加号不进盒内） */}
                <div className="absolute flex flex-col gap-1.5" style={{ left: p.x + BOX_W + 8, top: p.y + 6 }}>
                  {canAdd ? (
                    <button type="button"
                      className="flex h-6 w-6 items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:text-white"
                      style={{ borderColor: `${color}90`, color }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = color; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                      title="加一个副本：再起一个当前版本的实例，与主实例按权重分流（进变更清单）"
                      onClick={() => onAction(`${pid} · 新增当前版本副本`, [{ kind: 'add-replica', profileId: pid }])}>
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {canAdd && availOld.length > 0 ? (
                    <button type="button" className={`flex h-6 w-6 items-center justify-center rounded-full border bg-background shadow-sm ${pickFor === pid ? 'border-indigo-500 text-indigo-500' : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-indigo-500'}`}
                      title="用旧版本起副本：从历史部署版本里挑一个，与当前版本并排跑（新旧对比 / 灰度回退用；点开在画布下方选版本）" onClick={() => setPickFor(pickFor === pid ? null : pid)}>
                      <Layers className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button type="button" className="flex h-6 w-6 items-center justify-center rounded-full border border-[hsl(var(--hairline))] bg-background text-muted-foreground shadow-sm hover:text-primary"
                    title="分流实测：向真实入口发请求统计落点分布（弹窗显示结果）" onClick={() => void probe.runProbe(pid)}>
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}

          <DataLayerCards geo={geo} dbY={dbY} dbInfra={dbInfra} mainDbIdx={mainDbIdx} iso={branchIso}
            draftIsoCount={draftIsoCount} draftRevertCount={draftRevertCount}
            isolateTargets={isolateTargets} revertTargets={revertTargets} onIsolateAll={isolateAll} onRevertAll={revertAll}
            onRemoveIsoDrafts={removeIsoDrafts} onAudit={runAuditRep} />
        </div>
      </div>

      {/* 历史版本选择：弹窗（2026-07-25 用户拍板，不再显示在画布下方） */}
      {pickFor ? (
        <CanvasModal title={`${pickFor} · 选择历史版本作为副本`} onClose={() => setPickFor(null)}>
          {pickRows.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">没有可用的历史版本（需要至少一次托管构建产出的可复用镜像）</p>
          ) : (
            <div className="grid gap-1.5">
              {pickRows.slice(0, 12).map((row) => (
                <button key={row.versionId} type="button"
                  onClick={() => { setPickFor(null); onAction(`${pickFor} · 新增历史版本副本 ${row.commitSha.slice(0, 7)}`, [{ kind: 'add-replica', profileId: pickFor, params: { versionId: row.versionId } }]); }}
                  className="flex items-center gap-4 rounded-md border border-[hsl(var(--hairline))] bg-background px-3 py-2 text-left text-xs hover:border-indigo-500/50 hover:bg-indigo-500/[.06]">
                  <span className="font-mono font-semibold">{row.commitSha.slice(0, 7)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{row.image}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
        </CanvasModal>
      ) : null}
      <ProbeModal probe={probe} />
      <IsolationAuditModal audit={audit} />
      <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] px-5 py-2.5">
        <Button type="button" size="sm" variant="outline"
          title="隔离审计（MECE 实测）：逐容器 docker inspect 真实连接 + 双向金丝雀写入验证；未隔离时显示逐容器连接观测"
          onClick={runAuditRep}>
          <Database />隔离审计
        </Button>
        <Button type="button" size="sm" variant="outline"
          title="压测：对主实例与各副本同时加压，实时看 QPS/延迟曲线生长，结束给出谁更快、谁更稳的对比结论"
          onClick={() => onOpenLoadTest(profileIds.find((pid) => (replicaSets[pid]?.members.length ?? 0) > 0) || profileIds[0])}>
          <Activity />压测
        </Button>
        <span className="text-[11px] text-muted-foreground">黄色 = 草稿预期（保存后转常色）· 连线 = 环境变量引用（悬停看键名）· 粘性 cookie cds_rs · 响应头 X-CDS-Replica</span>
      </div>
      <style>{'@keyframes rsants{to{stroke-dashoffset:-40}}@keyframes rsflow{to{stroke-dashoffset:-20}}.rsflow{animation:rsflow 1.1s linear infinite}'}</style>
    </section>
  );
}

/** 实例行（容器盒内，Railway 风：细分隔线 + 素净行）：状态点 + 名称 + 权重（可点改）+ 动作 */
function ChipRow({ color, mono, sub, weight, onWeightClick, weightInput, actions, danger, boot, ghost, dim }: {
  color: string; mono: string; sub?: string; weight?: string; onWeightClick?: () => void; weightInput?: JSX.Element;
  actions?: JSX.Element; danger?: boolean; boot?: boolean; ghost?: boolean; dim?: boolean;
}): JSX.Element {
  return (
    <div className={`flex h-[22px] items-center gap-1.5 border-t border-[hsl(var(--hairline))]/70 px-2.5 text-[10px] ${danger ? 'bg-destructive/[.06] text-destructive' : ghost ? 'bg-warn/[.06] text-warn' : ''} ${dim ? 'opacity-50' : ''}`}>
      {boot ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-warn" /> : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : ghost ? '#f59e0b' : color }} />
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
const GROUP_W = 208;

function ProjectStage(props: StageSharedProps): JSX.Element {
  const { branchId, previewUrl, entries, services, infra, replicaSets, candidates, memberLimit, planMaxSteps, draftActions, draftSteps, onAction, onRemoveAction, onToast, profileIds, branchIso, isolateTargets, revertTargets, isolateAll, revertAll, draftIsoCount, draftRevertCount, removeIsoDrafts, headerLeft, headerRight, onOpenLoadTest } = props;
  const [hostRef, w] = useMeasuredWidth();
  const probe = useProbe(branchId, previewUrl, onToast);
  const audit = useIsolationAudit(branchId, onToast);
  const runAuditRep = (): void => {
    const rep = branchIso.isolatedProfiles[0] || profileIds[0];
    if (rep) void audit.run(rep);
  };
  const [weightFor, setWeightFor] = useState<number | null>(null);
  const [weightDraft, setWeightDraft] = useState('');

  const entryHost = previewUrl ? new URL(previewUrl).hostname : '预览入口未就绪';
  const dbInfra = infra.filter((s) => /mongo|mysql|mariadb|postgres|redis/i.test(s.dockerImage || s.id));

  const membersOf = (pid: string): ReplicaMemberView[] => (replicaSets[pid]?.enabled ? replicaSets[pid].members : []);
  // 按持久化组身份 join（Codex 第二十轮 P1）：部分失败/单侧下线造成数组错位时，
  // 按位配对会把不同批次的副本拼成假组；projectGroupId 缺失的存量成员退回按位
  const groups = buildProjectGroups(profileIds, membersOf);
  const groupCount = groups.length;
  const uneven = groupCount > 0 && groups.some((g) => profileIds.some((pid) => !g[pid]));
  const addable = profileIds.filter((p) => {
    const adds = draftSteps.filter((d) => d.profileId === p && d.kind === 'add-replica').length;
    return membersOf(p).length + adds < memberLimit;
  });
  // 整组必须覆盖项目全部服务（Codex 第十五轮 P1）：无可复用当前版本快照的服务
  // 物化不了副本——缺一个服务的「整组」是假整组（该服务流量仍打主实例，项目级
  // 实验失真）。缺口在 addGroup 里显式挡下并说明，不静默发起残组。
  const missingSnap = profileIds.filter((p) => !(candidates[p] ?? []).some((r) => r.isCurrent));
  const limitBlocked = profileIds.filter((p) => !addable.includes(p));
  // 幽灵整组节点 = 含新增副本步骤的草稿操作（一次手势一个节点，可单独撤销）
  const ghostGroupActions = draftActions.filter((a) => a.steps.some((s) => s.kind === 'add-replica'));
  const canAddGroup = profileIds.length > 0;

  const chipH = 26;
  const PROJ_H = 64 + profileIds.length * chipH + 12;
  // 副本节点 = 项目节点的同样式同尺寸拷贝（2026-07-25 用户拍板：拷贝原元素，不再另造点状物）
  const GROUP_H = PROJ_H;
  const gap = 26;
  const midNodes: Array<{ kind: 'main' | 'group' | 'ghost' | 'add'; k?: number; gi?: number; actionKey?: string; w: number; h: number }> = [
    { kind: 'main', w: PROJ_W, h: PROJ_H },
    ...Array.from({ length: groupCount }, (_, k) => ({ kind: 'group' as const, k, w: GROUP_W, h: GROUP_H })),
    ...ghostGroupActions.map((a, gi) => ({ kind: 'ghost' as const, gi, actionKey: a.key, w: GROUP_W, h: GROUP_H })),
    ...(canAddGroup ? [{ kind: 'add' as const, w: GROUP_W, h: GROUP_H }] : []),
  ];
  const geoProbe = dataGeo(w, Math.max(dbInfra.length, 1));
  const canvasW = Math.max(w, geoProbe.minWidth, PROJ_W + 2 * (GROUP_W + gap) + 40);
  const geo = dataGeo(canvasW, Math.max(dbInfra.length, 1));

  const rowsOut: Array<Array<{ node: typeof midNodes[number]; x: number }>> = [];
  {
    const totalW = midNodes.reduce((s, n) => s + n.w, 0) + (midNodes.length - 1) * gap;
    const startX = Math.max(12, (canvasW - Math.min(totalW, canvasW - 24)) / 2);
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

  const placed = rowsOut.flatMap((row, ri) => row.map((n) => ({ ...n, y: rowY[ri] })));
  const allIsolated = branchIso.state === 'done';
  const previewIso = branchIso.state === 'idle' && draftIsoCount > 0;

  const groupStatus = (k: number): { ok: number; boot: number; bad: number; missing: number; weightPct: number } => {
    let ok = 0, boot = 0, bad = 0, missing = 0;
    let pct = 0, pctN = 0;
    for (const pid of profileIds) {
      const m = groups[k]?.[pid];
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
    const steps: DraftStep[] = [];
    for (const pid of profileIds) {
      const m = groups[k]?.[pid];
      if (m) steps.push({ kind: 'remove-member', profileId: pid, params: { memberId: m.id } });
    }
    if (steps.length) {
      onAction(`下线整组副本 ${k + 1}（${steps.length} 容器各下线对应副本）`, steps);
      onToast?.(`整组副本 ${k + 1} 的下线草稿已加入`);
    }
  };
  const commitGroupWeight = (k: number): void => {
    const v = Math.max(0, Math.min(100, Math.round(Number(weightDraft))));
    setWeightFor(null);
    if (!Number.isFinite(v)) return;
    const steps: DraftStep[] = [];
    for (const pid of profileIds) {
      const m = groups[k]?.[pid];
      if (m) steps.push({ kind: 'set-weight', profileId: pid, params: { memberId: m.id, weight: v } });
    }
    if (steps.length) onAction(`整组副本 ${k + 1} 权重 → ${v}（${steps.length} 容器统一）`, steps);
  };
  const addGroup = (): void => {
    if (missingSnap.length > 0) {
      onToast?.(`无法加整组副本：${missingSnap.join('、')} 没有可复用的当前版本快照（先完成一次成功部署）——整组副本必须覆盖项目全部服务，缺口会让项目级实验失真`);
      return;
    }
    if (limitBlocked.length > 0) {
      onToast?.(`无法加整组副本：${limitBlocked.join('、')} 已达副本上限 ${memberLimit}——整组副本必须全员齐增`);
      return;
    }
    // 步数预检（Codex 第二十六轮 P2）：服务数 > 上限的项目，整组副本必然超步，
    // 此前按钮照样可点、草稿照样能加，直到保存才被后端 400 顶回来。
    if (draftSteps.length + profileIds.length > planMaxSteps) {
      onToast?.(`无法加整组副本：${profileIds.length} 个服务会让计划达到 ${draftSteps.length + profileIds.length} 步，超出单计划上限 ${planMaxSteps} 步——整组副本要求全员齐增，无法拆批，请联系管理员调高上限`);
      return;
    }
    const projectGroupId = newProjectGroupId();
    onAction(`整组副本（${profileIds.length} 容器各加 1 个当前版本副本）`,
      profileIds.map((p) => ({ kind: 'add-replica' as const, profileId: p, params: { projectGroupId } })));
    onToast?.('整组副本草稿已加入');
  };

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-2.5">
        {headerLeft}
        <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500"><Layers className="mr-1 inline h-3 w-3" />入口 → 项目 → 基础设施</span>
        {groupCount > 0 ? <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] text-indigo-500">整组副本 x{groupCount}</span> : null}
        {uneven ? <span className="rounded-md border border-warn/50 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">各容器副本数不齐</span> : null}
        {branchIso.state === 'done' ? <span className="rounded-md border border-ok/50 bg-ok-soft px-1.5 py-0.5 text-[11px] text-ok">已隔离 · 统一战线</span> : null}
        {branchIso.state === 'partial' ? <span className="rounded-md border border-warn/50 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">部分隔离 {branchIso.isolatedProfiles.length}/{branchIso.effectiveProfiles.length}</span> : null}
        {draftActions.length > 0 ? <span className="rounded-md border border-warn/50 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">{draftActions.length} 项变更待保存</span> : null}
        {headerRight}
      </div>

      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
        <div className="relative" style={{ width: canvasW, height, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
          <svg className="pointer-events-none absolute inset-0" width={canvasW} height={height}>
            <defs>
              <marker id="rsArrP" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker>
              <marker id="rsArrAmber" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#f59e0b" /></marker>
            </defs>
            {placed.map((n, i) => {
              if (n.node.kind === 'add') return null;
              const cx = n.x + n.node.w / 2;
              const ghost = n.node.kind === 'ghost';
              const group = n.node.kind === 'group';
              return (
                <g key={`edges-${i}`}>
                  <path className="rsflow" d={edgeD(entryX + CW / 2, entryY + 88, cx, n.y)} fill="none"
                    stroke={ghost ? '#f59e0b' : group ? '#6366f1' : 'hsl(var(--muted-foreground))'} strokeWidth={group || ghost ? 2 : 1.4}
                    strokeDasharray="5 5" opacity={ghost ? 0.45 : group ? 0.7 : 0.45} markerEnd={ghost ? 'url(#rsArrAmber)' : 'url(#rsArrP)'} />
                  {!ghost ? (
                    <path className={group && allIsolated ? 'rsflow' : undefined} d={edgeD(cx, n.y + n.node.h, (group && allIsolated ? geo.isoDbX(mainDbIdx) : mainDbX) + geo.dbCW / 2, dbY)} fill="none"
                      stroke={group && allIsolated ? '#10b981' : 'hsl(var(--muted-foreground))'} strokeWidth={group && allIsolated ? 1.8 : 1.2}
                      strokeDasharray="5 5" opacity={group && allIsolated ? 0.65 : 0.22} markerEnd={group && allIsolated ? 'url(#rsArrP)' : undefined} />
                  ) : null}
                  {/* 预期管理：隔离草稿时，整组/幽灵节点画黄色预连线到隔离副本库 */}
                  {previewIso && (group || ghost) ? (
                    <path className="rsflow" d={edgeD(cx, n.y + n.node.h, geo.isoDbX(mainDbIdx) + geo.dbCW / 2, dbY)} fill="none"
                      stroke="#f59e0b" strokeWidth="1.6" strokeDasharray="4 4" opacity="0.55" markerEnd="url(#rsArrAmber)" />
                  ) : null}
                </g>
              );
            })}
            <DataLayerSvg geo={geo} fy={fy} fh={fh} iso={branchIso} draftIsoCount={draftIsoCount} mainDbX={mainDbX}
              transferActive={branchIso.state === 'cloning' || branchIso.state === 'switching'} />
          </svg>

          <StageCard x={entryX} y={entryY} name="入口" ico="GW" color="#6366f1" ok status={entryHost} foot="forwarder · 按权重分流" />
          <EntryLinks x={entryX + CW + 12} y={entryY + 4} entries={entries} />

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
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
                    {profileIds.length} 容器 · 主实例组
                  </div>
                  {/* 容器 chips：与分支卡左上角的 chip 同一视觉语言（2026-07-25 用户拍板，样式不另造） */}
                  <div className="flex flex-col gap-1 px-2.5 pb-2 pt-1.5">
                    {profileIds.map((pid) => (
                      <span key={pid} className="inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-1.5 text-[10px]">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: profileColor(pid) }} />
                        <span className="min-w-0 flex-1 truncate font-mono" title={pid}>{pid}</span>
                        {services?.[pid]?.hostPort ? <span className="shrink-0 font-mono text-muted-foreground">:{services[pid].hostPort}</span> : null}
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
                <div key={`group-${k}`} className={`absolute rounded-xl border-[1.5px] bg-background text-xs shadow-md ${danger ? 'border-destructive/60' : 'border-indigo-500/45'}`}
                  style={{ left: n.x, top: n.y, width: GROUP_W, height: n.node.h }}>
                  <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] font-bold">
                    <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-indigo-500 text-[10px] font-extrabold text-white">PRJ</span>
                    <span className="min-w-0 flex-1 truncate">项目-复制集-{k + 1}</span>
                    <button type="button" className="rounded border border-[hsl(var(--hairline))] bg-background p-0.5 text-muted-foreground hover:text-destructive"
                      title="下线这一组（每个容器各下线对应副本，进变更清单）" onClick={() => removeGroup(k)}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className={`flex items-center gap-1.5 px-2.5 pt-0.5 text-[10px] ${danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                    {st.boot > 0 ? <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-warn" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : '#10b981' }} />}
                    <span className="min-w-0 flex-1 truncate">{st.boot > 0 ? '创建中…' : danger ? `${st.bad} 个容器副本异常` : st.missing > 0 ? `覆盖 ${profileIds.length - st.missing}/${profileIds.length} 容器` : '复制集成员 · 已负载'}</span>
                    {weightFor === k ? (
                      <WeightInput value={weightDraft} onChange={setWeightDraft} onCommit={() => commitGroupWeight(k)} onCancel={() => setWeightFor(null)} />
                    ) : st.ok > 0 ? (
                      <button type="button" className="shrink-0 rounded border border-indigo-500/45 bg-background px-1 font-mono text-[9px] text-indigo-500 hover:bg-indigo-500/10"
                        title="点击调整这一组的权重（整组统一，进变更清单）"
                        onClick={() => { setWeightFor(k); setWeightDraft(String(Object.values(groups[k] ?? {}).find(Boolean)?.weight ?? 0)); }}>
                        {st.weightPct}%
                      </button>
                    ) : null}
                  </div>
                  {/* 与项目节点同样式的容器 chip 行：一一对应的成员实例 */}
                  <div className="flex flex-col gap-1 px-2.5 pb-2 pt-1.5">
                    {profileIds.map((pid) => {
                      const m = groups[k]?.[pid];
                      const c = !m ? '#9ca3af' : m.status === 'running' && m.reachable !== false ? profileColor(pid) : m.status === 'provisioning' ? '#f59e0b' : '#ef4444';
                      return (
                        <span key={pid} className="inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-1.5 text-[10px]"
                          title={`${pid}：${m ? (m.status === 'running' ? (m.reachable === false ? '不可达' : '运行中') : m.status) : '缺此组副本'}`}>
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c, opacity: m ? 1 : 0.4 }} />
                          <span className="min-w-0 flex-1 truncate font-mono">{pid}</span>
                          {m?.hostPort ? <span className="shrink-0 font-mono text-muted-foreground">:{m.hostPort}</span> : null}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            }
            if (n.node.kind === 'ghost') {
              // 预期管理：幽灵节点 = 项目节点的同样式黄色拷贝——保存后长成什么样，现在就画什么样
              const num = groupCount + (n.node.gi ?? 0) + 1;
              return (
                <div key={`ghost-${n.node.actionKey}`} className="absolute rounded-xl border-[1.5px] border-dashed border-warn/60 bg-warn/[.04] text-xs shadow-md"
                  style={{ left: n.x, top: n.y, width: GROUP_W, height: n.node.h }}>
                  <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] font-bold text-warn">
                    <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-warn text-[10px] font-extrabold text-white">PRJ</span>
                    <span className="min-w-0 flex-1 truncate">项目-复制集-{num}</span>
                    <button type="button" className="rounded border border-warn/50 bg-background p-0.5 text-warn hover:text-destructive "
                      title="撤销这条整组副本草稿" onClick={() => onRemoveAction(n.node.actionKey!)}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 pt-0.5 text-[10px] text-warn/90 /90">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                    <span className="truncate">待保存 · 保存后每容器各创建 1 个副本</span>
                  </div>
                  <div className="flex flex-col gap-1 px-2.5 pb-2 pt-1.5">
                    {profileIds.map((pid) => (
                      <span key={pid} className="inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-md border border-warn/40 bg-warn/[.06] px-1.5 text-[10px] text-warn"
                        title={`${pid}：保存后创建副本实例`}>
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn/80" />
                        <span className="min-w-0 flex-1 truncate font-mono">{pid}</span>
                        <span className="shrink-0 font-mono opacity-70">待建</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            }
            return (
              <button key={`add-${i}`} type="button"
                className="absolute flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-indigo-500/50 bg-indigo-500/10 text-xs font-semibold text-indigo-500 transition-colors hover:bg-indigo-500 hover:text-white"
                style={{ left: n.x, top: n.y, width: GROUP_W, height: n.node.h }}
                title={missingSnap.length > 0
                  ? `整组副本被阻断：${missingSnap.join('、')} 缺可复用当前版本快照（先完成一次成功部署）`
                  : limitBlocked.length > 0
                    ? `整组副本被阻断：${limitBlocked.join('、')} 已达副本上限`
                    : `加一组副本：${profileIds.length} 个容器各加一个当前版本副本（进变更清单）`}
                onClick={addGroup}>
                <Plus className="h-5 w-5" />整组副本
              </button>
            );
          })}

          <DataLayerCards geo={geo} dbY={dbY} dbInfra={dbInfra} mainDbIdx={mainDbIdx} iso={branchIso}
            draftIsoCount={draftIsoCount} draftRevertCount={draftRevertCount}
            isolateTargets={isolateTargets} revertTargets={revertTargets} onIsolateAll={isolateAll} onRevertAll={revertAll}
            onRemoveIsoDrafts={removeIsoDrafts} onAudit={runAuditRep} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] px-5 py-2.5">
        <Button type="button" size="sm" variant="outline"
          title="分流实测：向真实入口发请求统计落点分布（取第一个有副本的容器作代表，弹窗显示结果）"
          onClick={() => {
            const rep = profileIds.find((pid) => (replicaSets[pid]?.enabled && replicaSets[pid].members.length > 0)) || profileIds[0];
            if (rep) void probe.runProbe(rep);
          }}>
          <RefreshCw />分流实测
        </Button>
        <Button type="button" size="sm" variant="outline"
          title="隔离审计（MECE 实测）：逐容器 docker inspect 真实连接 + 双向金丝雀写入验证；未隔离时显示逐容器连接观测"
          onClick={runAuditRep}>
          <Database />隔离审计
        </Button>
        <Button type="button" size="sm" variant="outline"
          title="压测：对主实例与整组副本同时加压，实时看 QPS/延迟曲线生长，结束给出谁更快、谁更稳的对比结论"
          onClick={() => onOpenLoadTest(profileIds.find((pid) => (replicaSets[pid]?.members.length ?? 0) > 0) || profileIds[0])}>
          <Activity />压测
        </Button>
        <span className="text-[11px] text-muted-foreground">黄色 = 草稿预期（保存后转常色）· 整组副本紧跟项目节点右侧生长（放不下换行）· 保存后串行执行</span>
      </div>
      <ProbeModal probe={probe} />
      <IsolationAuditModal audit={audit} />
      <style>{'@keyframes rsants{to{stroke-dashoffset:-40}}@keyframes rsflow{to{stroke-dashoffset:-20}}.rsflow{animation:rsflow 1.1s linear infinite}'}</style>
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

/** 入口链接列（2026-07-26 入口卡入画布）：挂在画布入口节点右侧的公开入口直达链。
 * 抽屉头部的「应用已上线」大卡只留总览页签，运行画布由此承载同一组入口。 */
function EntryLinks({ x, y, entries }: { x: number; y: number; entries: Array<{ name: string; url: string }> }): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="absolute flex flex-col gap-1" style={{ left: x, top: y }}>
      {entries.slice(0, 4).map((e) => (
        <a key={e.url} href={e.url} target="_blank" rel="noreferrer"
          onClick={(ev) => ev.stopPropagation()}
          title={'打开 ' + e.name + '：' + e.url}
          className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-ok/40 bg-ok/[.08] px-2 text-[11px] font-medium text-ok transition-colors hover:bg-ok-soft ">
          <span className="truncate">{e.name}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ))}
    </div>
  );
}

function StageCard({ x, y, w = 180, name, ico, color, ok, danger, ghost, locked, draftStyle, status, foot, hero, boot, extra, label, labelX, labelY, onLabelClick }: {
  x: number; y: number; w?: number; name: string; ico: string; color: string; ok?: boolean; danger?: boolean; ghost?: boolean; locked?: boolean;
  /** 草稿预期样式：黄色虚线边——保存后转常色（预期管理） */
  draftStyle?: boolean;
  status: string; foot?: string; hero?: boolean; boot?: boolean; extra?: JSX.Element; label?: string; labelX?: number; labelY?: number;
  onLabelClick?: () => void;
}): JSX.Element {
  return (
    <>
      <div className={`absolute rounded-xl border bg-background text-xs shadow-md ${danger ? 'border-destructive/60' : draftStyle ? 'border-[1.5px] border-dashed border-warn/60 bg-warn/[.04]' : ghost ? 'border-dashed border-[hsl(var(--muted-foreground))]/50 opacity-70' : hero ? 'border-indigo-500/45' : 'border-[hsl(var(--hairline))]'}`}
        style={{ left: x, top: y, width: w, ...(boot ? { animation: 'rscolorin 2.4s forwards' } : {}), ...(locked ? { filter: 'grayscale(0.9)', opacity: 0.65 } : {}) }}>
        {locked ? (
          <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[hsl(var(--hairline))] bg-background text-muted-foreground" title="副本请求已（或保存后将）转移到隔离区，回切主库可解锁">
            <Lock className="h-3 w-3" />
          </span>
        ) : null}
        <div className={`flex items-center gap-2 overflow-hidden rounded-t-xl px-3 py-2 text-[13px] font-bold ${draftStyle ? 'text-warn' : ''}`}>
          <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[10px] font-extrabold text-white" style={{ background: color }}>{ico}</span>
          <span className="truncate">{name}</span>
        </div>
        <div className={`flex items-center gap-1.5 px-3 pb-2 text-[11px] ${danger ? 'font-semibold text-destructive' : draftStyle ? 'text-warn/90 /90' : 'text-muted-foreground'}`}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : draftStyle ? '#f59e0b' : ok ? '#10b981' : 'hsl(var(--muted-foreground))' }} />
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
