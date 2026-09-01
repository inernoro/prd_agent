/**
 * IdentityTab —— 权限总览：按**主体**聚合，不按钥匙平铺。
 *
 * 这一页要解掉一个具体的两难：吊销记录留着，列表用久了糊成一片；删掉，又分不出
 * 「从没签发」和「被吊销」。第三条路是把**看板和判据分开**——
 *
 *   - 看板（这一页）只回答「现在有谁能进来」：主列表列主体（十几个），
 *     每个主体下面的凭证历史默认折叠，超过保留期的直接不展示（归档，不是删除）。
 *   - 「这把到底怎么了」交给凭据自检端点，由持有者自己去查，不用来问管理员。
 *
 * 另外把此前看不见的两样东西端出来：**签发留痕**（这张用户级凭证签出过几张下游）
 * 与**级联撤销**（撤源头一次撤干净）。用户级凭证只授权不操作，所以滥用一定表现为
 * 「签出一堆项目级凭证」—— 看不见签发次数，留痕就等于没留。
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldOff, UserCog } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';

interface CredentialView {
  id: string;
  kind: 'user' | 'project';
  label?: string;
  projectId?: string;
  projectName?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  status: 'active' | 'expired' | 'revoked';
  issuedCount?: number;
  lastIssuedAt?: string;
}

interface GrantView {
  id: string;
  projectId: string;
  projectName?: string;
  origin: 'created' | 'approved';
  grantedAt: string;
}

interface PrincipalRow {
  principal: {
    id: string;
    name: string;
    kind: 'human' | 'machine' | 'agent';
    status: 'active' | 'disabled';
    createdAt: string;
    createdBy?: string;
    lastSeenAt?: string;
  };
  activeCredentials: CredentialView[];
  retiredCredentials: CredentialView[];
  grants: GrantView[];
}

interface OverviewResponse {
  rows: PrincipalRow[];
  unclaimed: CredentialView[];
  archivedCount: number;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: OverviewResponse };

interface Props {
  onToast: (message: string) => void;
}

const KIND_LABEL: Record<PrincipalRow['principal']['kind'], string> = {
  human: '人',
  machine: '机器',
  agent: '智能体',
};

function formatDate(value?: string): string {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString('zh-CN', { hour12: false });
}

/** 到期还剩多久 —— 用户级 90 天、项目级 30 天都是「用一次自动续」，所以这里是活的。 */
function remaining(expiresAt?: string): string {
  if (!expiresAt) return '永不过期';
  const ms = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(ms)) return expiresAt;
  if (ms <= 0) return '已过期';
  const days = Math.floor(ms / 86_400_000);
  return days >= 1 ? `还剩 ${days} 天` : '不足 1 天';
}

export function IdentityTab({ onToast }: Props): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [issued, setIssued] = useState<{ plaintext: string; reach: string } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await apiRequest<OverviewResponse>('/api/identity/overview');
      setState({ status: 'ok', data: res });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const issue = useCallback(async () => {
    const name = newName.trim();
    if (!name) { onToast('先给这台机器 / 这个智能体起个名字'); return; }
    setCreating(true);
    try {
      const res = await apiRequest<{ plaintext: string; reach: string }>('/api/identity/user-credentials', {
        method: 'POST',
        body: { name },
      });
      setIssued({ plaintext: res.plaintext, reach: res.reach });
      setNewName('');
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [newName, onToast, load]);

  const revokeCredential = useCallback(async (id: string) => {
    try {
      const res = await apiRequest<{ cascadedCount: number }>(`/api/identity/user-credentials/${id}/revoke`, {
        method: 'POST',
        body: {},
      });
      onToast(res.cascadedCount > 0
        ? `已撤销，并级联撤掉它签出的 ${res.cascadedCount} 张下游凭证`
        : '已撤销');
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  }, [onToast, load]);

  const setPrincipalStatus = useCallback(async (id: string, status: 'active' | 'disabled') => {
    try {
      await apiRequest(`/api/identity/principals/${id}/status`, { method: 'POST', body: { status } });
      onToast(status === 'disabled' ? '已停用该主体，其名下凭证立刻不可用' : '已恢复该主体');
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  }, [onToast, load]);

  if (state.status === 'loading' || state.status === 'idle') return <LoadingBlock label="加载权限总览" />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  const { rows, unclaimed, archivedCount } = state.data;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">权限总览</h3>
          <p className="max-w-[80ch] text-xs leading-6 text-muted-foreground">
            列的是<strong>主体</strong>（一台机器一个、一个智能体一个），不是一把把钥匙。
            用户级凭证是「发钥匙的钥匙」：只能建项目、列项目、为已授权项目签发项目级凭证，
            不能删分支、改配置、跑运维指令。撤掉它会<strong>级联撤掉它签出的全部下游凭证</strong>。
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw /> 刷新
        </Button>
      </header>

      <section className="cds-surface-raised cds-hairline rounded-md border border-[hsl(var(--hairline))] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">给这台机器 / 这个智能体起个名字</span>
            <input
              className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="例如：我的笔记本 / CI 构建机 / 缺陷修复智能体"
            />
          </label>
          <Button type="button" size="sm" onClick={() => void issue()} disabled={creating}>
            {creating ? <Loader2 className="animate-spin" /> : <Plus />} 签发用户级凭证
          </Button>
        </div>
        {issued ? (
          <div className="mt-3 rounded-md border border-[hsl(var(--warn))]/40 bg-[hsl(var(--warn-soft))] p-3">
            <div className="mb-2 text-xs font-semibold text-[hsl(var(--warn))]">明文只显示这一次，现在就复制走</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-[hsl(var(--surface-sunken))] px-2 py-1 font-mono text-xs">
                {issued.plaintext}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(issued.plaintext);
                  onToast('已复制');
                }}
              >
                <Copy /> 复制
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setIssued(null)}>我已存好</Button>
            </div>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">{issued.reach}</p>
          </div>
        ) : null}
      </section>

      {rows.length === 0 ? (
        <section className="cds-surface-raised cds-hairline rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-8 text-center text-sm text-muted-foreground">
          还没有任何主体。签发第一张用户级凭证后，这里会按主体列出谁能进来。
        </section>
      ) : null}

      {rows.map((row) => {
        const open = expanded[row.principal.id] === true;
        const disabled = row.principal.status !== 'active';
        return (
          <section
            key={row.principal.id}
            className="cds-surface-raised cds-hairline rounded-md border border-[hsl(var(--hairline))]"
          >
            <header className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
              <UserCog className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">{row.principal.name}</span>
              <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {KIND_LABEL[row.principal.kind]}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${disabled ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok'}`}
              >
                {disabled ? '已停用' : '正常'}
              </span>
              <span className="text-xs text-muted-foreground">
                有效凭证 {row.activeCredentials.length} · 项目授权 {row.grants.length}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">最近活动 {formatDate(row.principal.lastSeenAt)}</span>
              <ConfirmAction
                title={disabled ? '恢复该主体?' : '停用该主体?'}
                description={disabled
                  ? '恢复后它名下未吊销、未过期的凭证会重新可用。'
                  : '停用后它名下所有凭证立刻不可用，记录保留以备审计。'}
                confirmLabel={disabled ? '恢复' : '停用'}
                onConfirm={() => void setPrincipalStatus(row.principal.id, disabled ? 'active' : 'disabled')}
                trigger={(
                  <Button type="button" size="sm" variant="ghost">
                    <ShieldOff /> {disabled ? '恢复' : '停用'}
                  </Button>
                )}
              />
            </header>

            <div className="flex flex-col gap-2 px-4 py-3">
              {row.grants.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">可自助补发凭证的项目：</span>
                  {row.grants.map((grant) => (
                    <span
                      key={grant.id}
                      className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 py-0.5"
                      title={grant.origin === 'created' ? '这个项目是它建的' : '经人在页面上批准过一次'}
                    >
                      {grant.projectName || grant.projectId}
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        {grant.origin === 'created' ? '创建' : '批准'}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  还没有任何项目授权 —— 它只能建新项目；要操作别人建的项目，需要在那个项目上批准一次。
                </p>
              )}

              {row.activeCredentials.map((cred) => (
                <div
                  key={cred.id}
                  className="flex flex-wrap items-center gap-3 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs"
                >
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-[11px]">{cred.id}</span>
                  <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[10px]">
                    {cred.kind === 'user' ? '用户级' : `项目级 · ${cred.projectName || cred.projectId}`}
                  </span>
                  {cred.label ? <span className="text-muted-foreground">{cred.label}</span> : null}
                  <span className="text-muted-foreground">{remaining(cred.expiresAt)}</span>
                  <span className="text-muted-foreground">最近使用 {formatDate(cred.lastUsedAt)}</span>
                  {cred.kind === 'user' ? (
                    <span
                      className="text-muted-foreground"
                      title="用户级凭证只授权不操作，所以滥用一定表现为「签出一堆项目级凭证」。看不见次数，留痕就等于没留。"
                    >
                      已签出 {cred.issuedCount || 0} 张下游
                    </span>
                  ) : null}
                  {cred.kind === 'user' ? (
                    <ConfirmAction
                      title="撤销这张用户级凭证?"
                      description="它签出的全部下游项目级凭证会同时失效 —— 撤了源头却留着下游等于撤了个寂寞。"
                      confirmLabel="撤销并级联"
                      onConfirm={() => void revokeCredential(cred.id)}
                      trigger={<Button type="button" size="sm" variant="ghost" className="ml-auto">撤销</Button>}
                    />
                  ) : null}
                </div>
              ))}

              {row.retiredCredentials.length > 0 ? (
                <button
                  type="button"
                  className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded((prev) => ({ ...prev, [row.principal.id]: !open }))}
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  已吊销 / 已过期 {row.retiredCredentials.length} 张
                </button>
              ) : null}
              {open
                ? row.retiredCredentials.map((cred) => (
                    <div key={cred.id} className="flex flex-wrap items-center gap-3 px-3 py-1 text-xs text-muted-foreground">
                      <span className="font-mono text-[11px]">{cred.id}</span>
                      <span>{cred.status === 'revoked' ? `吊销于 ${formatDate(cred.revokedAt)}` : `过期于 ${formatDate(cred.expiresAt)}`}</span>
                    </div>
                  ))
                : null}
            </div>
          </section>
        );
      })}

      {unclaimed.length > 0 ? (
        <section className="cds-surface-raised cds-hairline rounded-md border border-[hsl(var(--warn))]/30 p-4">
          <h4 className="mb-1 text-xs font-semibold text-[hsl(var(--warn))]">未认领的存量凭证 {unclaimed.length} 张</h4>
          <p className="mb-2 text-xs leading-6 text-muted-foreground">
            这些是身份层之前签发的项目级凭证，还没有归属主体。它们照常可用，只是不享受
            「换机器自助补发」和「按主体聚合」。下次使用时认领，或在项目卡上重签一张即可。
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            {unclaimed.slice(0, 30).map((cred) => (
              <span key={cred.id} className="rounded border border-[hsl(var(--hairline))] px-2 py-0.5 font-mono text-[11px]">
                {cred.projectName || cred.projectId} · {cred.id}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        已归档 {archivedCount} 条超过 90 天的吊销记录：不再出现在这里，但仍留在状态里可供审计。
        某把凭证「到底怎么了」由持有者自己查凭据自检端点，不必来问管理员。
      </p>
    </div>
  );
}
