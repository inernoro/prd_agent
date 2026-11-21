import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { ApiError, apiRequest } from '@/lib/api';

interface SitePolicy {
  origin: string;
  deniedUserIds: string[];
  suspended?: boolean;
  application?: { callbackPath: string; loginPath: string };
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
      <p className="text-sm text-muted-foreground">登记项目实现的登录和回调路径。项目维护自己的账号绑定和访问权限。保存前请在用户菜单用通行密钥重新验证。</p>
    </div>
    {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
    {loading ? <ContentLoading label="读取托管站点" variant="rows" /> : null}
    {!catalog && !loading ? <Button variant="outline" type="button" onClick={() => { setMessage(''); void load(); }}>重试读取</Button> : null}
    {catalog ? <>
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
  const [loginPath, setLoginPath] = useState(site.config?.application?.loginPath ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const origins = [...new Set([...(site.config?.origin ? [site.config.origin] : []), ...site.origins])];

  async function save(suspended: boolean): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`${endpoint}/${encodeURIComponent(site.id)}`, { method: 'PUT', body: {
        origin, suspended, deniedUserIds: denied,
        application: callbackPath && loginPath ? { callbackPath, loginPath } : null,
      } });
      setMessage(suspended ? '站点 CDS 登录已暂停。' : '站点登录配置已保存。');
      await onSaved();
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 403
        ? '请在用户菜单用通行密钥重新验证，再保存。'
        : '无法保存。请核对同域托管入口及项目实现的登录和回调路径。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-3">
    <label className="block text-sm">
      CDS 托管入口
      <select className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-2" value={origin} onChange={event => setOrigin(event.target.value)}>
        <option value="">选择已发布的同域 HTTPS 入口</option>
        {origins.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
    {!issuer ? <p className="text-sm text-muted-foreground">CDS 身份签发服务尚未就绪，请联系控制面管理员。</p> : null}
    {!origins.length ? <p className="text-sm text-muted-foreground">发布与 CDS 同注册域的独立 HTTPS 主机后即可登记。</p> : null}
    <fieldset disabled={busy} className="space-y-1 rounded-md border border-border p-3 text-sm">
      <legend className="px-1">限制以下 CDS 账号通过此站点授权</legend>
      {users.map(user => <label key={user.id} className="flex min-h-8 items-center gap-2">
        <input type="checkbox" checked={denied.includes(user.id)} onChange={event => setDenied(previous => event.target.checked ? [...previous, user.id] : previous.filter(id => id !== user.id))} />
        <span>{user.name} ({user.username})</span>
      </label>)}
    </fieldset>
    {issuer ? <details className="space-y-3 rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">项目登录登记</summary>
      <p className="break-all text-muted-foreground">签发方 {issuer}</p>
      <p className="break-all text-muted-foreground">客户端标识 {site.clientId}</p>
      <label className="block">站内回调路径
        <input value={callbackPath} onChange={event => setCallbackPath(event.target.value)} placeholder="/auth/cds/callback" className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-2" />
      </label>
      <label className="block">项目登录入口
        <input value={loginPath} onChange={event => setLoginPath(event.target.value)} placeholder="/api/v1/auth/cds/start" className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-2" />
      </label>
    </details> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={!origin || !issuer || !callbackPath || !loginPath || busy} onClick={() => { void save(false); }}>{site.config && !site.config.suspended ? '保存站点授权' : '启用 CDS 登录'}</Button>
      {site.config && !site.config.suspended ? <Button type="button" variant="outline" disabled={busy} onClick={() => { void save(true); }}>暂停 CDS 登录</Button> : null}
    </div>
    {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
  </div>;
}
