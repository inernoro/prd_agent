import { useEffect, useState } from 'react';
import { Flame, HardDrive, Snowflake, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { LoadState } from '../types';
import { SourceRetentionPreview } from '../components/SourceRetentionPreview';
import { BackupRetentionPanel } from '../components/BackupRetentionPanel';
import { AcceptanceRetentionPanel } from '../components/AcceptanceRetentionPanel';
import { ImageCachePanel } from '../components/ImageCachePanel';
import { HostCapacityPanel } from '../components/HostCapacityPanel';

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
  resourcePressure?: 'ample' | 'pressure' | 'unknown';
  occupancy?: Array<{ slug: string; state: string; reason: string }>;
  protections?: Array<{ slug: string; source: string; active: boolean; reviewRequired: boolean;
    pin?: { kind: string; actor: string; reason: string; expiresAt?: string; authorizationRef?: string } }>;
}

interface JanitorConfig {
  enabled: boolean;
  worktreeTTLDays: number;
  diskWarnPercent: number;
  sweepIntervalSeconds: number;
}

interface JanitorSnapshot {
  enabled?: boolean;
  reclaimLock?: { holder: string | null; since: number | null };
  config?: JanitorConfig | null;
  dryRun?: { wouldRemove: string[]; wouldSkip: string[] };
  disk?: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  lastSweep?: { at: string; reclaimDeferred?: { heldBy: string; heldForMs: number };
    capacity?: { fullRecheckScheduled?: boolean; fullRechecksRemaining?: number };
    deploymentSources?: { filesystem?: {
    beforeAvailableBytes: number | null; afterAvailableBytes: number | null; netAvailableBytesDelta: number | null;
  } } } | null;
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
    if (!Number.isInteger(hot) || hot < 1 || hot > 25) {
      onToast('最大热分支数必须是 1 到 25 之间的整数');
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
      description="热池最多 25 个分支。资源充裕时保留空闲服务；出现压力或容量不足时，按现有保护和访问顺序降温。临时固定到期退出，旧保护须核对。"
    >
      <div className="space-y-6">
        <HostCapacityPanel />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Flame className="h-4 w-4 text-warn" />
              当前热分支
            </div>
            <div className="mt-2 text-2xl font-semibold">{snap.capacityUsage?.current ?? hotList.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              上限 {capMax === 0 ? '不限' : capMax}
            </div>
          </div>
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Snowflake className="h-4 w-4 text-info" />
              当前冷分支
            </div>
            <div className="mt-2 text-2xl font-semibold">{coldList.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">已被停止 / 降温的分支</div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Trash2 className="h-4 w-4 text-bad" />
              即将过期删除
            </div>
            <div className="mt-2 text-2xl font-semibold">{dryRun.wouldRemove.length}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              保护跳过 {dryRun.wouldSkip.length} 个，当前阈值 {janitorCfg.worktreeTTLDays} 天
            </div>
          </div>
          <div className="rounded-md border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <HardDrive className="h-4 w-4 text-ok" />
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

        <Field label="热池占用与保护">
          <p className="text-xs text-muted-foreground">
            资源状态：{snap.resourcePressure === 'ample' ? '充裕，暂不因空闲降温' : snap.resourcePressure === 'pressure' ? '存在压力，保留空闲降温保护' : '未知，继续原有空闲保护'}。
            不占容量的已停止或空闲登记 {snap.occupancy?.filter(row => row.state === 'nonresident').length ?? '未知'} 个；
            用途待核对且保留预约 {snap.occupancy?.filter(row => row.state === 'unknown').length ?? '未知'} 个。
          </p>
          <div className="mt-2 space-y-2 text-xs">
            {(snap.protections ?? []).map(row => (
              <div key={`${row.slug}:${row.source}`} className="rounded border border-border p-2 break-words">
                <strong>{row.slug}</strong> · {({ user: '手动固定', debug: '调试标记', 'config-pinned': '配置固定', 'default-branch': '默认分支', 'trunk-branch': '主分支', 'release-batch-input': '发布与恢复保护' } as Record<string, string>)[row.source] ?? row.source} · {row.active ? '保护中' : '临时保护已到期'}
                {row.reviewRequired ? ' · 旧记录，须核对依据，继续保留' : null}
                {row.pin ? <div className="mt-1 text-muted-foreground">
                  {row.pin.actor} · {row.pin.reason} · {row.reviewRequired ? '期限及依据待核对' : row.pin.expiresAt ? `到期 ${row.pin.expiresAt}` : '永久固定'}
                  {row.pin.authorizationRef ? ` · 授权依据 ${row.pin.authorizationRef}` : ''}
                </div> : null}
              </div>
            ))}
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
            资源有压力或状态未知时，超过此时长的空闲分支可被降温。范围 1–1440 分钟。当前生效值{' '}
            <CodePill>{Math.round((cfg.idleTTLSeconds || 900) / 60)} 分钟</CodePill>
          </div>
        </Field>

        <Field label="最大热分支数">
          <input
            type="number"
            min={1}
            max={25}
            value={maxHot}
            onChange={(e) => setMaxHot(e.target.value)}
            className={inputClass}
          />
          <div className="mt-1.5 text-xs text-muted-foreground">
            同时保持运行及在途预约的分支上限，范围 1–25。超出时仅降温可安全停止的分支。当前生效值{' '}
            <CodePill>{capMax}</CodePill>
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

        <Field label="回收执行状态">
          <p className="text-xs text-muted-foreground">
            {janitorSnap.reclaimLock === undefined
              ? '当前版本未提供回收互斥状态，执行情况未知。'
              : janitorSnap.reclaimLock.holder
                ? <>本次读取时，回收锁由 <CodePill>{janitorSnap.reclaimLock.holder}</CodePill> 持有。</>
                : '本次读取时回收锁空闲。'}
          </p>
          {janitorSnap.lastSweep?.reclaimDeferred ? (
            <p className="mt-1.5 text-xs text-muted-foreground" role="status">
              上轮回收因互斥锁占用而延期，持有任务为 <CodePill>{janitorSnap.lastSweep.reclaimDeferred.heldBy}</CodePill>。
              {janitorSnap.lastSweep.capacity?.fullRecheckScheduled === true
                ? '已安排有次数上限的延迟复查。'
                : janitorSnap.lastSweep.capacity?.fullRecheckScheduled === false
                  ? '本周期未安排延迟复查，下一常规周期重试。'
                  : '复查调度状态未提供。'}
            </p>
          ) : null}
        </Field>

        <Field label="部署源码磁盘治理">
          <p className="text-xs text-muted-foreground">
            最近一轮文件系统净可用空间变化：{janitorSnap.lastSweep?.deploymentSources?.filesystem?.netAvailableBytesDelta == null
              ? '尚无已确认读数'
              : `${janitorSnap.lastSweep.deploymentSources.filesystem.netAvailableBytesDelta.toLocaleString()} 字节`}。
            该读数包含同时发生的写入，不能将候选估计值或删除数量当作实际释放量。
          </p>
          <SourceRetentionPreview />
          <BackupRetentionPanel />
          <AcceptanceRetentionPanel />
          <ImageCachePanel />
        </Field>

        {cfg.pinnedBranches.length > 0 ? (
          <Field label="配置固定名单（旧记录保留，已复核的临时保护按期限退出）">
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
