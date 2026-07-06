/*
 * ExtraServicesPanel — 分支级临时额外服务管理（波1 W1b，最后一公里）。
 *
 * 能力 2026-06-29 已在后端落地（BranchEntry.extraProfiles + PUT /extra-services），
 * 但此前只有裸 HTTP API，无任何 UI 入口——本面板把它推到产品可用：
 *   - 列表：id / 镜像 / 端口 / 命名子域 / 数据库隔离 徽标，env 已脱敏
 *   - 添加/编辑：ExtraServiceFormDialog（预设 + 校验与服务端对齐）
 *   - 移除：二次确认；「移除并重部署」才会真正下掉在跑容器
 *   - 响应处理：redeployTriggered / redeployRejected / removalRolledBack 显性化
 *     （expectation-management：重部署被拒 + 破坏性移除被回滚时用户必须知道）
 *
 * 挂载点：BranchDetailDrawer 的「设置」tab + BranchDetailPage。
 */
import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { apiRequest, ApiError } from '@/lib/api';
import { ExtraServiceFormDialog, type ExtraServiceProfile } from './ExtraServiceFormDialog';

interface ExtraServicesPutResponse {
  extraProfiles: ExtraServiceProfile[];
  count: number;
  redeployTriggered: boolean;
  redeployRejected?: { status: number; message: string };
  removalRolledBack?: boolean;
  rolledBackServiceIds?: string[];
  hint?: string;
}

type PanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; profiles: ExtraServiceProfile[] }
  | { status: 'error'; message: string };

export function ExtraServicesPanel({
  branchId,
  onToast,
  onChanged,
}: {
  branchId: string;
  onToast?: (message: string) => void;
  onChanged?: () => void;
}): JSX.Element {
  const [state, setState] = useState<PanelState>({ status: 'idle' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExtraServiceProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'warn' | 'info'; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const res = await apiRequest<{ extraProfiles: ExtraServiceProfile[] }>(
        `/api/branches/${encodeURIComponent(branchId)}/extra-services`,
      );
      setState({ status: 'ok', profiles: res.extraProfiles || [] });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const putProfiles = useCallback(async (
    profiles: ExtraServiceProfile[],
    redeploy: boolean,
  ): Promise<ExtraServicesPutResponse> => {
    const query = redeploy ? '?redeploy=1' : '';
    return apiRequest<ExtraServicesPutResponse>(
      `/api/branches/${encodeURIComponent(branchId)}/extra-services${query}`,
      { method: 'PUT', body: { extraProfiles: profiles } },
    );
  }, [branchId]);

  // 把 PUT 响应翻译成用户可读的结果通告（重部署被拒 / 回滚都必须显性化，不许静默）。
  const digestResponse = useCallback((res: ExtraServicesPutResponse, successText: string): void => {
    setState({ status: 'ok', profiles: res.extraProfiles || [] });
    if (res.removalRolledBack) {
      setNotice({
        kind: 'warn',
        text: `重部署被拒（${res.redeployRejected?.message || '未知原因'}），且本次移除的服务仍在运行——`
          + `配置已自动回滚以避免幽灵服务（${(res.rolledBackServiceIds || []).join(', ')}）。请先处理拒因再重试。`,
      });
      return;
    }
    if (res.redeployRejected) {
      setNotice({
        kind: 'warn',
        text: `配置已保存，但重部署被拒：${res.redeployRejected.message}。处理后可手动重新部署本分支。`,
      });
      return;
    }
    setNotice(null);
    onToast?.(res.redeployTriggered
      ? `${successText}，已触发重部署，几十秒后容器就位`
      : `${successText}（纯配置变更，下次部署时生效）`);
    if (res.redeployTriggered) onChanged?.();
  }, [onChanged, onToast]);

  const handleSubmit = useCallback(async (draft: ExtraServiceProfile, redeploy: boolean): Promise<void> => {
    if (state.status !== 'ok') return;
    setSaving(true);
    try {
      const merged = [...state.profiles.filter((p) => p.id !== draft.id), draft];
      const res = await putProfiles(merged, redeploy);
      digestResponse(res, editing ? `临时服务 ${draft.id} 已更新` : `临时服务 ${draft.id} 已声明`);
      setDialogOpen(false);
      setEditing(null);
    } catch (err) {
      onToast?.(`保存失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [digestResponse, editing, onToast, putProfiles, state]);

  const handleRemove = useCallback(async (serviceId: string, redeploy: boolean): Promise<void> => {
    if (state.status !== 'ok') return;
    setRemovingId(serviceId);
    try {
      const remaining = state.profiles.filter((p) => p.id !== serviceId);
      const res = await putProfiles(remaining, redeploy);
      digestResponse(res, `临时服务 ${serviceId} 已移除`);
    } catch (err) {
      onToast?.(`移除失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setRemovingId(null);
    }
  }, [digestResponse, onToast, putProfiles, state]);

  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <FlaskConical className="h-3.5 w-3.5" />
            临时额外服务
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            只作用于本分支的实验容器（如临时接 Nacos），不影响其他分支，删分支即消失。
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load()}
            disabled={state.status === 'loading'}
            title="刷新列表"
          >
            <RefreshCw className={state.status === 'loading' ? 'animate-spin' : ''} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setEditing(null); setDialogOpen(true); }}
            disabled={state.status !== 'ok'}
          >
            <Plus />
            添加服务
          </Button>
        </div>
      </div>

      {notice ? (
        <div className={`mb-3 rounded-md border px-3 py-2 text-sm ${notice.kind === 'warn'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground'}`}
        >
          {notice.text}
        </div>
      ) : null}

      {state.status === 'loading' || state.status === 'idle' ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在加载临时服务…
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </div>
      ) : null}

      {state.status === 'ok' && state.profiles.length === 0 ? (
        <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-5 text-center text-sm text-muted-foreground">
          <div>本分支还没有临时服务。</div>
          <div className="mt-1 text-xs">
            典型场景：这个分支要试 Nacos / Kafka / MinIO，但不想影响别的分支——点「添加服务」，
            选个预设改两下就能起容器。
          </div>
        </div>
      ) : null}

      {state.status === 'ok' && state.profiles.length > 0 ? (
        <div className="space-y-2">
          {state.profiles.map((profile) => (
            <div
              key={profile.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{profile.id}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="max-w-[220px] truncate font-mono" title={profile.dockerImage}>{profile.dockerImage}</span>
                  <span className="font-mono">:{profile.containerPort}</span>
                  {profile.subdomain ? (
                    <span className="rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-blue-700 dark:text-blue-300">
                      子域 {profile.subdomain}
                    </span>
                  ) : null}
                  {profile.dbScope === 'per-branch' ? (
                    <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                      分支独立库
                    </span>
                  ) : null}
                  {profile.env && Object.keys(profile.env).length > 0 ? (
                    <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5">
                      env×{Object.keys(profile.env).length}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setEditing(profile); setDialogOpen(true); }}
                  title="编辑"
                >
                  <Pencil />
                </Button>
                <ConfirmAction
                  trigger={(
                    <Button size="sm" variant="ghost" title="移除" disabled={removingId === profile.id}>
                      {removingId === profile.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    </Button>
                  )}
                  title={`移除临时服务 ${profile.id}？`}
                  description="将同时触发重部署把在跑容器下掉。只想改配置不动容器可在编辑弹窗里取消勾选重部署。"
                  confirmLabel="移除并重部署"
                  pending={removingId === profile.id}
                  onConfirm={() => handleRemove(profile.id, true)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <ExtraServiceFormDialog
        open={dialogOpen}
        initial={editing}
        existingIds={state.status === 'ok' ? state.profiles.map((p) => p.id) : []}
        saving={saving}
        onClose={() => { if (!saving) { setDialogOpen(false); setEditing(null); } }}
        onSubmit={(draft, redeploy) => void handleSubmit(draft, redeploy)}
      />
    </div>
  );
}
