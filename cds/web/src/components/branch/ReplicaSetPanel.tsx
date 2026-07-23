/*
 * ReplicaSetPanel — 复制集模式操作面板（design.cds.replica-set，2026-07-23）。
 *
 * 单服务粒度：一个分支 5 个容器可以只把其中 1 个复制集化。面板按服务分卡：
 *   - 未复制集化：展示可秒起的历史版本数 + 「复制集化」入口（选版本即并排启动）
 *   - 已复制集化：特殊卡（堆叠徽章）——主版本 + 成员行（状态/权重/直达链/下线/提升）
 *   - 「退回普通模式」一键解散，分支回到与未启用时完全一致的状态
 *
 * 成员启动是异步物化（provisioning → running/error），面板在有 provisioning
 * 成员时 4s 轮询，杜绝空白等待。
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, DatabaseZap, ExternalLink, Layers, Loader2, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react';
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
}

export interface ReplicaDbSnapshotView {
  id: string;
  profileId: string;
  memberId: string;
  engine: 'mongo' | 'mysql' | 'postgres';
  sourceDb: string;
  dbName: string;
  clonedAt: string;
}

export interface ProfileReplicaSetView {
  profileId: string;
  enabled: boolean;
  primaryWeight: number;
  members: ReplicaMemberView[];
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
      <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        启动中
      </span>
    );
  }
  if (member.status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        运行中
      </span>
    );
  }
  if (member.status === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive"
        title={member.statusMessage}
      >
        启动失败
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md border border-[hsl(var(--hairline))] px-2 py-0.5 text-[11px] text-muted-foreground">
      已停止
    </span>
  );
}

export function ReplicaSetPanel({
  branchId,
  previewUrl,
  onToast,
}: {
  branchId: string;
  previewUrl?: string;
  onToast?: (message: string) => void;
}): JSX.Element {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [addingProfile, setAddingProfile] = useState<string | null>(null);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setState({ status: 'loading' });
    try {
      const data = await apiRequest<ReplicaSetsResponse>(
        `/api/branches/${encodeURIComponent(branchId)}/replica-sets`,
      );
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  // provisioning 成员轮询：4s 刷新直到全部落到终态（禁止空白等待）
  useEffect(() => {
    if (state.status !== 'ok') return;
    const hasProvisioning = Object.values(state.data.replicaSets)
      .some((rs) => rs.members.some((m) => m.status === 'provisioning'));
    if (!hasProvisioning) return;
    const timer = setInterval(() => { void load(true); }, 4000);
    return () => clearInterval(timer);
  }, [state, load]);

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

  // 「一个 + 号」：不选版本，直接把当前版本再起一个副本，权重自动与主均分（Railway 语义）
  const quickAddReplica = useCallback((profileId: string) => {
    void run(`add:${profileId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members`, {
        method: 'POST',
        body: {},
      });
    }, '副本启动中：当前版本再起一个实例，就绪后自动与主均分流量');
  }, [branchId, run]);

  const addMember = useCallback((profileId: string, versionId: string, dbMode: 'shared' | 'isolated') => {
    setAddingProfile(null);
    void run(`add:${profileId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members`, {
        method: 'POST',
        body: { versionId, dbMode },
      });
    }, dbMode === 'isolated'
      ? '成员启动中：先克隆数据库到隔离库，再从保留镜像秒起'
      : '成员启动中：从保留镜像秒起，无需重新构建');
  }, [branchId, run]);

  const setWeight = useCallback((profileId: string, memberId: string, weight: number) => {
    void run(`weight:${profileId}:${memberId}`, async () => {
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members/${encodeURIComponent(memberId)}`, {
        method: 'PATCH',
        body: { weight },
      });
    }, '权重已更新，约 2 秒后生效');
  }, [branchId, run]);

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
  const profileIds = Array.from(new Set([
    ...Object.keys(replicaSets),
    ...Object.keys(candidates),
  ])).sort();

  if (profileIds.length === 0) {
    return (
      <section className="cds-surface-raised cds-hairline px-5 py-8 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Layers className="h-4 w-4" />
          还没有可复制集化的服务
        </div>
        <p className="mt-2 leading-6">
          复制集需要至少一个「可秒起」的历史部署版本（不可变镜像）。走一次极速版/托管构建部署后，
          该服务的历史版本就会出现在这里，可一键并排启动做新旧对比或灰度分流。
        </p>
      </section>
    );
  }

  return (
    <div className="grid gap-4">
      <section className="cds-surface-raised cds-hairline px-5 py-3 text-xs leading-5 text-muted-foreground">
        点「副本」一键把当前版本再起一个实例（就绪后与主自动均分流量）；「历史版本」并排旧版做对比或灰度
        （默认权重 0，仅直达链可见，拉高权重才分流）。随时「退回普通模式」。单服务成员上限 {memberLimit} 个。
      </section>

      {profileIds.map((profileId) => {
        const rs = replicaSets[profileId];
        const rows = candidates[profileId] ?? [];
        const availableRows = rows.filter((row) =>
          !row.isCurrent && !(rs?.members ?? []).some((m) => m.versionId === row.versionId && m.status !== 'error'));

        if (!rs?.enabled || rs.members.length === 0) {
          return (
            <section key={profileId} className="cds-surface-raised cds-hairline px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {profileId}
                    <span className="rounded-md border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                      普通模式
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {availableRows.length > 0
                      ? `${availableRows.length} 个历史版本可秒起并排`
                      : '暂无可并排的历史版本（需非当前版本的可复用镜像）'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => quickAddReplica(profileId)}
                    title="当前版本再起一个副本，就绪后与主均分流量"
                  >
                    {busy === `add:${profileId}` ? <Loader2 className="animate-spin" /> : <Plus />}
                    副本
                  </Button>
                  {availableRows.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setAddingProfile(addingProfile === profileId ? null : profileId)}
                    >
                      <Layers />
                      历史版本
                    </Button>
                  ) : null}
                </div>
              </div>
              {addingProfile === profileId ? (
                <CandidatePicker rows={availableRows} busy={busy === `add:${profileId}`} onPick={(versionId, dbMode) => addMember(profileId, versionId, dbMode)} />
              ) : null}
            </section>
          );
        }

        return (
          <section
            key={profileId}
            className="cds-surface-raised overflow-hidden rounded-lg border border-indigo-500/45 shadow-[0_0_0_1px_hsl(239_84%_67%/.15)]"
          >
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-500/25 bg-indigo-500/[.06] px-5 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-indigo-500/40 bg-indigo-500/15">
                  <Layers className="h-4 w-4 text-indigo-500" />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {profileId}
                    <span className="rounded-md border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-medium text-indigo-500">
                      复制集 · {rs.members.length + 1} 版本
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">主入口按权重分流；成员另有直达链，会话内粘住同一版本</p>
                </div>
              </div>
              <ConfirmAction
                title="退回普通模式"
                description="移除全部成员容器并删除复制集配置，主容器与主入口不受影响。确认解散？"
                confirmLabel="解散复制集"
                trigger={(
                  <Button type="button" size="sm" variant="outline" disabled={busy !== null}>
                    {busy === `dissolve:${profileId}` ? <Loader2 className="animate-spin" /> : <Undo2 />}
                    退回普通模式
                  </Button>
                )}
                onConfirm={() => run(`dissolve:${profileId}`, async () => {
                  await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
                }, '已退回普通模式')}
              />
            </header>

            <div className="divide-y divide-[hsl(var(--hairline))]">
              <MemberRow
                title="主版本（当前部署）"
                subtitle="随分支正常部署滚动更新"
                pill={(
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                    primary
                  </span>
                )}
                weight={rs.primaryWeight}
                busy={busy === `weight:${profileId}:primary`}
                onWeight={(w) => setWeight(profileId, 'primary', w)}
              />
              {rs.members.map((member) => {
                const direct = memberDirectUrl(previewUrl, member.id);
                return (
                  <MemberRow
                    key={member.id}
                    title={`${member.label || member.id}`}
                    subtitle={`${member.commitSha ? member.commitSha.slice(0, 7) : member.versionId}${member.hostPort ? ` · :${member.hostPort}` : ''}${member.dbMode === 'isolated' ? ` · 隔离库 ${member.isolatedDbName || '(克隆中)'}` : ''}`}
                    pill={statusPill(member)}
                    weight={member.weight}
                    busy={busy === `weight:${profileId}:${member.id}`}
                    disabled={member.status !== 'running'}
                    onWeight={(w) => setWeight(profileId, member.id, w)}
                    actions={(
                      <>
                        {direct && member.status === 'running' ? (
                          <Button type="button" size="sm" variant="ghost" asChild>
                            <a href={direct} target="_blank" rel="noreferrer" title={`直达该版本：${direct}`}>
                              <ExternalLink />
                              直达
                            </a>
                          </Button>
                        ) : null}
                        {member.status === 'running' ? (
                          <ConfirmAction
                            title="提升为主版本"
                            description="主容器将重建为该版本（走既有版本部署链路），随后复制集自动解散。确认提升？"
                            confirmLabel="提升"
                            trigger={(
                              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} title="把该版本设为主版本">
                                <ArrowUpCircle />
                                提升
                              </Button>
                            )}
                            onConfirm={() => run(`promote:${profileId}:${member.id}`, async () => {
                              await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members/${encodeURIComponent(member.id)}/promote`, { method: 'POST' });
                            }, '已派发主版本切换，复制集将自动解散')}
                          />
                        ) : null}
                        <ConfirmAction
                          title="下线成员"
                          description="移除该成员容器（保留其历史版本记录，可随时再次并排）。确认下线？"
                          confirmLabel="下线"
                          trigger={(
                            <Button type="button" size="sm" variant="ghost" disabled={busy !== null}>
                              <Trash2 />
                            </Button>
                          )}
                          onConfirm={() => run(`remove:${profileId}:${member.id}`, async () => {
                            await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-sets/${encodeURIComponent(profileId)}/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
                          }, '成员已下线')}
                        />
                      </>
                    )}
                  />
                );
              })}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] px-5 py-3">
              {rs.members.length < memberLimit ? (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => quickAddReplica(profileId)}
                    title="当前版本再起一个副本，就绪后与主均分流量"
                  >
                    {busy === `add:${profileId}` ? <Loader2 className="animate-spin" /> : <Plus />}
                    副本
                  </Button>
                  {availableRows.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => setAddingProfile(addingProfile === profileId ? null : profileId)}
                    >
                      <Layers />
                      历史版本
                    </Button>
                  ) : null}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">成员数已达上限 {memberLimit}</span>
              )}
              <span className="text-[11px] text-muted-foreground">
                粘性：cookie cds_rs / header x-cds-replica / query ?__rs=成员id
              </span>
            </footer>
            {addingProfile === profileId ? (
              <div className="border-t border-[hsl(var(--hairline))] px-5 pb-4">
                <CandidatePicker rows={availableRows} busy={busy === `add:${profileId}`} onPick={(versionId, dbMode) => addMember(profileId, versionId, dbMode)} />
              </div>
            ) : null}
          </section>
        );
      })}

      {(state.data.snapshots ?? []).length > 0 ? (
        <section className="cds-surface-raised cds-hairline px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <DatabaseZap className="h-4 w-4 text-indigo-500" />
            隔离库数据快照（{state.data.snapshots!.length}）
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            成员下线后隔离库保留在这里（克隆时间点的数据副本）。确认不再需要时手动删除，才会真正 drop 数据库。
          </p>
          <div className="mt-3 grid gap-2">
            {state.data.snapshots!.map((snapshot) => (
              <div
                key={snapshot.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-mono font-semibold">{snapshot.dbName}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {snapshot.engine} · 来源 {snapshot.sourceDb} · 服务 {snapshot.profileId} · {new Date(snapshot.clonedAt).toLocaleString()}
                  </div>
                </div>
                <ConfirmAction
                  title="删除隔离库"
                  description={`将执行 DROP DATABASE ${snapshot.dbName}，数据不可恢复。确认删除？`}
                  confirmLabel="删除数据库"
                  trigger={(
                    <Button type="button" size="sm" variant="ghost" disabled={busy !== null}>
                      <Trash2 />
                      删除
                    </Button>
                  )}
                  onConfirm={() => run(`snapshot:${snapshot.id}`, async () => {
                    await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/replica-db-snapshots/${encodeURIComponent(snapshot.id)}`, { method: 'DELETE' });
                  }, `隔离库 ${snapshot.dbName} 已删除`)}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MemberRow({
  title,
  subtitle,
  pill,
  weight,
  busy,
  disabled,
  onWeight,
  actions,
}: {
  title: string;
  subtitle: string;
  pill: JSX.Element;
  weight: number;
  busy?: boolean;
  disabled?: boolean;
  onWeight: (weight: number) => void;
  actions?: JSX.Element;
}): JSX.Element {
  const [draft, setDraft] = useState(String(weight));
  useEffect(() => { setDraft(String(weight)); }, [weight]);
  const commit = (): void => {
    const parsed = Math.max(0, Math.min(100, Math.round(Number(draft))));
    if (!Number.isFinite(parsed) || parsed === weight) { setDraft(String(weight)); return; }
    onWeight(parsed);
  };
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{title}</span>
          {pill}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{subtitle}</div>
      </div>
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        权重
        <input
          type="number"
          min={0}
          max={100}
          value={draft}
          disabled={disabled || busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="h-7 w-16 rounded-md border border-[hsl(var(--hairline))] bg-transparent px-2 text-right text-xs tabular-nums outline-none focus:border-primary disabled:opacity-50"
        />
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="w-3.5" />}
      </label>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

function CandidatePicker({
  rows,
  busy,
  onPick,
}: {
  rows: Array<{ versionId: string; commitSha: string; image: string; createdAt: string; isCurrent: boolean }>;
  busy: boolean;
  onPick: (versionId: string, dbMode: 'shared' | 'isolated') => void;
}): JSX.Element {
  const [dbMode, setDbMode] = useState<'shared' | 'isolated'>('shared');
  if (rows.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">没有可并排的历史版本。</p>;
  }
  return (
    <div className="mt-3 grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>数据库：</span>
        <button
          type="button"
          onClick={() => setDbMode('shared')}
          className={`rounded-md border px-2 py-1 transition-colors ${
            dbMode === 'shared'
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-[hsl(var(--hairline))] hover:bg-[hsl(var(--surface-sunken))]'
          }`}
        >
          共享主库
        </button>
        <button
          type="button"
          onClick={() => setDbMode('isolated')}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 transition-colors ${
            dbMode === 'isolated'
              ? 'border-indigo-500/60 bg-indigo-500/10 text-foreground'
              : 'border-[hsl(var(--hairline))] hover:bg-[hsl(var(--surface-sunken))]'
          }`}
          title="启动前把当前库整库克隆成隔离副本，成员只写隔离库；成员下线后隔离库保留在数据快照列表"
        >
          <DatabaseZap className="h-3.5 w-3.5" />
          一键隔离库（克隆保留）
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {dbMode === 'isolated'
          ? '将先把当前数据库整库克隆为隔离副本（克隆时间点快照），成员读写隔离库，不碰共享数据。'
          : '选择一个历史版本并排启动（保留镜像秒起，零构建）：'}
      </p>
      {rows.slice(0, 8).map((row) => (
        <button
          key={row.versionId}
          type="button"
          disabled={busy}
          onClick={() => onPick(row.versionId, dbMode)}
          className="flex items-center justify-between gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-left text-xs transition-colors hover:border-indigo-500/50 hover:bg-indigo-500/[.06] disabled:opacity-50"
        >
          <span className="min-w-0">
            <span className="block font-mono font-semibold">{row.commitSha.slice(0, 7)}</span>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{row.image}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : new Date(row.createdAt).toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
}
