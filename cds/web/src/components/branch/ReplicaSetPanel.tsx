/*
 * ReplicaSetPanel — 复制集模式面板（design.cds.replica-set，2026-07-24 定稿版）。
 *
 * 信息层级（用户拍板）：
 *   - 方案A「行式」默认：一行一个服务，常驻只有 服务名/实例块/流量条/+，
 *     权重、直达、提升、下线、历史版本、实测全部收进「管理」展开层；
 *   - 方案B「流量舞台」切换视图：Railway 风自上而下拓扑（入口 → 实例层 → 数据层），
 *     贝塞尔曲线、灰卡渐显可撤回、连线上的「复制隔离」按钮（复制 → 切换 → 留影可回切）；
 *   - 分流实测：串流模式（服务端逐请求等响应），前端按真实结果回放粒子动画 + 实时日志 + 仪表盘。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpCircle, Copy, ExternalLink, Layers, LayoutList, Loader2, Network, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react';
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
  /** 服务端 TCP 实测可达性（P1-2：status 只反映控制面意图，健康必须实测） */
  reachable?: boolean;
}

export interface ReplicaDbSnapshotView {
  id: string;
  profileId: string;
  memberId: string;
  engine: 'mongo' | 'mysql' | 'postgres';
  sourceDb: string;
  dbName: string;
  /** 有值 = 隔离库在专用独立实例容器里（删除快照即移除该实例） */
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

interface ReplicaCandidateView {
  versionId: string;
  commitSha: string;
  image: string;
  createdAt: string;
  isCurrent: boolean;
}

interface ReplicaSetsResponse {
  replicaSets: Record<string, ProfileReplicaSetView>;
  candidates: Record<string, ReplicaCandidateView[]>;
  snapshots?: ReplicaDbSnapshotView[];
  memberLimit: number;
}

interface ProbeHit { seq: number; servedBy: string; status: number }
interface ProbeResult { tally: Record<string, number>; hits: ProbeHit[]; count: number; path: string }

export interface PanelServiceInfo { hostPort?: number; status?: string }
export interface PanelInfraInfo { id: string; name?: string; dockerImage?: string; status?: string }

type PanelState =
  | { status: 'loading' }
  | { status: 'ok'; data: ReplicaSetsResponse }
  | { status: 'error'; message: string };

/** 从主入口 previewUrl 推导成员直达链：首个 DNS 标签追加 -<memberId>。 */
export function memberDirectUrl(previewUrl: string | undefined, memberId: string): string | null {
  if (!previewUrl) return null;
  try {
    const url = new URL(previewUrl);
    const [first, ...rest] = url.hostname.split('.');
    if (!first || rest.length === 0) return null;
    url.hostname = [`${first}-${memberId}`, ...rest].join('.');
    return url.toString();
  } catch {
    return null;
  }
}

function statusPill(member: ReplicaMemberView): JSX.Element {
  if (member.status === 'provisioning') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400" title={member.statusMessage}>
        <Loader2 className="h-3 w-3 animate-spin" />
        {member.statusMessage?.includes('第1步') ? '复制中' : member.statusMessage?.includes('第2步') || member.statusMessage?.includes('回切') ? '切换中' : '创建中'}
      </span>
    );
  }
  if (member.status === 'running') {
    if (member.reachable === false) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive" title="容器端口拒绝连接（服务端 TCP 实测），仍按权重接流量，建议下线">
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          不可达
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        运行中
      </span>
    );
  }
  if (member.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive" title={member.statusMessage}>
        失败
      </span>
    );
  }
  return <span className="inline-flex items-center rounded-md border border-[hsl(var(--hairline))] px-2 py-0.5 text-[11px] text-muted-foreground">已停止</span>;
}

const MEMBER_COLORS = ['#6366f1', '#0ea5e9', '#14b8a6'];

export function ReplicaSetPanel({
  branchId,
  previewUrl,
  services,
  infra,
  onToast,
}: {
  branchId: string;
  previewUrl?: string;
  /** 分支应用服务（profileId → 端口/状态），舞台与行式展示用 */
  services?: Record<string, PanelServiceInfo>;
  /** 项目基础设施（舞台数据层展示用） */
  infra?: PanelInfraInfo[];
  onToast?: (message: string) => void;
}): JSX.Element {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<'rows' | 'stage'>('rows');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [stageSel, setStageSel] = useState<string | null>(null);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setState({ status: 'loading' });
    try {
      const data = await apiRequest<ReplicaSetsResponse>(`/api/branches/${encodeURIComponent(branchId)}/replica-sets`);
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  // provisioning / 隔离切换中：4s 轮询直到终态（禁止空白等待）
  useEffect(() => {
    if (state.status !== 'ok') return;
    const busyNow = Object.values(state.data.replicaSets)
      .some((rs) => rs.members.some((m) => m.status === 'provisioning'));
    if (!busyNow) return;
    const timer = setInterval(() => { void load(true); }, 4000);
    return () => clearInterval(timer);
  }, [state, load]);

  // 成员转入 error 时立即 toast 失败原因（复验 R2-P2-1：失败不许静默）
  const toastedErrorsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (state.status !== 'ok') return;
    for (const [profileId, rs] of Object.entries(state.data.replicaSets)) {
      for (const m of rs.members) {
        const key = `${profileId}:${m.id}:${m.statusMessage ?? ''}`;
        if (m.status === 'error' && !toastedErrorsRef.current.has(key)) {
          toastedErrorsRef.current.add(key);
          onToast?.(`${profileId} 的副本 ${m.id} 失败：${m.statusMessage || '未知原因'}`);
        }
      }
    }
  }, [state, onToast]);

  const run = useCallback(async (key: string, fn: () => Promise<void>, doneMessage?: string) => {
    setBusy(key);
    try {
      await fn();
      if (doneMessage) onToast?.(doneMessage);
      await load(true);
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [load, onToast]);

  const api = useMemo(() => ({
    quickAdd: (profileId: string) => run(`add:${profileId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members`, { method: 'POST', body: {} });
    }, '副本创建中：当前版本再起一个实例，就绪后自动与主均分流量'),
    addVersion: (profileId: string, versionId: string, dbMode: 'shared' | 'isolated') => {
      setPickerFor(null);
      return run(`add:${profileId}`, async () => {
        await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members`, { method: 'POST', body: { versionId, dbMode } });
      }, '成员启动中：从保留镜像秒起');
    },
    setWeight: (profileId: string, memberId: string, weight: number) => run(`w:${profileId}:${memberId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members/${encodeURIComponent(memberId)}`, { method: 'PATCH', body: { weight } });
    }, '权重已更新，约 2 秒后生效'),
    remove: (profileId: string, memberId: string) => run(`rm:${profileId}:${memberId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
    }, '成员已下线'),
    promote: (profileId: string, memberId: string) => run(`pr:${profileId}:${memberId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members/${encodeURIComponent(memberId)}/promote`, { method: 'POST' });
    }, '已派发主版本切换，复制集将自动解散'),
    dissolve: (profileId: string) => run(`ds:${profileId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
    }, '已关闭复制集'),
    isolate: (profileId: string) => run(`iso:${profileId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/isolate`, { method: 'POST' });
    }, '复制隔离启动：第1步 克隆隔离库（主库不动）→ 第2步 副本切换'),
    revert: (profileId: string) => run(`rev:${profileId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/revert-db`, { method: 'POST' });
    }, '回切主库：副本恢复原连接，隔离库转为快照保留'),
    probe: async (profileId: string, path?: string): Promise<ProbeResult | null> => {
      if (!previewUrl) { onToast?.('该分支还没有预览入口，无法实测'); return null; }
      const host = new URL(previewUrl).hostname;
      const cleanPath = path && path.startsWith('/') ? path : undefined;
      return apiRequest<ProbeResult>(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/probe`, {
        method: 'POST', body: { host, count: 12, ...(cleanPath ? { path: cleanPath } : {}) },
      });
    },
    deleteSnapshot: (id: string, dbName: string) => run(`snap:${id}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-db-snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }, `隔离库 ${dbName} 已删除`),
  }), [branchId, previewUrl, run, onToast]);

  if (state.status === 'loading') {
    return (
      <section className="cds-surface-raised cds-hairline flex items-center gap-2 px-5 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载复制集配置…
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="cds-surface-raised cds-hairline px-5 py-8 text-sm">
        <p className="text-destructive">{state.message}</p>
        <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
          <RefreshCw />
          重试
        </Button>
      </section>
    );
  }

  const { replicaSets, candidates, memberLimit } = state.data;
  const snapshots = state.data.snapshots ?? [];
  const profileIds = Array.from(new Set([...Object.keys(replicaSets), ...Object.keys(candidates)])).sort();
  // 舞台默认展示有成员的服务；用户可用切换器显式选定（R3-P3：默认字母序首个会误导「+副本」打到非预期服务）
  const stageProfile = (stageSel && profileIds.includes(stageSel) ? stageSel : undefined)
    || profileIds.find((p) => replicaSets[p]?.enabled && replicaSets[p].members.length > 0)
    || profileIds[0];

  return (
    <div className="grid gap-4">
      <section className="cds-surface-raised cds-hairline flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="inline-flex overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
          <button type="button" onClick={() => setView('rows')} className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs ${view === 'rows' ? 'bg-primary text-primary-foreground font-semibold' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'}`}>
            <LayoutList className="h-3.5 w-3.5" />
            行式
          </button>
          <button type="button" onClick={() => setView('stage')} className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs ${view === 'stage' ? 'bg-primary text-primary-foreground font-semibold' : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'}`}>
            <Network className="h-3.5 w-3.5" />
            流量舞台
          </button>
        </div>
        <span className="text-xs leading-5 text-muted-foreground">
          点「+」一键副本（当前版本，就绪后与主均分流量）；细节在「管理」展开。随时「关闭复制集」。上限 {memberLimit} 个副本。
        </span>
      </section>

      {view === 'rows' ? (
        <section className="cds-surface-raised cds-hairline overflow-hidden">
          {profileIds.length === 0 ? (
            <div className="px-5 py-8 text-sm text-muted-foreground">
              还没有可复制集化的服务：走一次极速版/托管构建部署后，历史版本会出现在这里。
            </div>
          ) : profileIds.map((profileId) => (
            <ServiceRow
              key={profileId}
              profileId={profileId}
              rs={replicaSets[profileId]}
              candidates={candidates[profileId] ?? []}
              service={services?.[profileId]}
              previewUrl={previewUrl}
              busy={busy}
              open={openRow === profileId}
              pickerOpen={pickerFor === profileId}
              memberLimit={memberLimit}
              api={api}
              onToggle={() => setOpenRow(openRow === profileId ? null : profileId)}
              onTogglePicker={() => setPickerFor(pickerFor === profileId ? null : profileId)}
            />
          ))}
        </section>
      ) : (
        <ReplicaStage
          profileId={stageProfile}
          profileIds={profileIds}
          onSelectProfile={setStageSel}
          rs={stageProfile ? replicaSets[stageProfile] : undefined}
          service={stageProfile ? services?.[stageProfile] : undefined}
          infra={infra ?? []}
          previewUrl={previewUrl}
          memberLimit={memberLimit}
          api={api}
          onToast={onToast}
        />
      )}

      {snapshots.length > 0 ? (
        <section className="cds-surface-raised cds-hairline px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold">隔离库数据快照（{snapshots.length}）</div>
          <p className="mt-1 text-xs text-muted-foreground">回切/下线后隔离库保留在这里（克隆时间点副本）。手动删除才会真正 drop。</p>
          <div className="mt-3 grid gap-2">
            {snapshots.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-4 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs">
                <span className="min-w-0">
                  <span className="block font-mono font-semibold">{s.dbName}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{s.engine} · 来源 {s.sourceDb}{s.dedicatedContainer ? ' · 专用隔离实例' : ''} · {new Date(s.clonedAt).toLocaleString()}</span>
                </span>
                <ConfirmAction
                  title="删除隔离库"
                  description={`将执行 DROP DATABASE ${s.dbName}，数据不可恢复。确认删除？`}
                  confirmLabel="删除数据库"
                  trigger={<Button type="button" size="sm" variant="ghost" disabled={busy !== null}><Trash2 />删除</Button>}
                  onConfirm={() => api.deleteSnapshot(s.id, s.dbName)}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ── 方案A：行式 ── */
function ServiceRow({
  profileId, rs, candidates, service, previewUrl, busy, open, pickerOpen, memberLimit, api, onToggle, onTogglePicker,
}: {
  profileId: string;
  rs?: ProfileReplicaSetView;
  candidates: ReplicaCandidateView[];
  service?: PanelServiceInfo;
  previewUrl?: string;
  busy: string | null;
  open: boolean;
  pickerOpen: boolean;
  memberLimit: number;
  api: ReturnType<typeof Object> & Record<string, (...args: never[]) => unknown>;
  onToggle: () => void;
  onTogglePicker: () => void;
}): JSX.Element {
  const a = api as unknown as {
    quickAdd: (p: string) => Promise<void>;
    addVersion: (p: string, v: string, d: 'shared' | 'isolated') => Promise<void>;
    setWeight: (p: string, m: string, w: number) => Promise<void>;
    remove: (p: string, m: string) => Promise<void>;
    promote: (p: string, m: string) => Promise<void>;
    dissolve: (p: string) => Promise<void>;
    isolate: (p: string) => Promise<void>;
    revert: (p: string) => Promise<void>;
    probe: (p: string, path?: string) => Promise<ProbeResult | null>;
  };
  const members = rs?.enabled ? rs.members : [];
  const running = members.filter((m) => m.status === 'running');
  const unreachable = running.filter((m) => m.reachable === false);
  const errored = members.filter((m) => m.status === 'error');
  const tw = (rs?.primaryWeight ?? 100) + running.reduce((s, m) => s + m.weight, 0);
  const availableRows = candidates.filter((row) => !row.isCurrent && !members.some((m) => m.versionId === row.versionId && m.status !== 'error'));
  const [probe, setProbe] = useState<ProbeResult | 'running' | null>(null);
  const [probePath, setProbePath] = useState('');

  return (
    <div className="border-t border-[hsl(var(--hairline))] first:border-t-0">
      <div className="flex flex-wrap items-center gap-4 px-5 py-3.5">
        <div className="w-[190px] min-w-0">
          <div className="flex items-center gap-1.5 truncate text-sm font-semibold">
            <span className="truncate">{profileId}</span>
            {members.length > 0 ? <Layers className="h-3.5 w-3.5 shrink-0 text-indigo-500" /> : null}
            {rs?.isolated ? <span className="rounded border border-emerald-500/50 bg-emerald-500/10 px-1 text-[10px] text-emerald-600 dark:text-emerald-400">隔离库</span> : null}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {service?.hostPort ? `:${service.hostPort}` : ''}{members.length ? ` · ${members.length + 1} 实例` : ` · ${candidates.length} 个历史版本`}
          </div>
        </div>
        <div className="flex w-[84px] gap-1">
          <i className="h-[18px] w-3.5 rounded bg-[hsl(var(--muted-foreground))]/60" title="主实例" />
          {members.map((m) => (
            <i key={m.id} className={`h-[18px] w-3.5 rounded ${m.status === 'provisioning' ? 'animate-pulse bg-amber-500' : m.status === 'error' || m.reachable === false ? 'bg-destructive' : 'bg-indigo-500'}`} title={`${m.id} ${m.reachable === false ? '不可达' : m.status}`} />
          ))}
        </div>
        <div className="min-w-[140px] flex-1">
          {running.length > 0 ? (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-md border border-[hsl(var(--hairline))]">
                <div className="bg-[hsl(var(--muted-foreground))]/60" style={{ width: `${((rs?.primaryWeight ?? 100) / tw) * 100}%` }} />
                {running.map((m, i) => (
                  <div key={m.id} style={{ width: `${(m.weight / tw) * 100}%`, background: MEMBER_COLORS[i % MEMBER_COLORS.length] }} />
                ))}
              </div>
              <div className="mt-0.5 flex gap-3 text-[11px] tabular-nums text-muted-foreground">
                <span>主 {Math.round(((rs?.primaryWeight ?? 100) / tw) * 100)}%</span>
                {running.map((m) => <span key={m.id}>{m.id} {Math.round((m.weight / tw) * 100)}%</span>)}
              </div>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">全部流量走主实例</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={busy !== null || members.length >= memberLimit} onClick={() => void a.quickAdd(profileId)} title="当前版本再起一个副本，就绪后与主均分流量">
            {busy === `add:${profileId}` ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
          {members.length > 0 || availableRows.length > 0 ? (
            <button type="button" className="text-xs text-muted-foreground hover:text-primary" onClick={onToggle}>{open ? '收起' : '管理'}</button>
          ) : null}
        </div>
      </div>
      {unreachable.length > 0 || rs?.primaryReachable === false ? (
        <div className="flex flex-wrap items-center gap-2 px-5 pb-2.5 text-[11px] text-destructive">
          <span className="font-semibold">
            {[...(rs?.primaryReachable === false ? ['主实例'] : []), ...unreachable.map((m) => m.id)].join('、')} 实际不可达（TCP 拒绝连接），仍按权重接收真实流量
          </span>
          <span className="text-muted-foreground">— 建议在「管理」里下线该副本，或将权重调为 0</span>
        </div>
      ) : null}
      {errored.map((m) => (
        <div key={m.id} className="flex flex-wrap items-center gap-2 px-5 pb-2.5 text-[11px] text-destructive">
          <span className="font-semibold">{m.id} 失败：{m.statusMessage || '未知原因'}</span>
          <span className="text-muted-foreground">— 可在「管理」里下线后重试</span>
        </div>
      ))}

      {open ? (
        <div className="grid gap-2.5 border-t border-dashed border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 px-5 py-3.5">
          {members.length > 0 ? (
            <>
              <MemberLine title="主实例" pill={<span className="rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">primary</span>}
                sub="随分支部署滚动更新" weight={rs!.primaryWeight} busy={busy === `w:${profileId}:primary`} onWeight={(w) => void a.setWeight(profileId, 'primary', w)} />
              {members.map((m) => (
                <MemberLine key={m.id} title={m.id} pill={statusPill(m)}
                  sub={`${m.commitSha?.slice(0, 7) ?? ''}${m.hostPort ? ` · :${m.hostPort}` : ''}${m.isolatedDbName ? ` · 隔离库 ${m.isolatedDbName}` : ''}`}
                  weight={m.weight} busy={busy === `w:${profileId}:${m.id}`} disabled={m.status !== 'running'}
                  onWeight={(w) => void a.setWeight(profileId, m.id, w)}
                  actions={(
                    <>
                      {m.status === 'running' && memberDirectUrl(previewUrl, m.id) ? (
                        <Button type="button" size="sm" variant="ghost" asChild>
                          <a href={memberDirectUrl(previewUrl, m.id)!} target="_blank" rel="noreferrer"><ExternalLink />直达</a>
                        </Button>
                      ) : null}
                      {m.status === 'running' ? (
                        <ConfirmAction title="提升为主版本" description="主容器将重建为该版本，复制集随后自动解散。确认？" confirmLabel="提升"
                          trigger={<Button type="button" size="sm" variant="ghost" disabled={busy !== null}><ArrowUpCircle />提升</Button>}
                          onConfirm={() => a.promote(profileId, m.id)} />
                      ) : null}
                      <ConfirmAction title="下线成员" description="移除该成员容器（历史版本记录保留）。确认下线？" confirmLabel="下线"
                        trigger={<Button type="button" size="sm" variant="ghost" disabled={busy !== null}><Trash2 /></Button>}
                        onConfirm={() => a.remove(profileId, m.id)} />
                    </>
                  )} />
              ))}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {rs?.isolated ? (
                  <ConfirmAction title="回切主库" description={`副本恢复直连主库；隔离库 ${rs.isolated.dbName} 转为快照保留。确认回切？`} confirmLabel="回切"
                    trigger={<Button type="button" size="sm" variant="outline" disabled={busy !== null}><Undo2 />回切主库</Button>}
                    onConfirm={() => a.revert(profileId)} />
                ) : running.length > 0 ? (
                  <ConfirmAction title="复制隔离" description="第1步 复制：整库克隆一份隔离库（主库不动）；第2步 切换：全部副本重启改连隔离库。旧连接可随时回切。确认？" confirmLabel="复制隔离"
                    trigger={<Button type="button" size="sm" variant="outline" disabled={busy !== null}><Copy />复制隔离</Button>}
                    onConfirm={() => a.isolate(profileId)} />
                ) : null}
                {availableRows.length > 0 && members.length < memberLimit ? (
                  <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={onTogglePicker}><Layers />历史版本</Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" disabled={probe === 'running' || running.every((m) => m.weight === 0)}
                  title="服务端串流发 12 个真实请求（逐个等响应），按 X-CDS-Replica 统计落点"
                  onClick={() => { setProbe('running'); void a.probe(profileId, probePath.trim() || undefined).then((r) => setProbe(r)); }}>
                  {probe === 'running' ? <Loader2 className="animate-spin" /> : <RefreshCw />}分流实测
                </Button>
                <input type="text" value={probePath} onChange={(e) => setProbePath(e.target.value)} placeholder="探测路径（默认自动推导）"
                  title="指定实测请求的路径，需以 / 开头；留空按服务路由前缀自动推导。非 2xx 状态不影响落点判定（以 X-CDS-Replica 头为准）"
                  className="h-7 w-44 rounded-md border border-[hsl(var(--hairline))] bg-transparent px-2 font-mono text-[11px] outline-none focus:border-primary" />
                <ConfirmAction title="关闭复制集" description="移除全部副本容器并删除复制集配置，主容器与主入口不受影响。确认？" confirmLabel="关闭复制集"
                  trigger={<Button type="button" size="sm" variant="ghost" disabled={busy !== null}><Undo2 />关闭复制集</Button>}
                  onConfirm={() => a.dissolve(profileId)} />
                <span className="text-[11px] text-muted-foreground">粘性 cookie cds_rs · 响应头 X-CDS-Replica</span>
              </div>
              {probe && probe !== 'running' ? <ProbeDashboard result={probe} /> : null}
            </>
          ) : null}
          {pickerOpen || (open && members.length === 0) ? (
            <CandidatePicker rows={availableRows} busy={busy === `add:${profileId}`} onPick={(v, d) => void a.addVersion(profileId, v, d)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MemberLine({ title, sub, pill, weight, busy, disabled, onWeight, actions }: {
  title: string; sub: string; pill: JSX.Element; weight: number; busy?: boolean; disabled?: boolean;
  onWeight: (w: number) => void; actions?: JSX.Element;
}): JSX.Element {
  const [draft, setDraft] = useState(String(weight));
  useEffect(() => { setDraft(String(weight)); }, [weight]);
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs">
      <span className="w-[90px] truncate font-medium">{title}</span>
      {pill}
      <label className="flex items-center gap-1.5 text-muted-foreground">
        权重
        <input type="number" min={0} max={100} value={draft} disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { const v = Math.max(0, Math.min(100, Math.round(Number(draft)))); if (Number.isFinite(v) && v !== weight) onWeight(v); else setDraft(String(weight)); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="h-6 w-14 rounded-md border border-[hsl(var(--hairline))] bg-transparent px-1.5 text-right text-xs tabular-nums outline-none focus:border-primary disabled:opacity-50" />
      </label>
      <span className="min-w-0 flex-none truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
      <span className="flex items-center gap-1">{actions}</span>
    </div>
  );
}

function CandidatePicker({ rows, busy, onPick }: {
  rows: ReplicaCandidateView[]; busy: boolean; onPick: (versionId: string, dbMode: 'shared' | 'isolated') => void;
}): JSX.Element {
  const [dbMode, setDbMode] = useState<'shared' | 'isolated'>('shared');
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">没有可并排的历史版本（需非当前版本的可复用镜像）。</p>;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        数据库：
        <button type="button" onClick={() => setDbMode('shared')} className={`rounded-md border px-2 py-1 ${dbMode === 'shared' ? 'border-primary bg-primary/10 text-foreground' : 'border-[hsl(var(--hairline))]'}`}>共享主库</button>
        <button type="button" onClick={() => setDbMode('isolated')} className={`rounded-md border px-2 py-1 ${dbMode === 'isolated' ? 'border-emerald-500/60 bg-emerald-500/10 text-foreground' : 'border-[hsl(var(--hairline))]'}`}>一键隔离库（克隆保留）</button>
      </div>
      {rows.slice(0, 8).map((row) => (
        <button key={row.versionId} type="button" disabled={busy} onClick={() => onPick(row.versionId, dbMode)}
          className="flex items-center gap-4 rounded-md border border-[hsl(var(--hairline))] bg-background px-3 py-2 text-left text-xs hover:border-indigo-500/50 hover:bg-indigo-500/[.06] disabled:opacity-50">
          <span className="font-mono font-semibold">{row.commitSha.slice(0, 7)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{row.image}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : new Date(row.createdAt).toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

/* ── 分流实测仪表盘（真实结果） ── */
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
          {nonOkTagged} 个请求返回非 2xx（业务路由无此路径）——落点以 X-CDS-Replica 响应头为准，分流统计不受影响；可在探测路径框指定真实存在的接口。
        </span>
      ) : null}
    </div>
  );
}

/* ── 方案B：流量舞台（Railway 风拓扑，真实数据/真实 API） ── */
function ReplicaStage({ profileId, profileIds, onSelectProfile, rs, service, infra, previewUrl, memberLimit, api, onToast }: {
  profileId?: string;
  profileIds: string[];
  onSelectProfile: (profileId: string) => void;
  rs?: ProfileReplicaSetView;
  service?: PanelServiceInfo;
  infra: PanelInfraInfo[];
  previewUrl?: string;
  memberLimit: number;
  api: Record<string, unknown>;
  onToast?: (m: string) => void;
}): JSX.Element {
  const a = api as {
    quickAdd: (p: string) => Promise<void>;
    remove: (p: string, m: string) => Promise<void>;
    isolate: (p: string) => Promise<void>;
    revert: (p: string) => Promise<void>;
    probe: (p: string) => Promise<ProbeResult | null>;
    dissolve: (p: string) => Promise<void>;
  };
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
  const probing = useRef(false);

  if (!profileId) {
    return <section className="cds-surface-raised cds-hairline px-5 py-8 text-sm text-muted-foreground">没有可展示的服务。</section>;
  }
  const members = rs?.enabled ? rs.members : [];
  const running = members.filter((m) => m.status === 'running');
  const tw = (rs?.primaryWeight ?? 100) + running.reduce((s, m) => s + m.weight, 0);
  const entryHost = previewUrl ? new URL(previewUrl).hostname : '预览入口未就绪';
  const dbInfra = infra.filter((s) => /mongo|mysql|mariadb|postgres|redis/i.test(s.dockerImage || s.id));
  const isoState = rs?.isolated ? (members.some((m) => m.status === 'provisioning') ? 'switching' : 'done') : (members.some((m) => m.status === 'provisioning' && m.statusMessage?.includes('第1步')) ? 'cloning' : 'idle');

  const CW = 180;
  const insts = [{ id: 'primary', name: '主实例', w: rs?.primaryWeight ?? 100, boot: false, danger: rs?.primaryReachable === false, sub: rs?.primaryReachable === false ? '不可达 · 端口拒绝连接' : 'primary · 滚动更新', port: service?.hostPort }]
    .concat(members.map((m) => ({
      id: m.id,
      name: m.id,
      w: m.status === 'running' ? m.weight : 0,
      boot: m.status === 'provisioning',
      danger: m.status === 'error' || (m.status === 'running' && m.reachable === false),
      sub: m.status === 'provisioning'
        ? (m.statusMessage || '创建中 · 可撤回')
        : m.status === 'error'
          ? `失败：${m.statusMessage || '未知原因'}`
          : m.reachable === false ? '不可达 · 端口拒绝连接，建议下线' : `副本 · ${m.commitSha?.slice(0, 7) ?? ''}`,
      port: m.hostPort,
    })));
  const slots = insts.length + (members.length < memberLimit ? 1 : 0);
  const gap = Math.max(12, Math.min(32, (w - slots * CW) / (slots + 1)));
  const rowW = slots * CW + (slots - 1) * gap;
  const startX = Math.max(8, (w - rowW) / 2);
  const entryX = (w - CW) / 2, entryY = 14, instY = 190;
  const dbCW = 168, dbGap = 26;
  const dbCount = Math.max(dbInfra.length, 1) + 1; // +1 隔离位
  const frameW = dbCount * dbCW + (dbCount - 1) * dbGap + 28;
  const fx = Math.max(6, (w - frameW) / 2), dbY = 430, fy = dbY - 16, fh = 128;
  const edgeD = (x1: number, y1: number, x2: number, y2: number): string => {
    const k = Math.max(52, (y2 - y1) * 0.55);
    return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2 - 8}`;
  };
  const mongoIdx = dbInfra.findIndex((s) => /mongo|mysql|mariadb|postgres/i.test(s.dockerImage || s.id));
  const dbX = (i: number): number => fx + 14 + i * (dbCW + dbGap);
  const isoX = dbX(Math.max(dbInfra.length, 1));
  const mainDbX = dbX(Math.max(mongoIdx, 0));
  const repXs = insts.map((_, i) => startX + i * (CW + gap) + CW / 2);

  const runProbe = async (): Promise<void> => {
    if (probing.current) return;
    probing.current = true;
    setLog(['串流模式：每个请求等上一个响应返回才发出——']);
    setProbeRes(null);
    try {
      const res = await a.probe(profileId);
      if (!res) { probing.current = false; return; }
      // 真实结果逐条回放：粒子沿真实命中路径飞 + 日志逐行
      for (let i = 0; i < res.hits.length; i += 1) {
        const hit = res.hits[i];
        const missed = hit.servedBy === 'untagged' || hit.servedBy === 'error';
        const idx = hit.servedBy === 'primary' ? 0 : insts.findIndex((x) => x.id === hit.servedBy);
        if (!missed && idx >= 0) {
          setFlying({ path: edgeD(entryX + CW / 2, entryY + 88, repXs[idx], instY), key: i });
          await new Promise((r) => setTimeout(r, 640));
          setFlying(null);
        }
        const line = missed
          ? `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'error' ? '连接失败' : '未命中复制集路由（无 X-CDS-Replica 头）'}  HTTP ${hit.status}`
          : `#${String(hit.seq).padStart(2, '0')} 入口 → ${hit.servedBy === 'primary' ? '主实例' : hit.servedBy}  X-CDS-Replica: ${hit.servedBy}  HTTP ${hit.status}${hit.status >= 200 && hit.status < 300 ? ' OK' : ' · 业务路由响应，落点已验证'}`;
        setLog((prev) => [...prev, line]);
      }
      setProbeRes(res);
    } catch (err) {
      onToast?.(err instanceof ApiError ? err.message : String(err));
    }
    probing.current = false;
  };

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-5 py-3">
        {profileIds.length > 1 ? (
          <select value={profileId} onChange={(e) => onSelectProfile(e.target.value)}
            title="切换舞台展示的服务（+副本 / 复制隔离等操作只作用于当前选中服务）"
            className="h-7 rounded-md border border-[hsl(var(--hairline))] bg-transparent px-2 text-sm font-semibold outline-none focus:border-primary">
            {profileIds.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <b className="text-sm">{profileId}</b>
        )}
        <span className="rounded-md border border-indigo-500/45 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-500">复制集 · {insts.length} 实例</span>
        {rs?.isolated ? <span className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">已隔离 · {rs.isolated.dbName}</span> : null}
        <span className="text-[11px] text-muted-foreground">入口按权重分流 · 会话粘住同一实例</span>
      </div>
      <div ref={hostRef} className="relative mx-4 my-4 overflow-x-auto rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]"
        style={{ height: 590, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <defs><marker id="rsArr" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="hsl(var(--muted-foreground))" /></marker></defs>
          {insts.map((inst, i) => {
            const x2 = repXs[i];
            const pct = inst.w / tw;
            return (
              <g key={inst.id}>
                <path d={edgeD(entryX + CW / 2, entryY + 88, x2, instY)} fill="none" stroke={i > 0 && !inst.boot ? '#6366f1' : 'hsl(var(--muted-foreground))'}
                  strokeWidth={i > 0 && !inst.boot ? 2 : 1.4} strokeDasharray="5 5" opacity={inst.boot ? 0.2 : 0.35 + 0.65 * pct} markerEnd="url(#rsArr)" />
                {i > 0 && isoState === 'done' ? (
                  <>
                    <path d={edgeD(x2, instY + 92, mainDbX + dbCW / 2, dbY)} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.4" strokeDasharray="5 5" opacity="0.2" />
                    <g opacity="0.65">
                      <circle cx={(x2 + mainDbX + dbCW / 2) / 2} cy={(instY + 92 + dbY) / 2 + 12} r="8" fill="hsl(var(--background))" stroke="hsl(var(--muted-foreground))" />
                      <line x1={(x2 + mainDbX + dbCW / 2) / 2 - 4} y1={(instY + 92 + dbY) / 2 + 16} x2={(x2 + mainDbX + dbCW / 2) / 2 + 4} y2={(instY + 92 + dbY) / 2 + 8} stroke="hsl(var(--muted-foreground))" strokeWidth="1.6" />
                    </g>
                    <path d={edgeD(x2, instY + 92, isoX + dbCW / 2, dbY)} fill="none" stroke="#6366f1" strokeWidth="2" strokeDasharray="5 5" opacity="0.8" markerEnd="url(#rsArr)" />
                  </>
                ) : (
                  <path d={edgeD(x2, instY + 92, mainDbX + dbCW / 2, dbY)} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.4" strokeDasharray="5 5" opacity={i === 0 ? 0.35 : 0.3} markerEnd="url(#rsArr)" />
                )}
              </g>
            );
          })}
          <rect x={fx} y={fy} width={frameW} height={fh} rx="14" fill="none" stroke="#10b981" strokeWidth="1.6" strokeDasharray="7 6" opacity="0.85"
            className={isoState === 'cloning' ? 'animate-[rsants_1.2s_linear_infinite]' : undefined} />
          {isoState === 'cloning' || isoState === 'switching' ? (
            <g>
              <path d={`M ${mainDbX + dbCW} ${dbY + 46} L ${isoX} ${dbY + 46}`} fill="none" stroke="#10b981" strokeWidth="2" strokeDasharray="4 4" />
              <circle r="3.6" fill="#10b981"><animateMotion dur="0.8s" repeatCount="indefinite" path={`M ${mainDbX + dbCW} ${dbY + 46} L ${isoX} ${dbY + 46}`} /></circle>
            </g>
          ) : null}
          {flying ? (
            <circle key={flying.key} r="4.6" fill="#f59e0b">
              <animateMotion dur="0.6s" repeatCount="1" fill="freeze" path={flying.path} />
            </circle>
          ) : null}
        </svg>

        <StageCard x={entryX} y={entryY} name="入口" ico="GW" color="#6366f1" ok status={entryHost} foot="forwarder · 按权重分流" />
        {insts.map((inst, i) => (
          <StageCard key={inst.id} x={startX + i * (CW + gap)} y={instY} w={CW} name={inst.name} ico="API" color={i === 0 ? '#8b8578' : '#6366f1'} ok={!inst.boot && !inst.danger} danger={inst.danger}
            status={inst.sub} foot={`${inst.port ? `:${inst.port}` : ''}`} hero={i > 0} boot={inst.boot}
            extra={inst.boot && inst.id !== 'primary' ? (
              <button type="button" className="absolute right-1.5 top-1.5 rounded border border-[hsl(var(--hairline))] bg-background px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                onClick={() => void a.remove(profileId, inst.id)}>撤回</button>
            ) : undefined}
            label={`${inst.boot ? '…' : `${Math.round((inst.w / tw) * 100)}%`}`} labelY={instY - 34} labelX={repXs[i]} />
        ))}
        {members.length < memberLimit ? (
          <button type="button"
            className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-indigo-500/50 bg-indigo-500/10 text-xs font-semibold text-indigo-500 transition-colors hover:bg-indigo-500 hover:text-white"
            style={{ left: startX + insts.length * (CW + gap), top: instY, width: 120, height: 92 }}
            onClick={() => void a.quickAdd(profileId)}>
            <span className="text-[22px] leading-none">+</span>副本
          </button>
        ) : null}

        {(dbInfra.length ? dbInfra : [{ id: 'db', name: '数据库', dockerImage: '', status: 'running' }]).map((s, i) => (
          <StageCard key={s.id} x={dbX(i)} y={dbY} w={dbCW} name={s.name || s.id} ico={/redis/i.test(s.dockerImage || s.id) ? 'R' : 'DB'}
            color={/redis/i.test(s.dockerImage || s.id) ? '#c2372f' : '#10b981'} ok status={i === mongoIdx ? '主库' : '共享实例'} foot={`${s.id}-volume`} />
        ))}
        {isoState === 'idle' ? (
          <div className="absolute flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/10 text-xs font-semibold text-emerald-600 dark:text-emerald-400"
            style={{ left: isoX, top: dbY, width: dbCW, height: 92 }}>
            <span className="text-[18px] leading-none">&#9676;</span>隔离位 · 空
          </div>
        ) : (
          <StageCard x={isoX} y={dbY} w={dbCW} name="隔离库" ico="DB" color="#10b981" ok={isoState === 'done'} boot={isoState === 'cloning'}
            status={isoState === 'cloning' ? '第1步 复制：拷入数据…' : isoState === 'switching' ? '第2步 切换：副本改连新库…' : '复制自主库 · 独立读写'}
            foot={rs?.isolated?.dbName || 'prdagent_rs_guard'}
            extra={isoState === 'done' ? (
              <ConfirmAction title="回切主库" description="副本恢复直连主库，隔离库转为快照保留。确认回切？" confirmLabel="回切"
                trigger={<button type="button" className="absolute bottom-1.5 right-1.5 rounded border border-emerald-500/50 bg-background px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">回切主库</button>}
                onConfirm={() => a.revert(profileId)} />
            ) : undefined} />
        )}
        {running.length > 0 && isoState === 'idle' ? (
          <ConfirmAction title="复制隔离" description="第1步 复制：整库克隆隔离库（主库不动）；第2步 切换：全部副本改连隔离库；旧连接留影可随时回切。确认？" confirmLabel="复制隔离"
            trigger={(
              <button type="button" className="absolute z-10 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-md border border-emerald-500/60 bg-background px-2.5 py-1 text-[11px] font-semibold text-emerald-600 shadow-sm hover:bg-emerald-500/10 dark:text-emerald-400"
                style={{ left: (repXs[Math.min(1, repXs.length - 1)] + mainDbX + dbCW / 2) / 2, top: (instY + 92 + dbY) / 2 + 6 }}>
                <Copy className="h-3 w-3" />复制隔离
              </button>
            )}
            onConfirm={() => a.isolate(profileId)} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] px-5 py-3">
        <Button type="button" size="sm" disabled={members.length >= memberLimit} onClick={() => void a.quickAdd(profileId)}><Plus />副本</Button>
        <Button type="button" size="sm" variant="outline" disabled={probing.current || running.every((m) => m.weight === 0)} onClick={() => void runProbe()}>
          <RefreshCw />分流实测
        </Button>
        {members.length > 0 ? (
          <ConfirmAction title="关闭复制集" description="移除全部副本容器并删除配置，主容器与主入口不受影响。确认？" confirmLabel="关闭复制集"
            trigger={<Button type="button" size="sm" variant="ghost"><Undo2 />关闭复制集</Button>}
            onConfirm={() => a.dissolve(profileId)} />
        ) : null}
        <span className="text-[11px] text-muted-foreground">灰色留影线 = 原路径（已断开可回切）· 每个响应带 X-CDS-Replica 标记头</span>
      </div>
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

function StageCard({ x, y, w = 180, name, ico, color, ok, danger, status, foot, hero, boot, extra, label, labelX, labelY }: {
  x: number; y: number; w?: number; name: string; ico: string; color: string; ok?: boolean; danger?: boolean; status: string; foot?: string;
  hero?: boolean; boot?: boolean; extra?: JSX.Element; label?: string; labelX?: number; labelY?: number;
}): JSX.Element {
  return (
    <>
      <div className={`absolute overflow-hidden rounded-xl border bg-background text-xs shadow-md ${danger ? 'border-destructive/60' : hero ? 'border-indigo-500/45' : 'border-[hsl(var(--hairline))]'}`}
        style={{ left: x, top: y, width: w, ...(boot ? { animation: 'rscolorin 2.4s forwards' } : {}) }}>
        <div className="flex items-center gap-2 px-3 py-2 text-[13px] font-bold">
          <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[10px] font-extrabold text-white" style={{ background: color }}>{ico}</span>
          <span className="truncate">{name}</span>
        </div>
        <div className={`flex items-center gap-1.5 px-3 pb-2 text-[11px] ${danger ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: danger ? '#ef4444' : ok ? '#10b981' : 'hsl(var(--muted-foreground))' }} />
          <span className="truncate">{status}</span>
        </div>
        {foot !== undefined ? (
          <div className="border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-1.5 font-mono text-[10px] text-muted-foreground">{foot}</div>
        ) : null}
        {extra}
      </div>
      {label !== undefined && labelX !== undefined && labelY !== undefined ? (
        <span className="absolute -translate-x-1/2 -translate-y-1/2 rounded border border-indigo-500/45 bg-background px-1.5 font-mono text-[10px] text-indigo-500" style={{ left: labelX, top: labelY }}>{label}</span>
      ) : null}
      <style>{'@keyframes rscolorin{from{filter:grayscale(1);opacity:.45}to{filter:grayscale(0);opacity:1}}'}</style>
    </>
  );
}
