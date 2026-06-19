import { useEffect, useState } from 'react';
import { Flame, HardDrive, Snowflake, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { LoadState } from '../types';

interface SchedulerConfig {
  enabled: boolean;
  maxHotBranches: number;
  idleTTLSeconds: number;
  tickIntervalSeconds: number;
  pinnedBranches: string[];
}

interface SchedulerSnapshot {
  enabled?: boolean;
  // scheduler 未挂载时后端可能返回 config: null —— 全部按可选处理（Codex P2）。
  config?: SchedulerConfig | null;
  hot?: Array<{ slug: string; lastAccessedAt: string | undefined; pinned: boolean }>;
  cold?: Array<{ slug: string; lastAccessedAt: string | undefined }>;
  capacityUsage?: { current: number; max: number };
}

interface JanitorConfig {
  enabled: boolean;
  worktreeTTLDays: number;
  diskWarnPercent: number;
  sweepIntervalSeconds: number;
}

interface JanitorSnapshot {
  enabled?: boolean;
  config?: JanitorConfig | null;
  dryRun?: { wouldRemove: string[]; wouldSkip: string[] };
  disk?: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
}

interface RuntimePolicyState {
  scheduler: SchedulerSnapshot;
  janitor: JanitorSnapshot;
}

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  enabled: false,
  maxHotBranches: 3,
  idleTTLSeconds: 900,
  tickIntervalSeconds: 60,
  pinnedBranches: [],
};

const DEFAULT_JANITOR_CONFIG: JanitorConfig = {
  enabled: true,
  worktreeTTLDays: 7,
  diskWarnPercent: 80,
  sweepIntervalSeconds: 3600,
};

const inputClass =
  'min-h-11 w-32 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring';

export function SchedulerTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [state, setState] = useState<LoadState<RuntimePolicyState>>({ status: 'loading' });
  const [enabled, setEnabled] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState('15');
  const [maxHot, setMaxHot] = useState('3');
  const [janitorEnabled, setJanitorEnabled] = useState(true);
  const [expiryDays, setExpiryDays] = useState('7');
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      apiRequest<SchedulerSnapshot>('/api/scheduler/state', { signal: ctrl.signal }),
      apiRequest<JanitorSnapshot>('/api/janitor/state', { signal: ctrl.signal }),
    ])
      .then(([scheduler, janitor]) => {
        const schedulerCfg = scheduler.config ?? DEFAULT_SCHEDULER_CONFIG;
        const janitorCfg = janitor.config ?? DEFAULT_JANITOR_CONFIG;
        setState({ status: 'ok', data: { scheduler, janitor } });
        setEnabled(scheduler.enabled ?? schedulerCfg.enabled);
        setIdleMinutes(String(Math.round((schedulerCfg.idleTTLSeconds || 900) / 60)));
        setMaxHot(String(schedulerCfg.maxHotBranches ?? 3));
        setJanitorEnabled(janitor.enabled ?? janitorCfg.enabled);
        setExpiryDays(String(janitorCfg.worktreeTTLDays ?? 7));
      })
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [reloadKey]);

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  const snap = state.data.scheduler;
  const janitorSnap = state.data.janitor;
  const cfg = snap.config ?? DEFAULT_SCHEDULER_CONFIG;
  const janitorCfg = janitorSnap.config ?? DEFAULT_JANITOR_CONFIG;
  const hotList = snap.hot ?? [];
  const coldList = snap.cold ?? [];
  const capMax = snap.capacityUsage?.max ?? cfg.maxHotBranches;
  const dryRun = janitorSnap.dryRun ?? { wouldRemove: [], wouldSkip: [] };
  const disk = janitorSnap.disk;

  async function save(): Promise<void> {
    const minutes = Number(idleMinutes);
    const hot = Number(maxHot);
    const days = Number(expiryDays);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      onToast('空闲超时必须是 1 到 1440 之间的整数（分钟）');
      return;
    }
    if (!Number.isInteger(hot) || hot < 0 || hot > 100) {
      onToast('最大热分支数必须是 0 到 100 之间的整数（0 = 不限）');
      return;
    }
    if (!Number.isInteger(days) || days < 1 || days > 7) {
      onToast('全局过期天数必须是 1 到 7 之间的整数（最长 7 天）');
      return;
    }
    setSubmitting(true);
    try {
      await Promise.all([
        apiRequest<SchedulerSnapshot>('/api/scheduler/config', {
          method: 'PUT',
          body: { enabled, idleTTLSeconds: minutes * 60, maxHotBranches: hot },
        }),
        apiRequest<JanitorSnapshot>('/api/janitor/config', {
          method: 'PUT',
          body: { enabled: janitorEnabled, worktreeTTLDays: days },
        }),
      ]);
      onToast('运行时策略已保存并即时生效');
      setReloadKey((k) => k + 1);
    } catch (err) {
      onToast(`保存失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Section
      title="调度器"
      description="调度器开启后，空闲超过设定时长的分支会自动停止变灰；热分支数超上限时按 LRU 驱逐最久未访问分支。固定分支永不冷却。配置即时生效并在重启后保留。"
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Flame className="h-4 w-4 text-amber-500" />
              当前热分支
            </div>
            <div className="mt-2 text-2xl font-semibold">{hotList.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              上限 {capMax === 0 ? '不限' : capMax}
            </div>
          </div>
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Snowflake className="h-4 w-4 text-sky-500" />
              当前冷分支
            </div>
            <div className="mt-2 text-2xl font-semibold">{coldList.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">已被停止 / 降温的分支</div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Trash2 className="h-4 w-4 text-rose-500" />
              即将过期删除
            </div>
            <div className="mt-2 text-2xl font-semibold">{dryRun.wouldRemove.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              保护跳过 {dryRun.wouldSkip.length} 个，当前阈值 {janitorCfg.worktreeTTLDays} 天
            </div>
          </div>
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <HardDrive className="h-4 w-4 text-emerald-500" />
              工作区磁盘
            </div>
            <div className="mt-2 text-2xl font-semibold">{disk ? `${disk.usedPercent}%` : '-'}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {disk ? `阈值 ${janitorCfg.diskWarnPercent}%` : '当前环境未返回磁盘信息'}
            </div>
          </div>
        </div>

        <Field label="启用调度器">
          <Button
            type="button"
            variant={enabled ? 'default' : 'outline'}
            size="sm"
            onClick={() => setEnabled((v) => !v)}
          >
            {enabled ? '已启用（点击停用）' : '已停用（点击启用）'}
          </Button>
          <div className="mt-1.5 text-xs text-muted-foreground">
            停用后所有分支不再被自动降温；已停止的分支下次被访问时会自动重建。
          </div>
        </Field>

        <Field label="空闲自动下线时长（分钟）">
          <input
            type="number"
            min={1}
            max={1440}
            value={idleMinutes}
            onChange={(e) => setIdleMinutes(e.target.value)}
            className={inputClass}
          />
          <div className="mt-1.5 text-xs text-muted-foreground">
            分支无预览域名访问超过此时长即被停止。范围 1–1440 分钟。当前生效值{' '}
            <CodePill>{Math.round((cfg.idleTTLSeconds || 900) / 60)} 分钟</CodePill>
          </div>
        </Field>

        <Field label="最大热分支数">
          <input
            type="number"
            min={0}
            max={100}
            value={maxHot}
            onChange={(e) => setMaxHot(e.target.value)}
            className={inputClass}
          />
          <div className="mt-1.5 text-xs text-muted-foreground">
            同时保持运行的分支上限，超出按 LRU 驱逐最久未访问的非固定分支。0 = 不限。当前生效值{' '}
            <CodePill>{cfg.maxHotBranches === 0 ? '不限' : cfg.maxHotBranches}</CodePill>
          </div>
        </Field>

        <Field label="启用全局过期删除">
          <Button
            type="button"
            variant={janitorEnabled ? 'default' : 'outline'}
            size="sm"
            onClick={() => setJanitorEnabled((v) => !v)}
          >
            {janitorEnabled ? '已启用（点击停用）' : '已停用（点击启用）'}
          </Button>
          <div className="mt-1.5 text-xs text-muted-foreground">
            启用后，超过全局过期天数且未被固定 / 标记 / 设为默认的分支，会自动删除本地容器和 worktree。
          </div>
        </Field>

        <Field label="全局过期删除天数">
          <input
            type="number"
            min={1}
            max={7}
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            className={inputClass}
          />
          <div className="mt-1.5 text-xs text-muted-foreground">
            默认 7 天，最长 7 天。当前生效值 <CodePill>{janitorCfg.worktreeTTLDays} 天</CodePill>
          </div>
        </Field>

        {cfg.pinnedBranches.length > 0 ? (
          <Field label="固定分支（永不冷却）">
            <div className="flex flex-wrap gap-2">
              {cfg.pinnedBranches.map((slug) => (
                <CodePill key={slug}>{slug}</CodePill>
              ))}
            </div>
          </Field>
        ) : null}

        <div>
          <Button type="button" onClick={() => void save()} disabled={submitting}>
            {submitting ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </Section>
  );
}
