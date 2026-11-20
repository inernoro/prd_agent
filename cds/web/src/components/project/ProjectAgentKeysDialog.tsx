import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownItem, DropdownMenu } from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, apiRequest } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

interface ProjectKey {
  id: string;
  label: string;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  archivedAt?: string;
  requestCount: number;
}

interface KeyDetails {
  key: ProjectKey;
  principal?: { id: string; name?: string; kind?: 'human' | 'machine' | 'agent' };
  approval?: { id: string; agentName: string; purpose: string; requestedAt: string; decidedBy?: string; decidedAt?: string };
  requests: Array<{ at: string; method: string; route?: string; status: number; durationMs: number; principalId?: string }>;
}

const sections = [
  { id: 'current', label: '当前', empty: '还没有当前密钥。可以签发一把项目密钥。' },
  { id: 'history', label: '历史', empty: '归档或已到期的密钥会显示在这里。' },
  { id: 'revoked', label: '已吊销', empty: '还没有已吊销的密钥。' },
] as const;
const actions = {
  rename: { label: '重命名', description: '修改管理列表中的名称。' },
  archive: { label: '归档', description: '移至历史栏。密钥仍可用于认证，直至到期或吊销。' },
  restore: { label: '移回当前', description: '将密钥移回当前栏。' },
  revoke: { label: '吊销', description: '密钥将立即失效，此操作无法撤回。' },
  remove: { label: '永久删除', description: '同时删除这把已吊销密钥的签发记录和请求统计，此操作无法撤回。' },
};
type Action = keyof typeof actions;

function expired(key: ProjectKey): boolean {
  return Boolean(key.expiresAt && Date.parse(key.expiresAt) <= Date.now());
}

function sectionOf(key: ProjectKey): typeof sections[number]['id'] {
  if (key.revokedAt) return 'revoked';
  return key.archivedAt || expired(key) ? 'history' : 'current';
}

function date(value?: string): string {
  return value ? new Date(value).toLocaleString() : '暂无';
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : String(error);
}

export function ProjectAgentKeysDialog({ project, onClose, onToast }: {
  project: { id: string; name: string };
  onClose: () => void;
  onToast: (message: string) => void;
}): JSX.Element {
  const endpoint = `/api/projects/${encodeURIComponent(project.id)}/agent-keys`;
  const [keys, setKeys] = useState<ProjectKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);
  const [target, setTarget] = useState<{ key: ProjectKey; action: Action } | null>(null);
  const [details, setDetails] = useState<ProjectKey | null>(null);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const { signal } = controller;
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ keys: ProjectKey[] }>(endpoint, { signal });
      if (!signal.aborted) setKeys(data.keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (err) {
      if (!signal.aborted) setError(errorMessage(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);

  const groups = sections.map((section) => ({ ...section, keys: keys.filter((key) => sectionOf(key) === section.id) }));
  const keyUrl = (key: ProjectKey) => `${endpoint}/${encodeURIComponent(key.id)}`;

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent frame className="max-w-3xl" style={{ height: 'min(42rem, 86dvh)' }}>
          <DialogHeader className="shrink-0 px-5 pb-4 pt-5 pr-12">
            <DialogTitle>Agent Key 管理</DialogTitle>
            <DialogDescription>{project.name} · 项目级密钥</DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap gap-2 px-5 pb-4">
            <Button type="button" onClick={() => setSigning(true)}><KeyRound />签发新 Key</Button>
            <Button type="button" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCw />刷新</Button>
          </div>
          <Tabs defaultValue="current" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-5 grid shrink-0 grid-cols-3 flex-row" aria-label="密钥分类">
              {groups.map((group) => (
                <TabsTrigger key={group.id} value={group.id} className="justify-center gap-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                  {group.label}<span className="text-xs tabular-nums">{group.keys.length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            {groups.map((group) => (
              <TabsContent key={group.id} value={group.id} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
                {error ? <ErrorBlock message={error} /> : null}
                {loading ? <LoadingBlock label="读取项目密钥" /> : null}
                {!loading && !error && group.keys.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{group.empty}</p> : null}
                {group.keys.map((key) => (
                  <div key={key.id} className="cds-surface-raised cds-hairline flex flex-wrap items-start justify-between gap-2 px-3 py-3">
                    <div className="min-w-0 flex-1 basis-44">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-medium">{key.label}</span>
                        {key.revokedAt ? null : key.archivedAt || expired(key) ? <CodePill>{expired(key) ? '已到期' : '已归档'}</CodePill> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>签发 {date(key.createdAt)}</span>
                        <span>最近使用 {date(key.lastUsedAt)}</span>
                        <span>已记录请求 {key.requestCount ?? 0}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button type="button" size="sm" variant="ghost" onClick={() => setDetails(key)}>请求详情</Button>
                      <DropdownMenu trigger={<Button type="button" size="icon" variant="ghost" aria-label={`管理 ${key.label}`}><MoreHorizontal /></Button>}>
                        <DropdownItem onSelect={() => setTarget({ key, action: 'rename' })}>重命名</DropdownItem>
                        {key.revokedAt ? (
                          <DropdownItem destructive onSelect={() => setTarget({ key, action: 'remove' })}>永久删除</DropdownItem>
                        ) : (
                          <>
                            {!expired(key) ? (key.archivedAt
                              ? <DropdownItem onSelect={() => setTarget({ key, action: 'restore' })}>移回当前</DropdownItem>
                              : <DropdownItem onSelect={() => setTarget({ key, action: 'archive' })}>归档</DropdownItem>) : null}
                            <DropdownItem destructive onSelect={() => setTarget({ key, action: 'revoke' })}>吊销</DropdownItem>
                          </>
                        )}
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </TabsContent>
            ))}
          </Tabs>
        </DialogContent>
      </Dialog>
      {signing ? <SignKeyDialog endpoint={endpoint} projectId={project.id} onClose={() => setSigning(false)} onSigned={() => void load()} onToast={onToast} /> : null}
      {target ? <KeyActionDialog endpoint={keyUrl(target.key)} target={target} onClose={() => setTarget(null)} onSaved={() => {
        onToast(`${actions[target.action].label}成功`);
        void load();
      }} /> : null}
      {details ? <KeyDetailsDialog endpoint={keyUrl(details)} agentKey={details} onClose={() => setDetails(null)} /> : null}
    </>
  );
}

function SignKeyDialog({ endpoint, projectId, onClose, onSigned, onToast }: {
  endpoint: string; projectId: string; onClose: () => void; onSigned: () => void; onToast: (message: string) => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const env = `CDS_HOST=${window.location.origin}\nCDS_PROJECT_ID=${projectId}\nCDS_PROJECT_KEY=${secret}`;

  async function sign() {
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<{ plaintext: string }>(endpoint, { method: 'POST', body: { label: label.trim() || undefined } });
      setSecret(result.plaintext);
      onSigned();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      onToast(message);
    } catch {
      setError('剪贴板不可用。可以选中上方内容手动复制。');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{secret ? '云环境接入配置' : '签发项目级 Agent Key'}</DialogTitle>
          <DialogDescription>{secret ? '明文仅在本次签发后显示。请将密钥保存到云环境的 Secrets。' : '签发一把可重复使用、可单独吊销的项目密钥。'}</DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="space-y-3">
            <pre className="cds-surface-raised cds-hairline whitespace-pre-wrap break-all p-3 font-mono text-xs">{env}</pre>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void copy(env, '已复制环境变量')}><Copy />复制环境变量</Button>
              <Button type="button" variant="outline" onClick={() => void copy(secret, '已复制密钥')}>仅复制密钥</Button>
            </div>
            <p className="text-sm text-muted-foreground">注入三个环境变量后，运行 <code>cdscli auth check</code> 验证接入。</p>
          </div>
        ) : <KeyNameInput value={label} onChange={setLabel} disabled={busy} />}
        {error ? <ErrorBlock message={error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{secret ? '关闭' : '取消'}</Button>
          {!secret ? (
            <Button type="button" onClick={() => void sign()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}确认签发
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyNameInput({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }): JSX.Element {
  return (
    <label className="block space-y-1.5 text-sm">
      <span>密钥名称</span>
      <input className="h-10 w-full rounded-md border border-input bg-background px-3" value={value} onChange={(event) => onChange(event.target.value)} maxLength={100} disabled={disabled} placeholder="例如 云环境部署" />
    </label>
  );
}

function KeyActionDialog({ endpoint, target, onClose, onSaved }: {
  endpoint: string; target: { key: ProjectKey; action: Action }; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const { key, action } = target;
  const [label, setLabel] = useState(key.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const destructive = action === 'remove' || action === 'revoke';

  async function save() {
    setBusy(true);
    setError('');
    try {
      const url = action === 'remove' ? `${endpoint}/record` : endpoint;
      await apiRequest(url, destructive ? { method: 'DELETE' } : {
        method: 'PATCH', body: action === 'rename' ? { label: label.trim() } : { archived: action === 'archive' },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{actions[action].label} · {key.label}</DialogTitle>
          <DialogDescription>{actions[action].description}</DialogDescription>
        </DialogHeader>
        {action === 'rename' ? <KeyNameInput value={label} onChange={setLabel} disabled={busy} /> : null}
        {error ? <ErrorBlock message={error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" variant={destructive ? 'destructive' : 'default'} onClick={() => void save()} disabled={busy || (action === 'rename' && (!label.trim() || label.trim() === key.label))}>
            {busy ? <Loader2 className="animate-spin" /> : null}确认{actions[action].label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyDetailsDialog({ endpoint, agentKey, onClose }: { endpoint: string; agentKey: ProjectKey; onClose: () => void }): JSX.Element {
  const [details, setDetails] = useState<KeyDetails | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<KeyDetails>(endpoint, { signal: controller.signal }).then(setDetails).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(err));
    });
    return () => controller.abort();
  }, [endpoint]);

  const principal = details?.principal;
  const approval = details?.approval;
  const summary = details?.key ?? agentKey;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>请求详情 · {agentKey.label}</DialogTitle>
          <DialogDescription>密钥编号 {summary.id} · 已记录请求 {summary.requestCount ?? 0} 次</DialogDescription>
        </DialogHeader>
        {error ? <ErrorBlock message={error} /> : null}
        {!details && !error ? <LoadingBlock label="读取请求记录" /> : null}
        {details ? <div className="space-y-4 text-sm">
          <div className="cds-surface-raised cds-hairline space-y-1 px-3 py-3">
            <div>签发人 {summary.createdBy || '暂无记录'} · {date(summary.createdAt)}</div>
            <div>凭据主体 {principal ? `${principal.name || principal.id} (${principal.id})` : '未绑定'}</div>
            {agentKey.expiresAt ? <div>到期时间 {date(agentKey.expiresAt)}</div> : null}
            {agentKey.revokedAt ? <div>吊销时间 {date(agentKey.revokedAt)}</div> : null}
            {approval ? <div className="space-y-1 border-t border-border pt-2">
              <div>授权申请 {approval.id} · {date(approval.requestedAt)}</div>
              <div className="break-words">申请方（自报）{approval.agentName} · {approval.purpose}</div>
              <div>审批人 {approval.decidedBy || '暂无记录'} · {date(approval.decidedAt)}</div>
            </div> : null}
          </div>
          <div className="space-y-2">
            <h3 className="font-medium">最近请求</h3>
            <p className="text-xs text-muted-foreground">从启用统计后开始计数，展示最近 20 条。</p>
            {details.requests.length === 0 ? <p className="text-muted-foreground">暂无请求记录。</p> : null}
            {details.requests.map((request, index) => (
              <div key={`${request.at}-${index}`} className="cds-surface-raised cds-hairline space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="break-all">{request.method} {request.route || '路由未记录'}</code>
                  <CodePill>{request.status}</CodePill><span className="text-xs text-muted-foreground">{request.durationMs} ms</span>
                </div>
                <div className="text-xs text-muted-foreground">{date(request.at)} · {request.principalId === principal?.id && principal?.name ? principal.name : request.principalId || '项目密钥身份'}</div>
              </div>
            ))}
          </div>
        </div> : null}
      </DialogContent>
    </Dialog>
  );
}
