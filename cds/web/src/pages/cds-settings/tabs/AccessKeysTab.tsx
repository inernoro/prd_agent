/**
 * AccessKeysTab — 全局 Agent Key 管理(2026-05-04 用户反馈)
 *
 * 用户原话:「access-key 我也希望有个地方可以修改或添加,双重 key 也行,
 * 反正不能让用户还去 env 获取吧,那太反人性了」。
 *
 * 之前 GlobalAgentKey 入口埋在 ProjectListPage「+ 新建」dropdown,新用户
 * 找不到。本 tab 把同一份后端 API 平铺到 CDS 系统设置「常用」组,inline
 * 列表 + 签发 + 复制 + 吊销,不再走对话框。
 *
 * 双重 key:后端 GlobalAgentKey list 天然支持多个 active key 同时有效,
 * 用户可签 2+ 个轮换。本 UI 在 footer 给出文案明示这点。
 *
 * 与 ProjectListPage 的 GlobalAgentKeyManagerDialog 共用同一组 API:
 *   GET    /api/global-agent-keys      列表
 *   POST   /api/global-agent-keys      签发 → 返回 plaintext(只一次!)
 *   DELETE /api/global-agent-keys/:id  吊销
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';

interface AgentKeySummary {
  id: string;
  label: string;
  scope: string;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface AgentKeysResponse {
  keys: AgentKeySummary[];
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; keys: AgentKeySummary[] };

interface Props {
  onToast: (message: string) => void;
}

export function AccessKeysTab({ onToast }: Props): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [signing, setSigning] = useState(false);
  const [signLabel, setSignLabel] = useState('');
  const [signError, setSignError] = useState('');
  /** 刚签出的 plaintext key — 只展示一次,用户必须复制 */
  const [freshKey, setFreshKey] = useState<{ plaintext: string; preview: string } | null>(null);
  const [copyHint, setCopyHint] = useState('');

  const loadKeys = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<AgentKeysResponse>('/api/global-agent-keys');
      setState({ status: 'ok', keys: data.keys || [] });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function signKey(): Promise<void> {
    setSigning(true);
    setSignError('');
    try {
      const res = await apiRequest<{ keyId: string; plaintext: string; preview: string }>(
        '/api/global-agent-keys',
        {
          method: 'POST',
          body: { label: signLabel.trim() || undefined },
        },
      );
      setFreshKey({ plaintext: res.plaintext, preview: res.preview });
      setSignLabel('');
      await loadKeys();
      onToast(`已签发新 Key ${res.preview}`);
    } catch (err) {
      setSignError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSigning(false);
    }
  }

  async function revokeKey(keyId: string, label: string): Promise<void> {
    try {
      await apiRequest(`/api/global-agent-keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
      });
      await loadKeys();
      onToast(`已吊销 Key ${label}`);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint('已复制');
      window.setTimeout(() => setCopyHint(''), 1800);
    } catch {
      setCopyHint('复制失败 — 请手动选中文字');
    }
  }

  const activeKeys = state.status === 'ok' ? state.keys.filter((k) => !k.revokedAt) : [];
  const revokedKeys = state.status === 'ok' ? state.keys.filter((k) => k.revokedAt) : [];

  return (
    <div className="space-y-6">
      {/* 介绍 */}
      <div className="cds-surface-raised cds-hairline space-y-2 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <KeyRound className="h-4 w-4" />
          AI Access Key(全局通行证)
        </div>
        <div className="text-xs leading-5 text-muted-foreground">
          用于 cdscli / curl 等自动化场景调 CDS API。可签发多个 key 同时有效(双重 key 轮换),
          签发后<strong className="text-foreground">明文只显示一次</strong>,务必立刻复制保存。
          忘了就吊销重签。<br />
          基础 bootstrap key 仍在 .cds.env 的 <code>AI_ACCESS_KEY</code>,本页签发的是 <code>cdsg_</code>
          前缀的全局通行证,等价权限,不会读取 / 修改 .cds.env。
        </div>
      </div>

      {/* 刚签出的 plaintext — 醒目展示 */}
      {freshKey ? (
        <div className="rounded-md border-2 border-amber-500/60 bg-amber-500/10 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
            <KeyRound className="h-4 w-4" />
            新 Key 已生成 — 立刻复制(只显示一次!)
          </div>
          <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-background px-3 py-2 font-mono text-xs">
            <span className="min-w-0 flex-1 truncate">{freshKey.plaintext}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyToClipboard(freshKey.plaintext)}
            >
              <Copy className="mr-1 h-3 w-3" />
              复制
            </Button>
          </div>
          {copyHint ? <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">{copyHint}</div> : null}
          <div className="mt-2 text-xs text-amber-700/80 dark:text-amber-300/80">
            签发后该明文不再保存。关闭本提示后无法再次显示,请确认已复制。
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setFreshKey(null)}>
            我已保存,关闭提示
          </Button>
        </div>
      ) : null}

      {/* 签发新 Key */}
      <div className="cds-surface-raised cds-hairline px-4 py-3">
        <div className="mb-2 text-sm font-semibold">签发新 Key</div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="可选标签,例如 prod-rotate-2026-05 / shenzhen-mac"
            value={signLabel}
            onChange={(e) => setSignLabel(e.target.value)}
            maxLength={100}
            disabled={signing}
          />
          <Button type="button" onClick={() => void signKey()} disabled={signing}>
            {signing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
            签发
          </Button>
        </div>
        {signError ? (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {signError}
          </div>
        ) : null}
      </div>

      {/* 已有 keys 列表 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">
            已签发 Key({activeKeys.length} 个有效{revokedKeys.length > 0 ? ` + ${revokedKeys.length} 已吊销` : ''})
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadKeys()}>
            <RefreshCw className="mr-1 h-3 w-3" />
            刷新
          </Button>
        </div>

        {state.status === 'loading' ? <LoadingBlock label="加载全局 Agent Keys" /> : null}
        {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
        {state.status === 'ok' && activeKeys.length === 0 && revokedKeys.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            还没有签发过任何全局 Agent Key。可点击上方「签发」按钮新建。
          </div>
        ) : null}
        {state.status === 'ok' && (activeKeys.length > 0 || revokedKeys.length > 0) ? (
          <div className="space-y-2">
            {[...activeKeys, ...revokedKeys].map((key) => {
              const isRevoked = !!key.revokedAt;
              return (
                <div key={key.id} className="cds-surface-raised cds-hairline px-4 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`font-medium ${isRevoked ? 'opacity-60' : ''}`}>
                          {key.label || key.id}
                        </span>
                        <span
                          className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
                            isRevoked
                              ? 'border-border bg-muted/40 text-muted-foreground opacity-70'
                              : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold'
                          }`}
                        >
                          {isRevoked ? '已吊销' : '有效'}
                        </span>
                        <span className="rounded-md border border-[hsl(var(--hairline))] bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {key.scope}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                        <span>id={key.id}</span>
                        <span>签发={formatDate(key.createdAt)}</span>
                        {key.lastUsedAt ? <span>最近使用={formatDate(key.lastUsedAt)}</span> : null}
                        {key.revokedAt ? <span>吊销={formatDate(key.revokedAt)}</span> : null}
                        {key.createdBy ? <span>by={key.createdBy}</span> : null}
                      </div>
                    </div>
                    {!isRevoked ? (
                      <ConfirmAction
                        title="吊销此 Key?"
                        description={`吊销后用此 Key 的 cdscli / curl 立即 401。如果是当前在用的请先签发新 key 替换。`}
                        confirmLabel="确认吊销"
                        onConfirm={() => void revokeKey(key.id, key.label || key.id)}
                        trigger={
                          <Button type="button" variant="outline" size="sm">
                            <Trash2 className="mr-1 h-3 w-3" />
                            吊销
                          </Button>
                        }
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
