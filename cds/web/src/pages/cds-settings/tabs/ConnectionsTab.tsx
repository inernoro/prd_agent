/**
 * 对接 MAP（CDS 系统设置 → 运行时 → 对接 MAP）—— spec.cds.map-pairing-protocol.md v1。
 *
 * 用户体验流：
 *   1. 点 [+ 创建连接密钥]
 *   2. dialog 显示一段 base64url 密文 + [复制到剪贴板]
 *   3. 用户切到 MAP 平台粘贴
 *   4. 完成后回到本页，列表自动出现一条 status='active' 的连接
 *
 * 关键约束：
 *   - 密钥仅一次性可见（这条 status='pending-pairing' 时 issue 端可重新看，
 *     但 long token 只在 accept 响应里给 partner 一次，CDS 端不显示）
 *   - 默认 10 分钟 TTL，过期后 GC 自动删除
 */
import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Copy,
  Plus,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import { apiRequest, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorBlock, Field, LoadingBlock, Section } from '../components';

interface CdsConnectionView {
  id: string;
  name: string;
  partnerKind: string;
  status: 'pending-pairing' | 'active' | 'revoked';
  scopes: string[];
  pairingExpiresAt?: string;
  partnerId?: string;
  partnerName?: string;
  partnerBaseUrl?: string;
  projectId?: string;
  longTokenExpiresAt?: string;
  createdAt: string;
  activatedAt?: string;
  lastUsedAt?: string;
}

interface ListResponse {
  connections: CdsConnectionView[];
}

/**
 * `/api/cds-system/connections/issue` 响应。
 *
 * 注意：后端**不再**单独返回 pairingToken 明文 —— 它已嵌在 clipboardText
 * （`cds-connect:v1:<base64url>` 格式）里。这样减少 token 在 access logs /
 * proxy logs / browser devtools 中的足迹（PR #529 Bugbot MEDIUM）。
 * 前端只需要把 clipboardText 整体丢给 navigator.clipboard.writeText。
 */
interface IssueResponse {
  connectionId: string;
  clipboardText: string;
  expiresAt: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; connections: CdsConnectionView[] };

export function ConnectionsTab({
  onToast,
}: {
  onToast: (msg: string) => void;
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [issueOpen, setIssueOpen] = useState(false);
  const [issued, setIssued] = useState<IssueResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reload = async () => {
    try {
      const data = await apiRequest<ListResponse>('/api/cds-system/connections');
      setState({ status: 'ok', connections: data.connections });
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

  const handleIssue = async (name: string) => {
    setSubmitting(true);
    try {
      const resp = await apiRequest<IssueResponse>(
        '/api/cds-system/connections/issue',
        {
          method: 'POST',
          body: { name: name.trim() || undefined, ttlMinutes: 10 },
        },
      );
      setIssued(resp);
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast('密钥已复制到剪贴板，去 MAP 端粘贴');
    } catch {
      onToast('复制失败，请手动选中复制');
    }
  };

  const handleRevoke = async (conn: CdsConnectionView) => {
    try {
      await apiRequest(`/api/cds-system/connections/${conn.id}/revoke`, {
        method: 'POST',
      });
      onToast('已撤销');
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const handleDelete = async (conn: CdsConnectionView) => {
    try {
      await apiRequest(`/api/cds-system/connections/${conn.id}`, {
        method: 'DELETE',
      });
      onToast('已删除');
      await reload();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <Section
      title="对接 MAP"
      description={
        <>
          通过剪贴板配对密钥，与 MAP 平台或其他执行器适配器建立信任连接。流程：点
          「创建连接密钥」→ 复制 → 在 MAP 平台粘贴 → 自动完成。详见{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            doc/spec.cds.map-pairing-protocol.md
          </code>
          。
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            {state.status === 'ok'
              ? `${state.connections.length} 条记录（含 pending）`
              : null}
          </div>
          <Button size="sm" onClick={() => setIssueOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> 创建连接密钥
          </Button>
        </div>

        {state.status === 'loading' ? <LoadingBlock /> : null}
        {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
        {state.status === 'ok' && state.connections.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            还没有连接。点「创建连接密钥」开始配对。
          </div>
        ) : null}
        {state.status === 'ok' && state.connections.length > 0 ? (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">名称</th>
                  <th className="px-3 py-2 text-left font-medium">对端</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-left font-medium">Scope</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {state.connections.map(conn => (
                  <tr key={conn.id} className="border-t border-border align-middle">
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{conn.name}</div>
                      <div className="font-mono text-xs text-muted-foreground/70">
                        {conn.id}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {conn.partnerName ? (
                        <div>
                          <div className="text-sm">{conn.partnerName}</div>
                          <div className="font-mono text-xs text-muted-foreground/70">
                            {conn.partnerBaseUrl}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={conn.status} pairingExpiresAt={conn.pairingExpiresAt} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {conn.scopes.map(s => (
                          <span
                            key={s}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {conn.status === 'active' ? (
                          <ConfirmAction
                            title="撤销连接"
                            description={`撤销与 ${conn.partnerName || conn.name} 的连接，对方将无法继续调用 CDS API。`}
                            confirmLabel="撤销"
                            onConfirm={() => handleRevoke(conn)}
                            trigger={(
                              <Button variant="ghost" size="sm" title="撤销">
                                <ShieldCheck className="h-4 w-4" />
                              </Button>
                            )}
                          />
                        ) : null}
                        <ConfirmAction
                          title="删除连接记录"
                          description={`删除连接记录 ${conn.name}。已撤销的记录删除后不会影响现有状态。`}
                          confirmLabel="删除"
                          onConfirm={() => handleDelete(conn)}
                          trigger={(
                            <Button variant="ghost" size="sm" title="删除记录">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
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

      {/* 创建密钥 dialog */}
      <Dialog
        open={issueOpen}
        onOpenChange={open => {
          if (!open) {
            setIssueOpen(false);
            setIssued(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>创建连接密钥</DialogTitle>
          </DialogHeader>
          {!issued ? (
            <IssueForm
              onSubmit={handleIssue}
              onCancel={() => setIssueOpen(false)}
              submitting={submitting}
            />
          ) : (
            <IssueResult
              data={issued}
              onCopy={() => void handleCopy(issued.clipboardText)}
              onClose={() => {
                setIssueOpen(false);
                setIssued(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

// ── 子组件 ────────────────────────────────────

function IssueForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}): JSX.Element {
  const [name, setName] = useState('');
  return (
    <form
      className="space-y-4"
      onSubmit={e => {
        e.preventDefault();
        void onSubmit(name);
      }}
    >
      <Field label="名称（可选，给自己看）">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="for noroenrn map"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
      </Field>
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        密钥 10 分钟内有效，且只能使用一次。请生成后立即复制粘贴。
      </div>
      <div className="flex items-center gap-3 pt-1">
        <Button type="submit" disabled={submitting}>
          {submitting ? '生成中…' : '生成密钥'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function IssueResult({
  data,
  onCopy,
  onClose,
}: {
  data: IssueResponse;
  onCopy: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="mr-1 inline h-4 w-4" />
        密钥已生成，10 分钟内有效。复制后到 MAP 平台粘贴即可完成连接。
      </div>
      <Field label="剪贴板密钥">
        <textarea
          readOnly
          value={data.clipboardText}
          rows={5}
          className="w-full rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs"
          onFocus={e => e.target.select()}
        />
      </Field>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div>过期时间：{new Date(data.expiresAt).toLocaleString()}</div>
        <div>连接 ID：{data.connectionId}</div>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={onCopy}>
          <Copy className="mr-1 h-4 w-4" /> 复制到剪贴板
        </Button>
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  pairingExpiresAt,
}: {
  status: CdsConnectionView['status'];
  pairingExpiresAt?: string;
}): JSX.Element {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600">
        <CheckCircle2 className="h-3 w-3" /> 已连接
      </span>
    );
  }
  if (status === 'pending-pairing') {
    const remain = pairingExpiresAt
      ? Math.max(0, Math.floor((new Date(pairingExpiresAt).getTime() - Date.now()) / 60000))
      : null;
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600"
        title={pairingExpiresAt ? `到期 ${new Date(pairingExpiresAt).toLocaleTimeString()}` : ''}
      >
        <Clock className="h-3 w-3" /> 待配对{remain !== null ? `（${remain}分钟）` : ''}
      </span>
    );
  }
  if (status === 'revoked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-600">
        <XCircle className="h-3 w-3" /> 已撤销
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
      <X className="h-3 w-3" /> 未知
    </span>
  );
}
