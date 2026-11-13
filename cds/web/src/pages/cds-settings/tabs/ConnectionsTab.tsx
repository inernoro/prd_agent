/** CDS 系统设置中的外部接入：统一走 MAP 跳转授权，不向用户暴露凭据。 */
import { useEffect, useState } from 'react';
import {
  Bug,
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<BugReportIntegrationTestResult | null>(null);

  const reload = async () => {
    const [connectionsResult, integrationResult] = await Promise.allSettled([
      apiRequest<ListResponse>('/api/cds-system/connections'),
      apiRequest<BugReportIntegrationStatus>('/api/cds-system/integrations/bug-report'),
    ]);
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
    setTestResult(null);
    try {
      const result = await apiRequest<BugReportIntegrationTestResult>(
        '/api/cds-system/integrations/bug-report/test',
        { method: 'POST' },
      );
      if (result.ok) onToast(result.message);
      else setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) });
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
  const activeMapConnections = connections.filter(
    (connection) => connection.partnerKind === 'map' && connection.status === 'active',
  );
  const integration = integrationState.status === 'ok' ? integrationState.data : null;
  const fullyAuthorized = activeMapConnections.length > 0 && Boolean(integration?.configured);

  return (
    <Section title="外部接入">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1 text-sm">
            <StatusLine icon={<Link2 className="h-4 w-4" />} title="MAP 系统互联" ready={activeMapConnections.length > 0}
              detail={activeMapConnections.length > 0 ? `${activeMapConnections.length} 条有效长期连接` : '尚未建立双向信任连接'} />
            <StatusLine icon={<Bug className="h-4 w-4" />} title="MAP 缺陷转发" ready={Boolean(integration?.configured)}
              detail={integration?.configured ? `快捷提缺陷将转发到 ${integration.baseUrl}` : '未授权时仅保存在 CDS 本地台账'} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!fullyAuthorized && (integration?.authorizationUrl ? (
              <Button asChild><a href={integration.authorizationUrl}><ExternalLink />前往 MAP 授权</a></Button>
            ) : <Button disabled>MAP 授权入口不可用</Button>)}
            {integration?.configured ? (
              <Button type="button" variant="outline" onClick={() => void testConnection()} disabled={testing}>
                <RefreshCw className={testing ? 'animate-spin' : undefined} />{testing ? '验证中' : '验证连接'}
              </Button>
            ) : null}
            {integration?.source === 'system-settings' ? (
              <ConfirmAction title="撤销缺陷转发授权"
                description="撤销后快捷提缺陷将退回 CDS 本地台账，系统互联连接不受影响。"
                confirmLabel="撤销" onConfirm={clearForwarding}
                trigger={<Button type="button" variant="ghost">撤销缺陷转发</Button>} />
            ) : null}
          </div>
        </div>
        {integration ? (
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
            {integration.tokenConfigured
              ? `缺陷转发凭据已由 MAP 自动签发并在 CDS ${integration.secretStorage === 'encrypted' ? '加密保存' : '保存'}，浏览器不会收到明文。`
              : '完成 MAP 授权后将自动签发永久缺陷转发凭据。'}
          </p>
        ) : null}
        {state.status === 'loading' || integrationState.status === 'loading' ? <LoadingBlock label="读取外部接入状态" /> : null}
        {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
        {integrationState.status === 'error' ? <ErrorBlock message={integrationState.message} /> : null}
        {integration?.configurationError ? <ErrorBlock message={integration.configurationError} /> : null}
        {testResult ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{testResult.message}</div> : null}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">连接记录</h3>
              <p className="mt-1 text-sm text-muted-foreground">长期授权不按时间自动过期，仅在主动撤销、删除或凭据实际失效时终止。</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}><RefreshCw />刷新</Button>
          </div>
          {state.status === 'ok' && connections.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              暂无连接记录，请使用上方“前往 MAP 授权”。
            </div>
          ) : null}
          {connections.length > 0 ? (
            <div className="overflow-x-auto rounded-md border border-border">
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
                  {connections.map((connection) => (
                    <tr key={connection.id} className="border-t border-border align-middle">
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{connection.name}</div>
                        <div className="font-mono text-xs text-muted-foreground/70">{connection.id}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div>{connection.partnerName || '未登记'}</div>
                        <div className="font-mono text-xs text-muted-foreground/70">{connection.partnerBaseUrl || '—'}</div>
                      </td>
                      <td className="px-3 py-2.5"><StatusBadge connection={connection} /></td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {connection.scopes.map((scope) => (
                            <span key={scope} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">{scope}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {connection.status === 'active' ? (
                            <ConfirmAction
                              title="撤销长期连接"
                              description={`撤销与 ${connection.partnerName || connection.name} 的连接后，对方将不能继续调用 CDS。`}
                              confirmLabel="撤销"
                              onConfirm={() => handleRevoke(connection)}
                              trigger={<Button variant="ghost" size="sm" title="撤销"><ShieldCheck /></Button>}
                            />
                          ) : null}
                          <ConfirmAction
                            title="删除连接记录"
                            description={`删除连接记录 ${connection.name}。`}
                            confirmLabel="删除"
                            onConfirm={() => handleDelete(connection)}
                            trigger={<Button variant="ghost" size="sm" title="删除"><Trash2 /></Button>}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">授权说明</summary>
          <p className="py-2 leading-6">MAP 系统互联与缺陷转发在同一次授权中完成。点击“前往 MAP 授权”后由服务端交换长期凭据，不需要填写地址、复制 Token 或粘贴配对码。</p>
        </details>
      </div>
    </Section>
  );
}

function StatusLine({ icon, title, ready, detail }: { icon: JSX.Element; title: string; ready: boolean; detail: string }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={ready ? 'text-ok' : 'text-muted-foreground'}>{icon}</span>
      <span className="font-medium">{title}</span>
      <span className={ready ? 'text-ok' : 'text-warn'}>{ready ? '已授权' : '待授权'}</span>
      <span className="break-all text-muted-foreground">{detail}</span>
    </div>
  );
}

function StatusBadge({ connection }: { connection: CdsConnectionView }): JSX.Element {
  if (connection.status === 'active') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok"><CheckCircle2 className="h-3 w-3" />长期有效</span>;
  }
  if (connection.status === 'pending-pairing') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn"><Clock className="h-3 w-3" />旧版待配对</span>;
  }
  if (connection.status === 'revoked') {
    return <span className="inline-flex items-center gap-1 rounded-full bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad"><XCircle className="h-3 w-3" />已撤销</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"><X className="h-3 w-3" />未知</span>;
}
