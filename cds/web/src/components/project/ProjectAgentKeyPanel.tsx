import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Bot, ChevronDown, CircleHelp, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import {
  isLegacyProjectAgentKey, type ProjectAgentKeyIssuer, type ProjectAgentKeyPermissions,
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

export function ProjectAgentKeyPanel({ projectId, projectName, onClose, onToast }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const path = `/api/projects/${encodeURIComponent(projectId)}/agent-keys`;
  const [data, setData] = useState<KeyList>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('all');
  const [creating, setCreating] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState('');
  const [label, setLabel] = useState('');
  const [permissions, setPermissions] = useState<ProjectAgentKeyPermissions>({ projectAccess: 'rw' });
  const [signError, setSignError] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [permissionOpen, setPermissionOpen] = useState(false);
  const loadRequest = useRef<AbortController>();
  const copyButton = useRef<HTMLButtonElement>(null);
  const busy = signing || revoking;

  const refresh = useCallback(async () => {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoadError('');
    setLoading(true);
    try {
      const result = await apiRequest<KeyList>(path, { signal: request.signal });
      if (!request.signal.aborted) setData(result);
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
    setSigned('');
    setLabel('');
    setPermissions({ projectAccess: 'rw' });
    setSignError('');
    setConfirmId('');
    setPermissionOpen(false);
    setCreating(true);
  }

  async function sign(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !Object.values(permissions).some(Boolean)) return;
    setSignError('');
    setSigning(true);
    try {
      const result = await apiRequest<{ plaintext: string }>(path, {
        method: 'POST', body: { label: label.trim() || undefined, ...permissions },
      });
      setSigned([`CDS_HOST=${window.location.origin}`, `CDS_PROJECT_ID=${projectId}`, `CDS_PROJECT_KEY=${result.plaintext}`].join('\n'));
      setCreating(false);
      setFilter('all');
      void refresh();
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
      setData(current => current && ({
        ...current,
        keys: current.keys.map(item => item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item),
      }));
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
  const allowed = data?.canIssueRestrictedPermissions === true;
  const hasPermissions = Object.values(permissions).some(Boolean);
  const blockedClose = (event: { preventDefault: () => void }) => { if (busy) event.preventDefault(); };

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent frame className="max-w-xl" onEscapeKeyDown={blockedClose} onPointerDownOutside={blockedClose}>
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base"><KeyRound className="size-5 text-primary-ink" />Agent Key 管理</DialogTitle>
          <DialogDescription className="break-words">{projectName} · 密钥仅用于当前项目</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {signed && (
            <section aria-label="新签发的 Agent Key" className="space-y-2 rounded-lg border border-primary/30 bg-primary-soft/40 p-3">
              <p role="status" className="text-sm font-semibold">Agent Key 已签发</p>
              <p className="text-xs text-muted-foreground">明文仅在本次签发后显示，请先复制接入配置。</p>
              <pre tabIndex={0} className="select-all whitespace-pre-wrap break-all rounded-md border border-border bg-background p-2.5 text-xs">{signed}</pre>
              <div className="flex flex-wrap gap-2">
                <Button ref={copyButton} size="sm" onClick={async () => {
                  try { await navigator.clipboard.writeText(signed); onToast('接入配置已复制'); }
                  catch { onToast('复制失败，请选中上方的接入配置并手动复制。'); }
                }}><Copy />复制接入配置</Button>
                <Button size="sm" variant="ghost" onClick={() => setSigned('')}>收起明文</Button>
              </div>
            </section>
          )}

          {creating ? (
            <form onSubmit={sign} aria-label="签发项目级 Agent Key" className="space-y-3 rounded-lg border border-border bg-background p-3">
              <label className="block space-y-1.5 text-sm font-medium">
                <span>标签</span>
                <input autoFocus type="text" className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={label} onChange={event => setLabel(event.currentTarget.value)} maxLength={100} disabled={signing} placeholder="例如 Claude 手机端" />
              </label>
              <div className="rounded-md border border-border bg-card">
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
              </div>
              {permissions.projectAccess === 'admin' && <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">项目管理员可删除当前项目，并查看和吊销项目密钥。</p>}
              {signError && <ErrorBlock message={signError} />}
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" disabled={signing} onClick={() => setCreating(false)}>取消</Button>
                <Button type="submit" size="sm" disabled={!hasPermissions || signing}>
                  {signing ? <Loader2 className="animate-spin" /> : <KeyRound />}
                  {signing ? '正在签发' : '确认签发'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button type="button" disabled={!data || busy} onClick={startSigning}><Plus />创建 Agent Key</Button>
              <Button type="button" variant="ghost" size="sm" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw />刷新</Button>
            </div>
          )}

          {loadError && (
            <div className="space-y-2">
              <ErrorBlock message={loadError} />
              {creating && <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>刷新列表</Button>}
            </div>
          )}
          {!data && loading && <LoadingBlock label="正在读取密钥" />}
          {data && (
            <section aria-label="项目密钥列表" className="space-y-2.5">
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
                {filter === 'all' ? '还没有项目密钥。' : '该类别下暂无密钥。'}
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
                            <p className="break-words text-xs text-muted-foreground">{permissionLabels(key).join('、')}</p>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span>签发于 {dateLabel(key.createdAt)}</span>
                              <span>最近使用 {dateLabel(key.lastUsedAt)}</span>
                              {key.issuer === 'user' && key.createdBy && <span className="break-all">签发人 {key.createdBy}</span>}
                            </div>
                          </div>
                          {canRevoke && confirmId !== key.id && (
                            <Button type="button" size="sm" variant="ghost" disabled={busy || creating}
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
            </section>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
