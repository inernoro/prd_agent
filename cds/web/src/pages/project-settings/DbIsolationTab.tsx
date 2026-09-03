import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { CodePill, ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';
import { DbProbePanel } from '@/components/branch/DbProbePanel';

/**
 * 项目设置 →「数据库隔离」。
 *
 * 这一屏回答一个问题：**这个项目的服务，多分支之间共不共用数据库。**
 *
 * 数据源只有一份：`BuildProfile.dbScope`（项目底座）。它以前只能在分支抽屉里
 * 当「覆盖项」看到，层级倒置——用户以为它是分支开关，其实真正的默认值藏在没人
 * 打开的 profile 里。现在项目默认在这里改，分支抽屉只保留「本分支覆盖」。
 *
 * 判定不在这里做：生效档位、来源、会改写的库名 key、分支覆盖概况全部来自后端
 * `GET /api/projects/:id/db-isolation`；保存走 `PUT`，后端先全量校验再一次落盘，
 * 不存在「保存一半」。前端只负责把它们摆好，并把「保存会影响谁」说清楚。
 */

export type DbScope = 'shared' | 'per-branch';

export interface DbIsolationService {
  profileId: string;
  name: string;
  dockerImage: string;
  dbScope: DbScope;
  dbScopeSource: 'explicit' | 'default';
  dbEnvKeys: string[];
  branchOverrideCount: number;
}

export interface DbIsolationBranchOverride {
  branchId: string;
  branch: string;
  overrides: Record<string, DbScope>;
}

export interface DbIsolationBranch {
  branchId: string;
  branch: string;
  status: string;
  hasOverride: boolean;
}

export interface DbIsolationView {
  projectId: string;
  readOnly: boolean;
  readOnlyReason?: string;
  services: DbIsolationService[];
  branchOverrides: DbIsolationBranchOverride[];
  branches?: DbIsolationBranch[];
  summary: {
    services: number;
    shared: number;
    perBranch: number;
    branches: number;
    branchesWithOverride: number;
  };
}

interface DbIsolationWriteResult {
  changes: Array<{ profileId: string; from: DbScope; to: DbScope }>;
  affectedBranches: number;
  keptBranchOverrides: number;
  message: string;
  view: DbIsolationView;
}

export const DB_SCOPE_LABEL: Record<DbScope, string> = {
  shared: '共享库',
  'per-branch': '分支独立库',
};

/** 第一屏那句判断：先给结论，数字挂在句子里。 */
export function dbIsolationHeadline(view: Pick<DbIsolationView, 'summary'>): { headline: string; subline: string } {
  const { services, shared, perBranch, branches, branchesWithOverride } = view.summary;
  const subline = branches === 0
    ? '这个项目还没有分支'
    : branchesWithOverride === 0
      ? `${branches} 条分支全部继承项目默认`
      : `${branches} 条分支，其中 ${branchesWithOverride} 条有本分支覆盖，不受项目默认影响`;
  if (services === 0) {
    return { headline: '这个项目还没有服务配置，先在「项目配置」里接入服务', subline };
  }
  if (perBranch === 0) {
    return { headline: `${services} 个服务全部共享库：所有分支读写同一个库，一条分支跑 migration 会影响其它分支`, subline };
  }
  if (shared === 0) {
    return { headline: `${services} 个服务全部分支独立库：每条分支各用一个库，互不影响；新分支首次部署要重跑 migration`, subline };
  }
  return { headline: `${shared} 个服务共享库、${perBranch} 个分支独立库，分支之间只在共享库那几个服务上互相可见`, subline };
}

function draftFromView(view: DbIsolationView): Record<string, DbScope> {
  const draft: Record<string, DbScope> = {};
  for (const s of view.services) draft[s.profileId] = s.dbScope;
  return draft;
}

/** 草稿里和当前生效值不一样的服务。 */
export function changedServices(view: DbIsolationView, draft: Record<string, DbScope>): Record<string, DbScope> {
  const changed: Record<string, DbScope> = {};
  for (const s of view.services) {
    const next = draft[s.profileId];
    if (next && next !== s.dbScope) changed[s.profileId] = next;
  }
  return changed;
}

function messageFromError(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function ScopeSwitch({
  value,
  onChange,
  disabled,
  name,
}: {
  value: DbScope;
  onChange: (next: DbScope) => void;
  disabled?: boolean;
  name: string;
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label={`${name} 的数据库隔离`} className="inline-flex rounded-md border border-input bg-background p-0.5">
      {(['shared', 'per-branch'] as const).map((scope) => {
        const active = value === scope;
        return (
          <button
            key={scope}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(scope)}
            className={`h-8 rounded px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            }`}
          >
            {DB_SCOPE_LABEL[scope]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 纯展示面板：拿视图 + 草稿渲染。抽出来是为了渲染冒烟能在没有网络的地方跑。
 */
export function DbIsolationPanel({
  view,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onReload,
}: {
  view: DbIsolationView;
  draft: Record<string, DbScope>;
  saving: boolean;
  error: string;
  onDraftChange: (next: Record<string, DbScope>) => void;
  onSave: () => void | Promise<void>;
  onReload?: () => void;
}): JSX.Element {
  const { headline, subline } = dbIsolationHeadline(view);
  const changed = changedServices(view, draft);
  const changedCount = Object.keys(changed).length;
  const disabled = view.readOnly || saving;
  const setAll = (scope: DbScope) => {
    const next: Record<string, DbScope> = {};
    for (const s of view.services) next[s.profileId] = scope;
    onDraftChange(next);
  };

  return (
    <div className="space-y-6">
      <section className="border-b border-border pb-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">数据库隔离</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              项目级默认值。分支独立库会给每条分支的库名自动加分支后缀（<CodePill>app</CodePill> 变成 <CodePill>app_feat_x</CodePill>），
              连接串通过 <CodePill>{'${CDS_POSTGRES_DB}'}</CodePill> 这类引用自动跟随；共享库则所有分支读写同一个库。
            </p>
          </div>
          {onReload ? (
            <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={saving}>
              <RefreshCw />
              刷新
            </Button>
          ) : null}
        </div>

        <div className="mt-5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-4 py-3">
          <div className="text-sm font-medium">{headline}</div>
          <div className="mt-1 text-xs text-muted-foreground">{subline}</div>
        </div>

        {view.readOnly ? (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{view.readOnlyReason || '这个项目的数据库隔离档位只读'}</span>
          </div>
        ) : null}
      </section>

      <section className="border-b border-border pb-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">逐服务设置</h3>
          {view.services.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>批量：</span>
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setAll('shared')}>
                全部设为共享库
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setAll('per-branch')}>
                全部设为分支独立库
              </Button>
            </div>
          ) : null}
        </div>

        {view.services.length === 0 ? (
          <div className="mt-4 text-sm text-muted-foreground">
            没有可设置的服务。先在「项目配置」里接入服务，这里才有东西可管。
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {view.services.map((service) => {
              const value = draft[service.profileId] ?? service.dbScope;
              const isChanged = changed[service.profileId] !== undefined;
              return (
                <div
                  key={service.profileId}
                  className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5 ${
                    isChanged ? 'border-warn/40 bg-warn-soft/40' : 'border-[hsl(var(--hairline))] bg-card'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{service.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{service.profileId}</span>
                      {service.dbScopeSource === 'default' && !isChanged ? (
                        <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[11px] text-muted-foreground" title="profile 上没有写 dbScope，按默认共享库生效">
                          默认值
                        </span>
                      ) : null}
                      {isChanged ? (
                        <span className="rounded border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">
                          未保存：{DB_SCOPE_LABEL[service.dbScope]} 变为 {DB_SCOPE_LABEL[value]}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {service.dockerImage ? <span className="font-mono">{service.dockerImage}</span> : null}
                      {service.dbEnvKeys.length > 0 ? (
                        <span>
                          会改写：
                          {service.dbEnvKeys.map((key) => (
                            <span key={key} className="ml-1"><CodePill>{key}</CodePill></span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-warn" title="分支独立库只改写 CDS_POSTGRES_DB / CDS_MYSQL_DATABASE / CDS_MONGO_INITDB_DATABASE 这类库名变量">
                          没声明库名变量，切分支独立库不会改写任何东西
                        </span>
                      )}
                      {service.branchOverrideCount > 0 ? (
                        <span title="这些分支写了自己的档位，不受项目默认影响">
                          {service.branchOverrideCount} 条分支覆盖
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <ScopeSwitch
                    name={service.name}
                    value={value}
                    disabled={disabled}
                    onChange={(next) => onDraftChange({ ...draft, [service.profileId]: next })}
                  />
                </div>
              );
            })}
          </div>
        )}

        {view.services.length > 0 && !view.readOnly ? (
          <div className="mt-5 space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <div className="text-muted-foreground">
                保存后影响<span className="text-foreground">所有继承项目配置的分支</span>
                （本项目 {view.summary.branches} 条分支），各分支<span className="text-foreground">重新部署后生效</span>；
                已有本分支覆盖的服务档位（{view.summary.branchesWithOverride} 条分支）保持不变。
              </div>
            </div>
            {error ? <ErrorBlock message={error} /> : null}
            <div className="flex flex-wrap items-center gap-3">
              <ConfirmAction
                trigger={(
                  <Button type="button" disabled={disabled || changedCount === 0}>
                    {saving ? <Loader2 className="animate-spin" /> : null}
                    {changedCount === 0 ? '没有改动' : `保存 ${changedCount} 项改动`}
                  </Button>
                )}
                title="写入项目默认？"
                description={`${changedCount} 个服务的档位会成为项目默认，继承项目配置的分支（本项目 ${view.summary.branches} 条）重新部署后生效；已写本分支覆盖的服务档位（${view.summary.branchesWithOverride} 条分支）不受影响。`}
                confirmLabel="写入"
                pending={saving}
                onConfirm={onSave}
              />
              {changedCount > 0 ? (
                <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => onDraftChange(draftFromView(view))}>
                  放弃改动
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <h3 className="text-base font-semibold">本分支覆盖</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          分支可以临时钉住自己的档位，不跟随项目默认。改动与恢复继承都在分支详情 → 配置 → 设置 里操作。
        </p>
        {view.branchOverrides.length === 0 ? (
          <div className="mt-3 text-sm text-muted-foreground">没有分支写过覆盖，所有分支都跟随项目默认。</div>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {view.branchOverrides.map((entry) => (
              <li key={entry.branchId} className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-card px-3 py-2 text-sm">
                <a
                  className="font-mono text-xs text-primary underline-offset-2 hover:underline"
                  href={`/branch-panel/${encodeURIComponent(entry.branchId)}`}
                >
                  {entry.branch}
                </a>
                {Object.entries(entry.overrides).map(([profileId, scope]) => (
                  <span key={profileId} className="rounded border border-warn/40 bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">
                    {profileId}：{DB_SCOPE_LABEL[scope]}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <BranchProbeSection branches={view.branches ?? []} />
    </div>
  );
}

/**
 * 各分支实测（收敛 0）：上面两节全是「配置说的」。这一节逐分支给「容器持有 / 连上的库」
 * 实测值——项目默认改完、分支重新部署后，在这里核对每条分支真的连到了哪个库。
 * 默认不自动探测（多分支时一开页就全量 docker inspect 太重），点「实测」再跑。
 */
export function BranchProbeSection({ branches }: { branches: DbIsolationBranch[] }): JSX.Element {
  const [probeAllToken, setProbeAllToken] = useState(0);
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">各分支实测</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            上面两节是配置说的；这里读每条分支容器的真实 env，并用应用自己的凭据连一次库，只读不写。
          </p>
        </div>
        {branches.length > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setProbeAllToken((t) => t + 1)} title="逐条分支 docker inspect + 连库实测">
            实测全部分支
          </Button>
        ) : null}
      </div>
      {branches.length === 0 ? (
        <div className="mt-3 text-sm text-muted-foreground">这个项目还没有分支，部署一条后再来实测。</div>
      ) : (
        <div className="mt-3 space-y-2">
          {branches.map((b) => (
            <DbProbePanel
              key={b.branchId}
              branchId={b.branchId}
              autoLoad={false}
              reloadToken={probeAllToken}
              title={`${b.branch}${b.hasOverride ? '（有本分支覆盖）' : ''} · ${b.status}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function DbIsolationTab({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (message: string) => void;
}): JSX.Element {
  const [view, setView] = useState<DbIsolationView | null>(null);
  const [draft, setDraft] = useState<Record<string, DbScope>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const next = await apiRequest<DbIsolationView>(`/api/projects/${encodeURIComponent(projectId)}/db-isolation`);
      setView(next);
      setDraft(draftFromView(next));
    } catch (err) {
      setLoadError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = useMemo(() => (view ? changedServices(view, draft) : {}), [view, draft]);

  async function save(): Promise<void> {
    if (!view || Object.keys(changed).length === 0) return;
    setSaving(true);
    setSaveError('');
    try {
      const result = await apiRequest<DbIsolationWriteResult>(
        `/api/projects/${encodeURIComponent(projectId)}/db-isolation`,
        { method: 'PUT', body: { services: changed } },
      );
      setView(result.view);
      setDraft(draftFromView(result.view));
      onToast(result.message);
    } catch (err) {
      setSaveError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !view) return <LoadingBlock label="正在读取数据库隔离配置" />;
  if (loadError && !view) return <ErrorBlock message={loadError} />;
  if (!view) return <ErrorBlock message="没有拿到数据库隔离配置" />;

  return (
    <DbIsolationPanel
      view={view}
      draft={draft}
      saving={saving}
      error={saveError}
      onDraftChange={setDraft}
      onSave={save}
      onReload={() => void load()}
    />
  );
}
