/** CDS 系统设置中的外部接入：统一走 MAP 跳转授权，不向用户暴露凭据。 */
import { useEffect, useRef, useState } from 'react';
import {
  Bug,
  Copy,
  CheckCircle2,
  Clock,
  ExternalLink,
  Link2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import { apiRequest, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ErrorBlock, LoadingBlock, Section } from '../components';

interface CdsConnectionView {
  id: string;
  name: string;
  partnerKind: string;
  status: 'pending-pairing' | 'active' | 'revoked';
  scopes: string[];
  pairingExpiresAt?: string;
  partnerName?: string;
  partnerBaseUrl?: string;
  createdAt: string;
}

interface ListResponse {
  connections: CdsConnectionView[];
}

interface BugReportIntegrationStatus {
  configured: boolean;
  source: 'system-settings' | 'environment' | 'none';
  baseUrl: string;
  tokenConfigured: boolean;
  updatedAt?: string | null;
  secretStorage: 'encrypted' | 'plaintext';
  configurationError?: string | null;
  authorizationUrl?: string | null;
}

interface BugReportIntegrationTestResult {
  ok: boolean;
  message: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; connections: CdsConnectionView[] };

export function ConnectionsTab({ onToast }: { onToast: (msg: string) => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [integrationState, setIntegrationState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ok'; data: BugReportIntegrationStatus }
  >({ status: 'loading' });
  const [query, setQuery] = useState('');
  const generation = useRef(0);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<BugReportIntegrationTestResult | null>(null);

  const reload = async () => {
    const requestGeneration = ++generation.current;
    setTestResult(null);
    const [connectionsResult, integrationResult] = await Promise.allSettled([
      apiRequest<ListResponse>('/api/cds-system/connections'),
      apiRequest<BugReportIntegrationStatus>('/api/cds-system/integrations/bug-report'),
    ]);
    if (generation.current !== requestGeneration) return;
    if (connectionsResult.status === 'fulfilled') {
      setState({ status: 'ok', connections: connectionsResult.value.connections });
    } else {
      const err = connectionsResult.reason;
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
    if (integrationResult.status === 'fulfilled') {
      setIntegrationState({ status: 'ok', data: integrationResult.value });
    } else {
      const err = integrationResult.reason;
      setIntegrationState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, []);

  const handleRevoke = async (connection: CdsConnectionView) => {
    try {
      await apiRequest(`/api/cds-system/connections/${connection.id}/revoke`, { method: 'POST' });
      onToast('长期连接已撤销');
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const handleDelete = async (connection: CdsConnectionView) => {
    try {
      await apiRequest(`/api/cds-system/connections/${connection.id}`, { method: 'DELETE' });
      onToast('连接记录已删除');
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const testConnection = async () => {
    setTesting(true);
    const requestGeneration = generation.current;
    setTestResult(null);
    try {
      const result = await apiRequest<BugReportIntegrationTestResult>(
        '/api/cds-system/integrations/bug-report/test',
        { method: 'POST' },
      );
      if (generation.current === requestGeneration) setTestResult(result);
    } catch (err) {
      if (generation.current === requestGeneration) setTestResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const clearForwarding = async () => {
    try {
      await apiRequest('/api/cds-system/integrations/bug-report', { method: 'DELETE' });
      setTestResult(null);
      onToast('缺陷转发授权已撤销');
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const connections = state.status === 'ok' ? state.connections : [];
  const needle = query.trim().toLocaleLowerCase();
  const visibleConnections = connections.filter(connection => !needle || [connection.name, connection.partnerName, connection.partnerBaseUrl, connection.id, ...connection.scopes].some(value => value?.toLocaleLowerCase().includes(needle)));
  const activeMapConnections = connections.filter(
    (connection) => connection.partnerKind === 'map' && connection.status === 'active',
  );
  const integration = integrationState.status === 'ok' ? integrationState.data : null;
  const authorizationConfirmed = state.status === 'ok' && integrationState.status === 'ok';
  const fullyAuthorized = activeMapConnections.length > 0 && Boolean(integration?.configured);

  return (
    <Section
      title="外部接入"
      description="管理 MAP 系统互联和缺陷转发两项授权。新授权会跳转到 MAP 确认，凭据由服务端交换。"
    >
      <div className="space-y-4">
        {!fullyAuthorized ? <div className="border-b border-border pb-3">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-base font-semibold">
                <ShieldCheck className={fullyAuthorized ? 'h-5 w-5 text-ok' : 'h-5 w-5 text-primary'} />
                {!authorizationConfirmed ? 'MAP 授权状态未确认' : fullyAuthorized ? 'MAP 授权已完成' : '接入 MAP 平台'}
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                {!authorizationConfirmed ? '请先读取并确认两项授权状态，再进行授权操作。' : fullyAuthorized
                  ? '系统互联与缺陷转发均已接通。长期凭据永久有效，仅在主动撤销、删除或凭据实际失效时终止。'
                  : '点击后跳转到 MAP 确认授权。确认完成后，MAP 与 CDS 由服务端自动交换永久有效的长期凭据并返回结果。'}
              </p>
            </div>
            {!authorizationConfirmed ? <Button variant="outline" onClick={() => void reload()}>重新读取状态</Button> : fullyAuthorized ? null : integration?.authorizationUrl ? (
              <Button asChild className="shrink-0">
                <a href={integration.authorizationUrl}>
                  <ExternalLink className="mr-1" />
                  前往 MAP 授权
                </a>
              </Button>
            ) : (
              <Button disabled className="shrink-0">MAP 授权入口不可用</Button>
            )}
          </div>
        </div> : null}

        {state.status === 'loading' || integrationState.status === 'loading' ? <LoadingBlock label="读取外部接入状态" /> : null}
        {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
        {integrationState.status === 'error' ? <ErrorBlock message={integrationState.message} /> : null}
        {integration?.configurationError ? <ErrorBlock message={integration.configurationError} /> : null}
        {integration?.tokenConfigured && integration.secretStorage === 'plaintext' ? <p role="alert" className="text-sm text-warn">缺陷转发凭据当前为明文存储，请配置服务端凭据加密。浏览器不会收到凭据明文。</p> : null}

        <div className="grid gap-3 md:grid-cols-2">
          <StatusCard
            icon={<Link2 className="h-5 w-5" />}
            title="MAP 系统互联"
            ready={state.status === 'ok' ? activeMapConnections.length > 0 : undefined}
            detail={state.status !== 'ok' ? '状态未确认，请重试读取' : activeMapConnections.length > 0
              ? `${activeMapConnections.length} 条有效长期连接`
              : '尚未建立双向信任连接'}
          />
          <StatusCard
            icon={<Bug className="h-5 w-5" />}
            title="MAP 缺陷转发"
            actions={integration?.configured ? <Button type="button" variant="outline" size="sm" onClick={() => void testConnection()} disabled={testing}><RefreshCw className={testing ? 'animate-spin' : undefined} />{testing ? '验证中' : '验证缺陷转发'}</Button> : undefined}
            ready={integrationState.status === 'ok' ? Boolean(integration?.configured) : undefined}
            detail={integrationState.status !== 'ok' ? '状态未确认，请重试读取' : integration?.configured
              ? `快捷提缺陷将转发到 ${integration.baseUrl}`
              : '未授权时仅保存在 CDS 本地台账'}
          />
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 basis-full sm:basis-auto">
              <h3 className="text-base font-semibold">连接记录</h3>
              <p className="mt-1 text-sm text-muted-foreground">长期授权不按时间自动过期，可在这里明确撤销或删除。</p>
            </div>
            {connections.length > 5 || query ? <label className="min-w-0 flex-1 sm:max-w-64"><span className="sr-only">搜索连接</span><input aria-label="搜索连接" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、对端或权限" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label> : null}
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
              <RefreshCw className="mr-1" /> 刷新
            </Button>
          </div>
          {state.status === 'ok' && connections.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              暂无连接记录，请使用上方“前往 MAP 授权”。
            </div>
          ) : null}
          {state.status === 'ok' && connections.length > 0 && visibleConnections.length === 0 ? <p className="py-4 text-sm text-muted-foreground">没有匹配的连接，请调整搜索条件。</p> : null}
          {visibleConnections.length > 0 ? (
            <div data-connection-view="table" className="hidden overflow-x-auto rounded-md border border-border xl:block">
              <table className="w-full min-w-[45rem] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">名称</th>
                    <th className="px-3 py-2 text-left font-medium">对端</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                    <th className="px-3 py-2 text-left font-medium">权限</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleConnections.map((connection) => (
                    <tr key={connection.id} className="border-t border-border align-middle">
                      <td className="px-3 py-2.5">
                        <div className="max-w-72 break-words font-medium">{connection.name}</div>
                        <div className="font-mono text-xs text-muted-foreground/70">{connection.id}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="max-w-64 break-words">{connection.partnerName || '未登记'}</div>
                        <ConnectionAddress connection={connection} query={query} onToast={onToast} compact />
                      </td>
                      <td className="px-3 py-2.5"><StatusBadge connection={connection} /></td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {connection.scopes.map((scope) => (
                            <span key={scope} className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{scope}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <ConnectionActions connection={connection} onRevoke={handleRevoke} onDelete={handleDelete} compact />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <ul data-connection-view="cards" className="grid gap-3 sm:grid-cols-2 xl:hidden">
          {visibleConnections.map(connection => <li key={connection.id} data-connection-card={connection.id} className="min-w-0 space-y-3 rounded-md border border-border p-3">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-sm font-semibold">{connection.name}</h4><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{connection.id}</p></div><StatusBadge connection={connection} /></div>
            <div className="space-y-1 text-sm"><p className="break-words">对端：{connection.partnerName || '未登记'}</p><ConnectionAddress connection={connection} query={query} onToast={onToast} /></div>
            <div className="text-sm"><span className="text-muted-foreground">授权范围：</span><div className="mt-1 flex flex-wrap gap-1">{connection.scopes.length ? connection.scopes.map(scope => <code key={scope} className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{scope}</code>) : <span>未声明权限</span>}</div></div>
            <ConnectionActions connection={connection} onRevoke={handleRevoke} onDelete={handleDelete} />
          </li>)}
        </ul>
        {integration ? (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <LockKeyhole className="h-4 w-4 text-ok" />
                  服务端凭据状态
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {integration.tokenConfigured
                    ? `缺陷转发凭据已由 MAP 自动签发并在 CDS ${integration.secretStorage === 'encrypted' ? '加密保存' : '以明文保存'}，浏览器不会收到明文。`
                    : '完成 MAP 授权后将自动签发永久缺陷转发凭据。'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {integration.source === 'system-settings' ? (
                  <ConfirmAction
                    title="撤销缺陷转发授权"
                    description="撤销后快捷提缺陷将退回 CDS 本地台账，系统互联连接不受影响。"
                    confirmLabel="撤销"
                    onConfirm={clearForwarding}
                    trigger={<Button type="button" variant="ghost">撤销缺陷转发</Button>}
                  />
                ) : null}
              </div>
            </div>
            {testResult ? (
              <div role="status" className={testResult.ok
                ? 'rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-sm text-ok'
                : 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'}
              >
                {testResult.message}
              </div>
            ) : null}
          </div>
        ) : null}

      </div>
    </Section>
  );
}

function ConnectionAddress({ connection, query, onToast, compact = false }: { connection: CdsConnectionView; query: string; onToast: (message: string) => void; compact?: boolean }): JSX.Element {
  const value = connection.partnerBaseUrl;
  if (!value) return <p className="text-xs text-muted-foreground">未登记连接地址</p>;
  let host = value;
  try { host = new URL(value).host || value; } catch { /* 保留可核对的原始值。 */ }
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(value!); onToast('连接地址已复制'); }
    catch { onToast('复制失败，请展开完整地址手动复制。'); }
  }
  const expandedBySearch = Boolean(query.trim() && value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && !host.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-all font-mono">{host}</span><Button type="button" size="sm" variant="ghost" className={compact ? undefined : "min-h-[3.25rem] text-base [&_svg]:size-[1.875rem]"} aria-label={`复制连接地址 ${connection.id}`} onClick={() => void copy()}><Copy />复制地址</Button></div>
    <details open={expandedBySearch || undefined}><summary className={compact ? "cursor-pointer" : "min-h-[3.25rem] cursor-pointer content-center text-sm"}>完整连接地址</summary><code className="mt-1 block break-all">{value}</code></details>
  </div>;
}

function ConnectionActions({ connection, onRevoke, onDelete, compact = false }: { connection: CdsConnectionView; onRevoke: (connection: CdsConnectionView) => Promise<void>; onDelete: (connection: CdsConnectionView) => Promise<void>; compact?: boolean }): JSX.Element {
  const identity = `${connection.name}（${connection.id}）`;
  return <div className="flex flex-wrap items-center gap-2">
    {connection.status === 'active' ? <ConfirmAction scopeKey={connection.id} title={`撤销连接：${connection.name}`} description={`对象：${identity}。撤销后，对方不能再使用此连接调用 CDS；连接记录会保留。`} confirmLabel="撤销连接" onConfirm={() => onRevoke(connection)} trigger={<Button type="button" variant={compact ? 'ghost' : 'outline'} size="sm" className={compact ? undefined : "min-h-[3.25rem] text-base [&_svg]:size-[1.875rem]"} aria-label={`撤销连接 ${connection.id}`}><ShieldCheck />{compact ? null : '撤销连接'}</Button>} /> : null}
    <ConfirmAction scopeKey={connection.id} title={`删除连接：${connection.name}`} description={`对象：${identity}。删除后此连接不能继续调用 CDS，且连接记录将移除。`} confirmLabel="删除连接" onConfirm={() => onDelete(connection)} trigger={<Button type="button" variant="ghost" size="sm" className={compact ? undefined : "min-h-[3.25rem] text-base [&_svg]:size-[1.875rem]"} aria-label={`删除连接 ${connection.id}`}><Trash2 />{compact ? null : '删除记录'}</Button>} />
  </div>;
}

function StatusCard({ icon, title, ready, detail, actions }: { icon: JSX.Element; title: string; ready: boolean | undefined; detail: string; actions?: JSX.Element }): JSX.Element {
  return (
    <div className="min-w-0 border-l-2 border-border pl-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 font-medium">
          <span className={ready ? 'text-ok' : 'text-muted-foreground'}>{icon}</span>
          {title}
        </div>
        <span className={ready === undefined ? 'rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground' : ready
          ? 'rounded-full bg-ok-soft px-2.5 py-1 text-xs font-medium text-ok'
          : 'rounded-full bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn'}
        >
          {ready === undefined ? '未确认' : ready ? '已授权' : '未授权'}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-all text-sm leading-6 text-muted-foreground">{detail}</p>{actions}</div>
    </div>
  );
}

function StatusBadge({ connection }: { connection: CdsConnectionView }): JSX.Element {
  if (connection.status === 'active') {
    return <span className="inline-flex whitespace-nowrap items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok"><CheckCircle2 className="h-3 w-3" />长期有效</span>;
  }
  if (connection.status === 'pending-pairing') {
    return <span className="inline-flex whitespace-nowrap items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn"><Clock className="h-3 w-3" />旧版待配对</span>;
  }
  if (connection.status === 'revoked') {
    return <span className="inline-flex whitespace-nowrap items-center gap-1 rounded-full bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad"><XCircle className="h-3 w-3" />已撤销</span>;
  }
  return <span className="inline-flex whitespace-nowrap items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"><X className="h-3 w-3" />未知</span>;
}
