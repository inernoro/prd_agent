/**
 * 远程主机管理 tab（系统级）—— shared-service 项目部署到的目标 SSH 主机。
 *
 * 当前阶段（Phase A.4）：CRUD + 列表显示，连接测试占位（v1.1 接入 SSH）。
 * 详见 doc/plan.cds-shared-service-extension.md。
 */
import { useEffect, useState } from 'react';
import { Plus, ServerCog, Tag, Trash2, X } from 'lucide-react';

import { apiRequest, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
}

interface ListResponse {
  hosts: RemoteHostPublicView[];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; hosts: RemoteHostPublicView[] };

export function RemoteHostsTab({ onToast }: { onToast: (msg: string) => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [showCreate, setShowCreate] = useState(false);

  const reload = async () => {
    try {
      const data = await apiRequest<ListResponse>('/api/cds-system/remote-hosts');
      setState({ status: 'ok', hosts: data.hosts });
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

  return (
    <Section
      title="远程主机"
      description={
        <>
          <code className="rounded bg-muted px-1 py-0.5 text-xs">shared-service</code> 项目（如 claude-sdk
          sidecar）部署到的目标 SSH 主机登记表。SSH 凭据本地加密存储，明文不出库。{' '}
          <span className="text-amber-500">连接测试与真实部署待 ssh2 集成完成（Phase A.3.2）。</span>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {state.status === 'ok' ? `${state.hosts.length} 台已登记` : null}
          </div>
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
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
            onError={(msg) => onToast(msg)}
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
                  <th className="px-3 py-2 text-left font-medium">指纹</th>
                  <th className="px-3 py-2 text-left font-medium">标签</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {state.hosts.map((h) => (
                  <tr key={h.id} className="border-t border-border">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <ServerCog className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{h.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {h.sshUser}@{h.host}:{h.sshPort}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {h.sshPrivateKeyFingerprint}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {h.tags.length === 0 ? (
                          <span className="text-xs text-muted-foreground/60">—</span>
                        ) : (
                          h.tags.map((t) => (
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
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDelete(h)}
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

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
            .map((t) => t.trim())
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
      onSubmit={(e) => void handleSubmit(e)}
      className="space-y-4 rounded-md border border-border bg-muted/20 p-4"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="prod-sandbox-1"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
        </Field>
        <Field label="Host (IP / 域名)">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
            placeholder="1.2.3.4 或 sandbox.example.com"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
          />
        </Field>
        <Field label="SSH 端口">
          <input
            type="number"
            min={1}
            max={65535}
            value={sshPort}
            onChange={(e) => setSshPort(e.target.value)}
            required
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
          />
        </Field>
        <Field label="SSH 用户">
          <input
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
            required
            placeholder="root / ubuntu"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
          />
        </Field>
      </div>
      <Field label="SSH 私钥（PEM 格式，AES-256-GCM 加密入库）">
        <textarea
          value={sshPrivateKey}
          onChange={(e) => setSshPrivateKey(e.target.value)}
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
            onChange={(e) => setSshPassphrase(e.target.value)}
            placeholder="无口令则留空"
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
          />
        </Field>
        <Field label="标签（逗号分隔）">
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
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
