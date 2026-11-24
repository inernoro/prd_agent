import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronDown, CircleHelp, Copy, FolderGit2, Globe, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { AgentKeyExpiryPicker } from '@/components/AgentKeyExpiryPicker';
import { type AgentKeyScope } from '@/components/AgentKeyScopePanel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import {
  isLegacyProjectAgentKey, type AgentKeyExpiryDays, type ProjectAgentKeyIssuer, type ProjectAgentKeyPermissions,
} from '../../../../src/shared/project-agent-key';

interface ProjectKey extends ProjectAgentKeyPermissions {
  id: string;
  label?: string;
  issuer?: ProjectAgentKeyIssuer;
  createdBy?: string;
  createdAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  expiryMode?: 'fixed';
  access?: AgentKeyScope;
}

type DraftScope = 'project' | 'all' | 'create';
type ListScope = 'project' | 'global';
type ProjectOption = { id: string; name: string };

const scopeOptions = [
  { value: 'project', label: '指定项目', description: '仅限一个项目', icon: FolderGit2 },
  { value: 'all', label: '所有项目', description: '全局管理员权限', icon: Globe },
  { value: 'create', label: '仅创建新项目', description: '创建项目专用', icon: Plus },
] as const;

function globalScopeLabel(access: AgentKeyScope | undefined, projects: ProjectOption[]): string {
  if (!access || access.projects === 'all') return access?.canCreateProjects === false ? '所有项目' : '所有项目 · 可创建新项目';
  if (!access.projects.length) return access.canCreateProjects ? '仅创建新项目' : '无项目权限';
  const names = access.projects.map(id => projects.find(project => project.id === id)?.name ?? id).join('、');
  return access.canCreateProjects ? names + ' · 可创建新项目' : names;
}

interface KeyList {
  keys: ProjectKey[];
  canIssueRestrictedPermissions?: boolean;
}

const issuerDetails = {
  user: { label: '用户签发', icon: UserRound, tone: 'bg-info-soft text-info' },
  agent: { label: 'AI Agent 签发', icon: Bot, tone: 'bg-primary-soft text-primary-ink' },
  unknown: { label: '来源未确认', icon: CircleHelp, tone: 'bg-muted text-muted-foreground' },
} as const;

const filters = [
  ['all', '全部'],
  ['user', issuerDetails.user.label],
  ['agent', issuerDetails.agent.label],
  ['unknown', issuerDetails.unknown.label],
] as const;

const projectLevels = { rw: '项目读写', admin: '项目管理员' } as const;
const planningLevels = { read: '工程规划只读', propose: '工程规划提案' } as const;
const designLevels = { read: '设计只读', feedback: '设计实施反馈', publish: '设计稿件发布' } as const;

function permissionLabels(key: ProjectAgentKeyPermissions): string[] {
  return [
    key.projectAccess ? projectLevels[key.projectAccess] : isLegacyProjectAgentKey(key) ? projectLevels.rw : undefined,
    key.planningAccess && planningLevels[key.planningAccess],
    key.designAccess && designLevels[key.designAccess],
  ].filter((label): label is NonNullable<typeof label> => Boolean(label));
}

function dateLabel(value?: string): string {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : '暂无';
}

function PermissionRow<Level extends string>({ disabled, restricted, title, levels, value, onChange }: {
  disabled: boolean;
  restricted: readonly Level[];
  title: string;
  levels: Record<Level, string>;
  value?: Level;
  onChange: (value?: Level) => void;
}): JSX.Element {
  const name = useId();
  return (
    <fieldset className="min-w-0 border-t border-border px-3 py-2">
      <legend className="mx-1 px-1 text-xs font-medium text-muted-foreground">{title}</legend>
      <div className="flex flex-wrap gap-x-4">
        {[undefined, ...(Object.keys(levels) as Level[])].map(level => (
          <label key={level ?? ''} className="flex min-h-8 items-center gap-2 text-sm has-[:disabled]:text-muted-foreground">
            <input type="radio" name={name} checked={value === level} className="accent-primary"
              disabled={disabled && level !== undefined && restricted.includes(level)}
              onChange={() => onChange(level)} />
            {level === undefined ? '不授权' : levels[level]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function AgentKeyPanel({ initialProjectId, projects, onClose, onToast }: {
  initialProjectId?: string;
  projects: ProjectOption[];
  onClose: () => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? '');
  const [scope, setScope] = useState<DraftScope>(initialProjectId ? 'project' : 'create');
  const [listScope, setListScope] = useState<ListScope>(initialProjectId ? 'project' : 'global');
  const [canCreateProjects, setCanCreateProjects] = useState(false);
  const [expiryDays, setExpiryDays] = useState<AgentKeyExpiryDays>();
  const projectName = projects.find(project => project.id === projectId)?.name ?? projectId;
  const projectPath = projectId ? `/api/projects/${encodeURIComponent(projectId)}/agent-keys` : '';
  const globalPath = '/api/global-agent-keys';
  const path = listScope === 'project' ? projectPath : globalPath;
  const [snapshot, setSnapshot] = useState<{ path: string; data: KeyList }>();
  const data = snapshot?.path === path ? snapshot.data : undefined;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('all');
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState<{ config: string; scope: string; expiresAt?: string }>();
  const [label, setLabel] = useState('');
  const [permissions, setPermissions] = useState<ProjectAgentKeyPermissions>({ projectAccess: 'rw' });
  const [signError, setSignError] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [permissionOpen, setPermissionOpen] = useState(false);
  const loadRequest = useRef<AbortController>();
  const copyButton = useRef<HTMLButtonElement>(null);
  const listSection = useRef<HTMLElement>(null);
  const busy = signing || revoking;

  const refresh = useCallback(async () => {
    loadRequest.current?.abort();
    setLoadError('');
    if (!path) { setLoading(false); return; }
    const request = new AbortController();
    loadRequest.current = request;
    setLoading(true);
    try {
      const result = await apiRequest<KeyList>(path, { signal: request.signal });
      if (!request.signal.aborted) setSnapshot({ path, data: result });
    } catch {
      if (!request.signal.aborted) setLoadError('密钥列表读取失败，请刷新重试。');
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
    return () => loadRequest.current?.abort();
  }, [refresh]);

  useEffect(() => {
    if (signed) copyButton.current?.focus();
  }, [signed]);

  function startSigning() {
    setSigned(undefined);
    setLabel('');
    setPermissions({ projectAccess: 'rw' });
    setSignError('');
    setConfirmId('');
    setPermissionOpen(false);
    setExpiryDays(undefined);
  }

  async function sign(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !canSign) return;
    const projectKey = scope === 'project';
    const nextList = projectKey ? 'project' : 'global';
    const access: AgentKeyScope = { canCreateProjects: scope === 'create' || canCreateProjects, projects: scope === 'all' ? 'all' : [] };
    setSignError('');
    setSigning(true);
    try {
      const result = await apiRequest<{ plaintext: string; expiresAt?: string }>(projectKey ? projectPath : globalPath, {
        method: 'POST', body: { label: label.trim() || undefined, expiresInDays: expiryDays, ...(projectKey ? permissions : { access }) },
      });
      const lines = projectKey
        ? [`CDS_PROJECT_ID=${projectId}`, `CDS_PROJECT_KEY=${result.plaintext}`]
        : [`AI_ACCESS_KEY=${result.plaintext}`];
      setSigned({
        config: [`CDS_HOST=${window.location.origin}`, ...lines].join('\n'),
        scope: projectKey ? projectName : globalScopeLabel(access, projects),
        expiresAt: result.expiresAt,
      });
      setFilter('all');
      setConfirmId('');
      setListScope(nextList);
      if (nextList === listScope) void refresh();
    } catch (error) {
      setSignError(error instanceof ApiError && error.status < 500 ? error.message : '未能确认签发结果，请先刷新检查密钥列表。');
    } finally {
      setSigning(false);
    }
  }

  async function revoke(key: ProjectKey): Promise<void> {
    if (busy || confirmId !== key.id) return;
    setRevokeError('');
    setRevoking(true);
    try {
      await apiRequest(`${path}/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
      setSnapshot(current => current?.path === path ? {
        path,
        data: { ...current.data, keys: current.data.keys.map(item => item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item) },
      } : current);
      setConfirmId('');
      onToast('Agent Key 已吊销');
      void refresh();
    } catch (error) {
      setRevokeError(error instanceof ApiError && error.status < 500 ? error.message : '未能确认吊销结果，请刷新检查密钥状态。');
    } finally {
      setRevoking(false);
    }
  }

  const keys = data?.keys ?? [];
  const visibleKeys = filter === 'all' ? keys : keys.filter(key => (key.issuer ?? 'unknown') === filter);
  const allowed = snapshot?.data.canIssueRestrictedPermissions === true;
  const hasPermissions = Object.values(permissions).some(Boolean);
  const canSign = scope !== 'project' || Boolean(projectId && hasPermissions);
  const blockedClose = (event: { preventDefault: () => void }) => { if (busy) event.preventDefault(); };

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent frame className="max-w-5xl" style={{ height: 'min(46rem, 90dvh)' }} onEscapeKeyDown={blockedClose} onPointerDownOutside={blockedClose}>
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base"><KeyRound className="size-5 text-primary-ink" />Agent Key 管理</DialogTitle>
          <DialogDescription>创建项目或全局密钥，查看有效期和签发记录。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col p-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)] lg:overflow-hidden">
          <section aria-label="创建密钥" className="min-w-0 space-y-4 px-4 py-4 sm:px-5 lg:min-h-0 lg:overflow-y-auto">
            <div className="flex min-h-9 items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">创建 Agent Key</h3>
              <Button type="button" size="sm" variant="ghost" className="lg:hidden"
                onClick={() => listSection.current?.scrollIntoView({ block: 'start' })}>查看已签发密钥</Button>
            </div>
          {signed ? (
            <section aria-label="新签发的 Agent Key" className="space-y-2 rounded-lg border border-primary/30 bg-primary-soft/40 p-3">
              <p role="status" className="text-sm font-semibold">Agent Key 已签发</p>
              <p className="text-xs text-muted-foreground">明文仅在本次签发后显示，请先复制接入配置。</p>
              <p className="text-xs font-medium">{signed.scope} · {signed.expiresAt ? `到期 ${dateLabel(signed.expiresAt)}` : '永久'}</p>
              <pre tabIndex={0} className="select-all whitespace-pre-wrap break-all rounded-md border border-border bg-background p-2.5 text-xs">{signed.config}</pre>
              <div className="flex flex-wrap gap-2">
                <Button ref={copyButton} size="sm" onClick={async () => {
                  try { await navigator.clipboard.writeText(signed.config); onToast('接入配置已复制'); }
                  catch { onToast('复制失败，请选中上方的接入配置并手动复制。'); }
                }}><Copy />复制接入配置</Button>
                <Button size="sm" variant="ghost" onClick={startSigning}>收起明文</Button>
              </div>
            </section>
          ) : (
            <form onSubmit={sign} aria-label="签发 Agent Key" className="space-y-4">
              <label className="block space-y-1.5 text-sm font-medium">
                <span>标签</span>
                <input type="text" className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={label} onChange={event => setLabel(event.currentTarget.value)} maxLength={100} disabled={signing} placeholder="例如 Claude 手机端" />
              </label>
              <fieldset disabled={busy} className="min-w-0 space-y-2">
                <legend className="text-sm font-medium">授权范围</legend>
                <div className="grid grid-cols-3 gap-2">
                  {scopeOptions.map(({ value, label: title, description, icon: Icon }) => (
                    <label key={value} className={cn('flex min-w-0 cursor-pointer flex-col gap-1 rounded-lg border p-2.5 text-left sm:p-3',
                      scope === value ? 'border-primary bg-primary-soft/40 text-primary-ink' : 'border-border bg-background hover:bg-accent',
                      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring')}>
                      <input type="radio" name="key-scope" className="sr-only" checked={scope === value} onChange={() => setScope(value)} />
                      <Icon className="size-5" aria-hidden="true" />
                      <span className="text-xs font-semibold sm:text-sm">{title}</span>
                      <span className="hidden text-xs text-muted-foreground sm:block">{description}</span>
                    </label>
                  ))}
                </div>
                {scope === 'project' && (
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    选择项目
                    <select value={projectId} onChange={event => { setProjectId(event.currentTarget.value); setConfirmId(''); }}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground">
                      {!projectId && <option value="">暂无可选项目</option>}
                      {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </label>
                )}
                {scope === 'all' && (
                  <div className="space-y-2 rounded-md border border-warn/40 bg-warn-soft p-2.5 text-xs text-warn">
                    <p>可读写和部署所有项目，并管理全局配置。</p>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={canCreateProjects} className="accent-primary" onChange={event => setCanCreateProjects(event.currentTarget.checked)} />
                      同时允许创建项目
                    </label>
                  </div>
                )}
                {scope === 'create' && <p className="text-xs text-muted-foreground">可创建新的项目，创建后 CDS 会返回该项目的独立密钥。</p>}
              </fieldset>
              <AgentKeyExpiryPicker value={expiryDays} onChange={setExpiryDays} disabled={busy} />
              {scope === 'project' && <div className="rounded-md border border-border bg-background">
                <button type="button" aria-expanded={permissionOpen} disabled={signing}
                  className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-accent"
                  onClick={() => setPermissionOpen(open => !open)}>
                  <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-medium">权限设置</span>
                  <span className="ml-auto text-right text-xs text-muted-foreground">{hasPermissions ? permissionLabels(permissions).join('、') : '请选择权限'}</span>
                  <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground', permissionOpen && 'rotate-180')} />
                </button>
                {permissionOpen && (
                  <fieldset disabled={signing} className="min-w-0 space-y-1">
                    <p className="px-3 pt-1 text-xs text-muted-foreground">可组合不同类别的权限。</p>
                    <PermissionRow title="项目" levels={projectLevels} value={permissions.projectAccess} disabled={!allowed} restricted={['admin']}
                      onChange={projectAccess => setPermissions(current => ({ ...current, projectAccess }))} />
                    <PermissionRow title="工程规划" levels={planningLevels} value={permissions.planningAccess} disabled={!allowed} restricted={['read', 'propose']}
                      onChange={planningAccess => setPermissions(current => ({ ...current, planningAccess }))} />
                    <PermissionRow title="设计" levels={designLevels} value={permissions.designAccess} disabled={!allowed} restricted={['read', 'feedback', 'publish']}
                      onChange={designAccess => setPermissions(current => ({ ...current, designAccess }))} />
                    {!allowed && <p className="px-3 pb-2 text-xs text-muted-foreground">管理员、工程规划和设计权限由登录 CDS 的系统所有者签发。</p>}
                  </fieldset>
                )}
              </div>}
              {scope === 'project' && permissions.projectAccess === 'admin' && <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">项目管理员可删除当前项目，并查看和吊销项目密钥。</p>}
              {signError && <ErrorBlock message={signError} />}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">
                  {scope === 'project' ? projectName || '请选择项目' : globalScopeLabel({ canCreateProjects: scope === 'create' || canCreateProjects, projects: scope === 'all' ? 'all' : [] }, projects)}
                  {' · '}{expiryDays === undefined ? '永久' : `${expiryDays} 天`}
                </span>
                <Button type="submit" disabled={!canSign || busy}>
                  {signing ? <Loader2 className="animate-spin" /> : <KeyRound />}
                  {signing ? '正在签发' : '确认签发'}
                </Button>
              </div>
            </form>
          )}
          </section>

          <section ref={listSection} aria-label="已签发密钥" className="min-w-0 space-y-3 border-t border-border px-4 py-4 sm:px-5 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">已签发密钥</h3>
              <Button type="button" variant="ghost" size="sm" disabled={!path || loading || busy} onClick={() => void refresh()}><RefreshCw />刷新</Button>
            </div>
            <div role="group" aria-label="密钥范围筛选" className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant={listScope === 'project' ? 'secondary' : 'ghost'} aria-pressed={listScope === 'project'}
                disabled={!projectId || busy} onClick={() => { setListScope('project'); setConfirmId(''); }}>项目密钥</Button>
              <Button type="button" size="sm" variant={listScope === 'global' ? 'secondary' : 'ghost'} aria-pressed={listScope === 'global'}
                disabled={busy} onClick={() => { setListScope('global'); setConfirmId(''); }}>全局密钥</Button>
              {listScope === 'project' && <span className="min-w-0 break-all text-xs text-muted-foreground">{projectName}</span>}
            </div>
            {loadError && <ErrorBlock message={loadError} />}
          {!data && loading && <LoadingBlock label="正在读取密钥" />}
          {data && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-background p-1" role="group" aria-label="按签发来源筛选">
                {filters.map(([value, title]) => (
                  <button key={value} type="button" aria-pressed={filter === value} disabled={revoking}
                    onClick={() => { setFilter(value); setConfirmId(''); }}
                    className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      filter === value ? 'bg-primary-soft text-primary-ink' : 'text-muted-foreground hover:bg-accent')}>
                    {title}
                  </button>
                ))}
              </div>
              {visibleKeys.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
                {filter === 'all' ? '此范围内还没有密钥。' : '该类别下暂无密钥。'}
              </p> : (
                <ul role="list" className="divide-y divide-border rounded-lg border border-border bg-background">
                  {visibleKeys.map(key => {
                    const source = issuerDetails[key.issuer ?? 'unknown'];
                    const SourceIcon = source.icon;
                    const expired = Date.parse(key.expiresAt ?? '') <= Date.now();
                    const canRevoke = !key.revokedAt && (key.projectAccess !== 'admin' || allowed);
                    const keyLabel = key.label || key.id;
                    return (
                      <li key={key.id} className="min-w-0 space-y-2 p-3">
                        <div className="flex items-start gap-2.5">
                          <SourceIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="break-all text-sm font-semibold">{keyLabel}</span>
                              <span className={cn('rounded px-1.5 py-0.5 text-xs', source.tone)}>{source.label}</span>
                              <span className={cn('text-xs', key.revokedAt || expired ? 'text-muted-foreground' : 'text-ok')}>
                                {key.revokedAt ? '已吊销' : expired ? '已过期' : '有效'}
                              </span>
                            </div>
                            <p className="break-words text-xs text-muted-foreground">{listScope === 'global' ? globalScopeLabel(key.access, projects) : permissionLabels(key).join('、')}</p>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span>签发于 {dateLabel(key.createdAt)}</span>
                              <span>{key.expiresAt ? `到期 ${dateLabel(key.expiresAt)}` : '有效期永久'}</span>
                              <span>最近使用 {dateLabel(key.lastUsedAt)}</span>
                              {key.issuer === 'user' && key.createdBy && <span className="break-all">签发人 {key.createdBy}</span>}
                            </div>
                          </div>
                          {canRevoke && confirmId !== key.id && (
                            <Button type="button" size="sm" variant="ghost" disabled={busy}
                              aria-label={`吊销 ${keyLabel}`} className="shrink-0 px-2 text-destructive hover:text-destructive"
                              onClick={() => { setConfirmId(key.id); setRevokeError(''); }}>吊销</Button>
                          )}
                        </div>
                        {confirmId === key.id && (
                          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5">
                            <p className="text-xs text-destructive">吊销后，这把密钥立即失效，无法恢复。</p>
                            {revokeError && <ErrorBlock message={revokeError} />}
                            <div className="flex justify-end gap-2">
                              <Button type="button" size="sm" variant="ghost" disabled={revoking} onClick={() => setConfirmId('')}>取消</Button>
                              <Button type="button" size="sm" variant="destructive" disabled={revoking} onClick={() => void revoke(key)}>
                                {revoking ? '正在吊销' : '确认吊销'}
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
