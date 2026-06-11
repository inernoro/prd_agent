import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Rocket,
  Server,
  Settings,
  Terminal,
  XCircle,
} from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest, apiUrl } from '@/lib/api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

interface ReleaseTarget {
  id: string;
  projectId: string;
  name: string;
  type: string;
  isEnabled: boolean;
  ssh?: {
    host: string;
    port: number;
    user: string;
    privateKeyRef: string;
    appPath: string;
    deployCommand: string;
    rollbackCommand?: string;
    healthcheckUrl: string;
  };
}

interface ReleaseRun {
  releaseId: string;
  projectId: string;
  branchId: string;
  commitSha: string;
  targetId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  previousReleaseId?: string;
  rollbackOf?: string;
  logs: ReleaseLogEntry[];
}

interface ReleaseLogEntry {
  seq: number;
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  phase?: string;
}

interface RemoteHostOption {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  fingerprint: string;
  isEnabled: boolean;
}

interface CenterRow {
  target: ReleaseTarget;
  currentVersion: string;
  currentCommit: string;
  latestRun?: ReleaseRun;
  lastReleasedAt?: string;
  healthStatus: string;
  lastOperator?: string;
  canRollback: boolean;
}

interface CenterResponse {
  rows: CenterRow[];
  runs: ReleaseRun[];
}

interface TargetsResponse {
  targets: ReleaseTarget[];
  remoteHosts: RemoteHostOption[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; center: CenterResponse; hosts: RemoteHostOption[] };

type WizardStep = 'server' | 'site' | 'scripts' | 'health';

interface SiteDraft {
  id?: string;
  projectId: string;
  name: string;
  privateKeyRef: string;
  host: string;
  port: string;
  user: string;
  sitePath: string;
  publicUrl: string;
  healthPath: string;
  rollbackCommand: string;
  advancedOpen: boolean;
  deployCommand: string;
  healthcheckUrl: string;
}

interface SiteView {
  id: string;
  target: ReleaseTarget;
  name: string;
  serverLabel: string;
  hostLabel: string;
  sitePath: string;
  publicUrl: string;
  healthUrl: string;
  deployScripts: string[];
  currentVersion: string;
  currentCommit: string;
  lastReleasedAt?: string;
  healthStatus: string;
  lastOperator?: string;
  latestRun?: ReleaseRun;
  canRollback: boolean;
  hasRollback: boolean;
  isEnabled: boolean;
}

const DEFAULT_SITE_PATH = '/opt/prd_agent';
const DEFAULT_DEPLOY_COMMAND = './fast.sh && ./exec_dep.sh';
const DEFAULT_HEALTH_PATH = '/';
const SCRIPT_LABELS = ['./fast.sh', './exec_dep.sh'];

function emptyDraft(projectId: string): SiteDraft {
  return {
    projectId,
    name: '',
    privateKeyRef: '',
    host: '',
    port: '22',
    user: '',
    sitePath: DEFAULT_SITE_PATH,
    publicUrl: '',
    healthPath: DEFAULT_HEALTH_PATH,
    rollbackCommand: '',
    advancedOpen: false,
    deployCommand: DEFAULT_DEPLOY_COMMAND,
    healthcheckUrl: '',
  };
}

export function ReleaseCenterPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const initialProject = searchParams.get('project') || 'default';
  const [projectId, setProjectId] = useState(initialProject);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<SiteDraft>(() => emptyDraft(initialProject));
  const [wizardStep, setWizardStep] = useState<WizardStep>('server');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [savingSite, setSavingSite] = useState(false);
  const [toast, setToast] = useState('');
  const [logRun, setLogRun] = useState<ReleaseRun | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [center, targets] = await Promise.all([
        apiRequest<CenterResponse>(`/api/releases/center?project=${encodeURIComponent(projectId)}`),
        apiRequest<TargetsResponse>(`/api/releases/targets?project=${encodeURIComponent(projectId)}`),
      ]);
      setState({ status: 'ok', center, hosts: targets.remoteHosts || [] });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const hosts = state.status === 'ok' ? state.hosts : [];
  const rows = state.status === 'ok' ? state.center.rows : [];
  const runs = state.status === 'ok' ? state.center.runs : [];
  const sites = useMemo(() => rows.map(toSiteView), [rows]);

  const openCreateWizard = (): void => {
    setDraft(emptyDraft(projectId));
    setWizardStep('server');
    setWizardOpen(true);
    setToast('');
  };

  const openConfigureWizard = (target: ReleaseTarget): void => {
    setDraft(draftFromTarget(target));
    setWizardStep('site');
    setWizardOpen(true);
    setToast('');
  };

  const selectHost = (hostId: string): void => {
    const host = hosts.find((item) => item.id === hostId);
    setDraft((current) => ({
      ...current,
      privateKeyRef: hostId,
      host: host?.host || current.host,
      port: host ? String(host.sshPort || 22) : current.port,
      user: host?.sshUser || current.user,
    }));
  };

  const saveSite = async (): Promise<void> => {
    setSavingSite(true);
    setToast('');
    try {
      const body = buildTargetBody(draft, projectId);
      if (draft.id) {
        await apiRequest(`/api/releases/targets/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
        setToast('站点发布目标已更新');
      } else {
        await apiRequest('/api/releases/targets', { method: 'POST', body });
        setToast('站点发布目标已添加');
      }
      setWizardOpen(false);
      setDraft(emptyDraft(projectId));
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSavingSite(false);
    }
  };

  const rollback = async (run: ReleaseRun): Promise<void> => {
    setToast('');
    try {
      const res = await apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/rollback`, { method: 'POST' });
      setLogRun(res.run);
      setToast('回滚已开始');
      await load();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <AppShell
      active="release-center"
      wide
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '发布中心' }]} />}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace wide>
        <div className="space-y-5">
          <section className="cds-surface-raised cds-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold">站点发布</h1>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  把已验收的预览分支发布到一台服务器上的站点目录。默认发布脚本是 <CodeText>./fast.sh</CodeText> → <CodeText>./exec_dep.sh</CodeText>。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Project</span>
                  <input
                    value={projectId}
                    onChange={(event) => {
                      const next = event.target.value.trim() || 'default';
                      setProjectId(next);
                      setDraft((current) => ({ ...current, projectId: next }));
                    }}
                    className="h-9 w-48 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 font-mono text-sm outline-none focus:border-primary/60"
                  />
                </label>
                <Button onClick={openCreateWizard}>
                  <Plus />
                  添加站点发布
                </Button>
              </div>
            </div>
            {toast ? <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-sm">{toast}</div> : null}
          </section>

          {state.status === 'loading' ? <LoadingBlock label="正在加载站点发布目标" /> : null}
          {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
          {state.status === 'ok' ? (
            <>
              {sites.length === 0 ? (
                <EmptySitesState hostCount={hosts.length} onAdd={openCreateWizard} />
              ) : (
                <section className="grid gap-4 xl:grid-cols-2">
                  {sites.map((site) => (
                    <SiteCard
                      key={site.id}
                      site={site}
                      onLogs={() => site.latestRun && setLogRun(site.latestRun)}
                      onRollback={() => site.latestRun && void rollback(site.latestRun)}
                      onConfigure={() => openConfigureWizard(site.target)}
                    />
                  ))}
                </section>
              )}
              <ReleaseRecords runs={runs} onOpen={setLogRun} />
            </>
          ) : null}
        </div>
      </Workspace>
      <SiteWizardDialog
        open={wizardOpen}
        draft={draft}
        step={wizardStep}
        hosts={hosts}
        saving={savingSite}
        onClose={() => setWizardOpen(false)}
        onStep={setWizardStep}
        onDraft={setDraft}
        onSelectHost={selectHost}
        onSave={() => void saveSite()}
      />
      <ReleaseLogDialog run={logRun} onClose={() => setLogRun(null)} />
    </AppShell>
  );
}

function EmptySitesState({ hostCount, onAdd }: { hostCount: number; onAdd: () => void }): JSX.Element {
  return (
    <section className="cds-surface-raised cds-hairline px-5 py-12 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-primary">
        <Rocket className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold">还没有站点发布目标</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
        添加一个站点后，CDS 会知道要发布到哪台服务器、哪个站点目录、上线地址是什么，以及默认执行哪些脚本。
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onAdd}>
          <Plus />
          添加站点发布
        </Button>
        {hostCount === 0 ? (
          <Button asChild variant="outline">
            <Link to="/cds-settings?tab=remote-hosts">先添加服务器</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SiteCard({
  site,
  onLogs,
  onRollback,
  onConfigure,
}: {
  site: SiteView;
  onLogs: () => void;
  onRollback: () => void;
  onConfigure: () => void;
}): JSX.Element {
  return (
    <article className="cds-surface-raised cds-hairline flex min-h-[360px] flex-col p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{site.name}</h2>
            {!site.isEnabled ? <span className="rounded-md border border-amber-500/30 px-2 py-0.5 text-xs text-amber-500">已停用</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            <span>{site.serverLabel}</span>
            <span>·</span>
            <span className="font-mono">{site.sitePath}</span>
          </div>
        </div>
        <StatusPill status={site.healthStatus} />
      </header>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <InfoBlock label="上线地址">
          {site.publicUrl ? (
            <a href={site.publicUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline">
              <span className="truncate">{site.publicUrl}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
          ) : '-'}
        </InfoBlock>
        <InfoBlock label="健康检查">{site.healthUrl || '-'}</InfoBlock>
        <InfoBlock label="当前版本"><CodeText>{site.currentVersion || '-'}</CodeText></InfoBlock>
        <InfoBlock label="当前 commit"><CodeText>{site.currentCommit ? site.currentCommit.slice(0, 12) : '-'}</CodeText></InfoBlock>
        <InfoBlock label="最近发布时间">{formatDate(site.lastReleasedAt)}</InfoBlock>
        <InfoBlock label="最近发布人">{site.lastOperator || '-'}</InfoBlock>
      </div>

      <div className="mt-4 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/55 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          发布脚本
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {site.deployScripts.map((script, index) => (
            <span key={`${script}-${index}`} className="inline-flex items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2.5 py-1 text-xs">
              <span className="font-mono">{script}</span>
              {index < site.deployScripts.length - 1 ? <span className="text-muted-foreground">→</span> : null}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <div className="text-xs text-muted-foreground">
          {site.latestRun ? `最近记录 ${site.latestRun.releaseId.slice(0, 12)} · ${statusLabel(site.latestRun.status)}` : '还没有发布记录'}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to={`/branch-list?project=${encodeURIComponent(site.target.projectId)}`}>
              <Rocket />
              立即发布
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={onLogs} disabled={!site.latestRun}>
            <FileText />
            查看日志
          </Button>
          {site.hasRollback && site.latestRun ? (
            <Button variant="outline" size="sm" onClick={onRollback} disabled={!site.canRollback}>
              <RotateCcw />
              回滚
            </Button>
          ) : (
            <span className="inline-flex h-9 items-center rounded-md border border-[hsl(var(--hairline))] px-3 text-xs text-muted-foreground">未配置回滚</span>
          )}
          <Button variant="outline" size="sm" onClick={onConfigure}>
            <Settings />
            配置
          </Button>
        </div>
      </div>
    </article>
  );
}

function SiteWizardDialog({
  open,
  draft,
  step,
  hosts,
  saving,
  onClose,
  onStep,
  onDraft,
  onSelectHost,
  onSave,
}: {
  open: boolean;
  draft: SiteDraft;
  step: WizardStep;
  hosts: RemoteHostOption[];
  saving: boolean;
  onClose: () => void;
  onStep: (step: WizardStep) => void;
  onDraft: Dispatch<SetStateAction<SiteDraft>>;
  onSelectHost: (hostId: string) => void;
  onSave: () => void;
}): JSX.Element {
  const selectedHost = hosts.find((host) => host.id === draft.privateKeyRef);
  const canSave = Boolean(draft.name.trim() && draft.privateKeyRef && draft.sitePath.trim() && buildHealthcheckUrl(draft));
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(896px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>{draft.id ? '配置站点发布' : '添加站点发布'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="grid content-start gap-2">
            {wizardSteps.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onStep(item.id)}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                  step === item.id
                    ? 'border-primary/45 bg-primary/10 text-primary'
                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'
                }`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-current/20 text-xs">{index + 1}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="min-h-[360px] space-y-4">
            {step === 'server' ? (
              <WizardPanel title="选择服务器" description="站点会发布到这台服务器的站点目录。凭据仍复用 Settings / Remote Hosts。">
                {hosts.length === 0 ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                    还没有可用服务器。先到 <Link className="underline" to="/cds-settings?tab=remote-hosts">Settings / Remote Hosts</Link> 添加 SSH 凭据。
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {hosts.map((host) => (
                      <button
                        key={host.id}
                        type="button"
                        onClick={() => onSelectHost(host.id)}
                        className={`flex items-start justify-between gap-3 rounded-md border p-3 text-left ${
                          draft.privateKeyRef === host.id
                            ? 'border-primary/45 bg-primary/10'
                            : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:bg-[hsl(var(--surface-sunken))]'
                        }`}
                      >
                        <span>
                          <span className="block text-sm font-medium">{host.name}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">{host.sshUser}@{host.host}:{host.sshPort}</span>
                        </span>
                        <StatusPill status={host.isEnabled ? '可用' : '已停用'} />
                      </button>
                    ))}
                  </div>
                )}
              </WizardPanel>
            ) : null}

            {step === 'site' ? (
              <WizardPanel title="填写站点目录" description="用户只需要知道站点在哪台服务器上的哪个目录，不需要手写 SSH 命令。">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="站点名称" value={draft.name} onChange={(value) => onDraft((c) => ({ ...c, name: value }))} placeholder="生产站点" />
                  <Field label="站点目录" value={draft.sitePath} onChange={(value) => onDraft((c) => ({ ...c, sitePath: value }))} placeholder="/opt/prd_agent" />
                </div>
                <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <div className="text-muted-foreground">服务器</div>
                  <div className="mt-1 font-mono">{selectedHost ? `${selectedHost.sshUser}@${selectedHost.host}:${selectedHost.sshPort}` : '尚未选择服务器'}</div>
                </div>
              </WizardPanel>
            ) : null}

            {step === 'scripts' ? (
              <WizardPanel title="检测发布脚本" description="默认发布动作固定为进入站点目录后依次执行 fast.sh 和 exec_dep.sh。">
                <div className="grid gap-3 md:grid-cols-2">
                  {SCRIPT_LABELS.map((script) => (
                    <div key={script} className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-300">
                        <CheckCircle2 className="h-4 w-4" />
                        将检测 {script}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">发布前检查会连接服务器；发布过程会单独显示该脚本步骤。</p>
                    </div>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.advancedOpen}
                    onChange={(event) => onDraft((c) => ({ ...c, advancedOpen: event.target.checked }))}
                  />
                  高级配置：自定义发布命令
                </label>
                {draft.advancedOpen ? (
                  <Field label="发布脚本" value={draft.deployCommand} onChange={(value) => onDraft((c) => ({ ...c, deployCommand: value }))} />
                ) : null}
              </WizardPanel>
            ) : null}

            {step === 'health' ? (
              <WizardPanel title="配置上线地址" description="上线地址用于发布后的健康检查，也会显示在站点卡片上。">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
                  <Field label="上线地址" value={draft.publicUrl} onChange={(value) => onDraft((c) => ({ ...c, publicUrl: value }))} placeholder="https://xxx.miduo.org" />
                  <Field label="健康检查路径" value={draft.healthPath} onChange={(value) => onDraft((c) => ({ ...c, healthPath: value || '/' }))} placeholder="/" />
                </div>
                <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <div className="text-muted-foreground">健康检查</div>
                  <div className="mt-1 font-mono">{buildHealthcheckUrl(draft) || '填写上线地址后自动生成'}</div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.rollbackCommand)}
                    onChange={(event) => onDraft((c) => ({ ...c, rollbackCommand: event.target.checked ? './rollback.sh' : '' }))}
                  />
                  这个站点支持一键回滚
                </label>
                {draft.rollbackCommand ? (
                  <Field label="回滚脚本" value={draft.rollbackCommand} onChange={(value) => onDraft((c) => ({ ...c, rollbackCommand: value }))} />
                ) : null}
              </WizardPanel>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] pt-4">
              <div className="text-xs text-muted-foreground">
                {draft.id ? '保存后不会自动发布，需要在分支卡片点击发布。' : '保存后即可从成功运行的分支发布到该站点。'}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose}>取消</Button>
                <Button onClick={onSave} disabled={saving || !canSave}>
                  {saving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  保存站点发布
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseRecords({ runs, onOpen }: { runs: ReleaseRun[]; onOpen: (run: ReleaseRun) => void }): JSX.Element {
  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <div className="border-b border-[hsl(var(--hairline))] px-4 py-3 text-sm font-semibold">发布记录</div>
      {runs.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">还没有发布记录。</div>
      ) : (
        <div className="divide-y divide-[hsl(var(--hairline))]">
          {runs.slice(0, 12).map((run) => (
            <button
              key={run.releaseId}
              type="button"
              onClick={() => onOpen(run)}
              className="grid w-full gap-3 px-4 py-3 text-left text-sm hover:bg-[hsl(var(--surface-sunken))]/60 md:grid-cols-[minmax(0,1fr)_120px_120px_160px]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">发布记录</span>
                  <CodeText>{run.releaseId}</CodeText>
                  {run.rollbackOf ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-xs text-amber-500">回滚</span> : null}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{run.branchId} · {run.commitSha}</div>
              </div>
              <StatusPill status={run.status} />
              <div className="text-muted-foreground">{run.operator || '-'}</div>
              <div className="text-muted-foreground">{formatDate(run.startedAt)}</div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ReleaseLogDialog({ run, onClose }: { run: ReleaseRun | null; onClose: () => void }): JSX.Element {
  const [current, setCurrent] = useState<ReleaseRun | null>(run);
  useEffect(() => setCurrent(run), [run]);
  useEffect(() => {
    if (!run || isTerminal(run.status)) return undefined;
    const source = new EventSource(apiUrl(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/stream?afterSeq=${run.logs.at(-1)?.seq || 0}`));
    source.addEventListener('snapshot', (event) => {
      const data = parseSseJson<{ run: ReleaseRun; logs: ReleaseLogEntry[] }>(event);
      if (data?.run) setCurrent(data.run);
    });
    source.addEventListener('release.log', (event) => {
      const data = parseSseJson<{ log: ReleaseLogEntry }>(event);
      if (!data?.log) return;
      setCurrent((prev) => prev ? { ...prev, logs: dedupeLogs([...prev.logs, data.log]) } : prev);
    });
    source.addEventListener('release.status', (event) => {
      const data = parseSseJson<{ run: ReleaseRun }>(event);
      if (data?.run) setCurrent(data.run);
    });
    return () => source.close();
  }, [run]);
  const steps = current ? releaseSteps(current) : [];
  return (
    <Dialog open={!!run} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(768px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>发布记录 {current?.releaseId ? <span className="font-mono text-sm text-muted-foreground">{current.releaseId}</span> : null}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <StatusPill status={current?.status || 'unknown'} />
          <span className="text-muted-foreground">{formatDate(current?.startedAt)}</span>
        </div>
        <div className="grid gap-2">
          {steps.map((step) => (
            <div key={step.id} className="flex items-center gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-sm">
              {step.state === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : step.state === 'failed' ? <XCircle className="h-4 w-4 text-red-500" /> : step.state === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
              <span className="font-medium">{step.label}</span>
              {step.detail ? <span className="min-w-0 truncate text-xs text-muted-foreground">{step.detail}</span> : null}
            </div>
          ))}
        </div>
        <pre className="max-h-[42vh] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 text-xs leading-5">
          {(current?.logs || []).map((log) => `[${formatTime(log.at)}] ${log.level.toUpperCase()} ${log.phase ? `${log.phase}: ` : ''}${log.message}`).join('\n') || '等待发布日志...'}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function WizardPanel({ title, description, children }: { title: string; description: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function InfoBlock({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 p-3 text-sm">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 truncate">{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }): JSX.Element {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
      />
    </label>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const label = statusLabel(status);
  const tone = status.includes('failed') || status === 'failed'
    ? 'border-red-500/35 bg-red-500/10 text-red-500'
    : status.includes('running') || status === 'queued' || status === 'healthchecking'
      ? 'border-sky-500/35 bg-sky-500/10 text-sky-500'
      : status === 'success' || status === 'healthy' || status === 'rollback_success' || status === '可用'
        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-500'
        : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  return <span className={`inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium ${tone}`}>{label}</span>;
}

function CodeText({ children }: { children: string }): JSX.Element {
  return <span className="font-mono text-xs text-muted-foreground">{children}</span>;
}

function toSiteView(row: CenterRow): SiteView {
  const target = row.target;
  const ssh = target.ssh;
  const healthUrl = ssh?.healthcheckUrl || '';
  return {
    id: target.id,
    target,
    name: target.name || '未命名站点',
    serverLabel: ssh ? `${ssh.user}@${ssh.host}:${ssh.port}` : '-',
    hostLabel: ssh?.host || '-',
    sitePath: ssh?.appPath || '-',
    publicUrl: publicUrlFromHealth(healthUrl),
    healthUrl,
    deployScripts: scriptsFromCommand(ssh?.deployCommand || ''),
    currentVersion: row.currentVersion,
    currentCommit: row.currentCommit,
    lastReleasedAt: row.lastReleasedAt,
    healthStatus: row.healthStatus,
    lastOperator: row.lastOperator,
    latestRun: row.latestRun,
    canRollback: row.canRollback,
    hasRollback: Boolean(ssh?.rollbackCommand?.trim()),
    isEnabled: target.isEnabled,
  };
}

function draftFromTarget(target: ReleaseTarget): SiteDraft {
  const ssh = target.ssh;
  const health = splitHealthUrl(ssh?.healthcheckUrl || '');
  return {
    id: target.id,
    projectId: target.projectId,
    name: target.name,
    privateKeyRef: ssh?.privateKeyRef || '',
    host: ssh?.host || '',
    port: String(ssh?.port || 22),
    user: ssh?.user || '',
    sitePath: ssh?.appPath || DEFAULT_SITE_PATH,
    publicUrl: health.publicUrl,
    healthPath: health.healthPath,
    rollbackCommand: ssh?.rollbackCommand || '',
    advancedOpen: ssh?.deployCommand !== DEFAULT_DEPLOY_COMMAND,
    deployCommand: ssh?.deployCommand || DEFAULT_DEPLOY_COMMAND,
    healthcheckUrl: ssh?.healthcheckUrl || '',
  };
}

function buildTargetBody(draft: SiteDraft, projectId: string): Record<string, unknown> {
  return {
    projectId,
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: Number(draft.port || 22),
    user: draft.user.trim(),
    privateKeyRef: draft.privateKeyRef.trim(),
    appPath: draft.sitePath.trim(),
    deployCommand: draft.advancedOpen ? draft.deployCommand.trim() : DEFAULT_DEPLOY_COMMAND,
    rollbackCommand: draft.rollbackCommand.trim(),
    healthcheckUrl: buildHealthcheckUrl(draft),
  };
}

function buildHealthcheckUrl(draft: SiteDraft): string {
  if (draft.healthcheckUrl.trim()) return draft.healthcheckUrl.trim();
  const base = draft.publicUrl.trim().replace(/\/+$/, '');
  if (!base) return '';
  const path = draft.healthPath.trim() || DEFAULT_HEALTH_PATH;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function publicUrlFromHealth(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value;
  }
}

function splitHealthUrl(value: string): { publicUrl: string; healthPath: string } {
  if (!value) return { publicUrl: '', healthPath: DEFAULT_HEALTH_PATH };
  try {
    const url = new URL(value);
    return { publicUrl: `${url.protocol}//${url.host}`, healthPath: `${url.pathname || '/'}${url.search || ''}` };
  } catch {
    return { publicUrl: value, healthPath: DEFAULT_HEALTH_PATH };
  }
}

function scriptsFromCommand(command: string): string[] {
  if (!command.trim()) return SCRIPT_LABELS;
  const normalized = command.replace(/&&/g, '\n').replace(/;/g, '\n');
  const found = normalized.split('\n').map((item) => item.trim()).filter(Boolean)
    .filter((item) => item.includes('fast.sh') || item.includes('exec_dep.sh'));
  if (found.length > 0) return found.map((item) => item.replace(/^\.?\//, './'));
  return [command.trim()];
}

interface StepState {
  id: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

function releaseSteps(run: ReleaseRun): StepState[] {
  const failed = run.status.includes('failed');
  const phaseSet = new Set(run.logs.map((log) => log.phase).filter(Boolean));
  const deployOutput = run.logs.map((log) => log.message).join('\n');
  const base: StepState[] = [
    { id: 'connect', label: '连接服务器', state: phaseSet.has('connect') ? 'done' : 'pending' },
    { id: 'path', label: '进入站点目录', state: phaseSet.has('prepare') || phaseSet.has('deploy') ? 'done' : 'pending' },
    { id: 'fast', label: '执行 fast.sh', state: deployOutput.includes('fast.sh') || phaseSet.has('deploy') ? 'done' : 'pending' },
    { id: 'exec', label: '执行 exec_dep.sh', state: deployOutput.includes('exec_dep.sh') || phaseSet.has('deploy') ? 'done' : 'pending' },
    { id: 'health', label: '检查上线地址', state: phaseSet.has('healthcheck') ? (failed ? 'failed' : 'done') : 'pending' },
    { id: 'record', label: '标记完成', state: run.status === 'success' || run.status === 'rollback_success' ? 'done' : 'pending' },
  ];
  if (failed) {
    const lastDone = [...base].reverse().find((step) => step.state === 'done');
    const next = base.find((step) => step.state === 'pending');
    if (next) next.state = 'failed';
    if (!next && lastDone) lastDone.state = 'failed';
  } else if (!isTerminal(run.status)) {
    const next = base.find((step) => step.state === 'pending');
    if (next) next.state = 'running';
  }
  return base;
}

function dedupeLogs(items: ReleaseLogEntry[]): ReleaseLogEntry[] {
  const bySeq = new Map<number, ReleaseLogEntry>();
  for (const item of items) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function formatDate(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    healthy: '健康',
    unknown: '未知',
    queued: '排队中',
    running: '发布中',
    healthchecking: '检查上线地址',
    success: '发布成功',
    failed: '发布失败',
    rollback_running: '回滚中',
    rollback_success: '回滚成功',
    rollback_failed: '回滚失败',
    可用: '可用',
    已停用: '已停用',
  };
  return map[status] || status;
}

function isTerminal(status: string): boolean {
  return ['success', 'failed', 'rollback_success', 'rollback_failed'].includes(status);
}

function parseSseJson<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

const wizardSteps: Array<{ id: WizardStep; label: string }> = [
  { id: 'server', label: '选择服务器' },
  { id: 'site', label: '站点目录' },
  { id: 'scripts', label: '发布脚本' },
  { id: 'health', label: '上线地址' },
];
