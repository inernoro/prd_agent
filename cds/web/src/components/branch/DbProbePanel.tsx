/*
 * DbProbePanel — 「配置说的 / 容器持有 / 连上的库」三列并排（收敛 0，可信数据面）。
 *
 * 数据库隔离设计文档第九节的落地：凡是展示「这个服务连着哪个库」的地方，配置推断不能单独
 * 站在台前——必须和实测值并排，机器给判定、人话给原因。实测值带探测时间，超过 10 分钟
 * 灰掉并提示可能过期。
 *
 * 数据源：GET /api/branches/:id/db-probe（只读；docker inspect + 应用凭据实测；不落密码）。
 * 挂载点：分支抽屉「配置检查器」与「分支设置」、项目设置「数据库隔离」页签的各分支实测。
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';

export type DbProbeVerdict = 'match' | 'mismatch' | 'not-running' | 'probe-failed' | 'no-db';

export interface DbProbeServiceResult {
  profileId: string;
  profileName: string;
  configured: {
    dbScope: 'shared' | 'per-branch';
    dbScopeSource: 'branch-override' | 'baseline' | 'default';
    engine: 'mongo' | 'mysql' | 'postgres' | null;
    dbName: string | null;
    envKeys: string[];
    infraId: string | null;
    reason?: string;
  };
  container: {
    containerName: string | null;
    status: string;
    running: boolean;
    dbName: string | null;
    inspectedAt: string;
    error?: string;
  };
  live: {
    attempted: boolean;
    ok: boolean;
    currentDb: string | null;
    serverVersion: string | null;
    objectCount: number | null;
    credentialSource: 'app-url' | 'app-env' | 'infra-root' | 'none' | null;
    error?: string;
    probedAt: string;
  };
  verdict: DbProbeVerdict;
  reasons: string[];
}

export interface DbProbeReport {
  branchId: string;
  projectId: string;
  branch: string;
  probedAt: string;
  services: DbProbeServiceResult[];
  summary: { services: number; match: number; mismatch: number; notRunning: number; probeFailed: number; noDb: number };
}

/** 超过这个时长的实测值视为可能过期：灰掉 + 提示 */
export const DB_PROBE_STALE_MS = 10 * 60 * 1000;

export const DB_PROBE_VERDICT_META: Record<DbProbeVerdict, { label: string; cls: string }> = {
  match: { label: '一致', cls: 'border-ok/40 bg-ok-soft text-ok' },
  mismatch: { label: '不一致', cls: 'border-destructive/40 bg-destructive/10 text-destructive' },
  'not-running': { label: '未运行', cls: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
  'probe-failed': { label: '实测失败', cls: 'border-warn/40 bg-warn-soft text-warn' },
  'no-db': { label: '无数据库', cls: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground' },
};

const SCOPE_LABEL = { shared: '共享库', 'per-branch': '分支独立库' } as const;
const SOURCE_LABEL = { 'branch-override': '本分支覆盖', baseline: '项目默认', default: '项目默认（未声明）' } as const;
const CREDENTIAL_LABEL = { 'app-url': '应用连接串凭据', 'app-env': '应用用户变量凭据', 'infra-root': '基础设施 root（应用 env 无凭据）', none: '无凭据' } as const;

/** 第一屏那句判断：数字挂在句子里，不让人自己数 */
export function dbProbeHeadline(report: Pick<DbProbeReport, 'summary'>): string {
  const s = report.summary;
  if (s.services === 0) return '这条分支还没有服务配置，没有可实测的数据库。';
  const withDb = s.services - s.noDb;
  if (withDb === 0) return `${s.services} 个服务都没声明数据库，没有可实测的库。`;
  if (s.mismatch > 0) return `${s.mismatch} 个服务实测到的库与配置说的不一致，先看原因再决定是否重新部署。`;
  if (s.probeFailed > 0) return `${s.probeFailed} 个服务没能连上确认，${s.match} 个一致；实测失败前不要把配置值当真。`;
  if (s.notRunning > 0 && s.match === 0) return `${s.notRunning} 个服务的容器没在跑，还没有实测值；配置值只是配置。`;
  if (s.notRunning > 0) return `${s.match} 个服务实测与配置一致，${s.notRunning} 个容器没在跑、尚无实测值。`;
  return `${s.match} 个服务实测到的库与配置说的一致。`;
}

/** 探测时间的人话：刚刚 / N 分钟前（超过阈值提示可能过期） */
export function dbProbeAge(probedAt: string, now: Date = new Date()): { label: string; stale: boolean } {
  const ms = now.getTime() - new Date(probedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return { label: '实测时间未知', stale: true };
  const stale = ms >= DB_PROBE_STALE_MS;
  if (ms < 60_000) return { label: '刚刚实测', stale };
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return { label: `${minutes} 分钟前实测${stale ? '，可能已过期' : ''}`, stale };
  const hours = Math.floor(minutes / 60);
  return { label: `${hours} 小时前实测，可能已过期`, stale };
}

function VerdictBadge({ verdict }: { verdict: DbProbeVerdict }): JSX.Element {
  const meta = DB_PROBE_VERDICT_META[verdict];
  return (
    <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] leading-none ${meta.cls}`} data-db-probe-verdict={verdict}>
      {meta.label}
    </span>
  );
}

function Mono({ children, muted }: { children: string; muted?: boolean }): JSX.Element {
  return <span className={`font-mono ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>{children}</span>;
}

/** 三列表（纯展示，可离线渲染测试） */
export function DbProbeTable({ report, now = new Date() }: { report: DbProbeReport; now?: Date }): JSX.Element {
  const age = dbProbeAge(report.probedAt, now);
  const valueCls = age.stale ? 'opacity-60' : '';
  return (
    <div data-db-probe-stale={age.stale ? 'true' : 'false'}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-foreground">{dbProbeHeadline(report)}</div>
        <div className={`text-[11px] ${age.stale ? 'text-warn' : 'text-muted-foreground'}`} title={new Date(report.probedAt).toLocaleString('zh-CN')}>
          {age.label}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3 font-medium">服务</th>
              <th className="py-1 pr-3 font-medium">配置说的</th>
              <th className="py-1 pr-3 font-medium">容器持有</th>
              <th className="py-1 pr-3 font-medium">连上的库</th>
              <th className="py-1 font-medium">判定</th>
            </tr>
          </thead>
          <tbody>
            {report.services.map((svc) => (
              <tr key={svc.profileId} className="border-t border-[hsl(var(--hairline))]/60 align-top" data-db-probe-service={svc.profileId}>
                <td className="py-1.5 pr-3">
                  <div className="font-medium">{svc.profileName}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{svc.profileId}</div>
                </td>
                <td className="py-1.5 pr-3">
                  {svc.configured.dbName ? (
                    <>
                      <div><Mono>{svc.configured.dbName}</Mono>{svc.configured.engine ? <span className="ml-1 text-muted-foreground">{svc.configured.engine}</span> : null}</div>
                      <div className="text-[11px] text-muted-foreground">{SCOPE_LABEL[svc.configured.dbScope]} · {SOURCE_LABEL[svc.configured.dbScopeSource]}</div>
                    </>
                  ) : (
                    <div className="text-muted-foreground" title={svc.configured.reason}>未定位到库</div>
                  )}
                </td>
                <td className={`py-1.5 pr-3 ${valueCls}`}>
                  {!svc.container.containerName ? (
                    <div className="text-muted-foreground">还没有容器</div>
                  ) : !svc.container.running ? (
                    <div className="text-muted-foreground">容器 {svc.container.status}</div>
                  ) : (
                    <>
                      <div><Mono>{svc.container.dbName ?? '(未设置)'}</Mono></div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground" title={svc.container.containerName}>{svc.container.containerName}</div>
                    </>
                  )}
                </td>
                <td className={`py-1.5 pr-3 ${valueCls}`}>
                  {svc.live.ok ? (
                    <>
                      <div><Mono>{svc.live.currentDb ?? ''}</Mono></div>
                      <div className="text-[11px] text-muted-foreground">
                        {svc.live.serverVersion ? `v${svc.live.serverVersion}` : ''}
                        {svc.live.objectCount !== null ? ` · ${svc.live.objectCount} 个表/集合` : ''}
                        {svc.live.credentialSource ? ` · ${CREDENTIAL_LABEL[svc.live.credentialSource]}` : ''}
                      </div>
                    </>
                  ) : svc.live.attempted ? (
                    <div className="text-warn" title={svc.live.error}>未连上：{svc.live.error}</div>
                  ) : (
                    <div className="text-muted-foreground">未实测</div>
                  )}
                </td>
                <td className="py-1.5">
                  <VerdictBadge verdict={svc.verdict} />
                  {svc.reasons.length > 0 ? (
                    <ul className={`mt-1 space-y-0.5 text-[11px] ${svc.verdict === 'mismatch' ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {svc.reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type PanelState =
  | { status: 'idle' }
  | { status: 'loading'; startedAt: number }
  | { status: 'ok'; report: DbProbeReport }
  | { status: 'error'; message: string };

export function DbProbePanel({
  branchId,
  autoLoad = true,
  reloadToken = 0,
  title,
  onToast,
}: {
  branchId: string;
  /** false = 等用户点「实测」再跑（项目页签里多分支时避免一开页就全量探测） */
  autoLoad?: boolean;
  /** 外部递增即触发一次实测（项目页签「实测全部分支」） */
  reloadToken?: number;
  /** 自定义标题（如分支名）按原样渲染，不套默认的大写眉标样式 */
  title?: React.ReactNode;
  onToast?: (message: string) => void;
}): JSX.Element {
  const [state, setState] = useState<PanelState>({ status: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const firstToken = useRef(reloadToken);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading', startedAt: Date.now() });
    try {
      const report = await apiRequest<DbProbeReport>(`/api/branches/${encodeURIComponent(branchId)}/db-probe`);
      setState({ status: 'ok', report });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
      onToast?.(`数据库实测失败：${message}`);
    }
  }, [branchId, onToast]);

  useEffect(() => { if (autoLoad) void load(); }, [autoLoad, load]);
  useEffect(() => {
    if (reloadToken !== firstToken.current) void load();
  }, [reloadToken, load]);

  // 等待期必须有变化：实测要 docker inspect + 起客户端，通常 1–5 秒，给出已等待秒数
  useEffect(() => {
    if (state.status !== 'loading') { setElapsed(0); return undefined; }
    const startedAt = state.startedAt;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [state]);

  return (
    <section className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3" data-db-probe-panel={branchId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title !== undefined ? (
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
            <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{title}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            数据库：配置说的 / 实测到的
          </div>
        )}
        <Button size="sm" variant={state.status === 'idle' ? 'outline' : 'ghost'} onClick={() => void load()} disabled={state.status === 'loading'} title="重新实测：docker inspect 容器 env，并用应用自己的凭据连一次库">
          {state.status === 'idle' ? '实测' : <RefreshCw className={state.status === 'loading' ? 'animate-spin' : ''} />}
        </Button>
      </div>
      {state.status === 'idle' ? (
        <div className="mt-2 text-xs text-muted-foreground">还没实测。点「实测」读容器真实 env 并用应用凭据连一次库，只读不写。</div>
      ) : null}
      {state.status === 'loading' ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在读容器 env 并用应用凭据连库…已等待 {elapsed}s（通常 1–5 秒）
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{state.message}</div>
      ) : null}
      {state.status === 'ok' ? <div className="mt-2"><DbProbeTable report={state.report} /></div> : null}
    </section>
  );
}
