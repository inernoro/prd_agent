/*
 * EffectiveConfigPanel — 分支生效配置检查器(波2)。
 *
 * 回答用户三个此前答不了的问题(配置可观测性,重建信任的关键):
 *   1. 这个分支每个容器最终拿到的配置/env,逐 key 从哪一层来
 *      (全局 → 项目 → 分支 → profile → 分支覆盖 → 部署模式 → 平台注入 → per-branch 改写)
 *   2. 哪些被本分支覆盖了、覆盖掉了谁(shadowed 链)
 *   3. CDS 预计为该分支做什么(起哪些容器 / 连哪些网 / 拉起哪些共享 infra)
 *
 * 数据源:GET /api/branches/:id/effective-config(值已服务端脱敏,本面板不做 reveal)。
 * 挂载点:BranchDetailDrawer 的「配置」tab + BranchDetailPage。
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';

type EnvSource =
  | 'cds-builtin' | 'cds-derived' | 'mirror' | 'global' | 'project' | 'branch'
  | 'profile' | 'extra-service' | 'branch-override' | 'deploy-mode'
  | 'platform-injected' | 'per-branch-db';

interface EnvKeyProvenance {
  key: string;
  value: string;
  source: EnvSource;
  detail?: string;
  shadowed?: EnvSource[];
  templated?: boolean;
}

interface EffectiveConfigProfile {
  profileId: string;
  profileName: string;
  isExtra: boolean;
  hasOverride: boolean;
  dockerImage: string;
  containerPort: number;
  activeDeployMode: string | null;
  prebuilt: boolean;
  dbScope: 'shared' | 'per-branch';
  dbScopeSource: 'branch-override' | 'baseline' | 'default';
  envProvenance: EnvKeyProvenance[];
  envError?: string;
}

interface EffectiveConfigResponse {
  branchId: string;
  projectId: string;
  projectSlug: string;
  branchStatus: string;
  envLayers: Array<{ source: EnvSource; count: number; keys: string[] }>;
  profiles: EffectiveConfigProfile[];
  plan: {
    stateBasis: 'recorded';
    containers: Array<{ profileId: string; containerName: string; dockerImage: string; containerPort: number; deployMode: string | null; prebuilt: boolean; isExtra: boolean }>;
    networks: { isolation: boolean; branchNetwork: string | null; sharedNetwork: string };
    requiredInfra: Array<{ id: string; containerName: string; status: string; shared: boolean }>;
  };
}

type PanelState =
  | { status: 'idle' | 'loading' }
  | { status: 'ok'; data: EffectiveConfigResponse }
  | { status: 'error'; message: string };

// 来源标签 + 徽标配色(双主题 token,与 VariablesPanel 的 envSourceClass 视觉语言一致)
const SOURCE_META: Record<EnvSource, { label: string; cls: string }> = {
  'cds-builtin': { label: 'CDS 注入', cls: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
  'cds-derived': { label: '项目身份', cls: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
  mirror: { label: '镜像加速', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  global: { label: '全局', cls: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  project: { label: '项目', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  branch: { label: '分支', cls: 'border-amber-500/45 bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  profile: { label: '服务底座', cls: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  'extra-service': { label: '临时服务', cls: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300' },
  'branch-override': { label: '分支覆盖', cls: 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300' },
  'deploy-mode': { label: '部署模式', cls: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300' },
  'platform-injected': { label: '平台注入', cls: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
  'per-branch-db': { label: '分支库改写', cls: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
};

function SourceBadge({ source }: { source: EnvSource }): JSX.Element {
  const meta = SOURCE_META[source] || { label: source, cls: 'border-[hsl(var(--hairline))]' };
  return (
    <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] leading-none ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

function ProfileConfigCard({ profile }: { profile: EffectiveConfigProfile }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate text-sm font-medium">{profile.profileName}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {profile.isExtra ? <SourceBadge source="extra-service" /> : null}
          {profile.hasOverride ? <SourceBadge source="branch-override" /> : null}
          {profile.dbScope === 'per-branch' ? (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
              分支独立库{profile.dbScopeSource === 'branch-override' ? '(本分支覆盖)' : ''}
            </span>
          ) : null}
          <span className="font-mono">:{profile.containerPort}</span>
          {profile.activeDeployMode ? <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[11px]">{profile.activeDeployMode}</span> : null}
          <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[11px]">env×{profile.envProvenance.length}</span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-[hsl(var(--hairline))] px-3 py-2">
          <div className="mb-2 truncate font-mono text-xs text-muted-foreground" title={profile.dockerImage}>
            镜像 {profile.dockerImage}{profile.prebuilt ? '(预构建)' : ''}
          </div>
          {profile.envError ? (
            <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              该服务 env 解析失败(部署时也会以同样原因被拦):{profile.envError}
            </div>
          ) : null}
          {profile.envProvenance.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">变量</th>
                    <th className="py-1 pr-3 font-medium">值(已脱敏)</th>
                    <th className="py-1 pr-3 font-medium">来源</th>
                    <th className="py-1 font-medium">覆盖了</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.envProvenance.map((p) => (
                    <tr key={p.key} className="border-t border-[hsl(var(--hairline))]/60 align-top">
                      <td className="max-w-[180px] truncate py-1.5 pr-3 font-mono" title={p.key}>{p.key}</td>
                      <td className="max-w-[220px] truncate py-1.5 pr-3 font-mono text-muted-foreground" title={p.value}>
                        {p.value}
                        {p.templated ? <span className="ml-1 rounded border border-blue-500/30 bg-blue-500/10 px-1 text-[10px] text-blue-700 dark:text-blue-300">模板展开</span> : null}
                      </td>
                      <td className="py-1.5 pr-3">
                        <SourceBadge source={p.source} />
                        {p.detail === 'per-branch-db-suffix' ? <span className="ml-1 text-[10px] text-muted-foreground">库名加分支后缀</span> : null}
                      </td>
                      <td className="py-1.5">
                        {p.shadowed && p.shadowed.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {p.shadowed.map((s, i) => <SourceBadge key={`${p.key}-${s}-${i}`} source={s} />)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !profile.envError ? (
            <div className="py-1 text-xs text-muted-foreground">该服务没有任何环境变量。</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function EffectiveConfigPanel({ branchId }: { branchId: string }): JSX.Element {
  const [state, setState] = useState<PanelState>({ status: 'idle' });

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<EffectiveConfigResponse>(
        `/api/branches/${encodeURIComponent(branchId)}/effective-config`,
      );
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            生效配置检查器
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            这个分支实际生效的完整配置:每一项从哪继承、被谁覆盖、CDS 接下来会做什么。
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={state.status === 'loading'} title="刷新">
          <RefreshCw className={state.status === 'loading' ? 'animate-spin' : ''} />
        </Button>
      </div>

      {state.status === 'loading' || state.status === 'idle' ? (
        <div className="flex items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在解析生效配置…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </div>
      ) : null}

      {state.status === 'ok' ? (
        <>
          {/* 继承链概览:段A customEnv 分层(合并顺序从左到右,靠右覆盖靠左) */}
          <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              环境变量继承链(靠右的层覆盖靠左)
            </div>
            {state.data.envLayers.length === 0 ? (
              <div className="text-xs text-muted-foreground">没有任何自定义环境变量层。</div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {state.data.envLayers.map((layer, idx) => (
                  <span key={layer.source} className="flex items-center gap-1.5">
                    {idx > 0 ? <span className="text-xs text-muted-foreground">→</span> : null}
                    <span className="inline-flex items-center gap-1">
                      <SourceBadge source={layer.source} />
                      <span className="text-xs text-muted-foreground">×{layer.count}</span>
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 每个容器的逐 key 溯源 */}
          <div className="space-y-2">
            {state.data.profiles.map((profile) => (
              <ProfileConfigCard key={profile.profileId} profile={profile} />
            ))}
            {state.data.profiles.length === 0 ? (
              <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-5 text-center text-sm text-muted-foreground">
                该分支还没有任何服务配置。先在项目设置添加构建配置,或在本分支添加临时额外服务。
              </div>
            ) : null}
          </div>

          {/* CDS 预计做什么(部署计划预览,记录态) */}
          <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              部署这个分支时,CDS 会做什么
            </div>
            <div className="space-y-1.5 text-xs">
              {state.data.plan.containers.map((c) => (
                <div key={c.profileId} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground">起容器</span>
                  <span className="font-mono">{c.containerName}</span>
                  <span className="max-w-[240px] truncate font-mono text-muted-foreground" title={c.dockerImage}>({c.dockerImage}:{c.containerPort})</span>
                  {c.isExtra ? <SourceBadge source="extra-service" /> : null}
                  {c.prebuilt ? <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[10px]">预构建</span> : null}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">网络</span>
                {state.data.plan.networks.isolation && state.data.plan.networks.branchNetwork ? (
                  <>
                    <span className="font-mono">{state.data.plan.networks.branchNetwork}</span>
                    <span className="text-muted-foreground">(分支专属)+</span>
                  </>
                ) : null}
                <span className="font-mono">{state.data.plan.networks.sharedNetwork}</span>
                <span className="text-muted-foreground">(项目共享)</span>
              </div>
              {state.data.plan.requiredInfra.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground">确保共享基础设施在跑</span>
                  {state.data.plan.requiredInfra.map((svc) => (
                    <span key={svc.id} className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 font-mono">
                      {svc.id}{svc.status !== 'running' ? '(将启动)' : ''}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="pt-1 text-[11px] text-muted-foreground">
                以上基于当前记录状态推算;共享基础设施(数据库/缓存)为项目级容器,所有分支共用同一实例。
              </div>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
