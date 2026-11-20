import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { ApiError, apiRequest } from '@/lib/api';

interface SitePolicy {
  origin: string;
  deniedUserIds: string[];
  suspended?: boolean;
  application?: { callbackPath: string; accounts: Record<string, string> };
}

interface SiteOption {
  id: string;
  projectId: string;
  name: string;
  origins: string[];
  clientId: string;
  config: SitePolicy | null;
}

type Catalog = {
  sites: SiteOption[];
  users: Array<{ id: string; name: string; username: string }>;
  issuer: string | null;
  statistics: { callbackSucceeded: number; callbackFailed: number; denied: number };
};
const endpoint = '/api/hosted-sso/sites';

export function HostedSsoSettings(): JSX.Element {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      setCatalog(await apiRequest<Catalog>(endpoint));
    } catch {
      setMessage('无法读取托管站点，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  const site = catalog?.sites.find(item => item.id === selected);

  return <section className="space-y-4 rounded-md border border-border bg-card p-4" aria-label="CDS 托管站点登录">
    <div className="space-y-1">
      <h2 className="font-medium">CDS 托管站点登录</h2>
      <p className="text-sm text-muted-foreground">选择预览入口并管理可登录账号。保存前请在用户菜单用通行密钥重新验证。</p>
    </div>
    {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
    {loading ? <ContentLoading label="读取托管站点" variant="rows" /> : null}
    {!catalog && !loading ? <Button variant="outline" type="button" onClick={() => { setMessage(''); void load(); }}>重试读取</Button> : null}
    {catalog ? <>
      <p className="text-sm text-muted-foreground">
        本次运行回调成功 {catalog.statistics.callbackSucceeded} 次，失败 {catalog.statistics.callbackFailed} 次，拒绝访问 {catalog.statistics.denied} 次。
      </p>
      <label className="block text-sm">
        分支预览
        <select className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-2" value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">选择分支</option>
          {catalog.sites.map(item => <option key={item.id} value={item.id}>{item.projectId} / {item.name}</option>)}
        </select>
      </label>
      {site ? <SitePolicyForm key={site.id} site={site} users={catalog.users} issuer={catalog.issuer} onSaved={load} /> : null}
    </> : null}
  </section>;
}

function SitePolicyForm({ site, users, issuer, onSaved }: { site: SiteOption; users: Catalog['users']; issuer: string | null; onSaved: () => Promise<void> }): JSX.Element {
  const [origin, setOrigin] = useState(site.config?.origin || site.origins[0] || '');
  const [denied, setDenied] = useState<string[]>(site.config?.deniedUserIds ?? []);
  const [callbackPath, setCallbackPath] = useState(site.config?.application?.callbackPath ?? '');
  const [accounts, setAccounts] = useState<Record<string, string>>(site.config?.application?.accounts ?? {});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const origins = [...new Set([...(site.config?.origin ? [site.config.origin] : []), ...site.origins])];

  async function save(suspended: boolean): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`${endpoint}/${encodeURIComponent(site.id)}`, { method: 'PUT', body: {
        origin, suspended, deniedUserIds: denied,
        application: callbackPath ? { callbackPath, accounts: Object.fromEntries(Object.entries(accounts).filter(([, value]) => value.trim())) } : null,
      } });
      setMessage(suspended ? '站点访问已暂停。' : '站点登录配置已保存。');
      await onSaved();
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 403
        ? '请在用户菜单用通行密钥重新验证，再保存。'
        : '无法保存。请核对预览域、回调路径和账号绑定，重新读取后重试。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-3">
    <label className="block text-sm">
      登录保护入口
      <select className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-2" value={origin} onChange={event => setOrigin(event.target.value)}>
        <option value="">选择已发布的独立域入口</option>
        {origins.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
    {!origins.length ? <p className="text-sm text-muted-foreground">该分支需要一个与 CDS 登录域隔离的 HTTPS 预览入口。</p> : null}
    <fieldset disabled={busy} className="space-y-1 rounded-md border border-border p-3 text-sm">
      <legend className="px-1">限制以下 CDS 账号访问</legend>
      {users.map(user => <label key={user.id} className="flex min-h-8 items-center gap-2">
        <input type="checkbox" checked={denied.includes(user.id)} onChange={event => setDenied(previous => event.target.checked ? [...previous, user.id] : previous.filter(id => id !== user.id))} />
        <span>{user.name} ({user.username})</span>
      </label>)}
    </fieldset>
    {issuer ? <details className="space-y-3 rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">应用内账号接入</summary>
      <p className="break-all text-muted-foreground">签发方 {issuer}</p>
      <p className="break-all text-muted-foreground">客户端标识 {site.clientId}</p>
      <label className="block">站内回调路径
        <input value={callbackPath} onChange={event => setCallbackPath(event.target.value)} placeholder="/auth/cds/callback" className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-2" />
      </label>
      {callbackPath ? <div className="grid gap-2 sm:grid-cols-2">{users.map(user => <label key={user.id} className="block">
        {user.name} 的已核实站内账号 ID
        <input value={accounts[user.id] || ''} onChange={event => setAccounts(previous => ({ ...previous, [user.id]: event.target.value }))}
          className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-2" />
      </label>)}</div> : null}
    </details> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={!origin || busy} onClick={() => { void save(false); }}>{site.config && !site.config.suspended ? '保存站点授权' : '启用 CDS 登录'}</Button>
      {site.config && !site.config.suspended ? <Button type="button" variant="outline" disabled={busy} onClick={() => { void save(true); }}>暂停站点访问</Button> : null}
    </div>
    {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
  </div>;
}
