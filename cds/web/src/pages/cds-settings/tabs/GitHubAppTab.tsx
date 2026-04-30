import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Github, Loader2, LogOut, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, EmptyBlock, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { GitHubAppResponse, LoadState } from '../types';

interface GitHubOAuthStatusResponse {
  configured?: boolean;
  connected?: boolean;
  login?: string;
  name?: string | null;
  avatarUrl?: string | null;
  connectedAt?: string;
  scopes?: string[];
}

interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn?: number;
  interval?: number;
}

interface DevicePollResponse {
  status: 'pending' | 'slow-down' | 'expired' | 'denied' | 'ready';
  login?: string;
  name?: string | null;
  avatarUrl?: string | null;
  connectedAt?: string;
  scopes?: string[];
  warning?: string;
}

type DeviceFlowState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'waiting'; init: DeviceStartResponse; note: string }
  | { status: 'error'; message: string };

function apiMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function formatDate(value?: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString();
}

export function GitHubAppTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [state, setState] = useState<LoadState<GitHubAppResponse>>({ status: 'loading' });

  const load = useCallback(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading' });
    apiRequest<GitHubAppResponse>('/api/github/app', { signal: ctrl.signal })
      .then((data) => setState({ status: 'ok', data }))
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setState({ status: 'error', message: apiMessage(err) });
      });
    return ctrl;
  }, []);

  useEffect(() => {
    const ctrl = load();
    return () => ctrl.abort();
  }, [load]);

  return (
    <div className="space-y-8">
      <Section title="GitHub App" description="用于 webhook、check-run 和项目级仓库绑定。">
        {state.status === 'loading' ? <LoadingBlock /> : null}
        {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
        {state.status === 'ok' ? <GitHubAppStatus app={state.data} onToast={onToast} onRefresh={load} /> : null}
      </Section>

      <GitHubDeviceFlowPanel onToast={onToast} />

      <Section
        title="管理员配置"
        description="GitHub App 负责 webhook 自动部署，Device Flow 只负责用 GitHub 账号列仓库和克隆私有仓库。"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <pre className="overflow-x-auto rounded-md border border-border bg-card p-4 font-mono text-xs leading-6">
{`# GitHub App
export CDS_GITHUB_APP_ID="<numeric-app-id>"
export CDS_GITHUB_APP_PRIVATE_KEY="$(cat private-key.pem)"
export CDS_GITHUB_WEBHOOK_SECRET="<random-string>"
export CDS_GITHUB_APP_SLUG="<lowercase-app-slug>"
export CDS_PUBLIC_BASE_URL="https://cds.your-domain.com"`}
          </pre>
          <pre className="overflow-x-auto rounded-md border border-border bg-card p-4 font-mono text-xs leading-6">
{`# Device Flow
export CDS_GITHUB_CLIENT_ID="<your-oauth-app-client-id>"

# Optional, only for web OAuth login
export CDS_GITHUB_CLIENT_SECRET="<web-flow-secret>"`}
          </pre>
        </div>
      </Section>
    </div>
  );
}

function GitHubAppStatus({
  app,
  onToast,
  onRefresh,
}: {
  app: GitHubAppResponse;
  onToast: (message: string) => void;
  onRefresh: () => AbortController;
}): JSX.Element {
  if (!app.configured) {
    return (
      <EmptyBlock
        title="未配置 GitHub App"
        description={
          <>
            在 <code>cds/.cds.env</code> 设置 <code>CDS_GITHUB_APP_ID</code> /{' '}
            <code>CDS_GITHUB_APP_PRIVATE_KEY</code> / <code>CDS_GITHUB_WEBHOOK_SECRET</code> 后重启。
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <CodePill>App 已配置</CodePill>
        {app.appId ? <CodePill>id {String(app.appId)}</CodePill> : null}
        {app.appSlug ? <CodePill>{app.appSlug}</CodePill> : null}
      </div>
      <Field label="Webhook 地址">
        <div className="flex min-w-0 gap-2">
          <input
            readOnly
            value={app.webhookUrl || ''}
            className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="复制 Webhook 地址"
            onClick={() => {
              void navigator.clipboard.writeText(app.webhookUrl || '').then(() => onToast('已复制'));
            }}
          >
            <Copy />
          </Button>
        </div>
      </Field>
      <div className="flex flex-wrap gap-2">
        {app.installUrl ? (
          <Button asChild variant="outline">
            <a href={app.installUrl} target="_blank" rel="noreferrer">
              <Github />
              管理 GitHub App
            </a>
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={() => onRefresh()}>
          <RefreshCw />
          刷新
        </Button>
      </div>
    </div>
  );
}

function GitHubDeviceFlowPanel({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [state, setState] = useState<LoadState<GitHubOAuthStatusResponse>>({ status: 'loading' });
  const [flow, setFlow] = useState<DeviceFlowState>({ status: 'idle' });
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<GitHubOAuthStatusResponse>('/api/github/oauth/status');
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: apiMessage(err) });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    return () => {
      abortRef.current = true;
      clearTimer();
    };
  }, [clearTimer]);

  function schedulePoll(deviceCode: string, intervalMs: number): void {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      if (abortRef.current) return;
      void apiRequest<DevicePollResponse>('/api/github/oauth/device-poll', {
        method: 'POST',
        body: { deviceCode },
      })
        .then((body) => {
          if (abortRef.current) return;
          if (body.status === 'ready') {
            setFlow({ status: 'idle' });
            onToast(`已连接 GitHub @${body.login || ''}`.trim());
            void loadStatus();
            return;
          }
          if (body.status === 'pending') {
            setFlow((current) =>
              current.status === 'waiting'
                ? { ...current, note: `等待授权，最近检查：${new Date().toLocaleTimeString()}` }
                : current,
            );
            schedulePoll(deviceCode, intervalMs);
            return;
          }
          if (body.status === 'slow-down') {
            setFlow((current) =>
              current.status === 'waiting'
                ? { ...current, note: 'GitHub 要求降低轮询频率，继续等待授权。' }
                : current,
            );
            schedulePoll(deviceCode, intervalMs + 5000);
            return;
          }
          setFlow({
            status: 'error',
            message: body.status === 'expired' ? '设备代码已过期，请重新发起登录。' : '用户拒绝了授权。',
          });
        })
        .catch((err: unknown) => {
          if (abortRef.current) return;
          setFlow((current) =>
            current.status === 'waiting' ? { ...current, note: `网络抖动，继续等待：${apiMessage(err)}` } : current,
          );
          schedulePoll(deviceCode, intervalMs);
        });
    }, intervalMs);
  }

  async function startDeviceFlow(): Promise<void> {
    abortRef.current = false;
    clearTimer();
    setFlow({ status: 'starting' });
    try {
      const init = await apiRequest<DeviceStartResponse>('/api/github/oauth/device-start', { method: 'POST' });
      setFlow({ status: 'waiting', init, note: '等待 GitHub 授权。' });
      window.open(init.verificationUri, '_blank', 'noopener');
      schedulePoll(init.deviceCode, (init.interval || 5) * 1000);
    } catch (err) {
      setFlow({ status: 'error', message: apiMessage(err) });
    }
  }

  async function disconnect(): Promise<void> {
    setDisconnecting(true);
    try {
      await apiRequest('/api/github/oauth', { method: 'DELETE' });
      abortRef.current = true;
      clearTimer();
      setFlow({ status: 'idle' });
      setDisconnectOpen(false);
      onToast('已断开 GitHub Device Flow');
      await loadStatus();
    } catch (err) {
      onToast(apiMessage(err));
    } finally {
      setDisconnecting(false);
    }
  }

  function stopWaiting(): void {
    abortRef.current = true;
    clearTimer();
    setFlow({ status: 'idle' });
  }

  return (
    <Section
      title="GitHub Device Flow"
      description="系统级 GitHub 登录，用于列出账号仓库和克隆私有仓库。不会替代 GitHub App webhook。"
    >
      {state.status === 'loading' ? <LoadingBlock label="加载 Device Flow 状态" /> : null}
      {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
      {state.status === 'ok' ? (
        <div className="space-y-4">
          <DeviceFlowStatusCard
            status={state.data}
            flow={flow}
            onToast={onToast}
            onStart={() => void startDeviceFlow()}
            onStopWaiting={stopWaiting}
            onDisconnect={() => setDisconnectOpen(true)}
          />
          <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>断开 GitHub Device Flow</DialogTitle>
                <DialogDescription>
                  这只会清除 CDS 本地保存的 Device Flow token，不会撤销 GitHub 侧授权。彻底撤销需到 GitHub 应用授权页面操作。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDisconnectOpen(false)}>
                  取消
                </Button>
                <Button type="button" variant="destructive" onClick={() => void disconnect()} disabled={disconnecting}>
                  {disconnecting ? <Loader2 className="animate-spin" /> : <LogOut />}
                  断开连接
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </Section>
  );
}

function DeviceFlowStatusCard({
  status,
  flow,
  onToast,
  onStart,
  onStopWaiting,
  onDisconnect,
}: {
  status: GitHubOAuthStatusResponse;
  flow: DeviceFlowState;
  onToast: (message: string) => void;
  onStart: () => void;
  onStopWaiting: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  if (!status.configured) {
    return (
      <EmptyBlock
        title="未配置 Device Flow"
        description={
          <>
            设置 <code>CDS_GITHUB_CLIENT_ID</code>，并在 GitHub OAuth App 的 General 设置中启用 Device Flow 后重启 CDS。
          </>
        }
      />
    );
  }

  if (status.connected) {
    const avatar = status.avatarUrl ? (
      <img
        className="h-12 w-12 rounded-full border border-border"
        src={status.avatarUrl}
        alt={status.login || 'GitHub account'}
      />
    ) : (
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted text-sm font-semibold">
        GH
      </div>
    );
    return (
      <div className="max-w-3xl rounded-md border border-border bg-card px-4 py-4">
        <div className="flex items-start gap-3">
          {avatar}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{status.name || status.login || 'GitHub'}</span>
              <CodePill>已连接</CodePill>
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              @{status.login || 'unknown'} · {formatDate(status.connectedAt)}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(status.scopes || []).map((scope) => (
                <CodePill key={scope}>{scope}</CodePill>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <a href="/project-list?new=git">
              <Github />
              新建 GitHub 项目
            </a>
          </Button>
          <Button type="button" variant="outline" onClick={onDisconnect}>
            <LogOut />
            断开连接
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl rounded-md border border-border bg-card px-4 py-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <CodePill>未连接</CodePill>
        <span className="text-sm text-muted-foreground">连接后可列出账号仓库并克隆私有仓库。</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onStart} disabled={flow.status === 'starting' || flow.status === 'waiting'}>
          {flow.status === 'starting' ? <Loader2 className="animate-spin" /> : <Github />}
          使用 GitHub 登录
        </Button>
      </div>
      {flow.status === 'waiting' ? (
        <div className="mt-4 rounded-md border border-primary/30 bg-primary/10 px-4 py-4">
          <div className="text-sm font-medium">在 GitHub 输入设备代码</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded-md bg-background px-3 py-2 font-mono text-lg font-semibold tracking-normal">
              {flow.init.userCode}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(flow.init.userCode).then(() => onToast('设备代码已复制'));
              }}
            >
              <Copy />
              复制代码
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={flow.init.verificationUri} target="_blank" rel="noreferrer">
                <ExternalLink />
                打开 GitHub
              </a>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onStopWaiting}>
              停止等待
            </Button>
          </div>
          <div className="mt-3 text-sm text-muted-foreground">{flow.note}</div>
        </div>
      ) : null}
      {flow.status === 'error' ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {flow.message}
        </div>
      ) : null}
    </div>
  );
}
