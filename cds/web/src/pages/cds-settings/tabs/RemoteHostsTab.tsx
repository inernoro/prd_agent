/**
 * 远程主机管理 tab（系统级）—— shared 基础设施服务部署目标。
 *
 * 当前能力：
 *   - CRUD 主机
 *   - 真实 SSH 连接测试
 *   - 一键部署 sidecar 到主机（5 阶段流式进度）
 *   - 查看当前实例（host:port + 健康）
 *
 * 详见 doc/plan.cds-shared-service-extension.md。
 */
import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  Plus,
  Rocket,
  ServerCog,
  Tag,
  TestTube2,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import { apiRequest, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorBlock, Field, LoadingBlock, Section } from '../components';

interface RemoteHostPublicView {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKeyFingerprint: string;
  hasPassphrase: boolean;
  tags: string[];
  isEnabled: boolean;
  createdAt: string;
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestError?: string;
}

interface ListResponse {
  hosts: RemoteHostPublicView[];
}

interface InstanceResponse {
  instance: {
    deploymentId: string;
    host: string;
    port: number;
    healthy: boolean;
    version?: string;
    deployedAt: string;
    tags: string[];
    hostName: string;
  } | null;
  lastFailed?: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; hosts: RemoteHostPublicView[]; instances: Record<string, InstanceResponse> };

type DeployTarget = { host: RemoteHostPublicView } | null;

export function RemoteHostsTab({ onToast }: { onToast: (msg: string) => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [showCreate, setShowCreate] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deployTarget, setDeployTarget] = useState<DeployTarget>(null);

  const reload = async () => {
    try {
      const data = await apiRequest<ListResponse>('/api/cds-system/remote-hosts');
      const instances: Record<string, InstanceResponse> = {};
      await Promise.all(
        data.hosts.map(async h => {
          try {
            instances[h.id] = await apiRequest<InstanceResponse>(
              `/api/cds-system/remote-hosts/${h.id}/instance`,
            );
          } catch {
            instances[h.id] = { instance: null };
          }
        }),
      );
      setState({ status: 'ok', hosts: data.hosts, instances });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof ApiError ? err.message : String(err),
      });
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const handleDelete = async (host: RemoteHostPublicView) => {
    if (!window.confirm(`确认删除远程主机 "${host.name}"（${host.host}）？此操作不可撤销。`)) return;
    try {
      await apiRequest(`/api/cds-system/remote-hosts/${host.id}`, { method: 'DELETE' });
      onToast(`已删除 ${host.name}`);
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const handleToggleEnabled = async (host: RemoteHostPublicView) => {
    try {
      await apiRequest(`/api/cds-system/remote-hosts/${host.id}`, {
        method: 'PATCH',
        body: { isEnabled: !host.isEnabled },
      });
      onToast(host.isEnabled ? `${host.name} 已禁用` : `${host.name} 已启用`);
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const handleTest = async (host: RemoteHostPublicView) => {
    setTestingId(host.id);
    try {
      const resp = await apiRequest<{ ok: boolean; message: string }>(
        `/api/cds-system/remote-hosts/${host.id}/test`,
        { method: 'POST' },
      );
      onToast(resp.ok ? `${host.name} 连接成功` : `连接失败: ${resp.message}`);
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <Section
      title="远程主机"
      description={
        <>
          shared 基础设施服务（如 claude-sdk sidecar）部署到的目标 SSH 主机。SSH
          凭据本地加密存储，明文不出库。点击「部署」可一键把 sidecar 推到主机并跑起来。
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {state.status === 'ok' ? `${state.hosts.length} 台已登记` : null}
          </div>
          <Button size="sm" onClick={() => setShowCreate(v => !v)}>
            {showCreate ? (
              <>
                <X className="mr-1 h-4 w-4" /> 取消新增
              </>
            ) : (
              <>
                <Plus className="mr-1 h-4 w-4" /> 新增主机
              </>
            )}
          </Button>
        </div>

        {showCreate ? (
          <CreateHostForm
            onCreated={async () => {
              setShowCreate(false);
              onToast('主机已登记');
              await reload();
            }}
            onError={msg => onToast(msg)}
          />
        ) : null}

        {state.status === 'loading' ? <LoadingBlock /> : null}
        {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
        {state.status === 'ok' && state.hosts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            还没有远程主机。点击「新增主机」录入第一台。
          </div>
        ) : null}
        {state.status === 'ok' && state.hosts.length > 0 ? (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">名称</th>
                  <th className="px-3 py-2 text-left font-medium">SSH 目标</th>
                  <th className="px-3 py-2 text-left font-medium">实例</th>
                  <th className="px-3 py-2 text-left font-medium">标签</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {state.hosts.map(h => {
                  const inst = state.instances[h.id]?.instance ?? null;
                  return (
                    <tr key={h.id} className="border-t border-border align-middle">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <ServerCog className="h-4 w-4 text-muted-foreground" />
                          <div className="min-w-0">
                            <div className="font-medium">{h.name}</div>
                            <div className="font-mono text-xs text-muted-foreground/70">
                              fp:{h.sshPrivateKeyFingerprint}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {h.sshUser}@{h.host}:{h.sshPort}
                        {h.lastTestOk === true ? (
                          <span className="ml-2 inline-flex items-center gap-1 text-emerald-500">
                            <CheckCircle2 className="h-3 w-3" /> ok
                          </span>
                        ) : h.lastTestOk === false ? (
                          <span className="ml-2 inline-flex items-center gap-1 text-rose-500" title={h.lastTestError}>
                            <XCircle className="h-3 w-3" /> fail
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5">
                        {inst ? (
                          <div className="space-y-0.5">
                            <div className="font-mono text-xs">
                              {inst.host}:{inst.port}
                            </div>
                            <div
                              className={
                                inst.healthy
                                  ? 'text-xs text-emerald-500'
                                  : 'text-xs text-amber-500'
                              }
                            >
                              {inst.healthy ? 'running' : 'unhealthy'}
                              {inst.version ? ` · ${inst.version}` : ''}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">未部署</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {h.tags.length === 0 ? (
                            <span className="text-xs text-muted-foreground/60">—</span>
                          ) : (
                            h.tags.map(t => (
                              <span
                                key={t}
                                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
                              >
                                <Tag className="h-3 w-3" />
                                {t}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => void handleToggleEnabled(h)}
                          className={
                            h.isEnabled
                              ? 'rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 hover:bg-emerald-500/25'
                              : 'rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/70'
                          }
                        >
                          {h.isEnabled ? '已启用' : '已禁用'}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleTest(h)}
                            disabled={testingId === h.id}
                            title="测试 SSH 连接"
                          >
                            {testingId === h.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <TestTube2 className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeployTarget({ host: h })}
                            disabled={!h.isEnabled}
                            title="部署 Sidecar"
                          >
                            <Rocket className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDelete(h)}
                            title="删除"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {deployTarget ? (
        <DeploySidecarDialog
          host={deployTarget.host}
          onClose={async (changed) => {
            setDeployTarget(null);
            if (changed) await reload();
          }}
          onToast={onToast}
        />
      ) : null}
    </Section>
  );
}

// ── 部署对话框 ───────────────────────────────────

function DeploySidecarDialog({
  host,
  onClose,
  onToast,
}: {
  host: RemoteHostPublicView;
  onClose: (changed: boolean) => void | Promise<void>;
  onToast: (msg: string) => void;
}): JSX.Element {
  const [image, setImage] = useState('prdagent/claude-sidecar:dev');
  const [port, setPort] = useState('7400');
  const [envText, setEnvText] = useState(
    'ANTHROPIC_API_KEY=\nSIDECAR_TOKEN=dev-skip\n# ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic',
  );
  const [releaseTag, setReleaseTag] = useState('');
  const [phase, setPhase] = useState<'form' | 'streaming' | 'done'>('form');
  const [logs, setLogs] = useState<Array<{ at: string; level: string; message: string }>>([]);
  const [status, setStatus] = useState<string>('pending');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      onToast('端口必须是 1-65535 的整数');
      return;
    }
    const env = parseEnvText(envText);
    setLogs([]);
    setErrorMsg(null);
    setPhase('streaming');
    setStatus('pending');

    try {
      const resp = await apiRequest<{ deploymentId: string; streamUrl: string }>(
        `/api/cds-system/remote-hosts/${host.id}/deploy-sidecar`,
        {
          method: 'POST',
          body: {
            image: image.trim(),
            port: portNum,
            env,
            releaseTag: releaseTag.trim() || undefined,
          },
        },
      );
      // SSE：收尾后会 close，我们也在 done 时切到 phase='done'
      const es = new EventSource(resp.streamUrl);
      esRef.current = es;
      es.addEventListener('status', (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          if (typeof data.status === 'string') setStatus(data.status);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('log', (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          setLogs(prev => [...prev, { at: data.at, level: data.level, message: data.message }]);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('done', (evt: MessageEvent) => {
        try {
          const data = JSON.parse(evt.data);
          setStatus(data.status);
        } catch {
          /* ignore */
        }
        es.close();
        setPhase('done');
      });
      es.addEventListener('error', () => {
        setErrorMsg('SSE 连接异常，部署可能仍在后台执行');
        es.close();
        setPhase('done');
      });
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : String(err));
      setPhase('done');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) {
          esRef.current?.close();
          void onClose(phase !== 'form');
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            部署 Sidecar 到 {host.name}（{host.host}）
          </DialogTitle>
        </DialogHeader>

        {phase === 'form' ? (
          <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
            <Field label="镜像（含 tag）">
              <input
                value={image}
                onChange={e => setImage(e.target.value)}
                required
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
              />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="端口">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={e => setPort(e.target.value)}
                  required
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
                />
              </Field>
              <Field label="Release Tag（可选，仅展示）">
                <input
                  value={releaseTag}
                  onChange={e => setReleaseTag(e.target.value)}
                  placeholder="v0.2.1"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
                />
              </Field>
            </div>
            <Field label="环境变量（每行 KEY=VALUE，# 开头为注释）">
              <textarea
                value={envText}
                onChange={e => setEnvText(e.target.value)}
                rows={6}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
                spellCheck={false}
              />
            </Field>
            <div className="flex items-center gap-3 pt-1">
              <Button type="submit">
                <Rocket className="mr-1 h-4 w-4" /> 开始部署
              </Button>
              <Button type="button" variant="ghost" onClick={() => onClose(false)}>
                取消
              </Button>
              <span className="text-xs text-muted-foreground">
                docker run + healthz 探测；包含 SECRET/TOKEN/KEY 后缀的 env 在日志中自动脱敏。
              </span>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">状态：</span>
              <StatusBadge status={status} />
              {phase === 'streaming' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : null}
            </div>
            {errorMsg ? (
              <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600">
                {errorMsg}
              </div>
            ) : null}
            <div
              className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs leading-5"
              style={{ overscrollBehavior: 'contain' }}
            >
              {logs.length === 0 ? (
                <div className="text-muted-foreground">等待部署日志…</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className={logLevelClass(l.level)}>
                    <span className="opacity-50">{l.at.slice(11, 19)}</span>{' '}
                    <span className="opacity-70">[{l.level}]</span> {l.message}
                  </div>
                ))
              )}
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => void onClose(true)}>
                关闭
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── 子组件 / 工具 ─────────────────────────────────

function CreateHostForm({
  onCreated,
  onError,
}: {
  onCreated: () => Promise<void>;
  onError: (msg: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [sshPrivateKey, setSshPrivateKey] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const port = Number(sshPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('SSH 端口必须是 1-65535 的整数');
      }
      await apiRequest('/api/cds-system/remote-hosts', {
        method: 'POST',
        body: {
          name: name.trim(),
          host: host.trim(),
          sshPort: port,
          sshUser: sshUser.trim(),
          sshPrivateKey,
          sshPassphrase: sshPassphrase || undefined,
          tags: tags
            .split(',')
            .map(t => t.trim())
            .filter(Boolean),
        },
      });
      await onCreated();
      setName('');
      setHost('');
      setSshPrivateKey('');
      setSshPassphrase('');
      setTags('');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={e => void handleSubmit(e)}
      className="space-y-4 rounded-md border border-border bg-muted/20 p-4"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="名称">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            required
            placeholder="prod-sandbox-1"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
        </Field>
        <Field label="Host (IP / 域名)">
          <input
            value={host}
            onChange={e => setHost(e.target.value)}
            required
            placeholder="1.2.3.4 或 sandbox.example.com"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
          />
        </Field>
        <Field label="SSH 端口">
          <input
            type="number"
            min={1}
            max={65535}
            value={sshPort}
            onChange={e => setSshPort(e.target.value)}
            required
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
          />
        </Field>
        <Field label="SSH 用户">
          <input
            value={sshUser}
            onChange={e => setSshUser(e.target.value)}
            required
            placeholder="root / ubuntu"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm"
          />
        </Field>
      </div>
      <Field label="SSH 私钥（PEM 格式，AES-256-GCM 加密入库）">
        <textarea
          value={sshPrivateKey}
          onChange={e => setSshPrivateKey(e.target.value)}
          required
          rows={6}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs"
          spellCheck={false}
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="私钥口令（可选）">
          <input
            type="password"
            value={sshPassphrase}
            onChange={e => setSshPassphrase(e.target.value)}
            placeholder="无口令则留空"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
        </Field>
        <Field label="标签（逗号分隔）">
          <input
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder="prod, asia"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
        </Field>
      </div>
      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </Button>
        <span className="text-xs text-muted-foreground">
          私钥保存后通过 fingerprint（{'< 16 字 hex'}）展示，不会再返回明文。
        </span>
      </div>
    </form>
  );
}

function StatusBadge({ status }: { status: string }): JSX.Element {
  const tone =
    status === 'running'
      ? 'bg-emerald-500/15 text-emerald-600'
      : status === 'failed'
        ? 'bg-rose-500/15 text-rose-600'
        : 'bg-amber-500/15 text-amber-600';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>
  );
}

function logLevelClass(level: string): string {
  if (level === 'error') return 'text-rose-500';
  if (level === 'warn') return 'text-amber-500';
  return '';
}

function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (key) out[key] = value;
  }
  return out;
}
