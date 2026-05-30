/**
 * ConfigSnapshotsTab — 配置快照(2026-05-07 wave 2.3)
 *
 * 后端 /api/config-snapshots 已齐:
 *   GET    /api/config-snapshots         列表
 *   GET    /api/config-snapshots/:id     详情
 *   POST   /api/config-snapshots         手动创建(label)
 *   POST   /api/config-snapshots/:id/rollback  回滚到该快照
 *
 * UI:
 *   - 列表展示最近快照(label / trigger / triggeredBy / createdAt)
 *   - "创建快照"按钮 — 弹 prompt 输入 label
 *   - 每条 entry 旁有"回滚"按钮 — 二次确认后调 rollback
 *   - 自动刷新(60s)防止用户看到陈旧列表
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ErrorBlock, LoadingBlock, Section } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';

interface ConfigSnapshot {
  id: string;
  createdAt: string;
  projectId?: string | null;
  trigger: 'pre-import' | 'pre-destructive' | 'manual' | 'scheduled';
  label: string;
  triggeredBy?: string;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; snapshots: ConfigSnapshot[] };

interface Props {
  onToast: (message: string) => void;
}

function triggerLabel(t: ConfigSnapshot['trigger']): string {
  switch (t) {
    case 'pre-import':       return '导入前';
    case 'pre-destructive':  return '危险操作前';
    case 'manual':           return '手动';
    case 'scheduled':        return '定时';
  }
}

function triggerTone(t: ConfigSnapshot['trigger']): string {
  switch (t) {
    case 'manual':           return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'pre-import':       return 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'pre-destructive':  return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'scheduled':        return 'border-muted bg-muted/30 text-muted-foreground';
  }
}

export function ConfigSnapshotsTab({ onToast }: Props): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setState({ status: 'loading' });
    setRefreshing(true);
    try {
      const data = await apiRequest<{ snapshots: ConfigSnapshot[] }>('/api/config-snapshots', silent
        ? { headers: { 'X-CDS-Poll': 'true' } }
        : undefined);
      setState({ status: 'ok', snapshots: data.snapshots || [] });
    } catch (err) {
      // 2026-05-28 transient(Cloudflare 边缘抖动)静默保留缓存
      if (err instanceof ApiError && err.transient) return;
      const message = err instanceof ApiError ? err.message : String(err);
      setState({ status: 'error', message });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const create = async (): Promise<void> => {
    const label = window.prompt('快照标签(如"上线 v1.2 前"):', `手动快照 ${new Date().toLocaleString('zh-CN')}`);
    if (!label) return;
    setCreating(true);
    try {
      await apiRequest('/api/config-snapshots', { method: 'POST', body: { label, trigger: 'manual' } });
      onToast('快照已创建');
      await load(true);
    } catch (err) {
      onToast(`创建失败: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const rollback = async (snap: ConfigSnapshot): Promise<void> => {
    try {
      await apiRequest(`/api/config-snapshots/${encodeURIComponent(snap.id)}/rollback`, { method: 'POST' });
      onToast(`已回滚到「${snap.label}」`);
      await load(true);
    } catch (err) {
      onToast(`回滚失败: ${err instanceof ApiError ? err.message : String(err)}`);
    }
  };

  return (
    <Section
      title="配置快照"
      description="导入 / 危险操作前自动留快照,也可手动创建。回滚会把 buildProfiles / customEnv / infraServices / routingRules 恢复到该时刻。"
    >
      <div className="mb-4 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void load(false)} disabled={refreshing}>
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新
        </Button>
        <Button type="button" size="sm" onClick={() => void create()} disabled={creating}>
          {creating ? <Loader2 className="animate-spin" /> : <Save />}
          创建快照
        </Button>
      </div>

      {state.status === 'loading' || state.status === 'idle' ? (
        <LoadingBlock />
      ) : state.status === 'error' ? (
        <ErrorBlock message={state.message} />
      ) : state.snapshots.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          还没有快照。点上方「创建快照」生成第一条,或等待下次导入 / 危险操作时自动生成。
        </div>
      ) : (
        <ul className="divide-y divide-[hsl(var(--hairline))] rounded-md border border-border">
          {state.snapshots.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className={`rounded-md border px-2 py-0.5 text-[11px] ${triggerTone(s.trigger)}`}>
                {triggerLabel(s.trigger)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{s.label}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(s.createdAt).toLocaleString('zh-CN')}
                  {s.triggeredBy ? ` · ${s.triggeredBy}` : ''}
                  {s.projectId ? ` · 项目 ${s.projectId}` : ''}
                </div>
              </div>
              <ConfirmAction
                title={`回滚到「${s.label}」?`}
                description="将覆盖当前 buildProfiles / customEnv / infraServices / routingRules,无法直接撤销(但会自动留新快照)"
                confirmLabel="确认回滚"
                onConfirm={() => rollback(s)}
                trigger={(
                  <Button type="button" variant="outline" size="sm">
                    <RotateCcw />
                    回滚
                  </Button>
                )}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
